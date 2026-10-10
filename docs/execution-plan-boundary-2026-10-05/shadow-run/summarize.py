"""The shadow run's records summarised: `python3 -I summarize.py <outdir>` -- each verdict by kind and by test target,
then every record that is not SAME, grouped by its detail (a refusal's message, a difference's first bytes)."""
import collections
import pathlib
import sys

rows = []
for f in sorted(pathlib.Path(sys.argv[1]).rglob("shadow-*.tsv")):
    for line in f.read_text().splitlines():
        p = line.split("\t")
        if len(p) >= 6:
            rows.append(p)
print("records:", len(rows))
by = collections.Counter((r[0], r[1]) for r in rows)
for (v, k), n in sorted(by.items()):
    print("  %-13s %-9s %6d" % (v, k, n))
print("\nby test target (verdict counts):")
targets = collections.defaultdict(collections.Counter)
for r in rows:
    targets[r[2]][r[0]] += 1
for t, c in sorted(targets.items()):
    print("  %-60s %s" % (t, dict(c)))
print("\nnot SAME, grouped by detail (first 140 characters):")
groups = collections.defaultdict(list)
for r in rows:
    if r[0] != "SAME":
        key = r[0] + " " + r[1] + " " + (r[5][:140] if r[0] != "DIFF" else "")
        groups[key].append(r)
for key, rs in sorted(groups.items(), key=lambda kv: -len(kv[1])):
    print("\n[%d] %s" % (len(rs), key))
    for r in rs[:3]:
        print("    target %s | runtime %s\n      query  %s\n      detail %s" % (r[2], r[3], r[4][:300], r[5][:500]))
