import re
import time
import math
from decimal import Decimal, InvalidOperation
from datetime import datetime
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

import httpx

from .db import decrypt

BASE = 'https://open.feishu.cn/open-apis'


class FeishuError(Exception):
    def __init__(self, message, code=None, log_id=None, uncertain=False):
        self.message, self.code, self.log_id, self.uncertain = message, code, log_id, uncertain
        super().__init__(message)


def parse_url(url):
    u = urlparse(url)
    host = u.hostname or ''
    if u.scheme != 'https' or not host.endswith('.feishu.cn') or u.username or u.password:
        raise ValueError('请输入 https://xxx.feishu.cn/wiki/… 或 /base/… 的账本链接')
    match = re.fullmatch(r'/(wiki|base)/([A-Za-z0-9]+)', u.path.rstrip('/'))
    if not match:
        raise ValueError('链接路径必须为 /wiki/节点 或 /base/多维表格')
    table = parse_qs(u.query).get('table', [''])[0]
    if not re.fullmatch(r'tbl[A-Za-z0-9]+', table):
        raise ValueError('账本链接需包含 table=tbl… 参数')
    return {'kind': match[1], 'token': match[2], 'table_id': table, 'view_id': parse_qs(u.query).get('view', [''])[0]}


class Feishu:
    def __init__(self, config):
        self.config = config
        self.client = httpx.Client(timeout=30, follow_redirects=False)
        self.token = ''

    def close(self):
        self.client.close()

    def request(self, method, path, **kwargs):
        headers = {'Authorization': 'Bearer ' + self.token} if self.token else {}
        for attempt in range(3):
            try:
                response = self.client.request(method, BASE + path, headers=headers, **kwargs)
                if response.status_code == 429:
                    if attempt == 2:
                        raise FeishuError('飞书请求限流，请稍后重新核对')
                    time.sleep(min(5, float(response.headers.get('Retry-After', 1 + attempt))))
                    continue
                if response.status_code >= 500:
                    raise FeishuError('飞书服务暂时不可用，请先核对远端结果', uncertain=method != 'GET')
                body = response.json()
            except (httpx.HTTPError, ValueError):
                raise FeishuError('飞书请求失败；写入操作需先核对远端结果再重试', uncertain=method != 'GET') from None
            if response.is_error or body.get('code', 0):
                code = body.get('code')
                hint = '请检查接口权限、应用发布状态和目标文档授权'
                if code == 99991672:
                    hint = '缺少 API 权限，请按飞书返回的 scope 申请权限并发布应用'
                    violations = (body.get('error') or {}).get('permissionviolations') or []
                    scopes = [v.get('subject', '') for v in violations if re.fullmatch(r'[a-z_]+(?::[a-z_]+)+', v.get('subject', ''))]
                    # Feishu also returns required scopes only inside `msg`,
                    # without permissionviolations (notably Wiki get_node).
                    scopes += re.findall(r'\b[a-z][a-z0-9_]*(?::[a-z][a-z0-9_.]*)+\b', str(body.get('msg', '')))
                    if scopes:
                        hint = '缺少 API 权限，请开通以下任一应用身份权限并发布应用：' + ' / '.join(dict.fromkeys(scopes))
                    if path == '/wiki/v2/spaces/get_node':
                        hint = '读取 Wiki 节点失败。' + hint
                elif code in (91403, 1254302):
                    hint = '请在目标多维表格添加文档应用并授予编辑权限'
                elif code in (131005, 131006):
                    hint = 'Wiki 节点不可访问，请核对链接及知识库节点权限'
                raise FeishuError(hint, code, response.headers.get('x-tt-logid'))
            return body.get('data', body)
        raise FeishuError('请求未完成')

    def connect(self):
        if self.config.get('auth_mode') == 'user_token':
            self.token = decrypt(self.config.get('user_token', ''))
            if not self.token:
                raise FeishuError('尚未配置用户访问令牌；此方式仅用于接入诊断，令牌过期后需重新配置')
        else:
            if not self.config.get('app_id') or not self.config.get('app_secret'):
                raise FeishuError('请先配置个人账号创建的应用 App ID 与 App Secret')
            result = self.request('POST', '/auth/v3/tenant_access_token/internal', json={'app_id': self.config['app_id'], 'app_secret': decrypt(self.config['app_secret'])})
            self.token = result['tenant_access_token']
        parsed = parse_url(self.config.get('url', ''))
        app_token = parsed['token']
        if parsed['kind'] == 'wiki':
            node = self.request('GET', '/wiki/v2/spaces/get_node', params={'token': app_token})['node']
            if node['obj_type'] != 'bitable':
                raise FeishuError('Wiki 节点不是多维表格')
            app_token = node['obj_token']
        self.app_token, self.table_id = app_token, parsed['table_id']
        self.prefix = f'/bitable/v1/apps/{app_token}/tables/{self.table_id}'
        self.ledger = f'{app_token}:{self.table_id}'
        fields = self.pages('GET', self.prefix + '/fields', params={'page_size': 100})
        return {'ledger': self.ledger, 'fields': fields, **parsed, 'app_token': app_token}

    def pages(self, method, path, **kwargs):
        items, token = [], None
        for _ in range(2000):
            params = dict(kwargs.get('params', {}))
            if token:
                params['page_token'] = token
            result = self.request(method, path, **{**kwargs, 'params': params})
            items.extend(result.get('items') or [])
            if not result.get('has_more'):
                return items
            next_token = result.get('page_token')
            if not next_token or next_token == token:
                raise FeishuError('飞书分页结果异常，未完成全表核对')
            token = next_token
        raise FeishuError('记录数量过大，未完成全表核对')

    def records(self):
        # Intentionally no view_id: deduplicate against the whole table.
        return self.pages('GET', self.prefix + '/records', params={'page_size': 500})

    def create(self, fields):
        return self.request('POST', self.prefix + '/records', json={'fields': fields})['record']

    def update(self, record_id, fields):
        return self.request('PUT', self.prefix + '/records/' + record_id, json={'fields': fields})['record']


