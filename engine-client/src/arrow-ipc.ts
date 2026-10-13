// An Arrow IPC stream read as a DuckDB connection's answer: apache-arrow, the reader DuckDB-WASM's own answers come
// from. For a connection whose database answers in IPC -- Python's DuckDB under DataCube's headless host
// (datacube/src/headless/host.ts; docs/DATACUBE_HEADLESS_PYTHON_DESIGN_2026_10_11.md §3). A module of its own, so a
// page that never reads IPC this way imports nothing more.

import { RecordBatchReader, Table, tableFromIPC } from 'apache-arrow';

import type { ArrowishTable } from './duckdb.ts';

/** One Arrow IPC stream (the stream format) as the table a connection's `query` answers. */
export function arrowIpcTable(stream: Uint8Array): ArrowishTable {
  return tableFromIPC(stream) as unknown as ArrowishTable;
}

/** One Arrow IPC stream as a host's answer: its table, and what its schema's metadata says beside the rows (a host that
 *  plans and runs in one step carries its plan there: Python's plan-and-run). */
export function arrowIpcAnswer(stream: Uint8Array): { readonly table: ArrowishTable; readonly metadata: ReadonlyMap<string, string> } {
  const table = tableFromIPC(stream);
  return { table: table as unknown as ArrowishTable, metadata: table.schema.metadata };
}

/**
 * An Arrow IPC stream read as it comes (an engine's answer sent a batch at a time: Python's plan-and-run, G2): its
 * schema's metadata as soon as the schema has come, then each batch as a table of its own, none kept.
 */
export async function arrowIpcBatches(answer: Response): Promise<{
  readonly metadata: ReadonlyMap<string, string>;
  readonly tables: AsyncIterable<ArrowishTable>;
}> {
  const reader = await RecordBatchReader.from(answer);
  await reader.open();
  return {
    metadata: reader.schema.metadata,
    tables: (async function* () {
      for await (const batch of reader) yield new Table([batch]) as unknown as ArrowishTable;
    })(),
  };
}
