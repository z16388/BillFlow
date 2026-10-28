"""Account-local soft deletion. Preserve connected evidence as one recoverable batch."""
import hashlib
import json
import time
import uuid
from . import db as storage
from .data_scope import stored_events, visible_events, connected, edges

DAY = 86400


def busy(c):
    return bool(c.execute("SELECT 1 FROM jobs WHERE state IN ('queued','running') LIMIT 1").fetchone())


def plan(c, scope='all', ids=()):
    events = sorted(stored_events(c),key=lambda e:e['id'])
    files = [dict(r) for r in c.execute('SELECT f.* FROM files f WHERE NOT EXISTS (SELECT 1 FROM deleted_files d WHERE d.file_id=f.id) ORDER BY f.id')]
    decisions = {r[0]:json.loads(r[1]) for r in c.execute('SELECT event_id,payload FROM decisions ORDER BY event_id')}
    disabled = {r[0] for r in c.execute('SELECT file_id FROM disabled_files')}
    sources = {}
    for r in c.execute('SELECT event_id,file_id FROM event_files'):
        sources.setdefault(r[0],set()).add(r[1])
    for e in events:
        if e.get('file_id') and e['id'] not in sources:sources[e['id']]={e['file_id']}
    chosen_files = {f['id'] for f in files} if scope=='all' else set(ids) if scope=='files' else set()
    if scope=='events':
        if not ids or not set(ids) <= {e['id'] for e in events}:raise ValueError('请选择存在的账单')
        selected=set(ids)
    elif scope in ('files','all'):
        if scope=='files' and (not ids or not set(ids) <= {f['id'] for f in files}):raise ValueError('文件不存在或已移入回收站')
        selected={e['id'] for e in events if sources.get(e['id'],set()) & chosen_files and not (sources[e['id']] & {f['id'] for f in files}) - chosen_files}
    else:raise ValueError('删除范围无效')
    requested_count=len(selected)
    imported_count = sum(bool(sources.get(eid)) for eid in selected)
    # Merges and manually/automatically matched refunds must remain recoverable
    # together, including any manual expense attached to imported evidence.
    selected=connected(selected,events,edges(events,decisions))
    prefs = c.execute('SELECT retention_days,revision FROM data_preferences WHERE id=1').fetchone()
    fingerprint = hashlib.sha256(storage.dumps([events,files,decisions,dict(prefs),sorted(disabled),scope,sorted(ids),sorted((k,sorted(v)) for k,v in sources.items())]).encode()).hexdigest()
    visible={e['id'] for e in visible_events(c)}
    return {'event_ids':sorted(selected),'file_ids':sorted(chosen_files),
            'files':[{**{k:f[k] for k in ('id','name','platform','created')},'import_enabled':f['id'] not in disabled,
                      'event_count':sum(f['id'] in sources.get(e['id'],set()) for e in events),
                      'visible_count':sum(e['id'] in visible and f['id'] in sources.get(e['id'],set()) for e in events)} for f in files],
            'imported_count':imported_count,'linked_manual_count':sum(not sources.get(e['id']) for e in events if e['id'] in selected),
            'requested_count':requested_count,'linked_count':len(selected)-requested_count,'scope':scope,
            'event_count':len(selected),'file_count':len(chosen_files),'fingerprint':fingerprint,
            'retention_days':prefs['retention_days']}


def overview():
    with storage.db() as c:
        c.execute('BEGIN')
        result = plan(c)
        result.pop('event_ids')
        result.pop('file_ids')
        result['trash_batches'] = c.execute('SELECT COUNT(*) FROM trash_batches').fetchone()[0]
        result['trash_events'] = c.execute('SELECT COUNT(*) FROM deleted_events').fetchone()[0]
        result['busy'] = busy(c)
        return result


def clear_imports(fingerprint):
    return delete_selected('all',[],fingerprint)


