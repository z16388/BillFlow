"""Offline screenshot OCR and conservative order-list extraction."""
import csv
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import unicodedata
from pathlib import Path
from PIL import Image, UnidentifiedImageError

MAX_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 30_000_000
STATUSES = ('交易完成', '退款成功', '极速退款成功', '运输中', '备货中', '待发货', '待收货', '已完成', '交易关闭', '待付款', '已取消', '已关闭', '退款中')

def compact(text):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', text or ''))

def amount_from_line(text):
    text = compact(text).replace('·', '.').replace('•', '.')
    match = re.search(r'(?:实付款|合计).*?[¥￥]?([0-9][0-9,.]*)', text)
    if not match:
        return None, False
    value = match.group(1).replace(',', '').rstrip('.')
    if not value:
        return None, False
    inferred = '.' not in value
    try:
        if inferred:
            return int(value), True
        parts = value.split('.')
        if len(parts) != 2 or len(parts[1]) > 2:
            return None, False
        return int(parts[0]) * 100 + int(parts[1].ljust(2, '0')), False
    except ValueError:
        return None, False

def parse_lines(lines, width, height):
    lines = sorted(({**line, 'clean': compact(line.get('text', ''))} for line in lines), key=lambda l:(l['y'], l['x']))
    merchants = []
    for line in lines:
        # A status in shipping notices or footer buttons is not a new order.
        # Headers put the complete status at the right edge, next to a merchant.
        status = next((s for s in sorted(STATUSES, key=len, reverse=True) if line['clean'].endswith(s)), None)
        if not status:
            continue
        right = line['x'] + line.get('width', width - line['x'])
        standalone = line['clean'] == status and line['x'] >= width*.60 and right >= width*.85
        prefix = line['clean'][:-len(status)].rstrip('>›')
        # Some OCR engines put both header columns into a single line. Accept
        # that only when it spans the header, never a row of action buttons.
        combined = (line['x'] < width*.32 and right >= width*.85 and len(prefix) >= 2
                    and not any(t in prefix for t in ('删除订单', '更多', '申请售后', '退款成功', '查看物流', '再次购买', '待支付', '待发货', '待收货')))
        if not standalone and not combined:
            continue
        candidates = [x for x in lines if x is not line and x['x'] < width*.32
                      and abs(x['y']-line['y']) <= width*.035 and len(x['clean']) >= 2
                      and not any(t in x['clean'] for t in ('来自抖音商城', '删除订单', '申请售后', '查看物流', '再次购买', '更多'))]
        if combined:
            candidates = [{**line, 'clean':prefix}]
        if candidates:
            merchant = min(candidates, key=lambda x: abs(x['y']-line['y']))
            if not merchants or merchant['y']-merchants[-1][0]['y'] > 90:
                merchants.append((merchant, {**line, 'clean':status}))
    cards=[]
    for i,(merchant,status) in enumerate(merchants):
        start=merchant['y']; end=merchants[i+1][0]['y'] if i+1<len(merchants) else height
        segment=[x for x in lines if start < x['y'] < end]
        payments=[x for x in segment if '实付款' in x['clean'] or '合计' in x['clean']]
        paid, inferred=amount_from_line(payments[0]['clean']) if payments else (None,False)
        title=next((x['clean'] for x in segment if start+30 < x['y'] < start+300 and width*.23 < x['x'] < width*.8 and not any(t in x['clean'] for t in ('无理由', '实付款', '交易完成', '退款成功', '查看剩余', '来自抖音'))), '')
        title=re.sub(r'[¥￥]\d.*$', '', title).strip()
        name=re.split(r'抖音旗舰|旗舰直播|官方直播',merchant['clean'])[0].rstrip('>›')
        bottom=min(height, (merchants[i+1][0]['y']-70) if i+1<len(merchants) else (payments[0]['y']+180 if payments else start+650))
        cards.append({'id':str(i), 'merchant':name, 'description':title, 'paid_amount':paid, 'amount_inferred':inferred, 'status':status['clean'], 'top':max(0,start-100), 'bottom':max(start+1,bottom)})
    return cards

def _run_ocr(path):
    if os.name == 'nt':
        executable=shutil.which('powershell.exe') or shutil.which('powershell')
        if not executable:
            raise ValueError('无法启动 Windows 离线文字识别')
        command=[executable, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(Path(__file__).with_name('windows_ocr.ps1')), '-ImagePath', str(path)]
    else:
        executable=shutil.which('tesseract')
        if not executable:
            raise ValueError('服务器未安装离线 OCR，请安装 tesseract-ocr 和中文语言包')
        command=[executable, str(path), 'stdout', '-l', 'chi_sim+eng', '--psm', '11', 'tsv']
    try:
        result=subprocess.run(command, capture_output=True, timeout=90, creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    except subprocess.TimeoutExpired:
        raise ValueError('截图识别超时，请裁剪后重试') from None
    if result.returncode:
        raise ValueError('离线识别失败，请检查中文 OCR 语言包是否安装')
    if os.name == 'nt':
        return json.loads(result.stdout.decode('utf-8-sig'))['lines']
    groups={}
    for row in csv.DictReader(io.StringIO(result.stdout.decode('utf8')), delimiter='\t'):
        if row.get('level') != '5' or not row.get('text','').strip(): continue
        key=tuple(row[k] for k in ('page_num','block_num','par_num','line_num'))
        x,y,w,h=(int(row[k]) for k in ('left','top','width','height'))
        if key not in groups:groups[key]={'text':'','x':x,'y':y,'right':x+w,'bottom':y+h}
        g=groups[key]; g['text']+=' '+row['text']; g['x']=min(g['x'],x); g['y']=min(g['y'],y); g['right']=max(g['right'],x+w); g['bottom']=max(g['bottom'],y+h)
    return [{**g,'width':g['right']-g['x'],'height':g['bottom']-g['y']} for g in groups.values()]

def recognize(raw):
    if not raw or len(raw)>MAX_BYTES: raise ValueError('截图不得超过 20 MB')
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.format not in ('JPEG','PNG','WEBP'): raise ValueError('仅支持 JPG、PNG 或 WEBP 截图')
            width,height=image.size
            if width*height>MAX_PIXELS or width<200 or width>9000 or height<200: raise ValueError('截图尺寸不受支持，请适当裁剪')
            image.load()
            image=image.convert('RGB')
            with tempfile.TemporaryDirectory(prefix='ledger-ocr-') as tmp:
                lines=[]
                # Overlap chunks for very long screenshots; deduplicate repeated lines.
                top=0
                while top<height:
                    bottom=min(height,top+9000)
                    part=image.crop((0,top,width,bottom))
                    path=Path(tmp)/'image.png'; part.save(path)
                    for line in _run_ocr(path):
                        line['y']+=top
                        if not any(abs(old['y']-line['y'])<8 and abs(old['x']-line['x'])<8 and compact(old['text'])==compact(line['text']) for old in lines): lines.append(line)
                    if bottom==height: break
                    top=bottom-200
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise ValueError('无法读取截图，请使用有效的 JPG、PNG 或 WEBP 图片') from None
    return {'width':width,'height':height,'cards':parse_lines(lines,width,height)}
