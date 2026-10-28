import json
from .domain import project


def stored_events(c):
    return [json.loads(r[0]) for r in c.execute('SELECT e.payload FROM events e WHERE NOT EXISTS (SELECT 1 FROM deleted_events d WHERE d.event_id=e.id) ORDER BY e.rowid')]


def edges(events, decisions):
    links = [(eid,d[key]) for eid,d in decisions.items() for key in ('merge_into','refund_to') if d.get(key)]
    if events:
        links.extend((r['id'],r['target']) for r in project(events,decisions)['refunds'] if r.get('target'))
    return links


def connected(selected, events, links):
    selected = set(selected)
    ids = {e['id'] for e in events}
    while True:
        updated = selected | {eid for a,b in links if a in selected or b in selected for eid in (a,b) if eid in ids}
        if updated == selected:
            return selected
        selected = updated


def visible_events(c, disabled=None):
    events = stored_events(c)
    decisions = {r[0]:json.loads(r[1]) for r in c.execute('SELECT event_id,payload FROM decisions')}
    disabled = set(disabled) if disabled is not None else {r[0] for r in c.execute('SELECT file_id FROM disabled_files')}
    unavailable = disabled | {r[0] for r in c.execute('SELECT file_id FROM deleted_files')}
    sources = {}
    for row in c.execute('SELECT event_id,file_id FROM event_files'):
        sources.setdefault(row[0],set()).add(row[1])
    hidden = set()
    for event in events:
        origins = sources.get(event['id']) or ({event['file_id']} if event.get('file_id') else set())
        if origins and not origins - unavailable:
            hidden.add(event['id'])
    if hidden:
        hidden = connected(hidden,events,edges(events,decisions))
    return [e for e in events if e['id'] not in hidden]
