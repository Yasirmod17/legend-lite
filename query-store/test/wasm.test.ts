// The page's own store: legend-lite's saved-query rules compiled to WebAssembly (//query-store:page) over the page's
// records (src/wasm-server.ts), held to the one suite the server is -- and what only it can be asked: another user's
// query over the same records, and a body that is not JSON.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { QueryStoreClient, QueryStoreError } from '../src/client.ts';
import { MemoryRecords } from '../src/records.ts';
import { LOCAL_API, loadQueriesModule, wasmQueryServer } from '../src/wasm-server.ts';
import { conformance } from './conformance.ts';
import { runfileDirUrl } from '../../tools/js/runfiles.mts';

const DIR = runfileDirUrl('QUERIES_PAGE');
// Node loads the runtime by file URL and the module by path
const module = await loadQueriesModule(DIR, async (runtimeUrl) => {
  const runtime = await import(runtimeUrl) as { load(src: string, options?: unknown): Promise<unknown> };
  return { load: (src: string, options?: unknown) => runtime.load(fileURLToPath(src), options) };
});
const records = new MemoryRecords();
const server = wasmQueryServer({ module, records, user: 'anonymous' });
conformance("the page's own store, legend-lite's rules in WebAssembly", () => ({ api: LOCAL_API, fetch: server.fetch, user: 'anonymous' }));

describe("the page's own store: what a server here cannot be asked", () => {
  it('only the owner updates or deletes', async () => {
    const shared = new MemoryRecords();
    const mine = new QueryStoreClient(LOCAL_API, wasmQueryServer({ module, records: shared, user: 'me' }).fetch);
    const theirs = new QueryStoreClient(LOCAL_API, wasmQueryServer({ module, records: shared, user: 'someone' }).fetch);
    const q = await mine.create({
      id: 'owned', name: 'Owned', groupId: 'demo', artifactId: 'trading', versionId: '0.0.0', content: '|1',
    });
    await assert.rejects(theirs.update({ ...q, name: 'Taken' }), (e: unknown) => e instanceof QueryStoreError && e.status === 403
      && e.message === 'Only owner can update the query');
    await assert.rejects(theirs.delete('owned'), (e: unknown) => e instanceof QueryStoreError && e.status === 403
      && e.message === 'Only owner can delete the query');
    // and "mine only" is the caller's
    assert.deepEqual((await theirs.search({ showCurrentUserQueriesOnly: true })).map((x) => x.id), []);
    assert.deepEqual((await mine.search({ showCurrentUserQueriesOnly: true })).map((x) => x.id), ['owned']);
  });

  it('a body that is not JSON: the engine 500, naming the error, as the server answers it', async () => {
    const r = await server.fetch(`${LOCAL_API}/pure/v1/query`, { method: 'POST', body: '{not json' });
    assert.equal(r.status, 500);
    assert.match(((await r.json()) as { message: string }).message, /^\w+(Exception|Error): /);
  });

  it('keeps nothing between calls: another tab\'s query, written to the same records, is there at the next call', async () => {
    const shared = new MemoryRecords();
    const one = new QueryStoreClient(LOCAL_API, wasmQueryServer({ module, records: shared, user: 'me' }).fetch);
    const two = new QueryStoreClient(LOCAL_API, wasmQueryServer({ module, records: shared, user: 'me' }).fetch);
    await one.create({ id: 'from-one', name: 'One', groupId: 'demo', artifactId: 'trading', versionId: '0.0.0', content: '|1' });
    assert.equal((await two.get('from-one')).name, 'One');
  });
});
