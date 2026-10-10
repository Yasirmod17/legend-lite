# DataCube charts and dashboards: what the ECharts gallery shows we need (design, 2026-10-09)

The DataCube + Python line. The order (§3) and the maps (§4) are agreed with the user (2026-10-09); §6 lists what is
still open. This builds on `docs/DATACUBE_DASHBOARDS_DESIGN_2026_09_28.md` (the chart spec, the page model and its
linking rules, milestones M0-M5) rather than replacing it: batch 1 here is that design's M3 and M4, never built.

## 0. The ask

The user, 2026-10-09: "all the charts -- look at echarts examples"; then "definitely look through all the examples on
their example page -- what are important features are there for BI/visualization/dashboarding that we need to add to
Datacube?" And on maps: "yes long/lat", world regions "that would only download to browser when used/needed", and
borders "configurable by where the user is".

## 1. What was read

All 377 examples of the gallery, from its source repository: their list by category, and each one's source, counted for
the chart kinds and features it uses (`docs/datacube-charts-homework-2026-10-09/`: `examples.md`, `census.txt`, and the
two scripts that made them). The kinds, by how many examples use each: line 59, bar 57, scatter 43, pie 22, graph 16,
custom 16, heatmap 14, gauge 12, then effectScatter, lines, pictorialBar, sankey, sunburst, tree and treemap (7 each),
candlestick and map (6), radar (5), chord, funnel and parallel (4), boxplot (3), themeRiver (2). The features: a label
or axis formatter 95, a value-coloured scale (visualMap) 45, the toolbox (save as image, data view, switch kind) 44,
dimming the rest on hover 39, zoom and pan (dataZoom) 34, a second value axis 31, timed updates 26, reference lines 13,
pinned highest and lowest 7, shaded bands 3, several grids 14 and the matrix 13 (small multiples), large-data modes 15,
brush selection 6, a crosshair shared across charts 4, drill-down 3. (3D is a separate gallery, echarts-gl: not read.)

## 2. What DataCube has

Seven kinds -- bar, line, area, scatter, pie, heatmap, treemap (`datacube/src/chart-spec.ts`) -- and six options:
orientation, stack (none, stacked, 100%), sort, top N, labels, legend position. A chart is a view of its grid's query,
regrouped by its own encoding; the database aggregates, the chart only draws (`chart-option.ts`, the one file that
builds the ECharts option; `chart-render.ts`, the one that draws). A click on a mark filters the chart's own grid (a
chart's selection, `page/cube-page.ts`). A chart exports as a picture. ECharts 6.1.0 is registered piece by piece
(`echarts/core`) and loads only when a chart first draws (`test/bundle-budget.test.ts` holds it out of the grid's
startup). `chart-option.ts`'s house rules: the dataviz palette, bars at most 24 px wide, one value axis.

## 3. What to add, in order (agreed)

