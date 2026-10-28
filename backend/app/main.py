import csv
import hashlib
import io
import json
import os
import secrets
import time
import uuid
from decimal import Decimal
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, Request, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from . import db as storage
from . import accounts
from .feishu import Feishu, FeishuError, parse_url, validate_mapping, write_fields
from .service import projection, cache_remote, save_decision
from .service import projection_fingerprint, backfill_event_metadata
from .customization import RULE_FIELDS, validate_template
from . import recycle
from .field_mapping import FieldRule, validate_structure, validate_fields as validate_target_fields, effective_mapping, evaluate as evaluate_mapping, label_rules

LOCAL = os.environ.get('LOCAL_DEV') == '1'
PUBLIC_ORIGIN = os.environ.get('PUBLIC_ORIGIN', '')
attempts = defaultdict(deque)


@asynccontextmanager
async def lifespan(app):
    storage.init()
    accounts.init()
    backfill_event_metadata()
    yield


app = FastAPI(title='账单整理 API', lifespan=lifespan, docs_url='/api/docs' if LOCAL else None, openapi_url='/api/openapi.json' if LOCAL else None, redoc_url=None)


@app.middleware('http')
async def auth(request: Request, call_next):
    path = request.url.path
    if request.method in ('POST', 'PUT', 'PATCH', 'DELETE'):
        origin = request.headers.get('origin')
        allowed = {f'{request.url.scheme}://{request.url.netloc}', PUBLIC_ORIGIN}
        if LOCAL:
            allowed |= {'http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:8000'}
            # Some local browser/proxy setups strip the port from Origin.
            # Recover only when both browser metadata and a trusted Referer
            # confirm the same loopback page; never trust a bare Origin alone.
            if (origin in {'http://127.0.0.1', 'http://localhost'}
                    and request.headers.get('sec-fetch-site') == 'same-origin'):
                try:
                    referer = urlparse(request.headers.get('referer', ''))
                    referer_origin = f'{referer.scheme}://{referer.netloc}'
                    if (referer_origin in allowed
                            and origin == f'{referer.scheme}://{referer.hostname}'):
                        allowed.add(origin)
                except ValueError:
                    pass
        if origin and origin not in allowed:
            hint='请使用 http://127.0.0.1:5173 打开本地网页' if LOCAL else '请使用部署时配置的 HTTPS 域名访问，并核对 PUBLIC_ORIGIN'
            return JSONResponse({'detail': '请求来源不受信任；'+hint}, status_code=403)
        if request.headers.get('x-requested-with') != 'zhangdan' and path not in ('/api/health',):
            return JSONResponse({'detail': '请求缺少安全标识'}, status_code=403)
    public = path in ('/api/health', '/api/auth/login', '/api/auth/status')
    user = accounts.resolve(request.cookies.get('session', ''))
    if not public and not user:
        return JSONResponse({'detail': '请先登录'}, status_code=401, headers={'Cache-Control':'no-store'})
    request.state.user = user
    with storage.tenant(user['id'] if user else 'admin'):
        response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.exception_handler(FeishuError)
async def feishu_error(request, exc):
    return JSONResponse({'detail': exc.message, 'code': exc.code, 'log_id': exc.log_id}, status_code=400)


@app.exception_handler(ValueError)
async def validation_error(request, exc):
    return JSONResponse({'detail': str(exc)}, status_code=400)


class Login(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=128)


@app.get('/api/health')
def health():
    return {'ok': True}


@app.get('/api/auth/status')
def auth_status(request: Request):
    return {'authenticated': bool(request.state.user), 'local': LOCAL, 'user': request.state.user}


@app.post('/api/auth/login')
def login(body: Login, request: Request):
    ip = request.client.host
    queue = attempts[ip + '|' + body.username.strip().casefold()]
    while queue and queue[0] < time.time() - 300:
        queue.popleft()
    if len(queue) >= 5:
        raise HTTPException(429, '尝试过于频繁，请 5 分钟后再试')
    queue.append(time.time())
    user = accounts.verify(body.username.strip(), body.password)
    if not user:
        raise HTTPException(401, '账号或密码不正确，或账号已停用')
    queue.clear()
    token = accounts.new_session(user['id'])
    response = JSONResponse({'ok': True})
    response.set_cookie('session', token, max_age=43200, httponly=True, secure=not LOCAL, samesite='strict')
    return response


@app.post('/api/auth/logout')
def logout(request: Request):
    accounts.logout(request.cookies.get('session', ''))
    response = JSONResponse({'ok': True})
    response.delete_cookie('session')
    return response


def require_admin(request):
    if request.state.user['role'] != 'admin':
        raise HTTPException(403, '需要管理员权限')


class NewUser(BaseModel):
    username: str
    password: str
    role: str = 'user'


class UserPatch(BaseModel):
    role: str | None = None
    active: bool | None = None
    password: str | None = None
    confirm_password: str | None = None


@app.get('/api/users')
def get_users(request: Request):
    require_admin(request)
    return accounts.all_users()


@app.post('/api/users')
def create_user(body: NewUser, request: Request):
    require_admin(request)
    return accounts.create(body.username.strip(), body.password, body.role)


@app.patch('/api/users/{uid}')
def update_user(uid: str, body: UserPatch, request: Request):
    require_admin(request)
    if body.password is not None and body.password!=body.confirm_password:raise ValueError('两次输入的新密码不一致')
    return accounts.update(uid, body.model_dump(exclude_none=True,exclude={'confirm_password'}))


class PasswordChange(BaseModel):
    current_password: str = Field(max_length=128)
    new_password: str = Field(max_length=128)
    confirm_password: str = Field(max_length=128)


@app.post('/api/auth/password')
def change_password(body: PasswordChange, request: Request):
    if body.new_password!=body.confirm_password:raise ValueError('两次输入的新密码不一致')
    user = request.state.user
    if not accounts.verify(user['username'], body.current_password):
        raise ValueError('当前密码不正确')
    accounts.update(user['id'], {'password':body.new_password})
    response = JSONResponse({'ok':True})
    response.delete_cookie('session')
    return response


def enqueue(payload):
    jid = str(uuid.uuid4())
    with storage.db() as c:
        c.execute("INSERT INTO jobs(id,state,payload) VALUES (?,'queued',?)", (jid, storage.dumps(payload)))
    return {'id': jid, 'state': 'queued'}


