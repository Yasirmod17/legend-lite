// DuckDB in this tab, for an app that runs queries here (Query, Studio): its bundle from the app's own vendor/ (never a
// CDN: a cross-origin worker is forbidden, and a deployment behind a firewall has none), one connection -- the query
// engine, its session set up as the planner's SQL assumes before anything uses it (engine.ts setUpSession) -- and the
// database itself, into which a model's test data is loaded (model-data.ts).

import * as duckdb from './duckdb-wasm.ts';
import { DuckDbEngine, type ArrowishConnection } from './duckdb.ts';
import { setUpSession } from './engine.ts';
import type { FileSink } from './model-data.ts';

export interface DuckDbInTab {
  readonly engine: DuckDbEngine;
  /** Where a model's test data and a person's files go: a file by name (text or bytes), and SQL on the engine's connection. */
  readonly data: FileSink;
}

/**
 * `vendor`: the URL of the folder holding duckdb-{mvp,eh}.wasm and their workers. `setup`: the planner's session setup
 * for a database's type (WasmGrammar's sessionSetup), run on the connection before it is handed out.
 */
export async function startDuckDbInTab(vendor: string,
  setup: (databaseType: string) => Promise<readonly string[]>): Promise<DuckDbInTab> {
  // absolute URLs: the worker resolves its module against its own location, not the page's
  const asset = (f: string): string => new URL(f, new URL(vendor, globalThis.location.href)).href;
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: asset('duckdb-mvp.wasm'), mainWorker: asset('duckdb-browser-mvp.worker.js') },
    eh: { mainModule: asset('duckdb-eh.wasm'), mainWorker: asset('duckdb-browser-eh.worker.js') },
  });
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), new Worker(bundle.mainWorker!));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const engine = new DuckDbEngine((await db.connect()) as unknown as ArrowishConnection);
  await setUpSession(engine, setup);
  return {
    engine,
    data: {
      registerFileBuffer: (name, bytes) => db.registerFileBuffer(name, bytes),
      run: (sql) => engine.run(sql, 0),
    },
  };
}