def text_value(value):
    if isinstance(value, list):
        return ''.join(str(v.get('text', '')) if isinstance(v, dict) else str(v) for v in value)
    return '' if value is None else str(value)


def normalize_fields(fields, config):
    """Canonical values by schema, so API read/write representations compare.

    In particular the records API may return numeric columns as strings. Text
    identifiers must stay text; never infer their type from their contents.
    """
    from .field_mapping import effective_mapping
    mapping = effective_mapping(config)
    types = {f['field_name']: f['type'] for f in config.get('fields', [])}
    for role, kind in {'date':5,'amount':2,'original':2,'refund':2,'description':1,
                       'sync_key':1,'order_id':1,'note':1}.items():
        if mapping.get(role): types.setdefault(mapping[role], kind)
    result = {}
    for name, value in fields.items():
        kind = types.get(name)
        if kind == 1:
            value = text_value(value)
        elif kind in (2, 5) and value is not None and not isinstance(value, bool):
            if value == '':
                value = None
            elif isinstance(value, (str, int, float, Decimal)):
                try:
                    number = Decimal(str(value))
                    if number.is_finite() and math.isfinite(float(number)):
                        if number == number.to_integral_value(): value = int(number)
                        elif kind == 2: value = float(number)
                except (InvalidOperation, ValueError, OverflowError):
                    pass
        elif kind == 4:
            if value is None or value == '': value = []
            elif isinstance(value, list) and all(isinstance(v, str) for v in value): value = sorted(set(value))
        elif kind == 7 and value is None:
            value = False
        result[name] = value
    return result