@app.post('/api/imports')
async def upload(files: list[UploadFile] = File(...), account: str = Form('默认账户')):
    if not 1 <= len(files) <= 10 or not account or len(account) > 80:
        raise ValueError('每批上传 1–10 个文件，账户别名不超过 80 字')
    items = []
    uploads = storage.data_dir() / 'uploads'
    uploads.mkdir(exist_ok=True, mode=0o700)
    for f in files:
        name = Path((f.filename or '').replace('\\', '/')).name
        data = await f.read(20 * 1024 * 1024 + 1)
        await f.close()
        if len(data) > 20 * 1024 * 1024 or Path(name).suffix.lower() not in ('.csv', '.xlsx', '.pdf'):
            items.append({'name': name, 'state': 'error', 'error': '仅接收不超过 20 MB 的 CSV、XLSX、抖音 PDF'})
            continue
        digest = hashlib.sha256(account.encode() + b'\0' + data).hexdigest()
        path = uploads / (digest + '.upload')
        path.write_bytes(data)
        try:
            path.chmod(0o600)
        except OSError:
            pass
        items.append({'id': digest, 'name': name, 'path': str(path), 'state': 'queued'})
    return enqueue({'kind': 'import', 'files': items, 'account': account})


@app.get('/api/data')
def data():
    result = projection()
    with storage.db() as c:
        result['files'] = [{'id': r['id'], 'name': r['name'], 'platform': r['platform'], **json.loads(r['payload'])} for r in c.execute('SELECT f.* FROM files f WHERE NOT EXISTS (SELECT 1 FROM deleted_files d WHERE d.file_id=f.id) ORDER BY f.created DESC')]
    return result


class ManualExpense(BaseModel):
    time: str
    merchant: str = Field(min_length=1, max_length=200)
    description: str = Field(default='', max_length=1000)
    amount: str = Field(pattern=r'^\d{1,9}(\.\d{1,2})?$')
    category: str = Field(default='未分类', max_length=80)
    method: str = Field(default='', max_length=80)
    note: str = Field(default='', max_length=2000)
    request_id: str = Field(pattern=r'^[a-f0-9-]{36}$')


@app.post('/api/expenses/manual')
def manual_expense(body: ManualExpense):
    from .parsers import date
    amount = int(Decimal(body.amount) * 100)
    if amount <= 0 or not body.merchant.strip():
        raise ValueError('请填写商户和大于零的支出金额')
    when = date(body.time.replace('T', ' '))
    eid = 'manual-' + str(uuid.UUID(body.request_id))
    event = {'id':eid, 'platform':'手动', 'account':'手动录入', 'kind':'expense', 'direction':'支出',
             'transaction_type':'消费', 'amount':amount, 'time':when, 'merchant':body.merchant.strip(),
             'description':body.description.strip(), 'order_id':eid, 'merchant_id':'', 'state':'已支付',
             'category':body.category.strip() or '未分类', 'method':body.method.strip(), 'refund_snapshot':None,
             'observed_at':datetime.now().strftime('%Y-%m-%d %H:%M:%S'), 'review':False, 'reason':'',
             'location':'手动录入', 'file_name':'手动账单', 'reliable_id':True}
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        if c.execute('SELECT 1 FROM deleted_events WHERE event_id=?',(eid,)).fetchone():
            raise ValueError('这笔账单在回收站中，请先恢复后再处理')
        if c.execute('SELECT 1 FROM events WHERE id=?', (eid,)).fetchone():
            return {'id':eid, 'duplicate':True}
        c.execute('INSERT INTO events VALUES (?,?)', (eid, storage.dumps(event)))
        if body.note:
            c.execute('INSERT INTO decisions VALUES (?,?)', (eid, storage.dumps({'note':body.note})))
        storage.record_operation(c, 'create', 'manual', body.merchant.strip() + ' · 手动新增支出', eid, after={**event, 'note':body.note})
    return {'id':eid}


@app.get('/api/operations')
def operations(kind: str = Query(default='edit', pattern='^(edit|create|delete|restore)$'), limit: int = Query(default=50, ge=1, le=100), offset: int = Query(default=0, ge=0)):
    with storage.db() as c:
        rows = list(c.execute("SELECT o.*,CASE WHEN d.event_id IS NOT NULL THEN 'trash' WHEN e.id IS NOT NULL THEN 'active' ELSE 'missing' END AS event_state FROM operations o LEFT JOIN events e ON e.id=o.event_id LEFT JOIN deleted_events d ON d.event_id=o.event_id WHERE o.kind=? ORDER BY o.created DESC,o.rowid DESC LIMIT ? OFFSET ?", (kind, limit + 1, offset)))
        from .data_scope import visible_events
        visible={e['id'] for e in visible_events(c)}
    return {'has_more':len(rows) > limit, 'items':[{**{k:r[k] for k in ('id','kind','action','event_id','summary','created')},
             'before':json.loads(r['before_json']) if r['before_json'] else None,
             'after':json.loads(r['after_json']) if r['after_json'] else None,
             'event_state':('suspended' if r['event_state']=='active' and r['event_id'] not in visible else r['event_state']) if r['event_id'] else None} for r in rows[:limit]]}


class DataSelection(BaseModel):
    scope: str = Field(pattern='^(events|files|all)$')
    ids: list[str] = Field(default_factory=list,max_length=1000)


class DeleteSelection(DataSelection):
    fingerprint: str = Field(pattern='^[a-f0-9]{64}$')


@app.post('/api/data-management/delete-preview')
def preview_delete(body: DataSelection):
    return recycle.deletion_preview(body.scope,body.ids)


@app.post('/api/data-management/delete')
def delete_selection(body: DeleteSelection):
    return recycle.delete_selected(body.scope,body.ids,body.fingerprint)


class FileState(BaseModel):
    enabled: bool
    fingerprint: str | None = None


@app.post('/api/data-management/files/{fid}/import-state')
def file_state(fid: str, body: FileState):
    return recycle.file_import_state(fid,body.enabled,body.fingerprint)


class BulkExcluded(BaseModel):
    ids: list[str] = Field(min_length=1,max_length=1000)
    excluded: bool


@app.post('/api/expenses/bulk-exclusion')
def bulk_exclusion(body: BulkExcluded):
    from .data_scope import visible_events
    from .domain import project
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        if recycle.busy(c):raise ValueError('任务正在执行，请结束后再批量修改')
        decisions={r[0]:json.loads(r[1]) for r in c.execute('SELECT event_id,payload FROM decisions')}
        rows={e['id']:e for e in project(visible_events(c),decisions)['expenses']}
        chosen=set(body.ids)
        if not chosen<=rows.keys():raise ValueError('所选账单不存在、已取消导入或已移入回收站，请刷新列表')
        changed=0
        for eid in chosen:
            old=decisions.get(eid,{})
            if bool(old.get('ignore'))==body.excluded:continue
            updated={**old,'ignore':body.excluded}
            c.execute('INSERT OR REPLACE INTO decisions VALUES (?,?)',(eid,storage.dumps(updated)))
            storage.record_operation(c,'edit','bulk_exclusion',rows[eid]['merchant']+(' · 批量排除' if body.excluded else ' · 批量取消排除'),eid,old,updated)
            changed+=1
        if changed:c.execute('UPDATE data_preferences SET revision=revision+1 WHERE id=1')
    return {'changed':changed,'selected':len(chosen)}


