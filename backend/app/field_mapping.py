"""Deterministic, field-first mapping. No executable expressions or remote writes."""
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Literal
from zoneinfo import ZoneInfo
from pydantic import BaseModel, Field

SOURCES = {'merchant','description','sync_description','category','platform','method','account','transaction_type',
           'time','net','amount','refund','id','order_id','note'}
ROLES = {'date','amount','description','sync_key','order_id','original','refund','category','source','note'}
CORE = {'date':(5,), 'amount':(2,), 'description':(1,), 'sync_key':(1,)}
LOCKED = {'date':'time','amount':'net','sync_key':'id'}
SUPPORTED = {1,2,3,4,5,7}

class Condition(BaseModel):
    source: str = Field(max_length=120)
    operator: Literal['contains','equals','not_contains','starts_with','ends_with','empty'] = 'contains'
    value: str = Field(default='',max_length=300)

class Replacement(BaseModel):
    find: str = Field(min_length=1,max_length=200)
    replace: str = Field(default='',max_length=500)

class BranchResult(BaseModel):
    mode: Literal['source','join'] = 'source'
    sources: list[str] = Field(min_length=1,max_length=12)
    separator: str = Field(default=' · ',max_length=30)
    trim: bool = True
    replacements: list[Replacement] = Field(default_factory=list,max_length=20)
    prefix: str = Field(default='',max_length=500)
    suffix: str = Field(default='',max_length=500)

class Branch(BaseModel):
    name: str = Field(default='',max_length=100)
    match: Literal['all','any'] = 'all'
    conditions: list[Condition] = Field(min_length=1,max_length=10)
    value: str = Field(default='',max_length=1000)
    result: BranchResult | None = None

class FieldRule(BaseModel):
    field_id: str = Field(min_length=1,max_length=120)
    field_name: str = Field(default='',max_length=200)
    role: str = Field(default='',max_length=30)
    mode: Literal['source','join','fixed','rules'] = 'source'
    sources: list[str] = Field(default_factory=list,max_length=12)
    separator: str = Field(default=' · ',max_length=30)
    value: str = Field(default='',max_length=1000)
    rules: list[Branch] = Field(default_factory=list,max_length=50)
    fallback: Literal['source','fixed','empty'] = 'empty'
    trim: bool = True
    replacements: list[Replacement] = Field(default_factory=list,max_length=20)
    required: bool = False
    date_precision: Literal['original','day','month'] = 'original'
    date_format: Literal['','YYYY-MM-DD','YYYY/MM/DD','YYYY年MM月DD日','YYYY-MM','YYYYMMDD','YYYY-MM-DD HH:mm:ss'] = ''

def validate_structure(rules):
    ids=[r['field_id'] for r in rules]
    if len(ids)!=len(set(ids)):raise ValueError('同一飞书字段只能配置一次')
    roles=[r['role'] for r in rules if r.get('role')]
    if len(roles)!=len(set(roles)) or not set(roles)<=ROLES:raise ValueError('字段用途重复或无效')
    graph={}
    for r in rules:
        if r['mode'] in ('source','join') and not r.get('sources'):raise ValueError('请至少选择一个数据来源')
        if r['mode']=='rules' and not r.get('rules') and r.get('fallback','empty')=='empty':raise ValueError('请添加条件规则或设置默认来源 / 默认值')
        if r.get('role') in LOCKED and (r['mode']!='source' or r.get('sources')!=[LOCKED[r['role']]] or r.get('replacements')):
            raise ValueError('交易日期、净支出和同步键必须使用原始计算值，不能加工')
        refs=list(r.get('sources',[])) + [c['source'] for b in r.get('rules',[]) for c in b['conditions']] + [source for b in r.get('rules',[]) for source in (b.get('result') or {}).get('sources',[])]
        if any(c['operator']!='empty' and not c.get('value','').strip() for b in r.get('rules',[]) for c in b['conditions']):raise ValueError('请填写条件的匹配内容；判断空值请选择「为空」')
        if any(s not in SOURCES and not (s.startswith('field:') and s[6:] in ids) for s in refs):raise ValueError('取值来源不存在，请先配置引用字段')
        graph[r['field_id']]=[s[6:] for s in refs if s.startswith('field:')]
    active,done=set(),set()
    def visit(fid):
        if fid in active:raise ValueError('字段之间存在循环引用')
        if fid in done:return
        active.add(fid)
        for other in graph[fid]:visit(other)
        active.remove(fid);done.add(fid)
    for fid in ids:visit(fid)

