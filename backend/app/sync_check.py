"""Read remote records and reconcile local statuses, without remote writes."""
import json
from collections import defaultdict
from . import db as storage
from .feishu import Feishu, normalize_remote, field_differences
from .service import save_verified_sync


def check_job(jid, apply=False):
    with storage.db() as c:
        saved = c.execute('SELECT state,payload FROM jobs WHERE id=?',(jid,)).fetchone()
    if not saved: raise ValueError('同步任务不存在')
    payload = json.loads(saved['payload'])
    if payload.get('kind') != 'sync' or saved['state'] in ('queued','running'):
        raise ValueError('请等待同步任务结束后再核对')
    config = storage.settings(True)
    if config.get('ledger') != payload['config'].get('ledger'):
        raise ValueError('当前账本与此任务不同，请切回原账本后核对')
    client = Feishu(config)
    try:
        connection = client.connect()
        if connection['ledger'] != payload['config'].get('ledger'):
            raise ValueError('账本身份发生变化，请先检查配置')
        compare = {**payload['config'],'fields':connection['fields'],
                   '_extra_managed_fields':list({name for i in payload['items'] for name in i['fields']})}
        records = normalize_remote(client.records(),compare)
    finally:
        client.close()
    by_key = defaultdict(list)
    by_id = {r['id']:r for r in records}
    for record in records: by_key[record.get('sync_key')].append(record)
    types = {f['field_name']:f['type'] for f in connection['fields']}
    checks, matches = [], []
    for item in payload['items']:
        found = by_key[item['expense_id']]
        known_id = item.get('record_id') or item.get('written_record_id')
        current = by_id.get(known_id) if known_id else (found[0] if len(found)==1 else None)
        state = 'matched'
        if len(found)>1: state='duplicate'
        elif known_id and found and found[0]['id']!=known_id: state='conflict'
        elif not current: state='missing'
        differences = field_differences(current['fields'] if current else {},item['fields'],compare)
        if state=='matched' and differences: state='different'
        retryable = (state=='missing' and not known_id and item.get('action','create')=='create') or (
            state=='different' and bool(item.get('record_id')) and item.get('before') is not None
            and not field_differences(current['fields'],item['before'],compare))
        check = {'expense_id':item['expense_id'],'description':item.get('description',''),
                 'action':item.get('action'),'state':state,'retryable':retryable,
                 'record_id':current['id'] if current else None,'differences':differences,
                 'expected':item['fields'],'actual':current['fields'] if current else {},'types':types}
        checks.append(check)
        if state=='matched': matches.append((item,current))
    if apply:
        with storage.db() as c:
            c.execute('BEGIN IMMEDIATE')
            latest = c.execute('SELECT state,payload FROM jobs WHERE id=?',(jid,)).fetchone()
            if not latest or latest['state'] in ('queued','running') or latest['payload']!=saved['payload']:
                raise ValueError('任务已变化，请重新核对')
            if storage.settings(True).get('ledger')!=config.get('ledger'):
                raise ValueError('账本已变化，请重新核对')
            for item,current in matches:
                previous = item.get('state')
                save_verified_sync(c,compare,item,current)
                item.update(state='success',record_id=current['id'],message='已从飞书读取并确认成功',code=None,log_id=None)
                item.pop('differences',None)
                if previous!='success':
                    storage.record_operation(c,'edit','sync_reconcile','核实已同步记录 · '+item.get('description',''),item['expense_id'],
                        {'state':previous},{'state':'success','record_id':current['id']})
            state='done' if all(i.get('state')=='success' for i in payload['items']) else 'partial'
            payload.pop('error',None)
            c.execute('UPDATE jobs SET state=?,payload=?,updated=CURRENT_TIMESTAMP WHERE id=?',(state,storage.dumps(payload),jid))
            # Replace the cache with fresh schema-normalized read results.
            c.execute('DELETE FROM remote_cache WHERE ledger=?',(config['ledger'],))
            c.executemany('INSERT INTO remote_cache VALUES (?,?,?)',[(config['ledger'],r['id'],storage.dumps(r)) for r in records])
    return {'id':jid,'items':checks,'confirmed':len(matches) if apply else 0}