@app.get('/api/data-management')
def data_management():
    return recycle.overview()


class ClearImported(BaseModel):
    fingerprint: str = Field(pattern=r'^[a-f0-9]{64}$')


@app.post('/api/data-management/clear-imports')
def clear_imports(body: ClearImported):
    return recycle.clear_imports(body.fingerprint)


@app.get('/api/data-preferences')
def get_data_preferences():
    return storage.data_preferences()


class DataPreferences(BaseModel):
    retention_days: int = Field(ge=1,le=3650,strict=True)
    version: int = Field(ge=1)


@app.put('/api/data-preferences')
def put_data_preferences(body: DataPreferences):
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        old = c.execute('SELECT retention_days,version FROM data_preferences WHERE id=1').fetchone()
        if old['version'] != body.version:
            raise ValueError('回收站设置已被其他页面修改，请刷新后重试')
        if old['retention_days'] != body.retention_days:
            c.execute('UPDATE data_preferences SET retention_days=?,version=version+1 WHERE id=1',(body.retention_days,))
            storage.record_operation(c,'edit','retention','修改回收站保留天数',before={'retention_days':old['retention_days']},after={'retention_days':body.retention_days})
    return storage.data_preferences()


@app.get('/api/trash')
def trash():
    return recycle.batches()


@app.get('/api/trash-entries')
def trash_entries(kind: str = Query(default='bills',pattern='^(bills|files)$'), offset: int = Query(default=0,ge=0), limit: int = Query(default=20,ge=1,le=100)):
    return recycle.entries(kind,offset,limit)


@app.get('/api/trash/{bid}')
def trash_detail(bid: str, offset: int = Query(default=0,ge=0), limit: int = Query(default=50,ge=1,le=100)):
    return recycle.detail(bid,offset,limit)


@app.post('/api/trash/{bid}/restore')
def restore_trash(bid: str):
    return recycle.restore(bid)


class Decision(BaseModel):
    douyin_duplicate_exempt: bool | None = None
    refund_cash_amount: int | None = Field(None,ge=0,strict=True)
    refund_adjustment_reason: str | None = Field(None,max_length=1000)
    refund_original_order: str | None = Field(None,max_length=120)
    reset_refund_cash: bool | None = None

    confirmed: bool | None = None
    ignore: bool | None = None
    refund_to: str | None = None
    merge_into: str | None = None
    category: str | None = Field(None, max_length=80)
    note: str | None = Field(None, max_length=2000)
    distinct_remote: bool | None = None
    filter_exempt: bool | None = None


@app.patch('/api/events/{eid}')
def decide(eid: str, body: Decision):
    all_events = {e['id']: e for e in storage.events()}
    if eid not in all_events:
        raise ValueError('交易不存在')
    patch = body.model_dump(exclude_none=True)
    if any(k in patch for k in ('refund_cash_amount','refund_adjustment_reason','refund_original_order','reset_refund_cash')):
        event=all_events[eid]
        if event['kind']!='refund':raise ValueError('实际退款修正只适用于退款流水')
        if patch.get('reset_refund_cash') and 'refund_cash_amount' in patch:raise ValueError('恢复原始值与修改金额不能同时提交')
        if 'refund_cash_amount' in patch:patch['reset_refund_cash']=False
        current={**storage.decisions().get(eid,{}),**patch}
        cash=current.get('refund_cash_amount')
        if not current.get('reset_refund_cash') and cash is not None:
            if cash>event['amount']:raise ValueError('实际退款不能超过该笔流水金额，请核对是否需要补充独立退款')
            if not current.get('refund_adjustment_reason','').strip():raise ValueError('请填写修正依据，例如优惠扣回或实际到账明细')
        if 'refund_cash_amount' in patch:patch['reset_refund_cash']=False
        if 'refund_original_order' in patch:patch['refund_original_order']=patch['refund_original_order'].strip()

    if 'merge_into' in patch:
        target = patch['merge_into']
        if target:
            if target == eid or target not in all_events or all_events[target]['kind'] not in ('expense', 'reference'):
                raise ValueError('合并目标无效')
            cfg = storage.settings(True)
            with storage.db() as c:
                if c.execute('SELECT 1 FROM bindings WHERE ledger=? AND expense_id IN (?,?)', (cfg.get('ledger', ''), eid, target)).fetchone():
                    raise ValueError('已绑定飞书的交易暂不支持合并，请先核对远端记录；合并应在首次同步前完成')
                cached = [json.loads(r[0]) for r in c.execute('SELECT payload FROM remote_cache WHERE ledger=?', (cfg.get('ledger', ''),))]
            if any(r.get('sync_key') in (eid, target) for r in cached):
                raise ValueError('交易已在飞书记录，暂不能合并，以免留下重复远端支出')
            cursor = target
            for _ in range(len(all_events)):
                cursor = storage.decisions().get(cursor, {}).get('merge_into')
                if not cursor:
                    break
                if cursor == eid:
                    raise ValueError('不能循环合并')
    if patch.get('refund_to'):
        original = all_events.get(patch['refund_to'])
        if all_events[eid]['kind'] != 'refund' or not original or original['kind'] not in ('expense', 'reference'):
            raise ValueError('请选择有效的退款原单')
        if original['time'] > all_events[eid]['time']:
            raise ValueError('退款时间早于原交易')
    save_decision(eid, patch)
    return {'ok': True}


class Pair(BaseModel):
    a: str
    b: str


@app.post('/api/distinct')
def distinct(body: Pair):
    ids = {e['id'] for e in storage.events()}
    if body.a not in ids or body.b not in ids or body.a == body.b:
        raise ValueError('请选择当前账号的两条不同交易')
    a, b = sorted((body.a, body.b))
    save_decision(a, {'distinct_' + b: True})
    return {'ok': True}


class Bind(BaseModel):
    event_id: str
    record_id: str


