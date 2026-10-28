"""Read-only adapters. Money is integer CNY fen; identifiers are always strings."""
import csv
import hashlib
import io
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from zoneinfo import ZoneInfo

import openpyxl
import pdfplumber

TZ = ZoneInfo('Asia/Hong_Kong')
PLATFORMS = ('京东', '美团', '微信', '抖音', '支付宝')


def clean(value):
    return str(value if value is not None else '').strip().lstrip('\ufeff')


def money(value):
    s = re.sub(r'[¥￥元,\s]', '', clean(value))
    s = re.sub(r'[（(]已全额退款[）)]$', '', s)
    if not s or s in ('/', '-'):
        raise ValueError('金额为空')
    try:
        n = Decimal(s)
        if not n.is_finite() or n != n.quantize(Decimal('.01')):
            raise ValueError('金额精度不正确')
        return abs(int(n * 100))
    except InvalidOperation:
        raise ValueError('无法识别金额') from None


def date(value):
    if isinstance(value, datetime):
        return value.strftime('%Y-%m-%d %H:%M:%S')
    s = clean(value).replace('/', '-')
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d'):
        try:
            return datetime.strptime(s, fmt).strftime('%Y-%m-%d %H:%M:%S')
        except ValueError:
            pass
    raise ValueError('无法识别交易时间')


def rows_csv(data):
    for encoding in ('utf-8-sig', 'gb18030'):
        try:
            content = data.decode(encoding)
            if '\ufffd' in content:
                continue
            rows = list(csv.reader(io.StringIO(content)))
            if any('收/支' in r for r in rows):
                return rows, encoding
        except (UnicodeDecodeError, csv.Error):
            continue
    raise ValueError('无法识别 CSV 编码或表头，请上传平台原始导出文件')


def rows_pdf(data):
    rows = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        if len(pdf.pages) > 100:
            raise ValueError('PDF 超过 100 页，请分段导出')
        for pn, page in enumerate(pdf.pages, 1):
            words = page.extract_words()
            headers = [w for w in words if w['text'] == '交易单号']
            if not headers:
                continue
            top = headers[0]['top']
            # This bank-style PDF draws the header's column bottom boundaries.
            edges = [e for e in page.edges if e['orientation'] == 'h' and top < e['top'] < top + 30]
            borders = sorted(set(round(e['x0'], 1) for e in edges) | set(round(e['x1'], 1) for e in edges))
            borders = [x for i, x in enumerate(borders) if i == 0 or x - borders[i - 1] > 1]
            if len(borders) != 8:
                raise ValueError(f'第 {pn} 页的抖音表格布局不支持，请重新导出支付流水')
            header_bottom = min(e['top'] for e in edges)
            horizontal = sorted(set(round(e['top'], 1) for e in page.edges if e['orientation'] == 'h' and e['top'] >= header_bottom - .2 and e['x1'] - e['x0'] > page.width * .8))
            for y0, y1 in zip(horizontal, horizontal[1:]):
                cells = []
                for x0, x1 in zip(borders, borders[1:]):
                    cell = [w for w in words if x0 <= (w['x0'] + w['x1']) / 2 < x1 and y0 < (w['top'] + w['bottom']) / 2 < y1]
                    lines = {}
                    for w in cell:
                        lines.setdefault(round(w['top']), []).append(w)
                    text = ''.join(' '.join(w['text'] for w in sorted(line, key=lambda x: x['x0'])) for _, line in sorted(lines.items()))
                    cells.append(text)
                if cells and re.match(r'^\d{4}-\d{2}-\d{2}', cells[0]):
                    rows.append((pn, cells))
    if not rows:
        raise ValueError('没有识别到抖音文字流水；扫描 PDF 和其他平台 PDF 暂不支持')
    return rows


