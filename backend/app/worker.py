import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from . import db as storage
from . import accounts
from .recycle import purge_expired
from .feishu import Feishu, FeishuError, validate_mapping, write_fields, normalize_remote, field_differences
from .service import job_save, cache_remote, projection, save_verified_sync

BUSINESS_FIELDS = ('platform', 'account', 'kind', 'direction', 'amount', 'time', 'merchant', 'description',
                   'order_id', 'merchant_id', 'state', 'category', 'method', 'refund_snapshot', 'transaction_type', 'review')


def same_event(a, b):
    return all(a.get(k) == b.get(k) for k in BUSINESS_FIELDS)


def import_job(jid, payload):
    for f in payload['files']:
        if f.get('state') in ('done', 'duplicate', 'error'):
            continue
        with storage.db() as c:
            exists = c.execute('SELECT payload FROM files WHERE id=?', (f['id'],)).fetchone()
            deleted_file = c.execute('SELECT 1 FROM deleted_files WHERE file_id=?', (f['id'],)).fetchone()
            disabled_file = c.execute('SELECT 1 FROM disabled_files WHERE file_id=?',(f['id'],)).fetchone()
            reparse = c.execute('SELECT 1 FROM file_reparse WHERE file_id=?',(f['id'],)).fetchone()
        if deleted_file:
            f.update(state='error', error='这份账单在回收站中，请先在数据管理中恢复；已到期数据需等待后台清理后重新导入')
            job_save(jid, 'running', payload)
            continue
        if disabled_file:
            f.update(state='error',error='此文件已取消导入，请在「导入文件管理」中重新启用导入')
            job_save(jid,'running',payload)
            continue
        if exists and not reparse and not json.loads(exists[0]).get('dedup', {}).get('trashed_events'):
            result = json.loads(exists[0])
            result['dedup'] = {'new_events': 0, 'updated_events': 0, 'unchanged_events': result['row_count'] - len(result.get('errors', [])), 'older_snapshots': 0}
            f.update(state='duplicate', result=result)
            job_save(jid, 'running', payload)
            continue
        f['state'] = 'parsing'
        job_save(jid, 'running', payload)
        try:
            output = subprocess.run([sys.executable, '-m', 'app.parse_worker', f['path'], f['name'], payload['account']], timeout=90, capture_output=True, cwd=Path(__file__).resolve().parents[1])
            if output.returncode:
                raise ValueError('文件解析进程失败，请重新导出文件')
            result = json.loads(output.stdout.decode('utf-8'))
            if result.get('error'):
                raise ValueError(result['error'])
            same_file_ids = {}
            counts = {'new_events': 0, 'updated_events': 0, 'unchanged_events': 0, 'older_snapshots': 0, 'trashed_events': 0}
            with storage.db() as c:
                for event in result.pop('events'):
                    c.execute('INSERT OR IGNORE INTO event_files VALUES (?,?)',(event['id'],f['id']))
                    if c.execute('SELECT 1 FROM deleted_events WHERE event_id=?', (event['id'],)).fetchone():
                        counts['trashed_events'] += 1
                        continue
                    if event['id'] in same_file_ids:
                        if same_event(same_file_ids[event['id']], event):
                            counts['unchanged_events'] += 1
                            continue
                        # Ambiguous same-ID events must not disappear silently.
                        event['review'] = True
                        event['id'] = hashlib.sha256((event['id'] + f['id'] + event['location']).encode()).hexdigest()
                        c.execute('INSERT OR IGNORE INTO event_files VALUES (?,?)',(event['id'],f['id']))
                    same_file_ids[event['id']] = dict(event)
                    event['file_id'], event['file_name'] = f['id'], f['name']
                    previous = c.execute('SELECT payload FROM events WHERE id=?', (event['id'],)).fetchone()
                    if previous:
                        old = json.loads(previous[0])
                        if old.get('observed_at') and (not event.get('observed_at') or old['observed_at'] > event['observed_at']):
                            counts['older_snapshots'] += 1
                            continue
                        # Preserve cumulative refund evidence if an undated old
                        # export would regress it; flag instead of hiding it.
                        if (old.get('refund_snapshot') or 0) > (event.get('refund_snapshot') or 0):
                            event['review'] = True
                            event['refund_snapshot'] = old['refund_snapshot']
                        counts['unchanged_events' if same_event(old, event) else 'updated_events'] += 1
                    else:
                        counts['new_events'] += 1
                    if not previous or not same_event(old, event):
                        storage.record_operation(c, 'edit' if previous else 'create', 'import',
                                                 event['merchant'] + (' · 导入更新原交易' if previous else ' · 导入新增交易'),
                                                 event['id'], old if previous else None, event)
                    c.execute('INSERT OR REPLACE INTO events VALUES (?,?)', (event['id'], storage.dumps(event)))
                result['file_id'] = f['id']
                result['dedup'] = counts
                c.execute('INSERT INTO files(id,name,platform,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', (f['id'], f['name'], result['platform'], storage.dumps(result)))
                c.execute('DELETE FROM file_reparse WHERE file_id=?',(f['id'],))
            f.update(state='done', result=result)
        except (ValueError, subprocess.TimeoutExpired, json.JSONDecodeError) as e:
            f.update(state='error', error='解析超过 90 秒，请分段导出' if isinstance(e, subprocess.TimeoutExpired) else str(e))
        job_save(jid, 'running', payload)
    state = 'partial' if any(f['state'] == 'error' or f.get('result', {}).get('errors') for f in payload['files']) else 'done'
    job_save(jid, state, payload)


def equal_fields(actual, expected, config=None):
    return not field_differences(actual, expected, config or {})