@app.post('/api/bind')
def bind(body: Bind):
    cfg = storage.settings(True)
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        from .data_scope import visible_events
        if body.event_id not in {e['id'] for e in visible_events(c)}:
            raise ValueError('原消费不存在、已取消导入或已移入回收站')
        if not c.execute('SELECT 1 FROM events e WHERE e.id=? AND NOT EXISTS (SELECT 1 FROM deleted_events d WHERE d.event_id=e.id)',(body.event_id,)).fetchone():
            raise ValueError('原消费不存在或已移入回收站')
        row = c.execute('SELECT payload FROM remote_cache WHERE ledger=? AND id=?', (cfg.get('ledger'), body.record_id)).fetchone()
        if not row:
            raise ValueError('远端记录不存在，请先刷新账本')
        if c.execute('SELECT 1 FROM bindings WHERE ledger=? AND record_id=? AND expense_id<>?', (cfg['ledger'], body.record_id, body.event_id)).fetchone():
            raise ValueError('该飞书记录已绑定其他消费，不能重复绑定')
        record = json.loads(row[0])
        previous = c.execute('SELECT record_id FROM bindings WHERE ledger=? AND expense_id=?', (cfg['ledger'], body.event_id)).fetchone()
        c.execute('INSERT OR REPLACE INTO bindings VALUES (?,?,?,?)', (cfg['ledger'], body.event_id, body.record_id, storage.dumps(record['fields'])))
        storage.record_operation(c, 'edit', 'bind', '绑定飞书已有记录', body.event_id, before={'record_id':previous[0]} if previous else None, after={'record_id':body.record_id})
    return {'ok': True}


class Unbind(BaseModel):
    event_id: str


@app.post('/api/unbind')
def unbind(body: Unbind):
    cfg = storage.settings(True)
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        from .data_scope import visible_events
        if body.event_id not in {e['id'] for e in visible_events(c)}:
            raise ValueError('原消费不存在、已取消导入或已移入回收站')
        if not c.execute('SELECT 1 FROM events e WHERE e.id=? AND NOT EXISTS (SELECT 1 FROM deleted_events d WHERE d.event_id=e.id)',(body.event_id,)).fetchone():
            raise ValueError('原消费不存在或已移入回收站')
        row = c.execute('SELECT record_id FROM bindings WHERE ledger=? AND expense_id=?', (cfg.get('ledger', ''), body.event_id)).fetchone()
        if not row:
            raise ValueError('没有绑定记录')
        if c.execute('SELECT 1 FROM remote_cache WHERE ledger=? AND id=?', (cfg['ledger'], row[0])).fetchone():
            raise ValueError('飞书原记录仍存在，请核对后保留绑定，不能当作新消费重复写入')
        c.execute('DELETE FROM bindings WHERE ledger=? AND expense_id=?', (cfg['ledger'], body.event_id))
        storage.record_operation(c, 'edit', 'unbind', '解除已删除飞书记录的绑定', body.event_id, before={'record_id':row[0]})
    return {'ok': True}


@app.get('/api/ledger')
def get_ledger():
    return storage.settings()


class CustomRule(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=80)
    platform: str
    field: str
    operator: str
    keyword: str = Field(min_length=1, max_length=200)
    enabled: bool = True
    replacement: str = Field(default='', max_length=500)


class CustomRules(BaseModel):
    version: int = Field(ge=1)
    douyin_duplicate_filter: bool = False
    filter_rules: list[CustomRule] = Field(max_length=50)
    display_rules: list[CustomRule] = Field(max_length=50)


@app.get('/api/customization')
def get_customization():
    return storage.customization()


@app.put('/api/customization')
def put_customization(body: CustomRules):
    all_rules = body.filter_rules + body.display_rules
    if len({r.id for r in all_rules}) != len(all_rules):
        raise ValueError('规则标识重复，请刷新后重试')
    for rule in all_rules:
        if rule.platform not in ('全部', '微信', '支付宝', '京东', '美团', '抖音', '手动') or rule.field not in RULE_FIELDS or rule.operator not in ('contains', 'equals'):
            raise ValueError('规则的来源、字段或匹配方式无效')
        if not rule.keyword.strip() or not rule.name.strip():
            raise ValueError('规则名称与关键词不能为空')
    for rule in body.display_rules:
        if not rule.replacement.strip():
            raise ValueError('显示内容不能为空')
        validate_template(rule.replacement)
    payload = body.model_dump(exclude={'version'})
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        if c.execute("SELECT 1 FROM jobs WHERE state IN ('queued','running') AND payload LIKE '%\"kind\":\"sync\"%' LIMIT 1").fetchone():
            raise ValueError('同步任务正在执行，请完成后再修改规则')
        from .ai_assistant import assert_idle
        assert_idle(c)
        current = c.execute('SELECT payload,version FROM customization WHERE id=1').fetchone()
        if current['version'] != body.version:
            raise ValueError('规则已被其他页面修改，请刷新后重新编辑')
        c.execute('UPDATE customization SET payload=?,version=version+1 WHERE id=1', (storage.dumps(payload),))
        storage.record_operation(c, 'edit', 'rules', '更新账单自定义规则', before=json.loads(current['payload']), after=payload)
        previous = json.loads(current['payload'])
        if bool(previous.get('douyin_duplicate_filter')) != body.douyin_duplicate_filter:
            from .domain import project
            from .data_scope import visible_events
            events = visible_events(c)
            decisions = {r[0]:json.loads(r[1]) for r in c.execute('SELECT event_id,payload FROM decisions')}
            before = {r['id']:r for r in project(events, decisions, customization=previous)['expenses']}
            after = project(events, decisions, customization=payload)['expenses']
            for row in after:
                old = before[row['id']]
                if bool(old.get('automatic_exclusion')) != bool(row.get('automatic_exclusion')):
                    summary = ('自动排除重复月付流水' if row.get('automatic_exclusion') else '恢复重复月付流水')
                    storage.record_operation(c, 'edit', 'douyin_duplicate_rule', summary + ' · ' + row['time'], row['id'],
                        {'status':old['status'],'automatic_exclusion':old.get('automatic_exclusion')},
                        {'status':row['status'],'automatic_exclusion':row.get('automatic_exclusion'),
                         'original_order':row.get('douyin_duplicate',{}).get('original_order')})
    return storage.customization()


class Config(BaseModel):
    url: str = ''
    app_id: str = ''
    app_secret: str = ''
    auth_mode: str = 'app'
    user_token: str = ''
    negative_expense: bool = False
    mapping: dict[str, str] = Field(default_factory=dict)
    field_rules: list[FieldRule] | None = Field(default=None,max_length=100)
    version: int | None = None