def parse_file(name: str, data: bytes, account='默认账户'):
    suffix = Path(name).suffix.lower()
    if len(data) > 20 * 1024 * 1024:
        raise ValueError('单个文件不能超过 20 MB')
    encoding = None
    if suffix == '.pdf':
        if not data.startswith(b'%PDF'):
            raise ValueError('文件内容不是 PDF')
        platform = '抖音'
        raw = rows_pdf(data)
        header = ['交易时间', '收/支', '金额', '收/付款方式', '交易单号', '交易对方', '商家单号']
        records = [(f'第 {pn} 页 · 交易 {i}', dict(zip(header, cells))) for i, (pn, cells) in enumerate(raw, 1)]
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            metadata = pdf.pages[0].extract_text() or ''
    elif suffix in ('.csv', '.xlsx'):
        if suffix == '.csv':
            rows, encoding = rows_csv(data)
        else:
            import zipfile
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                if sum(x.file_size for x in z.infolist()) > 100 * 1024 * 1024:
                    raise ValueError('XLSX 解压体积过大')
            wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
            ws = wb.worksheets[0]
            if ws.max_row and ws.max_row > 50000:
                raise ValueError('单个文件最多支持 50,000 行')
            rows = list(ws.values)
            wb.close()
        hi = next((i for i, r in enumerate(rows) if any(clean(c) in ('交易时间', '交易创建时间') for c in r) and any(clean(c) == '收/支' for c in r)), None)
        if hi is None:
            raise ValueError('找不到账单表头，请上传原始 CSV 或 XLSX')
        header = [clean(c) for c in rows[hi]]
        if '实付金额' in header:
            platform = '美团'
        elif '当前状态' in header:
            platform = '微信'
        elif '商户名称' in header:
            platform = '京东'
        elif '对方账号' in header and '商品说明' in header:
            platform = '支付宝'
        else:
            raise ValueError('未知账单格式，当前支持京东、美团、微信、抖音和支付宝')
        metadata = '\n'.join(' '.join(map(clean, r)) for r in rows[:hi])
        records = []
        for i, r in enumerate(rows[hi + 1:], hi + 2):
            if not any(clean(c) for c in r):
                continue
            # Stop at footer but never silently lose a populated transaction row.
            if len(r) < 5:
                continue
            values = dict(zip(header, map(clean, r)))
            time = values.get('交易时间', values.get('交易创建时间', ''))
            if not re.match(r'^\d{4}[-/]', time):
                if any(values.get(k) not in ('', None, '/') for k in ('交易单号', '交易订单号')):
                    records.append((f'第 {i} 行', values))
                continue
            records.append((f'第 {i} 行', values))
    else:
        raise ValueError('仅支持 CSV、XLSX、抖音文字 PDF；压缩包请先在本机解压')
    # An explicit export time keeps old snapshots from overwriting newer ones.
    match = re.search(r'(?:导出时间|申请时间|申请日期|账单申请时间)[：:\s\[]*(\d{4}[-年]\d{2}[-月]\d{2}[日\sT]+\d{2}[:时]\d{2}[:分]\d{2})', metadata + '\n' + name)
    observed = re.sub(r'[年月日时分]', lambda m: {'年':'-', '月':'-', '日':' ', '时':':', '分':':'}[m[0]], match[1]).strip() if match else ''
    events, errors = [], []
    for location, r in records:
        try:
            events.append(normalize(platform, r, location, account, observed))
        except (ValueError, KeyError) as e:
            errors.append({'location': location, 'message': str(e)})
    if not events and not errors:
        raise ValueError('文件没有交易记录')
    return {'platform': platform, 'encoding': encoding, 'events': events, 'errors': errors, 'row_count': len(records), 'observed_at': observed, 'parser_version': '1.1'}


def normalize(platform, r, location, account, observed):
    direction = r.get('收/支', '')
    state = r.get('当前状态', r.get('交易状态', ''))
    typ = r.get('交易类型', '')
    method = r.get('支付方式', r.get('收/付款方式', ''))
    is_refund = ('退款' in typ or state == '退款成功' or (platform == '抖音' and method == '退款'))
    amount = money(r.get('实付金额', r.get('金额(元)', r.get('金额', ''))))
    time = date(r.get('交易成功时间') or r.get('交易时间') or r.get('交易创建时间'))
    description = r.get('商品', r.get('订单标题', r.get('商品说明', r.get('交易说明', ''))))
    merchant = r.get('交易对方', r.get('商户名称', ''))
    order = re.sub(r'\s+', '', r.get('交易单号', r.get('交易订单号', '')))
    merchant_id = re.sub(r'\s+', '', r.get('商户单号', r.get('商家单号', r.get('商家订单号', ''))))
    category = r.get('交易分类', '')
    kind = 'refund' if is_refund else ('expense' if direction == '支出' else 'excluded')
    reason = '非消费收支'
    if platform == '京东' and direction == '不计收支' and state == '交易成功':
        kind = 'reference'
        reason = '不计收支原单，保留供退款匹配'
    if kind == 'expense' and any(x in category + typ + description for x in ('还款', '理财申购', '理财赎回', '提现')):
        kind, reason = 'excluded', '还款、理财或资金流转'
    review = kind == 'expense' and (typ == '转账' or any(x in description + category + typ for x in ('充值', '储值', '红包')))
    if any(x in state for x in ('失败', '已关闭', '待支付', '退款中')) and kind != 'refund':
        kind, reason = 'excluded', '交易未完成'
    full_refund = state == '已全额退款' or '已全额退款' in r.get('金额', '')
    cumulative = amount if kind in ('expense', 'reference') and full_refund else None
    partial = re.search(r'已退款[（(]?[¥￥]?([\d,.]+)', state)
    if partial and kind in ('expense', 'reference'):
        cumulative = money(partial[1])
    # JD original payment and refund share order ID; event kind is essential.
    identity = order if kind != 'refund' else '|'.join((order, merchant_id))
    reliable_id = order not in ('', '/', '-')
    if not reliable_id:
        identity = '|'.join((time, str(amount), merchant, description, merchant_id))
    # Direction/status can change after a refund. A payment must keep the
    # same identity when a later export labels it "不计收支".
    identity_kind = 'refund' if kind == 'refund' else 'payment'
    key = hashlib.sha256(f'{platform}|{account}|{identity_kind}|{identity}'.encode()).hexdigest()
    return {'id': key, 'platform': platform, 'account': account, 'kind': kind, 'direction': direction, 'transaction_type': typ or category,
            'amount': amount, 'time': time, 'merchant': merchant, 'description': description,
            'order_id': order, 'merchant_id': merchant_id, 'state': state, 'category': category,
            'method': method, 'refund_snapshot': cumulative, 'observed_at': observed,
            'review': review or not reliable_id, 'reason': reason if kind in ('excluded', 'reference') else '',
            'location': location, 'reliable_id': reliable_id}
