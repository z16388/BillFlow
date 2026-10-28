import json
import hashlib
from . import db as storage
from .domain import project
from .feishu import Feishu, normalize_remote, normalize_fields, validate_mapping


def cache_remote(config, client=None):
    own = client is None
    client = client or Feishu(config)
    try:
        connection = client.connect()
        config['fields']=connection['fields']
        config['_extra_managed_fields']=list(dict.fromkeys([*config.get('_extra_managed_fields',[]),*[name for d in storage.decisions().values() for name in d.get('sync_overrides',{}).get(connection['ledger'],{}).get('fields',{})]]))
        records = normalize_remote(client.records(), config)
        with storage.db() as c:
            c.execute('DELETE FROM remote_cache WHERE ledger=?', (connection['ledger'],))
            c.executemany('INSERT INTO remote_cache VALUES (?,?,?)', [(connection['ledger'], r['id'], storage.dumps(r)) for r in records])
        return connection, records
    finally:
        if own:
            client.close()


def projection(ledger=None, config_override=None):
    config = config_override if config_override is not None else storage.settings(True)
    ledger = ledger or config.get('ledger', '')
    with storage.db() as c:
        cached = [json.loads(r[0]) for r in c.execute('SELECT payload FROM remote_cache WHERE ledger=?', (ledger,))]
        cached_config = {**config,'_extra_managed_fields':list({name for r in cached for name in r.get('fields',{})})}
        remote = normalize_remote([{'record_id':r['id'],'fields':r['fields']} for r in cached],cached_config)
        bindings = {r['expense_id']: {'record_id': r['record_id'], 'snapshot': normalize_fields(json.loads(r['snapshot']),config)} for r in c.execute('SELECT * FROM bindings WHERE ledger=?', (ledger,))}
    decisions=storage.decisions()
    data = project(storage.events(), decisions, remote, bindings, storage.customization())
    if config.get('fields'):
        from .field_mapping import evaluate, effective_mapping
        description_field=effective_mapping(config).get('description')
        for row in data['expenses']:
            try:result=evaluate(row,config)
            except ValueError as e:result={'fields':{},'warnings':[str(e)]}
            from .feishu import write_fields
            override=decisions.get(row['id'],{}).get('sync_overrides',{}).get(ledger,{})
            writable={f['field_name'] for f in config.get('fields',[]) if f['type'] in (1,2,3,4,5,7) and not f.get('is_readonly')}
            row['sync_overrides']={k:v for k,v in override.get('fields',{}).items() if k in writable}
            if override.get('net') != row['net']:
                row['sync_overrides'].pop(effective_mapping(config).get('amount'),None)
            result['fields']=write_fields(row,config)
            row['mapped_fields']=result['fields']
            row['mapping_warnings']=result['warnings']
            row['mapped_description']=result['fields'].get(description_field)
            if row['status'] in ('new','update','recorded'):
                if row.get('record_id') and any(row.get('remote_snapshot',{}).get(k)!=v for k,v in result['fields'].items()):
                    previous=bindings.get(row['id'],{}).get('snapshot',{})
                    edited=any(row.get('remote_snapshot',{}).get(k)!=v for k,v in previous.items() if k in result['fields'])
                    row['status']='review' if edited else 'update'
                    if edited:row['reasons'].append('飞书字段已被手动修改，请核对后重新绑定')
                    else:row['update_reason']='字段映射更新'
                elif row['status']=='update' and (row.get('update_reason')=='显示内容更新' or row.get('sync_overrides')):row['status']='recorded'
        data['summary']={k:sum(e['status']==k for e in data['expenses']) for k in data['summary']}
    data['remote_checked'] = bool(config.get('checked_at') and config.get('ledger') == ledger)
    return data


def projection_fingerprint():
    return hashlib.sha256(storage.dumps([storage.events(), storage.decisions(), storage.customization(), storage.data_preferences()['revision']]).encode()).hexdigest()