@app.put('/api/ledger')
def put_ledger(body: Config):
    config = body.model_dump(exclude={'version'})
    parse_url(config['url'])
    if config['auth_mode'] not in ('app', 'user_token'):
        raise ValueError('不支持的授权方式')
    old = storage.settings(True)
    if body.version is not None and body.version!=old['version']:raise ValueError('设置已被其他页面修改，请刷新后重试')
    if old.get('url') and parse_url(old['url'])==parse_url(config['url']):
        config['fields']=old.get('fields',[])
    if config.get('field_rules') is not None:
        validate_structure(config['field_rules'])
        if config.get('fields'):validate_target_fields(config['fields'],config,False)
        config['mapping']=effective_mapping(config)
        label_rules(config)
    for key in ('app_secret', 'user_token'):
        config[key] = storage.encrypt(config[key]) if config[key] else old.get(key, '')
    # Saving any config invalidates the old connection and previews.
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        from .ai_assistant import assert_idle
        assert_idle(c)
        if c.execute("SELECT 1 FROM jobs WHERE state IN ('queued','running') AND payload LIKE '%\"kind\":\"sync\"%' LIMIT 1").fetchone():raise ValueError('同步任务正在执行，请完成后再修改账本设置')
        current=c.execute('SELECT version FROM settings WHERE id=1').fetchone()
        if body.version is not None and body.version!=(current[0] if current else 0):raise ValueError('设置已被其他页面修改，请刷新后重试')
        c.execute('INSERT INTO settings(id,payload,version) VALUES (1,?,1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,version=settings.version+1', (storage.dumps(config),))
        keys = ('url','mapping','field_rules','auth_mode','negative_expense')
        storage.record_operation(c, 'edit', 'settings', '更新飞书账本设置（凭证不记入操作记录）', before={k:old.get(k) for k in keys}, after={k:config[k] for k in keys})
    return storage.settings()


class MappingPreview(BaseModel):
    field_rules: list[FieldRule] = Field(max_length=100)
    ids: list[str] = Field(default_factory=list,max_length=10)
    negative_expense: bool = False


class MappingSave(BaseModel):
    field_rules: list[FieldRule] = Field(max_length=100)
    negative_expense: bool = False
    version: int


@app.put('/api/ledger/mapping')
def save_field_mapping(body: MappingSave):
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        from .ai_assistant import assert_idle
        assert_idle(c)
        row=c.execute('SELECT payload,version FROM settings WHERE id=1').fetchone()
        if not row:raise ValueError('请先保存账本连接配置')
        if row['version']!=body.version:raise ValueError('设置已被其他页面修改，请刷新后重试')
        if c.execute("SELECT 1 FROM jobs WHERE state IN ('queued','running') AND payload LIKE '%\"kind\":\"sync\"%' LIMIT 1").fetchone():raise ValueError('同步任务正在执行，请结束后再修改映射')
        config=json.loads(row['payload'])
        before={k:config.get(k) for k in ('mapping','field_rules','negative_expense')}
        config.update(field_rules=[r.model_dump() for r in body.field_rules],negative_expense=body.negative_expense)
        validate_target_fields(config.get('fields',[]),config,False)
        config['mapping']=effective_mapping(config)
        label_rules(config)
        c.execute('UPDATE settings SET payload=?,version=version+1 WHERE id=1',(storage.dumps(config),))
        storage.record_operation(c,'edit','field_mapping','更新飞书字段加工规则',before=before,after={k:config[k] for k in before})
    return storage.settings()


@app.post('/api/mapping/preview')
def mapping_preview(body: MappingPreview):
    config=storage.settings()
    config.update(field_rules=[r.model_dump() for r in body.field_rules],negative_expense=body.negative_expense)
    validate_target_fields(config.get('fields',[]),config,False)
    rows=[r for r in projection()['expenses'] if r['status'] not in ('filtered','excluded','refunded') and r['net'] > 0]
    if body.ids:rows=[r for r in rows if r['id'] in body.ids]
    rows=sorted(rows,key=lambda r:r['time'],reverse=True)[:5]
    return {'items':[{'id':r['id'],'merchant':r['merchant'],'description':r['description'],'time':r['time'],'display_rule':r.get('display_rule'),**evaluate_mapping(r,config)} for r in rows]}


@app.post('/api/ledger/check')
def check_ledger():
    config = storage.settings(True)
    connection, records = cache_remote(config)
    config.update(ledger=connection['ledger'], fields=connection['fields'], checked_at=datetime.now(timezone.utc).isoformat(), read_count=len(records))
    with storage.db() as c:
        c.execute('UPDATE settings SET payload=?,version=version+1 WHERE id=1', (storage.dumps(config),))
    return {'ok': True, 'read_count': len(records), 'fields': connection['fields'], 'message': '已验证节点、字段和全表读取；尚未验证写入权限'}


@app.get('/api/jobs')
def jobs():
    with storage.db() as c:
        rows = list(c.execute('SELECT * FROM jobs ORDER BY created DESC,id DESC LIMIT 50'))
    result = []
    for r in rows:
        p = json.loads(r['payload'])
        p.pop('config', None)
        for f in p.get('files', []):
            f.pop('path', None)
        result.append({'id': r['id'], 'state': r['state'], 'created': r['created'], **p})
    return result


class Selected(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=1000)


@app.post('/api/sync/preview')
def preview(body: Selected):
    config = storage.settings(True)
    connection, _ = cache_remote(config)
    config['fields']=connection['fields']
    # Refresh discovered columns, including a sync-key column added since the last check.
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        stored=c.execute('SELECT payload,version FROM settings WHERE id=1').fetchone()
        if stored and json.loads(stored['payload']).get('fields')!=connection['fields']:
            if stored['version']!=config['version']:raise ValueError('连接配置已变化，请重新预览')
            saved=json.loads(stored['payload']);saved['fields']=connection['fields']
            c.execute('UPDATE settings SET payload=?,version=version+1 WHERE id=1',(storage.dumps(saved),))
            config['version']+=1
    setup_warnings=[]
    try:validate_mapping(connection['fields'], config)
    except ValueError as e:setup_warnings.append(str(e))
    if config.get('ledger') != connection['ledger']:
        raise ValueError('请先完成账本连接检测')
    rules_version = storage.customization()['version']
    event_digest = projection_fingerprint()
    projected=projection(config_override=config) if config.get('field_rules') is not None else projection()
    rows = {r['id']: r for r in projected['expenses']}
    items, skipped = [], []
    for eid in dict.fromkeys(body.ids):
        row = rows.get(eid)
        if not row or row['status'] not in ('new', 'update'):
            skipped.append({'id': eid, 'reason': '已记录、已全退、已过滤或尚未确认，本次不写入'})
            continue
        fields = write_fields(row, config)
        items.append({'expense_id': eid, 'description': fields.get(effective_mapping(config).get('description')) or row.get('sync_description', row['description'] or row['merchant']), 'action': 'update' if row['record_id'] else 'create',
                      'amount': round(abs(float(fields.get(effective_mapping(config).get('amount'),row['net']/100)))*100), 'before_amount': row.get('remote_amount'), 'fields': fields, 'net':row['net'], 'merchant':row['merchant'], 'original_description':row['description'], 'warnings':row.get('mapping_warnings',[]),
                      'before': row.get('remote_snapshot'), 'record_id': row['record_id'], 'state': 'queued'})
    if event_digest != projection_fingerprint() or rules_version != storage.customization()['version']:
        raise ValueError('账单或自定义规则在预览期间变化，请重新预览')
    pid = str(uuid.uuid4())
    payload = {'kind': 'preview', 'config': config, 'items': items, 'skipped': skipped, 'expires': time.time() + 300,
               'setup_warnings':setup_warnings,'event_digest': event_digest, 'rules_version': rules_version, 'data_revision':storage.data_preferences()['revision']}
    with storage.db() as c:
        c.execute("INSERT INTO jobs(id,state,payload) VALUES (?,'preview',?)", (pid, storage.dumps(payload)))
    return sync_preview_response(pid,payload)


