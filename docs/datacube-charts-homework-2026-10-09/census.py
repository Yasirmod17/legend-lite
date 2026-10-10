"""Which ECharts features each gallery example uses -- its chart kinds and option components -- counted, with
examples of each: python3 -I census.py <a folder of the examples' sources>."""
import collections, json, pathlib, re, sys

root = pathlib.Path(sys.argv[1])
SERIES = ['line', 'bar', 'pie', 'scatter', 'effectScatter', 'radar', 'tree', 'treemap', 'sunburst', 'boxplot',
          'candlestick', 'heatmap', 'map', 'parallel', 'lines', 'graph', 'sankey', 'funnel', 'gauge', 'pictorialBar',
          'themeRiver', 'custom', 'chord']
FEATURES = {
    'dataZoom (zoom/pan, slider)': r'\bdataZoom\b',
    'visualMap (colour by value)': r'\bvisualMap\b',
    'toolbox (save image, data view, zoom, restore)': r'\btoolbox\b',
    'brush (select a region)': r'\bbrush\s*:',
    'timeline (play through periods)': r'\btimeline\s*:',
    'dataset (one table, many series)': r'\bdataset\s*:',
    'transform (filter/sort/aggregate in the chart)': r'\btransform\s*:',
    'markLine (reference/average lines)': r'\bmarkLine\b',
    'markPoint (max/min pins)': r'\bmarkPoint\b',
    'markArea (shaded bands)': r'\bmarkArea\b',
    'axisPointer link (crosshair across charts)': r'axisPointer\s*:\s*\{[^}]*link',
    'echarts.connect (linked charts)': r'echarts\.connect',
    'polar coordinates': r'\bpolar\s*:',
    'calendar coordinates': r'\bcalendar\s*:',
    'singleAxis': r'\bsingleAxis\b',
    'geo/map component': r'\bgeo\s*:|registerMap',
    'matrix coordinates (v6)': r'\bmatrix\s*:',
    'graphic (free shapes, watermark)': r'\bgraphic\s*:',
    'rich text labels': r'\brich\s*:',
    'axis breaks (v6)': r'\bbreaks\s*:',
    'log axis': r"type\s*:\s*'log'",
    'time axis': r"type\s*:\s*'time'",
    'two y axes': r'yAxis\s*:\s*\[\s*\{[\s\S]*?\}\s*,\s*\{',
    'several grids (small multiples)': r'grid\s*:\s*\[',
    'stack': r'\bstack\s*:',
    'smooth line': r'\bsmooth\s*:\s*true',
    'step line': r'\bstep\s*:',
    'area fill': r'\bareaStyle\b',
    'gradient fill': r'LinearGradient|RadialGradient',
    'rose/nightingale pie': r'\broseType\b',
    'donut (pie radius pair)': r"radius\s*:\s*\[",
    'label formatter': r'formatter\s*:',
    'tooltip trigger axis': r"trigger\s*:\s*'axis'",
    'emphasis focus (dim others on hover)': r"focus\s*:\s*'",
    'legend selection/scroll': r"legend\s*:\s*\{[^}]*type\s*:\s*'scroll'",
    'universalTransition (morph between charts)': r'universalTransition',
    'large data / sampling / progressive': r'\blarge\s*:\s*true|\bsampling\s*:|\bprogressive\b',
    'animation tuning (race, delay)': r'animationDuration|animationDelay|realtimeSort',
    'realtime sort (bar race)': r'realtimeSort',
    'aria / decal (accessible patterns)': r'\baria\s*:|\bdecal\b',
    'click / event handlers': r"\.on\(\s*'(click|mouseover|brushselected|legendselectchanged|datazoom)",
    'dispatchAction (programmatic highlight)': r'dispatchAction',
    'setOption updates (live data)': r'setInterval|setTimeout',
    'media queries (responsive)': r'\bmedia\s*:',
    'encode (map columns to x/y)': r'\bencode\s*:',
    'seriesLayoutBy': r'seriesLayoutBy',
    'regression / ecStat': r'ecStat|regression',
    'drill down': r'drill|childGroupId|dataGroupId',
}
series_count = collections.Counter()
series_ex = collections.defaultdict(list)
feat_count = collections.Counter()
feat_ex = collections.defaultdict(list)
files = sorted(root.rglob('*.ts'))
for f in files:
    text = f.read_text(encoding='utf-8', errors='replace')
    name = str(f.relative_to(root))[:-3]
    used = {s for s in SERIES if re.search(r"type\s*:\s*'" + s + r"'", text)}
    for s in used:
        series_count[s] += 1
        series_ex[s].append(name)
    for label, pattern in FEATURES.items():
        if re.search(pattern, text):
            feat_count[label] += 1
            feat_ex[label].append(name)
print(f'{len(files)} examples read\n\nSERIES TYPES (examples using each)')
for s, n in series_count.most_common():
    print(f'  {n:3d}  {s:14s} e.g. {", ".join(series_ex[s][:4])}')
print('\nFEATURES (examples using each)')
for label, n in feat_count.most_common():
    print(f'  {n:3d}  {label:50s} e.g. {", ".join(feat_ex[label][:4])}')