def delete_selected(scope,ids,fingerprint):
    now = time.time()
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        if busy(c):
            raise ValueError('导入或同步任务正在执行，请结束后再清除账单')
        result = plan(c,scope,ids)
        if result['fingerprint'] != fingerprint:
            raise ValueError('账单或设置已变化，请刷新清除预览后重试')
        if not result['event_ids'] and not result['file_ids']:
            raise ValueError('没有可以删除的账单或文件')
        bid = uuid.uuid4().hex
        expires = now + result['retention_days'] * DAY
        summary = {k:result[k] for k in ('imported_count','linked_manual_count','event_count','file_count')}
        c.execute('INSERT INTO trash_batches VALUES (?,?,?,?,?)', (bid,now,expires,result['retention_days'],storage.dumps(summary)))
        c.executemany('INSERT INTO deleted_events VALUES (?,?)',[(eid,bid) for eid in result['event_ids']])
        c.executemany('INSERT INTO deleted_files VALUES (?,?)',[(fid,bid) for fid in result['file_ids']])
        c.execute('INSERT OR IGNORE INTO file_reparse SELECT ef.file_id FROM event_files ef JOIN deleted_events d ON d.event_id=ef.event_id WHERE d.batch_id=?',(bid,))
        c.execute('UPDATE data_preferences SET revision=revision+1 WHERE id=1')
        storage.record_operation(c, 'delete', 'trash_delete', f'{"删除账单" if scope=="events" else "删除导入文件"} · {summary["event_count"]} 笔交易、{summary["file_count"]} 个文件',
                                 before={**summary,'state':'正常'},after={**summary,'state':'回收站','batch_id':bid,'deleted_at':now,'expires_at':expires})
        return {'id':bid,**summary,'deleted_at':now,'expires_at':expires}


def deletion_preview(scope,ids):
    with storage.db() as c:
        c.execute('BEGIN')
        result=plan(c,scope,ids)
        preview={k:v for k,v in result.items() if k not in ('event_ids','file_ids','files')}
        preview['entries']=[{k:e.get(k) for k in ('id','merchant','description','amount','time','platform','kind')}
                            for e in stored_events(c) if e['id'] in ids][:3] if scope=='events' else []
        preview['file_names']=[f['name'] for f in result['files'] if f['id'] in ids][:3]
        return preview


def file_import_state(fid, enabled, fingerprint=None):
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE' if fingerprint is not None else 'BEGIN')
        if fingerprint is not None and busy(c):raise ValueError('任务正在执行，请结束后再调整导入状态')
        snapshot=plan(c,'files',[fid])
        fp=hashlib.sha256((snapshot['fingerprint']+str(enabled)).encode()).hexdigest()
        disabled={r[0] for r in c.execute('SELECT file_id FROM disabled_files')}
        before={e['id'] for e in visible_events(c)}
        after_disabled=(disabled-{fid}) if enabled else (disabled|{fid})
        after={e['id'] for e in visible_events(c,after_disabled)}
        name=next(f['name'] for f in snapshot['files'] if f['id']==fid)
        result={'fingerprint':fp,'file_id':fid,'name':name,'import_enabled':enabled,'hidden_count':len(before-after),'restored_count':len(after-before)}
        if fingerprint is None:return result
        if fingerprint!=fp:raise ValueError('文件或账单状态已变化，请重新确认')
        if (fid not in disabled)!=enabled:
            if enabled:c.execute('DELETE FROM disabled_files WHERE file_id=?',(fid,))
            else:c.execute('INSERT INTO disabled_files VALUES (?)',(fid,))
            c.execute('UPDATE data_preferences SET revision=revision+1 WHERE id=1')
            storage.record_operation(c,'edit','file_import',name+(' · 重新启用导入' if enabled else ' · 取消导入'),
                                     before={'import_enabled':fid not in disabled,'file_name':name},after={'file_name':name,**{k:result[k] for k in ('import_enabled','hidden_count','restored_count')}})
        return result


def batches():
    with storage.db() as c:
        return [{'id':r['id'],'deleted_at':r['deleted_at'],'expires_at':r['expires_at'],
                 'retention_days':r['retention_days'],**json.loads(r['summary'])}
                for r in c.execute('SELECT * FROM trash_batches ORDER BY deleted_at DESC,id')]


