"""The ECharts gallery's examples by category, each its id and title: python3 -I list.py <chart-list-data.js>."""
import json, re, sys, collections
text = open(sys.argv[1], encoding='utf-8').read()
body = text[text.index('['):text.rindex(']') + 1]
items = json.loads(body)
by = collections.defaultdict(list)
for it in items:
    by[(it['category'] or ['(none)'])[0]].append(it)
print(len(items), 'examples')
for cat, its in sorted(by.items(), key=lambda kv: -len(kv[1])):
    print(f'\n## {cat} ({len(its)})')
    for it in its:
        extra = [c for c in it['category'][1:]]
        print(f"- {it['id']}: {it.get('title') or it.get('titleCN') or ''}" + (f"  [also {', '.join(extra)}]" if extra else ''))
