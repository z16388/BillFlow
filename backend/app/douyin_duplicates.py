"""Explainable inference for repeated Douyin monthly-payment ledger entries.

ONP/INP are observed prefixes, not documented proof of a duplicate. Only a
unique earlier payment with matching independent evidence is auto-excluded.
"""
from datetime import datetime, timedelta


def repeated_payments(events):
    payments = [e for e in events if e.get('platform') == '抖音'
                and e.get('kind') == 'expense' and e.get('direction') == '支出'
                and e.get('method') == '抖音月付']
    originals = [e for e in payments if e.get('merchant_id', '').isdigit()]
    result = {}
    for event in payments:
        merchant_id = event.get('merchant_id', '').upper()
        order = event.get('order_id', '')
        if not merchant_id.startswith(('ONP', 'INP')) or not order.isdigit() or len(order) < 20:
            continue
        try:
            time = datetime.fromisoformat(event['time'])
        except (ValueError, KeyError):
            continue
        candidates = []
        for original in originals:
            original_order = original.get('order_id', '')
            if (original.get('account') != event.get('account')
                    or original.get('merchant') != event.get('merchant')
                    or original.get('amount') != event.get('amount')
                    or len(original_order) < 20 or not original_order.isdigit()
                    or original_order == order or original_order[-4:] != order[-4:]):
                continue
            try:
                delta = time - datetime.fromisoformat(original['time'])
            except (ValueError, KeyError):
                continue
            if timedelta(0) < delta <= timedelta(days=31):
                candidates.append(original)
        if candidates:
            result[event['id']] = {
                'certain': len(candidates) == 1,
                'prefix': merchant_id[:3],
                'original_id': candidates[0]['id'] if len(candidates) == 1 else None,
                'original_order': candidates[0]['order_id'] if len(candidates) == 1 else '',
                'original_time': candidates[0]['time'] if len(candidates) == 1 else '',
                'candidates': [e['id'] for e in candidates],
                'basis': '同账号、抖音月付、同商户同金额、交易单号尾四位一致，存在31天内的前序消费',
            }
    return result