def entries(kind,offset=0,limit=20):
    """Separate deleted bills and files, keeping recovery groups intact."""
    with storage.db() as c:
        c.execute('BEGIN')
        counts={key:c.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]
                for key,table in (('bills','deleted_events'),('files','deleted_files'))}
        table,column,origin=('deleted_events','event_id','events') if kind=='bills' else ('deleted_files','file_id','files')
        rows=list(c.execute(f'''SELECT e.*,b.id AS batch_id,b.deleted_at,b.expires_at,b.retention_days,b.summary
             FROM {origin} e JOIN {table} d ON d.{column}=e.id JOIN trash_batches b ON b.id=d.batch_id
             ORDER BY b.deleted_at DESC,e.id LIMIT ? OFFSET ?''',(limit+1,offset)))
        items=[]
        for r in rows[:limit]:
            item=json.loads(r['payload']) if kind=='bills' else {'id':r['id'],'name':r['name'],'platform':r['platform'],
                                                               'row_count':json.loads(r['payload']).get('row_count',0)}
            if kind=='bills':
                saved=c.execute('SELECT payload FROM decisions WHERE event_id=?',(r['id'],)).fetchone()
                decision=json.loads(saved[0]) if saved else {}
                for key in ('note','category'):
                    if key in decision:item[key]=decision[key]
            items.append({**item,**{k:r[k] for k in ('batch_id','deleted_at','expires_at','retention_days')},
                          'batch':json.loads(r['summary'])})
        return {'items':items,'counts':counts,'has_more':len(rows)>limit}


def detail(bid, offset=0, limit=50):
    with storage.db() as c:
        batch = c.execute('SELECT * FROM trash_batches WHERE id=?',(bid,)).fetchone()
        if not batch:
            raise ValueError('回收站记录不存在或已到期清理')
        rows = list(c.execute('SELECT e.payload FROM events e JOIN deleted_events d ON d.event_id=e.id WHERE d.batch_id=? ORDER BY e.id LIMIT ? OFFSET ?', (bid,limit+1,offset)))
        files = [dict(r) for r in c.execute('SELECT f.name,f.platform FROM files f JOIN deleted_files d ON d.file_id=f.id WHERE d.batch_id=? ORDER BY f.name',(bid,))]
        return {'items':[json.loads(r[0]) for r in rows[:limit]],'files':files,'has_more':len(rows)>limit}


def restore(bid):
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        if busy(c):
            raise ValueError('导入或同步任务正在执行，请结束后再恢复账单')
        row = c.execute('SELECT * FROM trash_batches WHERE id=?',(bid,)).fetchone()
        if not row:
            raise ValueError('回收站记录不存在或已到期清理')
        if row['expires_at'] <= time.time():
            raise ValueError('此批数据已到期，无法恢复，后台将自动清理')
        summary = json.loads(row['summary'])
        c.execute('DELETE FROM deleted_events WHERE batch_id=?',(bid,))
        c.execute('DELETE FROM deleted_files WHERE batch_id=?',(bid,))
        c.execute('DELETE FROM trash_batches WHERE id=?',(bid,))
        c.execute('UPDATE data_preferences SET revision=revision+1 WHERE id=1')
        storage.record_operation(c,'restore','trash_restore',f'恢复账单 · {summary["event_count"]} 笔交易、{summary["file_count"]} 个文件',
                                 before={**summary,'state':'回收站','batch_id':bid},after={**summary,'state':'正常'})
        return {'ok':True,**summary}


def purge_expired(now=None):
    now = time.time() if now is None else now
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        rows = list(c.execute('SELECT * FROM trash_batches WHERE expires_at<=?',(now,)))
        for row in rows:
            bid = row['id']
            # No active decision can refer to these IDs: clear_imports moves
            # connected evidence together, and mutation APIs reject trash IDs.
            for table,column in (('decisions','event_id'),('bindings','expense_id'),('events','id')):
                c.execute(f'DELETE FROM {table} WHERE {column} IN (SELECT event_id FROM deleted_events WHERE batch_id=?)',(bid,))
            c.execute('DELETE FROM event_files WHERE event_id IN (SELECT event_id FROM deleted_events WHERE batch_id=?)',(bid,))
            for table in ('event_files','disabled_files','file_reparse'):
                c.execute(f'DELETE FROM {table} WHERE file_id IN (SELECT file_id FROM deleted_files WHERE batch_id=?)',(bid,))
            c.execute('DELETE FROM files WHERE id IN (SELECT file_id FROM deleted_files WHERE batch_id=?)',(bid,))
            c.execute('DELETE FROM deleted_events WHERE batch_id=?',(bid,))
            c.execute('DELETE FROM deleted_files WHERE batch_id=?',(bid,))
            c.execute('DELETE FROM trash_batches WHERE id=?',(bid,))
            summary = json.loads(row['summary'])
            storage.record_operation(c,'delete','trash_expire',f'回收站到期自动清理 · {summary["event_count"]} 笔交易',
                                     before={**summary,'state':'回收站','batch_id':bid},after={**summary,'state':'已到期清理'})
        if rows:
            c.execute('UPDATE data_preferences SET revision=revision+1 WHERE id=1')
        return len(rows)