def sync_job(jid, payload):
    config = payload['config']
    config['_extra_managed_fields']=list(dict.fromkeys([*config.get('_extra_managed_fields',[]),*[name for item in payload['items'] for name in item.get('fields',{})]]))
    client = Feishu(config)
    try:
        connection, records = cache_remote(config, client)
        validate_mapping(connection['fields'], config)
        if connection['ledger'] != config['ledger']:
            raise ValueError('账本解析结果变化，请重新检测后同步')
        for item in payload['items']:
            if item.get('state') == 'success':
                continue
            try:
                fields = item['fields']
                # Refresh before every write, including crash recovery. A timed
                # out create can have succeeded remotely.
                records = normalize_remote(client.records(), config)
                found = [r for r in records if r.get('sync_key') == item['expense_id']]
                if len(found) > 1:
                    raise ValueError('远端有多条相同同步键记录，需手工处理')
                known_id = item.get('record_id') or item.get('written_record_id')
                if known_id:
                    current = next((r for r in records if r['id'] == known_id), None)
                    if not current:
                        raise ValueError('原飞书记录已删除或当前身份不可见')
                else:
                    current = found[0] if found else None
                if current and equal_fields(current['fields'], fields, config):
                    verified = current
                else:
                    item['differences'] = field_differences(current['fields'], fields, config) if current else []
                    if current and not item.get('record_id'):
                        item['written_record_id'] = current['id']
                        raise FeishuError('已找到写入记录，但字段有差异，请查看逐笔核对结果', uncertain=True)
                    if current and (item.get('before') is None or not equal_fields(current['fields'], item['before'], config)):
                        raise ValueError('飞书记录在预览后被修改，请刷新并重新核对')
                    item['state'] = 'sending'
                    job_save(jid, 'running', payload)
                    response = client.update(current['id'], fields) if current else client.create(fields)
                    record_id = response['record_id']
                    item['written_record_id'] = record_id
                    job_save(jid, 'running', payload)
                    # Verify the write by reading the table again; retain unknown
                    # state if verification is interrupted.
                    verified = None
                    for attempt in range(3):
                        if attempt: time.sleep(.3 * attempt)
                        after = normalize_remote(client.records(), config)
                        verified = next((r for r in after if r['id'] == record_id), None)
                        if verified and equal_fields(verified['fields'], fields, config): break
                    if not verified or not equal_fields(verified['fields'], fields, config):
                        item['differences'] = field_differences(verified['fields'] if verified else {}, fields, config)
                        raise FeishuError('写入后回读存在字段差异，请查看逐笔核对结果', uncertain=True)
                with storage.db() as c:
                    save_verified_sync(c, config, item, verified)
                item.pop('differences', None)
                item.update(state='success', record_id=verified['id'], message='已同步并回读核对',code=None,log_id=None)
            except FeishuError as e:
                item.update(state='unknown' if e.uncertain or item.get('state') == 'sending' else 'failed', message=e.message, code=e.code, log_id=e.log_id)
            except ValueError as e:
                item.update(state='failed', message=str(e))
            job_save(jid, 'running', payload)
        cache_remote(config, client)
        job_save(jid, 'done' if all(i['state'] == 'success' for i in payload['items']) else 'partial', payload)
    finally:
        client.close()


def cleanup():
    # Only generated upload files, no user-controlled paths.
    uploads = storage.data_dir() / 'uploads'
    if uploads.exists():
        for p in uploads.glob('*.upload'):
            if p.is_file() and p.stat().st_mtime < time.time() - 86400:
                p.unlink()
    with storage.db() as c:
        if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='screenshot_previews'").fetchone():
            c.execute("DELETE FROM screenshot_previews WHERE expires<?", (time.time(),))
    purge_expired()


def main():
    storage.init()
    accounts.init()
    # Only one worker may recover/execute this local database at a time.
    lock = open(storage.DATA / 'worker.lock', 'a+b')
    lock.seek(0)
    try:
        if os.name == 'nt':
            import msvcrt
            if lock.read(1) == b'':
                lock.write(b'0')
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        raise SystemExit('此数据库已有 worker 运行，请勿重复启动') from None
    (storage.DATA / 'worker.pid').write_text(str(os.getpid()), encoding='ascii')
    print(f'账单 worker 已启动，PID {os.getpid()}', flush=True)
    # Atomic claim gives the single worker exclusive ownership. On restart,
    # prior writes are reconciled rather than blindly repeated.
    for user in accounts.all_users():
        with storage.tenant(user['id']):
            storage.init()
            with storage.db() as c:
                c.execute("UPDATE jobs SET state='queued' WHERE state='running'")
    last_cleanup = 0
    while True:
        worked = False
        cleanup_due = time.time() - last_cleanup > 60
        for user in accounts.all_users():
            with storage.tenant(user['id']):
                if user['active']:
                    worked = process_next_job() or worked
                if cleanup_due:
                    cleanup()
        if not worked:
            time.sleep(.6)
        if cleanup_due:
            last_cleanup = time.time()


def process_next_job():
    """Claim and execute only within the caller's tenant context."""
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        row = c.execute("SELECT * FROM jobs WHERE state='queued' ORDER BY created,id LIMIT 1").fetchone()
        if row:
            c.execute("UPDATE jobs SET state='running',updated=CURRENT_TIMESTAMP WHERE id=?", (row['id'],))
    if not row:
        return False
    payload = json.loads(row['payload'])
    try:
        (import_job if payload['kind'] == 'import' else sync_job)(row['id'], payload)
    except Exception as e:
        payload['error'] = str(e) if isinstance(e, (ValueError, FeishuError)) else '任务异常，请检查服务器状态后重试'
        job_save(row['id'], 'partial', payload)
    return True


if __name__ == '__main__':
    main()
