// A MEASUREMENT, not a test (docs/DATACUBE_MODEL_DESIGN_2026_10_10.md §11): what a page's model costs the tab's own
// compiler (the WASM module the tab loads) as it grows, and what a class over a table costs to read against the same
// table read as a relation, as DataCube reads one today. Manual, in //gates:heavy: `bazel test //datacube:model_scale_measure
// --test_output=all`; its numbers print, and are written to the test's undeclared outputs as model-scale.json.
//
// Every plan compiles the whole model again (wasm/src/main/java/planner/Boundary.java `plan`: Compiler.compileModel on
// each call), so a plan's time is the model's compile plus the query's. Each class is the design's §3.3 shape -- its
// own store, relation function, class and mapping -- and each class is related to the next by an Association mapped by a
// ModelJoin (`next`, to-one; `prev`, to-many), all in one page mapping, as §4.2 writes them.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';

import { WasmPlanner } from '../src/wasm-planner.ts';
import { runfileDirUrl } from '../../tools/js/runfiles.mts';

/** How many sources a page's model has, measured at each. */
const SIZES = [1, 10, 50, 200];
/** Plans timed per query and size, after two not timed (the module's own warm-up). */
const RUNS = 7;

const RELATION = 'meta::pure::metamodel::relation::Relation<meta::pure::metamodel::type::Any>[1]';

/** Source `i`'s store: its one table. */
const store = (i: number): string =>
  `Database files::t${i}::Store ( Table t${i} ( id INTEGER PRIMARY KEY, k INTEGER, v DOUBLE, s VARCHAR(16) ) )`;

/** A model of `n` sources read as tables, as DataCube writes one today (stores, a connection, a runtime). */
function tableModel(n: number): string {
  const range = [...Array(n).keys()];
  return [
    '###Relational', ...range.map(store),
    '###Connection',
    'RelationalDatabaseConnection page::Connection { store: files::t0::Store; type: DuckDB; specification: DuckDB { }; auth: Test; }',
    '###Runtime',
    `Runtime page::Runtime { mappings: [ ]; connections: [ ${range.map((i) => `files::t${i}::Store: [ c${i}: page::Connection ]`).join(', ')} ]; }`,
  ].join('\n');
}

/** A model of `n` sources read as classes, each related to the next (the design's §3.1 and §3.3). */
function classModel(n: number): string {
  const range = [...Array(n).keys()];
  const links = range.slice(0, -1);
  return [
    '###Relational', ...range.map(store),
    '###Pure',
    ...range.map((i) => `function files::t${i}::read(): ${RELATION} { #>{files::t${i}::Store.t${i}}# }`),
    ...range.map((i) => `Class files::t${i}::T${i} { id: Integer[1]; k: Integer[0..1]; v: Float[0..1]; s: String[0..1]; }`),
    ...links.map((i) => `Association page::Link${i} { next: files::t${i + 1}::T${i + 1}[0..1]; prev: files::t${i}::T${i}[*]; }`),
    '###Mapping',
    'import meta::pure::metamodel::relation::*;',
    'import meta::pure::metamodel::type::*;',
    ...range.map((i) => `Mapping files::t${i}::Mapping ( *files::t${i}::T${i}[t${i}]: Relation { ~func files::t${i}::read():Relation<Any>[1]`
      + ' id: id, k: k, v: v, s: s } )'),
    'Mapping page::Mapping (',
    ...range.map((i) => `  include files::t${i}::Mapping`),
    ...links.map((i) => `  page::Link${i}: ModelJoin { {next: files::t${i + 1}::T${i + 1}[1], prev: files::t${i}::T${i}[1] | $next.id == $prev.k} }`),
    ')',
    '###Connection',
    'RelationalDatabaseConnection page::Connection { store: files::t0::Store; type: DuckDB; specification: DuckDB { }; auth: Test; }',
    '###Runtime',
    `Runtime page::Runtime { mappings: [ page::Mapping ]; connections: [ ${range.map((i) => `files::t${i}::Store: [ c${i}: page::Connection ]`).join(', ')} ]; }`,
  ].join('\n');
}

/** The middle of the times, in milliseconds. */
function median(times: readonly number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** `query(k)` planned RUNS times over `planner` (a different `k` each time, so no plan is answered from a cache). */
async function timed(planner: WasmPlanner, query: (k: number) => string): Promise<number> {
  const times: number[] = [];
  for (let run = 0; run < RUNS + 2; run += 1) {
    const lambda = await planner.parse(`|${query(run)}`);
    const start = performance.now();
    const plan = await planner.plan(lambda);
    const took = performance.now() - start;
    assert.ok(plan.sql.length > 0, `a plan: ${query(run)}`);
    if (run >= 2) times.push(took);
  }
  return median(times);
}

it('a page\'s model as it grows: the median plan, in milliseconds', async () => {
  const assets = runfileDirUrl('WASM_PLANNER');
  const rows: Record<string, number | string>[] = [];
  for (const n of SIZES) {
    const tables = new WasmPlanner({ model: tableModel(n), runtime: 'page::Runtime', assetBaseUrl: assets, cache: false });
    const classes = new WasmPlanner({
      model: classModel(n), runtime: 'page::Runtime', mapping: 'page::Mapping', assetBaseUrl: assets, cache: false,
    });
    const table = await timed(tables, (k) => `#>{files::t0::Store.t0}#->filter(x|$x.id > ${k})->select(~[id, v])`);
    const asClass = await timed(classes, (k) => `files::t0::T0.all()->filter(x|$x.id > ${k})->project(~[id: x|$x.id, v: x|$x.v])`);
    const walking = n < 2 ? '' : await timed(classes, (k) =>
      `files::t0::T0.all()->filter(x|$x.id > ${k})->project(~[id: x|$x.id, next: x|$x.next.v])`);
    rows.push({ sources: n, 'model text (KB)': Math.round(classModel(n).length / 1024),
      'table read': Math.round(table), 'class read': Math.round(asClass), 'class, one end walked': walking === '' ? '' : Math.round(walking) });
  }
  console.log('\n' + ['sources', 'model text (KB)', 'table read', 'class read', 'class, one end walked'].join('\t'));
  for (const r of rows) console.log(Object.values(r).join('\t'));
  const out = process.env['TEST_UNDECLARED_OUTPUTS_DIR'];
  if (out) writeFileSync(path.join(out, 'model-scale.json'), JSON.stringify({ runs: RUNS, rows }, null, 2));
});