def backfill_event_metadata():
    """Enrich retained older imports without changing identifiers or decisions."""
    from .parsers import parse_file
    missing = [e for e in storage.events() if 'transaction_type' not in e]
    by_file = {}
    for event in missing:
        by_file.setdefault(event.get('file_id'), []).append(event)
    for fid, entries in by_file.items():
        if not fid or len(fid) != 64 or any(c not in '0123456789abcdef' for c in fid):
            continue
        path = storage.data_dir() / 'uploads' / (fid + '.upload')
        enriched = {}
        if path.is_file():
            try:
                result = parse_file(entries[0]['file_name'], path.read_bytes(), entries[0]['account'])
                enriched = {e['id']: e.get('transaction_type', '') for e in result['events']}
            except (ValueError, OSError):
                pass
        with storage.db() as c:
            for event in entries:
                fallback = '转账' if event['platform'] == '微信' and event.get('state') == '对方已收钱' else event.get('category', '')
                event['transaction_type'] = enriched.get(event['id'], fallback)
                c.execute('UPDATE events SET payload=? WHERE id=?', (storage.dumps(event), event['id']))


def save_decision(eid, patch):
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        from .data_scope import visible_events
        visible={e['id'] for e in visible_events(c)}
        if eid not in visible:raise ValueError('交易不存在、已取消导入或已移入回收站')
        if not c.execute('SELECT 1 FROM events e WHERE e.id=? AND NOT EXISTS (SELECT 1 FROM deleted_events d WHERE d.event_id=e.id)',(eid,)).fetchone():
            raise ValueError('交易不存在或已移入回收站')
        targets = [patch[k] for k in ('merge_into','refund_to') if patch.get(k)]
        targets.extend(k[len('distinct_'):] for k in patch if k.startswith('distinct_') and k != 'distinct_remote' and patch[k])
        for target in targets:
            if target not in visible:raise ValueError('关联目标已取消导入或已移入回收站')
            if not c.execute('SELECT 1 FROM events e WHERE e.id=? AND NOT EXISTS (SELECT 1 FROM deleted_events d WHERE d.event_id=e.id)',(target,)).fetchone():
                raise ValueError('关联目标不存在或已移入回收站')
        previous = c.execute('SELECT payload FROM decisions WHERE event_id=?', (eid,)).fetchone()
        old = json.loads(previous[0]) if previous else {}
        updated = {**old, **patch}
        if old == updated:
            return
        c.execute('INSERT OR REPLACE INTO decisions VALUES (?,?)', (eid, storage.dumps(updated)))
        event = c.execute('SELECT payload FROM events WHERE id=?', (eid,)).fetchone()
        merchant = json.loads(event[0]).get('merchant', '') if event else ''
        labels = {'douyin_duplicate_exempt':'抖音重复流水单笔豁免','refund_cash_amount':'实际退款金额','refund_adjustment_reason':'退款修正依据','refund_original_order':'核实原订单号','reset_refund_cash':'恢复原始退款金额','ignore': '排除状态', 'filter_exempt':'单条过滤豁免', 'confirmed':'消费确认', 'refund_to':'退款关联', 'merge_into':'合并关系', 'category':'分类', 'note':'备注', 'distinct_remote':'已有记录核对'}
        changed = '、'.join(labels.get(k, '重复核对') for k in patch if old.get(k) != updated.get(k))
        storage.record_operation(c, 'edit', 'decision', merchant + ' · 修改' + changed, eid, old, updated)


def job_save(jid, state, payload):
    with storage.db() as c:
        c.execute('UPDATE jobs SET state=?,payload=?,updated=CURRENT_TIMESTAMP WHERE id=?', (state, storage.dumps(payload), jid))


def save_verified_sync(c, config, item, record):
    """Bind only a record whose managed fields have actually been verified."""
    snapshot = normalize_fields(record['fields'], config)
    c.execute('INSERT OR REPLACE INTO bindings VALUES (?,?,?,?)',
              (config['ledger'],item['expense_id'],record['id'],storage.dumps(snapshot)))
    if item.get('manual_fields'):
        existing = c.execute('SELECT payload FROM decisions WHERE event_id=?',(item['expense_id'],)).fetchone()
        decision = json.loads(existing[0]) if existing else {}
        previous = storage.dumps(decision)
        overrides = decision.setdefault('sync_overrides',{}).setdefault(config['ledger'],{'fields':{},'net':item.get('net')})
        if overrides.get('net') != item.get('net'):
            from .field_mapping import effective_mapping
            overrides['fields'].pop(effective_mapping(config).get('amount'),None)
        overrides['fields'].update(item['manual_fields'])
        overrides['net'] = item.get('net')
        if previous != storage.dumps(decision):
            c.execute('INSERT OR REPLACE INTO decisions VALUES (?,?)',(item['expense_id'],storage.dumps(decision)))
            storage.record_operation(c,'edit','sync_values','保存单笔同步修改',event_id=item['expense_id'],after=item['manual_fields'])