def effective_mapping(config):
    fields=config.get('fields',[])
    by_id={f['field_id']:f['field_name'] for f in fields}
    mapping=dict(config.get('mapping') or {}) if config.get('field_rules') is None else {r['role']:by_id[r['field_id']] for r in config['field_rules'] if r.get('role') and r['field_id'] in by_id}
    aliases={'date':['日期','交易日期','消费日期'],'amount':['金额','支出','净支出','消费金额'],'description':['消费项目','描述','商品','消费描述'],'sync_key':['同步键','同步标识'],'category':['消费类型','分类'],'source':['消费环境','账单来源']}
    for role,names in aliases.items():
        if mapping.get(role):continue
        found=next((f for name in names for f in fields if f['field_name']==name and not f.get('is_readonly') and f['type'] in (CORE[role] if role in CORE else (1,3,4))),None)
        if found and found['field_name'] not in mapping.values():mapping[role]=found['field_name']
    return mapping


def label_rules(config):
    names={f['field_id']:f['field_name'] for f in config.get('fields',[])}
    for rule in config.get('field_rules') or []:rule['field_name']=names.get(rule['field_id'],'已删除字段')

def managed_names(config):
    if config.get('field_rules') is None:return list(dict.fromkeys([*effective_mapping(config).values(),*config.get('_extra_managed_fields',[])]))
    ids={r['field_id'] for r in config['field_rules']}
    return list(dict.fromkeys([*effective_mapping(config).values(),*config.get('_extra_managed_fields',[]),*[f['field_name'] for f in config.get('fields',[]) if f['field_id'] in ids]]))

def validate_fields(fields,config,require_core=True):
    rules=config.get('field_rules') or []
    validate_structure(rules)
    by_id={f['field_id']:f for f in fields}
    for r in rules:
        f=by_id.get(r['field_id'])
        if not f:raise ValueError('映射字段已被删除，请刷新飞书字段后重新配置')
        if f['type'] not in SUPPORTED or f.get('is_readonly'):raise ValueError(f'「{f["field_name"]}」是公式、系统或暂不支持写入的字段')
        if (r.get('date_format') or r.get('date_precision','original')!='original') and (f['type'] not in (1,5) or r.get('role') in ('amount','sync_key')):raise ValueError('日期加工只支持日期或文本字段')
        if r.get('date_format') and f['type']!=1:raise ValueError('日期格式化文本请写入文本列；飞书日期列的显示格式在飞书设置')
        for branch in r.get('rules',[]):
            result=branch.get('result') or {}
            if f['type'] not in (1,3,4) and (result.get('mode')=='join' or result.get('prefix') or result.get('suffix') or result.get('replacements')):raise ValueError('组合、替换及前后缀只支持文本或选项字段')
        if r['mode']=='join' and f['type'] not in (1,3,4):raise ValueError('只有文本或选项字段支持组合来源')
        if r.get('role') in CORE and f['type'] not in CORE[r['role']]:raise ValueError(f'「{f["field_name"]}」类型不适合所选字段用途')
    if require_core and not set(CORE)<={r.get('role') for r in rules}:
        raise ValueError('请分别配置交易日期、净支出、消费描述和同步键四个字段用途')

def source_values(row):
    members=row.get('members') or [row]
    values={k:row.get(k) or next((m.get(k) for m in members if m.get(k)), '') for k in SOURCES}
    values['platform']=' / '.join(row.get('platforms') or list(dict.fromkeys(m.get('platform','') for m in members)))
    for k in ('net','amount','refund'):values[k]=(row.get(k) or 0)/100
    return values

def convert(value,field,negative=False):
    kind=field['type']
    if value is None or value=='':return None
    if kind in (1,3):result=str(value)
    elif kind==4:result=[s.strip() for s in str(value).split('、') if s.strip()] if not isinstance(value,list) else value
    elif kind==2:
        try:
            n=Decimal(str(value))
            if not n.is_finite() or abs(n)>Decimal('999999999999'):raise ValueError()
            result=float(n)*(-1 if negative else 1)
        except (InvalidOperation,ValueError,OverflowError):raise ValueError('需要有效数字') from None
    elif kind==5:
        try:result=int(datetime.fromisoformat(str(value)).replace(tzinfo=ZoneInfo('Asia/Shanghai')).timestamp()*1000)
        except (ValueError,OverflowError,OSError):raise ValueError('需要有效交易日期') from None
    elif kind==7:
        text=str(value).casefold()
        if text not in ('true','false','是','否','1','0'):raise ValueError('复选框仅接受是或否')
        result=text in ('true','是','1')
    else:raise ValueError('此字段不支持写入')
    if kind in (3,4):
        allowed={o['name'] for o in (field.get('property') or {}).get('options',[])}
        if any(v not in allowed for v in (result if isinstance(result,list) else [result])):raise ValueError('不在飞书现有选项中')
    return result