def field_differences(actual, expected, config):
    actual, expected = normalize_fields(actual, config), normalize_fields(expected, config)
    differences = []
    for name, value in expected.items():
        returned = actual[name] if name in actual else normalize_fields({name:None},config)[name]
        same = returned == value or (returned is None and value in ('', None))
        if isinstance(returned, bool) != isinstance(value, bool): same = False
        if not same: differences.append({'field':name, 'expected':value, 'actual':returned})
    return differences


def normalize_remote(records, config):
    from .field_mapping import effective_mapping, managed_names
    mapping = effective_mapping(config)
    rows = []
    sign = -1 if config.get('negative_expense') else 1
    for record in records:
        fields = normalize_fields(record.get('fields', {}), config)
        val = fields.get(mapping.get('amount'))
        amount = round(float(val) * 100 * sign) if isinstance(val, (float, int)) else None
        day = fields.get(mapping.get('date'))
        date = datetime.fromtimestamp(day / 1000, ZoneInfo('Asia/Hong_Kong')).isoformat() if isinstance(day, (float, int)) else ''
        managed = {v: fields.get(v) for v in managed_names(config) if v}
        rows.append({'id': record['record_id'], 'fields': managed, 'amount': amount, 'date': date,
                     'description': text_value(fields.get(mapping.get('description'))),
                     'sync_key': text_value(fields.get(mapping.get('sync_key'))),
                     'order_id': text_value(fields.get(mapping.get('order_id')))})
    return rows


def write_fields(expense, config):
    from .field_mapping import effective_mapping, evaluate, convert
    m=effective_mapping(config)
    values={'date':int(datetime.fromisoformat(expense['time']).replace(tzinfo=ZoneInfo('Asia/Hong_Kong')).timestamp()*1000),
            'amount':expense['net']/100*(-1 if config.get('negative_expense') else 1),
            'description':expense.get('sync_description') or expense.get('description') or expense.get('merchant') or '未命名消费',
            'sync_key':expense['id'],'order_id':expense.get('order_id',''),'original':expense['amount']/100,
            'refund':expense['refund']/100,'note':expense.get('note',''),'category':expense.get('category',''),
            'source':' / '.join(expense.get('platforms',[]))}
    fields={}
    schema={f['field_name']:f for f in config.get('fields',[])}
    for role,value in values.items():
        name=m.get(role)
        if not name:continue
        try:
            converted=convert(value,schema[name]) if name in schema and role not in ('date','amount') else value
            if converted is not None:fields[name]=converted
        except ValueError:pass
    if config.get('field_rules') is not None:
        try:fields.update(evaluate(expense,config)['fields'])
        except ValueError:pass
    # Identity is internal; preview edits may change business values, never the deduplication key.
    if m.get('sync_key'):fields[m['sync_key']]=expense['id']
    fields.update(expense.get('sync_overrides') or {})
    return fields


def validate_mapping(fields, config):
    if config.get('field_rules') is not None:
        from .field_mapping import effective_mapping
        mapping=effective_mapping({**config,'fields':fields})
    else:
        from .field_mapping import effective_mapping
        mapping=effective_mapping({**config,'fields':fields})
    by_name = {f['field_name']: f for f in fields}
    expected = {'date': (5,), 'amount': (2,), 'description': (1,), 'sync_key': (1,), 'order_id': (1,), 'original': (2,), 'refund': (2,), 'note': (1,), 'category': (1,3,4), 'source': (1,3,4)}
    for key in ('date', 'amount', 'description', 'sync_key'):
        if not mapping.get(key):
            raise ValueError('未识别到日期、金额、消费项目或同步键，请核对飞书列名与字段类型；无需先配置匹配规则')
    selected = [v for v in mapping.values() if v]
    if len(set(selected)) != len(selected):
        raise ValueError('多个逻辑字段不能写入同一个飞书字段')
    for key, name in mapping.items():
        if not name:
            continue
        if name not in by_name or by_name[name].get('is_readonly') or by_name[name].get('type') not in expected.get(key, ()):
            raise ValueError(f'字段「{name}」的类型不适合当前映射，请重新选择')