def sync_preview_response(pid,payload):
    return {'id':pid,'revision':payload.get('revision',0),'items':payload['items'],'skipped':payload['skipped'],
            'fields':payload['config'].get('fields',[]),'setup_warnings':payload.get('setup_warnings',[]),'sync_key_field':effective_mapping(payload['config']).get('sync_key')}

def editable_preview(pid):
    with storage.db() as c:row=c.execute("SELECT payload FROM jobs WHERE id=? AND state='preview'",(pid,)).fetchone()
    if not row:raise ValueError('预览已提交或不存在，请重新预览')
    payload=json.loads(row[0])
    if payload['expires']<time.time() or payload['config']['version']!=storage.settings()['version'] or payload['event_digest']!=projection_fingerprint() or payload['rules_version']!=storage.customization()['version']:
        raise ValueError('预览已过期或账单配置有变化，请重新预览')
    return payload

class PreviewEdit(BaseModel):
    values: dict[str, str | float | bool | list[str] | None] = Field(max_length=100)
    revision: int = 0

@app.patch('/api/sync/preview/{pid}/items/{eid}')
def edit_sync_preview(pid:str,eid:str,body:PreviewEdit):
    from .field_mapping import convert, SUPPORTED
    payload=editable_preview(pid)
    if body.revision!=payload.get('revision',0):raise ValueError('预览已被修改，请核对最新内容')
    item=next((i for i in payload['items'] if i['expense_id']==eid),None)
    if not item:raise ValueError('该账单不在本次预览中')
    schema={f['field_name']:f for f in payload['config'].get('fields',[])}
    mapping=effective_mapping(payload['config'])
    for name,value in body.values.items():
        field=schema.get(name)
        if not field or field['type'] not in SUPPORTED or field.get('is_readonly') or name==mapping.get('sync_key'):raise ValueError('此字段不可编辑')
        if isinstance(value,str) and len(value)>10000:raise ValueError('字段内容过长')
        converted=convert(value,field)
        if converted is None:
            if name in (mapping.get('date'),mapping.get('amount'),mapping.get('description')):raise ValueError('日期、金额和消费项目不能为空')
            # An explicit blank is retained as an intentional clear, not confused with an absent mapping.
            converted=[] if field['type']==4 else None if field['type'] in (2,5,7) else ''
        if name==mapping.get('amount') and converted is not None:
            if Decimal(str(converted))*100 != (Decimal(str(converted))*100).to_integral_value():raise ValueError('金额最多保留两位小数')
            if (converted<0) != bool(payload['config'].get('negative_expense')) and converted!=0:raise ValueError('金额正负号应与账本支出设置一致')
        item['fields'][name]=converted
        item.setdefault('manual_fields',{})[name]=converted
        payload['config']['_extra_managed_fields']=list(dict.fromkeys([*payload['config'].get('_extra_managed_fields',[]),name]))
    item['description']=item['fields'].get(mapping.get('description'),item['description'])
    item['amount']=round(abs(float(item['fields'].get(mapping.get('amount'),item['amount']/100)))*100)
    payload['revision']=payload.get('revision',0)+1
    payload['expires']=time.time()+300
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        current=c.execute("SELECT payload FROM jobs WHERE id=? AND state='preview'",(pid,)).fetchone()
        if not current or json.loads(current[0]).get('revision',0)!=body.revision:raise ValueError('预览已变化，请重新核对')
        c.execute('UPDATE jobs SET payload=? WHERE id=?',(storage.dumps(payload),pid))
    return sync_preview_response(pid,payload)

class QuickRule(BaseModel):
    field_id: str = Field(max_length=120)
    source: str = Field(pattern='^(merchant|description|platform)$')
    keyword: str = Field(min_length=1,max_length=300)
    value: str = Field(max_length=1000)
    revision: int = 0

@app.post('/api/sync/preview/{pid}/rules')
def quick_sync_rule(pid:str,body:QuickRule):
    from .field_mapping import FieldRule, convert
    payload=editable_preview(pid)
    if payload.get('revision',0)!=body.revision:raise ValueError('预览已变化，请重新核对')
    config=storage.settings()
    field=next((f for f in payload['config']['fields'] if f['field_id']==body.field_id),None)
    if field and field['field_name']==effective_mapping(payload['config']).get('sync_key'):raise ValueError('同步键由工具维护')
    if not field or field['type'] not in (1,3,4):raise ValueError('简单规则支持消费项目和选项字段')
    if not body.keyword.strip():raise ValueError('请输入匹配关键词')
    if not body.value.strip():raise ValueError('请输入希望自动填写的内容')
    convert(body.value,field)
    rules=config.get('field_rules')
    if rules is None:
        rules=[]
        mapping=effective_mapping({**config,'fields':payload['config']['fields']})
        sources={'date':'time','amount':'net','description':'sync_description','sync_key':'id','category':'category','source':'platform','note':'note','order_id':'order_id','original':'amount','refund':'refund'}
        for role,name in mapping.items():
            f=next((f for f in payload['config']['fields'] if f['field_name']==name),None)
            if f and role in sources:rules.append(FieldRule(field_id=f['field_id'],role=role,sources=[sources[role]]).model_dump())
    rules=[dict(r) for r in rules]
    rule=next((r for r in rules if r['field_id']==body.field_id),None)
    if rule is None:
        rule=FieldRule(field_id=body.field_id,sources=['description','merchant'] if field['type']==1 else []).model_dump();rules.append(rule)
    if rule.get('role') in ('date','amount','sync_key'):raise ValueError('此用途不支持匹配替换')
    if len(rule.get('rules',[]))>=50:raise ValueError('此字段已达到 50 条规则，请在设置中整理')
    if rule['mode']!='rules':rule['fallback']='fixed' if rule['mode']=='fixed' else 'source' if rule.get('sources') else 'empty'
    rule['mode']='rules';rule['required']=False
    rule['rules']=[{'name':body.keyword.strip(),'match':'all','conditions':[{'source':body.source,'operator':'contains','value':body.keyword.strip()}],'value':body.value},*rule.get('rules',[])]
    saved=save_field_mapping(MappingSave(field_rules=rules,negative_expense=config.get('negative_expense',False),version=config['version']))
    config=storage.settings(True)
    config['fields']=payload['config']['fields']
    rows={r['id']:r for r in projection(config_override=config)['expenses']}
    for item in payload['items']:
        row=rows.get(item['expense_id'])
        if row:
            item['fields']={**write_fields(row,config),**item.get('manual_fields',{})}
            item['warnings']=row.get('mapping_warnings',[])
            item['description']=item['fields'].get(effective_mapping(config).get('description'),item['description'])
    payload['config']=config;payload['revision']=payload.get('revision',0)+1;payload['expires']=time.time()+300
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        if not c.execute("SELECT 1 FROM jobs WHERE id=? AND state='preview'",(pid,)).fetchone():raise ValueError('预览已提交，请重新预览')
        c.execute('UPDATE jobs SET payload=? WHERE id=?',(storage.dumps(payload),pid))
    return sync_preview_response(pid,payload)


