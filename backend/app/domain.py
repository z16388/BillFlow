"""Pure, explainable accounting projection; raw events remain immutable evidence."""
from datetime import datetime
from .customization import apply_customization
from .douyin_duplicates import repeated_payments


def project(events, decisions=None, remote=None, bindings=None, customization=None):
    decisions, remote, bindings = decisions or {}, remote or [], bindings or {}
    duplicate_matches = repeated_payments(events)
    duplicate_rule = bool((customization or {}).get('douyin_duplicate_filter'))
    duplicate_targets = {
        eid: info['original_id'] for eid, info in duplicate_matches.items()
        if duplicate_rule and info['certain']
        and not decisions.get(eid, {}).get('douyin_duplicate_exempt')
    }
    by_id = {e['id']: e for e in events}
    originals = {e['id']: e for e in events if e['kind'] in ('expense', 'reference')}
    refunds = [e for e in events if e['kind'] == 'refund']
    groups, roots = {}, {}
    for eid in originals:
        root, seen = eid, set()
        while decisions.get(root, {}).get('merge_into'):
            if root in seen:
                raise ValueError('合并关系存在循环')
            seen.add(root)
            root = decisions[root]['merge_into']
            if root not in originals:
                raise ValueError('合并目标原单不存在')
        roots[eid] = root
        groups.setdefault(root, []).append(originals[eid])
    assigned, refund_rows = {}, []
    for refund in refunds:
        decision = decisions.get(refund['id'], {})
        statement_amount=refund['amount']
        cash=decision.get('refund_cash_amount')
        adjusted=cash is not None and not decision.get('reset_refund_cash')
        refund={**refund,'statement_amount':statement_amount,'amount':cash if adjusted else statement_amount,
                'refund_adjusted':adjusted,'refund_adjustment_reason':decision.get('refund_adjustment_reason',''),
                'refund_original_order':decision.get('refund_original_order','')}

        target, basis = decision.get('refund_to'), '手动确认原交易'
        if target in duplicate_targets:
            target = duplicate_targets[target]
            basis += '（重复流水对应的前序消费）'
        if decision.get('ignore'):
            refund_rows.append({**refund, 'status': 'ignored', 'basis': '已手动排除', 'candidates': []})
            continue
        if target and target not in originals:
            target = None
        if not target and not refund.get('review'):
            matches = []
            for eid, original in originals.items():
                if eid in duplicate_targets:
                    continue
                if original['platform'] != refund['platform'] or original['account'] != refund['account']:
                    continue
                if refund['time'] < original['time'] or refund['amount'] > original['amount']:
                    continue
                if refund['platform'] == '京东' and original['order_id'] == refund['order_id']:
                    matches.append(eid)
                    basis = '京东原付与退款共享交易订单号'
                elif refund['platform'] == '支付宝' and '_' in refund['order_id'] and refund['order_id'].split('_')[0] == original['order_id']:
                    matches.append(eid)
                    basis = '支付宝退款流水中的原交易号'
            if len(matches) == 1:
                target = matches[0]
        if not target and decision.get('refund_original_order'):
            exact=[e['id'] for e in originals.values() if e['order_id']==decision['refund_original_order']
                   and e['id'] not in duplicate_targets
                   and e['platform']==refund['platform'] and e['account']==refund['account']
                   and e['time']<=refund['time'] and e['amount']>=refund['amount']]
            if len(exact)==1:target=exact[0];basis='按人工核实的原商品订单号关联'
        candidates = []
        if not target:
            for eid, original in originals.items():
                if eid in duplicate_targets:
                    continue
                if original['time'] <= refund['time'] and original['amount'] >= refund['amount'] and original['platform'] == refund['platform']:
                    same_merchant = original['merchant'] == refund['merchant'] or original['merchant'] in refund['description']
                    if same_merchant:
                        candidates.append({'id': eid, 'time': original['time'], 'merchant': original['merchant'], 'amount': original['amount'], 'description': original['description']})
            candidates.sort(key=lambda x: x['time'], reverse=True)
            candidates.sort(key=lambda x: x['amount'] != refund['amount'])
        if target:
            root = roots[target]
            assigned.setdefault(root, []).append(refund)
            refund_rows.append({**refund, 'status': 'matched', 'target': root, 'basis': basis, 'candidates': []})
        else:
            refund_rows.append({**refund, 'status': 'unmatched', 'basis': '缺少可证明的原单编号，请选择原单或补充历史账单', 'candidates': candidates[:10], 'possible_originals': [c['id'] for c in candidates]})
    results = []
    for root, members in groups.items():
        event = by_id[root]
        decision = decisions.get(root, {})
        linked = assigned.get(root, [])
        if event['kind'] == 'reference' and not linked and event.get('refund_snapshot') is None:
            continue
        amounts = {e['amount'] for e in members}
        snapshots = [e['refund_snapshot'] for e in members if e.get('refund_snapshot') is not None]
        # Different platforms may show the same refund; do not add independent
        # platform refund sums without explicit review.
        refund_by_source = {}
        for r in linked:
            refund_by_source[r['platform']] = refund_by_source.get(r['platform'], 0) + r['amount']
        totals = set(refund_by_source.values())
        reasons = []
        if len(amounts) > 1:
            reasons.append('合并来源实付金额不一致，请解除合并或核实')
        if len(totals) > 1:
            reasons.append('多个来源退款总额不一致')
        linked_total = max(totals, default=0)
        snapshot_total = max(snapshots, default=0)
        refund_total = snapshot_total if snapshots else linked_total
        if snapshots and any(r.get('refund_adjusted') for r in linked):
            statement_by_source={}
            for r in linked:statement_by_source[r['platform']]=statement_by_source.get(r['platform'],0)+r.get('statement_amount',r['amount'])
            if snapshot_total in (linked_total,max(statement_by_source.values(),default=0)):refund_total=linked_total
            else:reasons.append('已修正实际退款，但原单累计退款快照范围不同，请核对')

        if snapshots and linked_total > snapshot_total:
            reasons.append('独立退款合计超过原单退款快照，请核对时间与归属')
        if len(set(snapshots)) > 1:
            reasons.append('多个来源原单退款快照不一致')
        if refund_total > event['amount']:
            reasons.append('退款总额超过原付金额')
        if event.get('review') and not decision.get('confirmed') and not (decision.get('filter_exempt') and event.get('reliable_id', False)):
            reasons.append('转账、充值或缺少稳定编号，需要确认是否计入消费')
        if decision.get('ignore'):
            reasons.append('已手动排除')
        net = event['amount'] - refund_total
        status = 'review' if reasons else ('refunded' if net == 0 else 'new')
        row = {**event, 'id': root, 'amount': event['amount'], 'refund': refund_total, 'net': net,
               'status': status, 'reasons': reasons, 'members': members, 'refunds': linked,
               'category': decision.get('category', event['category']) or '未分类',
               'note': decision.get('note', ''), 'platforms': list(dict.fromkeys(e['platform'] for e in members)),
               'filter_exempt': decision.get('filter_exempt', False),
               'suspects': [], 'existing_candidates': [], 'record_id': None}
        for member in members:
            info = decisions.get(member['id'], {}).get('douyin_order_info')
            if member.get('platform') == '抖音' and info:
                row['douyin_order_info'] = {**info, 'event_id': member['id']}
                row['original_merchant'], row['original_description'] = row['merchant'], row['description']
                row['merchant'] = info.get('merchant') or row['merchant']
                row['description'] = info.get('description') or row['description']
                break
        if decision.get('ignore'):
            row['status'] = 'excluded'
        binding = bindings.get(root)
        candidates = [r for r in remote if r.get('sync_key') == root]
        if binding:
            bound = next((r for r in remote if r['id'] == binding['record_id']), None)
            candidates = [bound] if bound else []
            if not bound:
                row['status'], row['reasons'] = 'review', ['原飞书记录已删除或不可见，请重新核对绑定']
        if len(candidates) > 1:
            row['status'], row['reasons'] = 'review', ['飞书存在多条相同同步键的记录']
        elif len(candidates) == 1:
            old = candidates[0]
            row.update(record_id=old['id'], remote_amount=old.get('amount'), remote_snapshot=old.get('fields'), remote_description=old.get('description'), remote_edited=bool(binding and binding.get('snapshot') != old.get('fields')))
            if binding and binding.get('snapshot') != old.get('fields') and old.get('amount') != net:
                row['status'], row['reasons'] = 'review', ['飞书受管理字段已被手动修改，请核对后重新绑定']
            elif row['status'] not in ('review', 'excluded'):
                row['status'] = 'recorded' if old.get('amount') == net else 'update'
        elif not binding and row['status'] in ('new', 'refunded'):
            for old in remote:
                same_order = old.get('order_id') and old['order_id'] in {e['order_id'] for e in members}
                same_day_amount = old.get('date', '')[:10] == row['time'][:10] and old.get('amount') in (net, row['amount'])
                if same_order or same_day_amount:
                    row['existing_candidates'].append(old)
            if row['existing_candidates'] and not decision.get('distinct_remote'):
                row['status'] = 'review'
                row['reasons'].append('可能已手工记账，请绑定已有记录或确认是另一笔')
        apply_customization(row, customization or {})
        duplicate = duplicate_matches.get(root)
        if duplicate:
            row['douyin_duplicate'] = duplicate
            row['douyin_duplicate_exempt'] = bool(decision.get('douyin_duplicate_exempt'))
            if duplicate_rule and not row['douyin_duplicate_exempt']:
                if root in duplicate_targets and roots.get(duplicate['original_id']) != root:
                    row['automatic_exclusion'] = 'douyin_duplicate'
                    row['status'] = 'excluded'
                    row['reasons'].append('自动排除疑似重复月付流水：对应 ' + duplicate['original_time']
                                          + ' 的消费，交易单号 ' + duplicate['original_order'])
                elif not duplicate['certain'] and row['status'] not in ('excluded', 'filtered', 'refunded'):
                    row['status'] = 'review'
                    row['reasons'].append('疑似抖音月付重复流水，但存在多笔前序消费，需人工核对')
        results.append(row)
    # A pending refund makes plausible original amounts uncertain. Do not offer
    # those rows as confirmed expenses until the user resolves the refund.
    for refund in refund_rows:
        if refund['status'] != 'unmatched':
            continue
        possible = {roots.get(eid, eid) for eid in refund.get('possible_originals', [])}
        for row in results:
            if row['id'] not in possible or row['status'] not in ('new', 'update'):
                continue
            explicit = [e for e in row['members'] if e.get('refund_snapshot') is not None and e.get('observed_at') and e['observed_at'] >= refund['time']]
            if explicit:
                continue
            row['status'] = 'review'
            row['reasons'].append('存在可能关联的待匹配退款，请先确认退款归属，避免高估净支出')
    # Conservative cross-platform candidates: same cash amount + near time +
    # explicit merchant hints. Pure amount equality never silently merges rows.
    for i, a in enumerate(results):
        for b in results[i + 1:]:
            if 'filtered' in (a['status'], b['status']) or a.get('automatic_exclusion') or b.get('automatic_exclusion'):
                continue
            if a['platform'] == b['platform'] or a['amount'] != b['amount']:
                continue
            if not ({a['platform'], b['platform']} & {'微信', '支付宝'}):
                continue
            delta = abs((datetime.fromisoformat(a['time']) - datetime.fromisoformat(b['time'])).total_seconds())
            hints = a['merchant'] + a['description'] + b['merchant'] + b['description']
            commerce = ({a['platform'], b['platform']} & {'京东', '美团', '抖音'})
            is_same = bool(commerce and any(p in hints for p in commerce)) or a['merchant'] == b['merchant']
            pair = sorted((a['id'], b['id']))
            if delta <= 180 and is_same and not decisions.get(pair[0], {}).get('distinct_' + pair[1]):
                for x, y in ((a, b), (b, a)):
                    x['suspects'].append({'id': y['id'], 'merchant': y['merchant'], 'time': y['time'], 'platform': y['platform']})
                    if x['status'] == 'new':
                        x['status'] = 'review'
                        x['reasons'].append('跨平台疑似同笔付款，请合并或确认分别保留')
    results.sort(key=lambda e: e['time'], reverse=True)
    excluded = [e for e in events if e['kind'] == 'excluded' or (e['kind'] == 'reference' and roots.get(e['id']) not in assigned)]
    return {'expenses': results, 'refunds': refund_rows, 'excluded': excluded,
            'summary': {k: sum(e['status'] == k for e in results) for k in ('new', 'update', 'review', 'recorded', 'refunded', 'excluded', 'filtered')}}
