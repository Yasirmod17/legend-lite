// The page's own store of saved pages: legend-lite's saved-page rules (core's SavedCubes) compiled to WebAssembly on
// the saved queries' module (//query-store:page) over the page's rows (src/cube-store.ts `wasmCubeServer`), held to the
// one suite the server and Python are -- and what only it can be asked: another user's page over the same rows, rows
// the rules cannot read, and two tabs over one store.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { fromJson } from '../../../pure-protocol/src/index.ts';
import { loadQueriesModule } from '../../../query-store/src/wasm-server.ts';
import { runfileDirUrl } from '../../../tools/js/runfiles.mts';
import {
  CubeStoreClient, CubeStoreError, LOCAL_CUBES_API, MemoryRecords, toRow, wasmCubeServer, type CubeRecords,
} from '../../src/cube-store.ts';
import { conformance } from './conformance.ts';

// Node loads the runtime by file URL and the module by path
const module = await loadQueriesModule(runfileDirUrl('QUERIES_PAGE'), async (runtimeUrl) => {
  const runtime = await import(runtimeUrl) as { load(src: string, options?: unknown): Promise<unknown> };
  return { load: (src: string, options?: unknown) => runtime.load(fileURLToPath(src), options) };
});
const load = async () => module;
const server = wasmCubeServer({ load, records: new MemoryRecords(), user: 'this browser' });
conformance("the page's own store, legend-lite's rules in WebAssembly", () => ({ api: LOCAL_CUBES_API, fetch: server.fetch, user: 'this browser' }));

const page = { id: 'p-1', name: 'Mine', content: { kind: 'datacube.page' } };

describe("the page's own saved pages: what a server here cannot be asked", () => {
  it('only the owner updates or deletes', async () => {
    const records = new MemoryRecords();
    const mine = new CubeStoreClient(LOCAL_CUBES_API, wasmCubeServer({ load, records, user: 'me' }).fetch, 'me');
    const theirs = new CubeStoreClient(LOCAL_CUBES_API, wasmCubeServer({ load, records, user: 'you' }).fetch, 'you');
    await mine.create(page);
    await assert.rejects(theirs.update('p-1', { ...page, name: 'Mine now' }),
      (e: unknown) => e instanceof CubeStoreError && e.status === 403 && e.message === 'Only owner can update the query');
    await assert.rejects(theirs.delete('p-1'), (e: unknown) => e instanceof CubeStoreError && e.status === 403);
    // and a search answers the caller's own first
    await theirs.create({ ...page, id: 'p-2', name: 'Theirs' });
    assert.deepEqual((await mine.search({})).map((q) => q.id), ['p-1', 'p-2']);
    assert.deepEqual((await theirs.search({})).map((q) => q.id), ['p-2', 'p-1']);
  });

  it('rows it cannot read: the engine 500, naming them, and nothing written', async () => {
    let wrote = 0;
    const odd: CubeRecords = {
      call: async (f) => {
        const said = f(new Map([['p-1', { id: 'p-1', content: 5 } as unknown as ReturnType<typeof toRow>]]));
        wrote += said.changed.size;
        return said.answer;
      },
    };
    const r = await wasmCubeServer({ load, records: odd, user: 'me' }).fetch(`${LOCAL_CUBES_API}/pure/v1/query/dataCube/p-1`);
    assert.equal(r.status, 500);
    assert.match(((await r.json()) as { message: string }).message, /the row of saved page 'p-1' is not one/);
    assert.equal(wrote, 0);
  });

  it("keeps nothing between calls: another tab's page, written to the same rows, is there at the next call", async () => {
    const records = new MemoryRecords();
    const one = new CubeStoreClient(LOCAL_CUBES_API, wasmCubeServer({ load, records, user: 'me' }).fetch, 'me');
    const two = new CubeStoreClient(LOCAL_CUBES_API, wasmCubeServer({ load, records, user: 'me' }).fetch, 'me');
    await one.create(page);
    assert.equal((await two.get('p-1')).name, 'Mine');
    await two.delete('p-1');
    assert.deepEqual(await one.search({}), []);
  });

  it('a row as it was kept before the rules were Java (its content the exact text) opens as it was', async () => {
    const records = new MemoryRecords();
    await records.call(() => ({
      changed: new Map([['old', toRow({ id: 'old', name: 'Kept', content: { kind: 'datacube.page', dec: 1 }, owner: 'me', createdAt: 1 })]]),
      answer: undefined,
    }));
    const client = new CubeStoreClient(LOCAL_CUBES_API, wasmCubeServer({ load, records, user: 'me' }).fetch, 'me');
    const got = await client.get('old');
    assert.deepEqual([got.name, got.createdAt, got.content], ['Kept', 1, fromJson('{"kind":"datacube.page","dec":1}')]);
  });
});