class Submit(BaseModel):
    preview_id: str
    revision: int | None = None


@app.post('/api/sync/jobs')
def submit(body: Submit):
    digest = projection_fingerprint()
    cfg = storage.settings(True)
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        from .ai_assistant import assert_idle
        assert_idle(c)
        row = c.execute("SELECT payload FROM jobs WHERE id=? AND state='preview'", (body.preview_id,)).fetchone()
        if not row:
            raise ValueError('预览已提交或不存在，请重新预览')
        payload = json.loads(row[0])
        if body.revision is not None and body.revision != payload.get('revision',0):raise ValueError('预览已被修改，请核对最新内容')
        revision = c.execute('SELECT revision FROM data_preferences WHERE id=1').fetchone()[0]
        if payload.get('data_revision',0) != revision:
            raise ValueError('账单数据已被清除或恢复，请重新生成同步预览')
        rules_version = c.execute('SELECT version FROM customization WHERE id=1').fetchone()[0]
        if payload.get('rules_version') != rules_version:
            raise ValueError('账单自定义规则已变化，请重新生成同步预览')
        if payload['expires'] < time.time() or payload['config']['version'] != cfg['version'] or digest != payload['event_digest']:
            raise ValueError('账单或配置已变化，请重新预览')
        validate_mapping(payload['config'].get('fields',[]),payload['config'])
        if not payload['items']:
            raise ValueError('没有可同步的已确认记录')
        if c.execute("SELECT 1 FROM jobs WHERE state IN ('queued','running') AND payload LIKE '%\"kind\":\"sync\"%' LIMIT 1").fetchone():
            raise ValueError('已有同步任务正在执行，请等完成后重新预览')
        payload['kind'] = 'sync'
        c.execute("UPDATE jobs SET state='queued',payload=? WHERE id=?", (storage.dumps(payload), body.preview_id))
    return {'id': body.preview_id}


@app.post('/api/jobs/{jid}/check')
def check_sync(jid: str):
    from .sync_check import check_job
    return check_job(jid)


@app.post('/api/jobs/{jid}/confirm-check')
def confirm_sync_check(jid: str):
    from .sync_check import check_job
    return check_job(jid,apply=True)


class RetryItems(BaseModel):
    ids: list[str] = Field(min_length=1,max_length=1000)


@app.post('/api/jobs/{jid}/retry')
def retry(jid: str, body: RetryItems | None = None):
    if body is not None:
        from .sync_check import check_job
        checked=check_job(jid)
        retryable={i['expense_id'] for i in checked['items'] if i['retryable']}
        if any(eid not in retryable for eid in body.ids):
            raise ValueError('所选记录已成功或存在远端差异，请重新核对，不会重复写入')
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        from .ai_assistant import assert_idle
        assert_idle(c)
        row = c.execute('SELECT * FROM jobs WHERE id=?', (jid,)).fetchone()
        if not row or row['state'] != 'partial':
            raise ValueError('只有已结束的部分失败任务可以重试')
        payload = json.loads(row['payload'])
        revision = c.execute('SELECT revision FROM data_preferences WHERE id=1').fetchone()[0]
        if payload.get('data_revision',0) != revision:
            raise ValueError('账单数据已被清除或恢复，请重新生成同步预览')
        if payload['kind'] != 'sync':
            raise ValueError('导入失败请重新上传对应文件')
        cfg = storage.settings(True)
        if payload.get('rules_version') is not None and payload['rules_version'] != storage.customization()['version']:
            raise ValueError('账单自定义规则已变化，请重新生成同步预览')
        if cfg.get('ledger') != payload['config'].get('ledger') or cfg.get('mapping') != payload['config'].get('mapping') or cfg.get('field_rules') != payload['config'].get('field_rules'):
            raise ValueError('账本或映射已变化，请重新预览')
        payload['config'] = cfg
        payload['items'] = [i for i in payload['items'] if i.get('state') != 'success']
        if body is not None:
            payload['items'] = [i for i in payload['items'] if i['expense_id'] in set(body.ids)]
        if not payload['items']:
            raise ValueError('没有需要重试的记录')
        payload.pop('error', None)
        if c.execute("SELECT 1 FROM jobs WHERE state IN ('queued','running') AND payload LIKE '%\"kind\":\"sync\"%' LIMIT 1").fetchone():
            raise ValueError('已有同步任务正在执行')
        payload['retried_from'] = jid
        new_id = str(uuid.uuid4())
        c.execute("INSERT INTO jobs(id,state,payload) VALUES (?,'queued',?)", (new_id, storage.dumps(payload)))
    return {'id': new_id}


@app.get('/api/export')
def export():
    buf = io.StringIO(newline='')
    writer = csv.writer(buf)
    writer.writerow(['日期', '商户', '描述', '来源', '原付', '已退', '净支出', '分类', '状态', '同步键'])
    for r in projection()['expenses']:
        cells = [r['time'], r['merchant'], r.get('sync_description', r['description']), '/'.join(r['platforms']), f'{r["amount"]/100:.2f}', f'{r["refund"]/100:.2f}', f'{r["net"]/100:.2f}', r['category'], r['status'], r['id']]
        writer.writerow(["'" + str(v) if str(v).startswith(('=', '+', '-', '@', '\t', '\r')) else v for v in cells])
    return Response(('\ufeff' + buf.getvalue()).encode('utf-8'), media_type='text/csv', headers={'Content-Disposition': 'attachment; filename="expenses.csv"'})


