"""Plain text rules over original evidence; never mutate money or source IDs."""
from string import Formatter

DEFAULT_RULES = {
    'douyin_duplicate_filter': False,
    'filter_rules': [
        {'id': 'wechat-transfer', 'name': '微信 · 转账', 'platform': '微信', 'field': 'transaction_type', 'operator': 'equals', 'keyword': '转账', 'enabled': True},
        {'id': 'alipay-family', 'name': '支付宝 · 亲情卡', 'platform': '支付宝', 'field': 'description', 'operator': 'contains', 'keyword': '亲情卡', 'enabled': True},
        {'id': 'alipay-transfer', 'name': '支付宝 · 转账', 'platform': '支付宝', 'field': 'any', 'operator': 'contains', 'keyword': '转账', 'enabled': True},
    ],
    'display_rules': [],
}
RULE_FIELDS = {'any', 'transaction_type', 'merchant', 'description', 'category', 'method'}
TEMPLATE_FIELDS = {'商户', '商品', '来源', '分类'}


def validate_template(template):
    for _, field, spec, conversion in Formatter().parse(template):
        if field is not None and (field not in TEMPLATE_FIELDS or spec or conversion):
            raise ValueError('显示模板只支持 {商户}、{商品}、{来源}、{分类}，不支持格式表达式')
    return template


def matches(event, rule):
    if not rule.get('enabled', True) or rule['platform'] not in ('全部', event['platform']):
        return False
    field = rule['field']
    values = [str(event.get(k) or '') for k in ('transaction_type', 'category', 'merchant', 'description')] if field == 'any' else [str(event.get(field) or '')]
    keyword = rule['keyword'].strip().casefold()
    return any((value.strip().casefold() == keyword if rule['operator'] == 'equals' else keyword in value.casefold()) for value in values)


def apply_customization(row, config):
    members = ([row] + row.get('members', [])) if row.get('douyin_order_info') else (row.get('members') or [row])
    filtered = [r['name'] for r in config.get('filter_rules', []) if any(matches(e, r) for e in members)]
    row['filter_rules'] = filtered
    row['sync_description'] = row['description'] or row['merchant']
    row['display_rule'] = None
    for rule in config.get('display_rules', []):
        matched = next((e for e in members if matches(e, rule)), None)
        if matched is not None:
            context = {'商户': matched['merchant'], '商品': matched['description'], '来源': matched['platform'], '分类': row['category']}
            row['sync_description'] = rule['replacement'].format_map(context)
            row['display_rule'] = rule['name']
            if row['status'] == 'recorded' and row.get('remote_description') != row['sync_description']:
                if row.get('remote_edited'):
                    row['status'] = 'review'
                    row['reasons'].append('飞书显示内容已被手动修改，请核对后重新绑定')
                else:
                    row['status'] = 'update'
                    row['update_reason'] = '显示内容更新'
            break
    row['filter_exempt'] = bool(row.get('filter_exempt'))
    if filtered and not row['filter_exempt'] and row['status'] != 'excluded':
        row['status'] = 'filtered'
        row['reasons'].append('已过滤：' + '、'.join(filtered))
