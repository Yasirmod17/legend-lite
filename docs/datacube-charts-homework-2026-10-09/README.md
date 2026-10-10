# The ECharts gallery, read whole (homework for docs/DATACUBE_CHARTS_DESIGN_2026_10_09.md)

Every example of Apache ECharts' gallery (https://echarts.apache.org/examples/en/index.html), as its source repository
publishes them (github.com/apache/echarts-examples, branch gh-pages, read 2026-10-09; the examples are Apache-2.0):

- `examples.md`: the 377 examples by category, each its id and title, from `src/data/chart-list-data.js` (`list.py`).
- `census.txt`: which chart kinds and which features each example uses, counted, with examples of each (`census.py`
  over every example's source, `public/examples/ts/<id>.ts`). A feature is found by a pattern in the source (named in
  `census.py`), so a count is a close measure, not an exact one: an example that builds its option in a loop can be
  missed.

To make them again: download `src/data/chart-list-data.js` and every `public/examples/ts/<id>.ts` into a folder of
their own, then `python3 -I list.py <chart-list-data.js>` and `python3 -I census.py <the examples' folder>`. The
downloads are not kept here: they are the gallery's, and these two files are what the design reads from them.
