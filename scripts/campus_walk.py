"""Writes server/talkdata/campus_walk.json: the footpath and road network within RADIUS m of
Klaus, as a graph (nodes [x, z], edges [a, b, foot]), so server-driven NPCs can walk, run
and cycle around campus on real paths. Run: python3 scripts/campus_walk.py"""
import json, math, os

RADIUS = 380
here = os.path.dirname(os.path.abspath(__file__))
c = json.load(open(os.path.join(here, '..', 'client', 'public', 'campus.json')))
cx, cz = c['event']['center']
ids, nodes, edges = {}, [], {}

def node(x, z):
    k = (round(x, 1), round(z, 1))
    if k not in ids:
        ids[k] = len(nodes)
        nodes.append([round(x, 2), round(z, 2)])
    return ids[k]

for r in c['roads']:
    pts = r['pts']
    for (ax, az), (bx, bz) in zip(pts, pts[1:]):
        if math.hypot(ax - cx, az - cz) > RADIUS or math.hypot(bx - cx, bz - cz) > RADIUS:
            continue
        a, b = node(ax, az), node(bx, bz)
        if a == b:
            continue
        key = (min(a, b), max(a, b))
        edges[key] = edges.get(key, False) or r['foot']

# keep the largest connected piece
adj = {i: [] for i in range(len(nodes))}
for a, b in edges:
    adj[a].append(b)
    adj[b].append(a)
seen, best = set(), []
for s in range(len(nodes)):
    if s in seen or not adj[s]:
        continue
    comp, stack = [], [s]
    seen.add(s)
    while stack:
        n = stack.pop()
        comp.append(n)
        for m in adj[n]:
            if m not in seen:
                seen.add(m)
                stack.append(m)
    if len(comp) > len(best):
        best = comp
keep = sorted(best)
remap = {o: i for i, o in enumerate(keep)}
out = {
    'center': [cx, cz],
    'nodes': [nodes[o] for o in keep],
    'edges': [[remap[a], remap[b], 1 if f else 0] for (a, b), f in edges.items() if a in remap and b in remap],
}
path = os.path.join(here, '..', 'server', 'talkdata', 'campus_walk.json')
json.dump(out, open(path, 'w'), separators=(',', ':'))
print(f"{len(out['nodes'])} nodes, {len(out['edges'])} edges ({sum(e[2] for e in out['edges'])} foot), {os.path.getsize(path)} bytes")