Each batch lands on its own (an audit, the local gate, CI, the user's OK), and each reaches Python the moment it lands:
`ll.Page` writes the same chart spec and page document, and `datacube/test/python-vocabulary.test.ts` holds Python's
words to DataCube's.

### Batch 1: the dashboard around the charts (the dashboards design's M3 and M4)

The largest gaps are not in the charts.

1. **Page filters.** A filter for the whole page -- a date range, a pick-list of values, a number range -- shown in the
   page's bar, reaching every tile whose source has the column (the dashboards design §5.4: "all tiles except
   excluded"; each tile says what filters it). Saved in the page document (its version 4: `filters`), never in a
   tile's own cube, so a grid exported alone is still the grid alone.
2. **Cross-filtering.** A click (and, batch 2, a brush) on one tile filters the others on the page, not only its own
   grid; the tile clicked highlights its mark rather than filtering itself. Within one source first; then across
   sources through declared links -- a column of one source named as a column of another, suggested by name and type,
   confirmed by the user (§5.4's links; a tile not linked says so).
3. **A KPI tile.** One number, large, in the grid's format; under it how it stands against a target (a percentage,
   good or bad by which way is good), and an optional small trend line; its change against the period before is batch
   4's (it needs the period before computed). As built, a chart kind (`mark: 'kpi'`), not a tile kind of its own: it
   is a view of its grid's query as every chart is, so it has a chart's every way -- placed beside its grid, on any
   sheet, stacked, following the grid's measure or frozen, saved, and Python's `grid.chart('kpi', ...)` -- with none
   of it written twice; its options carry the target and which way is good.

### Batch 2: the charts made dashboard-grade

1. **Bar and line together**, one series a bar and another a line, on one axis when they share a unit and on two when
   they do not -- each axis then labelled in its series' colour (§6, decided).
2. **Reference lines and colour by value**: a target, an average or a constant as a line; a shaded period or band;
   the highest and lowest pinned; a series coloured by thresholds (red below target).
3. **The grid's own number formats** on every axis, label and tooltip (currency, percent, thousands and millions),
   from the column's format in the grid, so a chart never says 15054092 where the grid says $15.1M.
4. **A real time axis, zoom and pan**: a date across is a time scale (gaps are gaps), a slider under a long series,
   and point thinning (ECharts' sampling) so a long series stays quick (the dashboards design's "~100k points").
5. **Drill-down in a chart**: a click on a bar goes one level down the grid's own row groupings (region, then desk),
   with the path shown and a way back up; it uses the grid's groupings, so a chart drills as its grid does.
6. **Brush to filter**: drag across a date range, or around a region of a scatter, to filter -- today's click-to-filter
   for a range (two conditions, from and to; four on a scatter's two columns).
7. **The cheaper options** with them: smooth and step lines, a log axis, axis breaks, label position and rotation,
   dimming the rest on hover, pattern fills for readers who cannot tell colours apart (ECharts' decal), and switching a
   chart's kind in place.

### Batch 3: new kinds over the query DataCube already runs (groupings and measures)

Each is drawing work over rows the database already grouped, as the seven are: **waterfall** (a profit-and-loss
bridge: each bar starts where the one before ended), **funnel**, **gauge** or **progress** against a target, **donut
variants** (half, two rings), **bubble** (a scatter whose size is a measure), **sunburst** (the row groups as rings, as
the treemap draws them as boxes), **Sankey** (two groupings as from and to, a measure as the flow), **calendar heatmap**
(a date grouping laid out as a calendar), **radar** (one shape per value, a measure per spoke), and **small multiples**
(one chart per value of a column, side by side, on shared axes).

### Batch 4: new kinds that need the database to compute something new

The rule holds -- the database computes, the chart draws -- so each needs the query to say more, and an aggregate
DataCube does not have becomes one it has (and Python's `AGGREGATES` with it):

| Kind | What the query must compute |
|---|---|
| Histogram | bins: a value's bucket as a grouping (its width chosen, or from the column's range) |
| Box plot | the quartiles (`quantile_cont` in DuckDB): new aggregates, or one "quartiles" measure |
| Candlestick, OHLC | open, high, low, close per period: `first` and `last` by time, new aggregates |
| Trend line | a regression (`regr_slope`, `regr_intercept`), drawn over the scatter or line |
| KPI change | the same measure for the period before, or a running window (DataCube's window columns) |

### Batch 5: maps (§4)

### Left for later

Network graphs, flow lines between places, fully custom series, picture bars, parallel coordinates, themeRiver, bar
races and timelines (storytelling, of little use in BI), 3D. And not adopted at all: ECharts' own data transforms
(filter, sort, aggregate in the chart), since the database does that.

## 4. Maps (agreed)

What a map is in practice: regions coloured by a measure (revenue by country, headcount by state: a choropleth), and
bubbles placed by latitude and longitude. Both offline: everything a map draws ships with DataCube.

1. **The shapes** are Natural Earth's (public domain), prepared at build time and fetched by the browser only when a
   map draws. Sizes as published (measured 2026-10-09, `github.com/nvkelso/natural-earth-vector`, `geojson/`):

   | Shapes | Published | What a browser fetches |
   |---|---|---|
   | World countries, 1:110m | 0.8 MB | one file, about 100-200 KB once simplified and compressed |
   | World countries, 1:50m | 3.1 MB | not needed for a tile |
   | States and provinces, the whole world (1:10m) | 41 MB | never as one: one file per country |
   | One country's states or provinces | (part of the 41 MB) | tens to a few hundred KB, only for the country drawn |

2. **Prepared at build time**: simplified to a tile's size and split by country, keeping the borders neighbouring
   regions share identical (simplified one by one, neighbours part and leave slivers between them). The tool is open
   (§6, open 2); not Node.
3. **Matching the data to the shapes**: a column of ISO codes ("USA", "GBR") matches exactly; names ("United States",
   "US") through Natural Earth's own name fields. Rows that match no region are said ("3 regions not found: ..."), as
   the treemap says what it leaves out.
4. **Borders by who is looking**: Natural Earth publishes country borders as 31 countries draw them (Argentina,
   Bangladesh, Brazil, China, Egypt, France, Germany, Greece, India, Indonesia, Israel, Italy, Japan, Korea, Morocco,
   Nepal, the Netherlands, Pakistan, Palestine, Poland, Portugal, Russia, Saudi Arabia, Spain, Sweden, Taiwan, Turkey,
   Ukraine, the UK, the US, Vietnam), and an ISO view. Each is prepared the same way and fetched only when used. The
   deployment sets the default; a user may choose another in settings; a deployment may let it follow the browser's
   region setting (an India-English browser, India's view) -- the browser's setting, never where the person is. A page
   shared draws in the viewer's view, not its author's, and a map says which view it draws. The views are of country
   borders; the provinces come in one version, by who controls an area.
5. **Projections**: the world in a projection that keeps areas honest; the US with Alaska and Hawaii set in below.
6. **Bubbles by latitude and longitude** on the same shapes, and **your own shapes** (sales territories, a floor
   plan) from a file the user gives.
7. **Not built**: street-level maps (background tiles from a tile server on the internet, with its limits and fees).
8. A click on a region filters, as a click on a bar does; a map zooms and pans.

## 5. Across every batch

- **The spec stays ours, plain JSON** (the dashboards design §6). A new kind is a new `mark`; an older DataCube
  opening a page with a kind it does not know refuses it by name (`page-document.ts`'s reader already does). New page
  parts (filters, KPI tiles, links) move the page document's version, read back from every version before it.
- **Download**: the chart chunk gets a budget of its own beside the grid's (`bundle-budget.test.ts`), raised on purpose
  with each batch, and the rarer kinds -- maps first -- go in chunks of their own, fetched with their first chart.
- **Accessible**: each kind says what it shows in words (`describe`), and pattern fills are one option away.
- **Tests**: each kind's option tested in node, drawn as SVG (`chart-option` tests); each batch's interactions in
  Chromium (`verify_*`); Python's words read against DataCube's (`python-vocabulary.test.ts`).

## 6. Decided, and open

**Decided (the user, 2026-10-09):** the work happens on this branch, `datacube-charts`, batch by batch, this note
landing with the first ("we should do everything on branch here -- definitely start"); and a second value axis, as
recommended ("yes on 2 axis"): only for a bar-and-line chart whose two measures differ in unit, each axis labelled in
its series' colour, one axis otherwise -- `chart-option.ts`'s rule changes to say so.

**Open:**

1. **Regions beyond countries and their provinces** (UK regions, EU regions): not planned; Natural Earth's provinces
   cover most countries, and a user's own shapes cover the rest.
2. **The map-preparation tool**: a pinned Python tool run at build time, or files prepared once and committed with how
   they were made. To be chosen when batch 5 starts, with the measured sizes.