def evaluate(row,config):
    rules=config.get('field_rules') or []
    validate_fields(config.get('fields',[]),config,False)
    fields={f['field_id']:f for f in config.get('fields',[])}
    definitions={r['field_id']:r for r in rules}
    original=source_values(row)
    output,raw,trace,warnings={},{},{},[]
    def get(key):
        if key.startswith('field:'):return resolve(key[6:])
        return original.get(key,'')
    def match(c):
        current=get(c['source'])
        a=str('' if current is None else current).strip().casefold();b=c.get('value','').strip().casefold()
        op=c['operator']
        return {'equals':lambda:a==b,'contains':lambda:b in a,'not_contains':lambda:b not in a,
                'starts_with':lambda:a.startswith(b),'ends_with':lambda:a.endswith(b),'empty':lambda:not a}[op]()
    def from_sources(r):
        values=[get(s) for s in r.get('sources',[])]
        values=[v for v in values if v is not None and v!='']
        return r.get('separator',' · ').join(map(str,values)) if r['mode']=='join' else next(iter(values),'')
    def branch_value(branch):
        spec=branch.get('result')
        if not spec:return branch.get('value','')
        value=from_sources(spec)
        if value is None or value=='':return ''
        if isinstance(value,str) and spec.get('trim',True):value=value.strip()
        if spec.get('replacements') or spec.get('prefix') or spec.get('suffix'):
            value=str(value)
            for change in spec.get('replacements',[]):
                if len(value)+value.count(change['find'])*(len(change['replace'])-len(change['find']))>10000:raise ValueError('规则结果替换后超过 10000 字符')
                value=value.replace(change['find'],change['replace'])
            value=spec.get('prefix','')+value+spec.get('suffix','')
        if isinstance(value,str) and len(value)>10000:raise ValueError('规则结果超过 10000 字符')
        return value
    def resolve(fid):
        if fid in raw:return raw[fid]
        r=definitions[fid];field=fields[fid];name=field['field_name'];mode=r['mode']
        value=r.get('value','') if mode=='fixed' else from_sources(r) if mode in ('source','join') else ''
        label={'source':'来源取值','join':'组合取值','fixed':'固定值','rules':'未命中规则'}[mode]
        if mode=='rules':
            found=next((b for b in r.get('rules',[]) if (all if b.get('match','all')=='all' else any)(match(c) for c in b['conditions'])),None)
            if found is not None:
                label=found.get('name') or f'条件规则 {r["rules"].index(found)+1}'
                trace[name]=label
                try:value=branch_value(found)
                except ValueError as e:warnings.append(f'「{name}」{e}');raw[fid]='';return ''
            elif r.get('fallback')=='source':value=from_sources(r);label='默认来源'
            elif r.get('fallback')=='fixed':value=r.get('value','');label='默认值'
        trace[name]=label
        if value not in ('',None) and (r.get('date_format') or r.get('date_precision','original')!='original'):
            try:
                dt=datetime.fromisoformat(str(value).replace('/','-'))
                if dt.tzinfo:dt=dt.astimezone(ZoneInfo('Asia/Shanghai')).replace(tzinfo=None)
                if r.get('date_precision') in ('day','month'):dt=dt.replace(hour=0,minute=0,second=0,microsecond=0)
                if r.get('date_precision')=='month':dt=dt.replace(day=1)
                patterns={'YYYY-MM-DD':'%Y-%m-%d','YYYY/MM/DD':'%Y/%m/%d','YYYY年MM月DD日':'%Y年%m月%d日','YYYY-MM':'%Y-%m','YYYYMMDD':'%Y%m%d','YYYY-MM-DD HH:mm:ss':'%Y-%m-%d %H:%M:%S'}
                value=dt.strftime(patterns[r['date_format']]) if r.get('date_format') else dt.isoformat(sep=' ')
            except (ValueError,OverflowError):
                warnings.append(f'「{name}」日期来源无法解析，请选择交易日期或有效日期文本');raw[fid]='';return ''
        if isinstance(value,str):
            if len(value)>10000:
                warnings.append(f'「{name}」内容超过 10000 字符');raw[fid]='';return ''
            if r.get('trim',True):value=value.strip()
            for change in r.get('replacements',[]):
                if len(value)+value.count(change['find'])*(len(change['replace'])-len(change['find']))>10000:
                    warnings.append(f'「{name}」替换结果超过 10000 字符');raw[fid]='';return ''
                value=value.replace(change['find'],change['replace'])
        raw[fid]=value
        try:
            converted=convert(value,field,bool(config.get('negative_expense') and r.get('role')=='amount'))
            if converted is None and (r.get('required') or r.get('role') in CORE):raise ValueError('未取得值，请补充规则或默认值')
            if converted is not None:output[name]=converted
        except ValueError as e:warnings.append(f'「{name}」{e}')
        return value
    for fid in definitions:resolve(fid)
    used={s for r in rules for s in r.get('sources',[])} | {c['source'] for r in rules for b in r.get('rules',[]) for c in b['conditions']} | {s for r in rules for b in r.get('rules',[]) for s in (b.get('result') or {}).get('sources',[])}
    inputs={s:raw.get(s[6:],'') if s.startswith('field:') else original.get(s,'') for s in used}
    return {'fields':output,'trace':trace,'warnings':warnings,'inputs':inputs}