# Screenshot previews contain recognized text only; original images remain temporary.
class ScreenshotSelection(BaseModel):
    image_id: str
    card_id: str
    event_id: str
    merchant: str = Field(default='', max_length=300)
    description: str = Field(default='', max_length=500)
    paid_amount: int | None = Field(default=None, ge=0, le=1000000000)
    allow_amount_mismatch: bool = False

class ScreenshotApply(BaseModel):
    selections: list[ScreenshotSelection] = Field(min_length=1, max_length=100)

def screenshot_orders():
    orders = []
    for row in projection()['expenses']:
        if row.get('automatic_exclusion'):
            continue
        members = [m for m in row['members'] if m.get('platform') == '抖音' and m.get('kind') in ('expense', 'reference')]
        if members:
            member = next((m for m in members if m['id'] == row['id']), members[0])
            orders.append({'id': member['id'], 'row_id': row['id'], 'time': member.get('time',''), 'amount': member['amount'], 'order_id': member.get('order_id',''), 'merchant': row.get('merchant',''), 'description': row.get('description',''), 'status': row['status'], 'existing': bool(row.get('douyin_order_info'))})
    return sorted(orders, key=lambda o:o['time'], reverse=True)

@app.post('/api/douyin-screenshots/preview')
async def screenshot_preview(files: list[UploadFile] = File(...)):
    from .douyin_screenshots import recognize, MAX_BYTES
    if not 1 <= len(files) <= 10: raise ValueError('每次请选择 1–10 张截图')
    fingerprint=projection_fingerprint()
    images=[]
    total=0
    for i, file in enumerate(files):
        raw=await file.read(MAX_BYTES+1)
        total+=len(raw)
        if len(raw)>MAX_BYTES or total>50*1024*1024: raise ValueError('单张截图不得超过 20 MB，每批不得超过 50 MB')
        result=await run_in_threadpool(recognize,raw)
        result.update(id=str(i), filename=Path((file.filename or '截图').replace('\\','/')).name[:200], digest=hashlib.sha256(raw).hexdigest())
        images.append(result)
    if fingerprint != projection_fingerprint(): raise ValueError('账单数据已变化，请重新识别截图')
    preview_id=secrets.token_urlsafe(24)
    with storage.db() as c:
        c.execute('CREATE TABLE IF NOT EXISTS screenshot_previews(id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires REAL NOT NULL)')
        c.execute('DELETE FROM screenshot_previews WHERE expires<?',(time.time(),))
        c.execute('INSERT INTO screenshot_previews VALUES (?,?,?)',(preview_id,storage.dumps({'images':images,'fingerprint':fingerprint}),time.time()+3600))
    return {'preview_id':preview_id,'images':images,'orders':screenshot_orders()}

@app.post('/api/douyin-screenshots/{preview_id}/apply')
def screenshot_apply(preview_id: str, body: ScreenshotApply):
    from .data_scope import visible_events
    if len({s.event_id for s in body.selections}) != len(body.selections): raise ValueError('同一笔账单不能重复补充，请检查选择')
    if len({(s.image_id,s.card_id) for s in body.selections}) != len(body.selections): raise ValueError('同一截图订单不能重复选择')
    eligible = {o['id']:o for o in screenshot_orders()}
    if any(s.event_id not in eligible for s in body.selections):
        raise ValueError('所选账单已自动排除或不在候选列表，请重新识别并选择')
    if len({eligible[s.event_id]['row_id'] for s in body.selections}) != len(body.selections):
        raise ValueError('合并后的同一笔账单不能重复补充')
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        c.execute('CREATE TABLE IF NOT EXISTS screenshot_previews(id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires REAL NOT NULL)')
        record=c.execute('SELECT payload,expires FROM screenshot_previews WHERE id=?',(preview_id,)).fetchone()
        if not record or record['expires']<time.time(): raise ValueError('截图预览已过期，请重新识别')
        preview=json.loads(record['payload'])
        if preview['fingerprint'] != projection_fingerprint(): raise ValueError('账单数据已变化，请重新识别并核对')
        valid={(im['id'],card['id']): (im,card) for im in preview['images'] for card in im['cards']}
        events={e['id']:e for e in visible_events(c)}
        for item in body.selections:
            pair=valid.get((item.image_id,item.card_id)); event=events.get(item.event_id)
            if not pair or not event or event.get('platform')!='抖音' or event.get('kind') not in ('expense','reference'): raise ValueError('截图或账单已不可用，请重新识别')
            if not item.merchant.strip() and not item.description.strip(): raise ValueError('请填写商户或商品名称')
            if item.paid_amount != event['amount'] and not item.allow_amount_mismatch: raise ValueError('截图金额与账单金额不同，请确认后再补充')
            im,card=pair
            existing=c.execute('SELECT payload FROM decisions WHERE event_id=?',(item.event_id,)).fetchone()
            old=json.loads(existing[0]) if existing else {}
            info={'merchant':item.merchant.strip(),'description':item.description.strip(),'image_digest':im['digest'],'image_name':im['filename'],'position':int(item.card_id)+1,'paid_amount':item.paid_amount}
            updated={**old,'douyin_order_info':info}
            c.execute('INSERT OR REPLACE INTO decisions VALUES (?,?)',(item.event_id,storage.dumps(updated)))
            storage.record_operation(c,'edit','douyin_screenshot','截图补充 · '+(info['merchant'] or info['description']),item.event_id,old,updated)
        c.execute('DELETE FROM screenshot_previews WHERE id=?',(preview_id,))
    return {'updated':len(body.selections)}

@app.delete('/api/douyin-screenshots/enrichment/{event_id}')
def delete_screenshot_enrichment(event_id: str):
    from .data_scope import visible_events
    with storage.db() as c:
        c.execute('BEGIN IMMEDIATE')
        if event_id not in {e['id'] for e in visible_events(c)}: raise ValueError('账单不存在或已不可见')
        found=c.execute('SELECT payload FROM decisions WHERE event_id=?',(event_id,)).fetchone()
        old=json.loads(found[0]) if found else {}
        if not old.get('douyin_order_info'): raise ValueError('该账单没有截图补充信息')
        updated={**old}; updated.pop('douyin_order_info')
        c.execute('INSERT OR REPLACE INTO decisions VALUES (?,?)',(event_id,storage.dumps(updated)))
        storage.record_operation(c,'edit','douyin_screenshot_remove','移除截图补充信息',event_id,old,updated)
    return {'ok':True}


from .ai_assistant import router as ai_router
app.include_router(ai_router)
