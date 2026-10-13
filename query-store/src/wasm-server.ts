// THE STORE IN THIS PAGE: upstream's `/api/pure/v1/query` answered without a server, by legend-lite's own rules
// (core's `com.legend.queries.SavedQueries`, the ones its server and Python's native library answer with) compiled to
// WebAssembly (//query-store:page), over the page's own records (records.ts: IndexedDB, so every app on this origin
// shares them) -- one implementation, only the storage the page's (docs/ONE_PLATFORM_PROGRAM_2026_10_12.md B5). Each
// call hands the module every record and writes back every query it wrote; the module keeps nothing between calls, so
// two tabs over the one IndexedDB see each other's queries at their next call. It is handed to the one client
// (client.ts) in place of the network, and the one wire-level suite (test/conformance.ts) runs against it and against
// legend-lite's server alike.
//
// What it cannot be is a server: its queries live in this browser only, and its user is the name the page was
// configured with, not someone signed in.

import type { Query } from './wire.ts';
import type { Records } from './records.ts';

/** The API root the page's store answers at: never on the network (`fetch` below answers it). */
export const LOCAL_API = 'http://this-browser.invalid/api';

/** What the module exports (`com.legend.queries.page.QueriesPage`). */
export interface QueriesModule {
  readonly exports: {
    answer(method: string, rest: string, rawQuery: string, body: string, user: string, records: string): string;
  };
}

/** The module, from the directory holding its `classes.wasm` and TeaVM's runtime (`<vendor>queries/`). */
export async function loadQueriesModule(base: string, load?: (runtimeUrl: string) => Promise<unknown>): Promise<QueriesModule> {
  const dir = base.endsWith('/') ? base : `${base}/`;
  const runtimeUrl = `${dir}wasm-gc-module-runtime.js`;
  const runtime = (load ? await load(runtimeUrl) : await import(/* @vite-ignore */ runtimeUrl)) as {
    load(src: string, options?: unknown): Promise<QueriesModule>;
  };
  return runtime.load(`${dir}classes.wasm`, {
    stackDeobfuscator: { enabled: false },
    installImports(imports: Record<string, unknown>) {
      imports.teavmConsole = { putcharStdout() {}, putcharStderr() {} };
    },
  });
}

export interface WasmServerOptions {
  readonly module: QueriesModule;
  readonly records: Records;
  /** Who this page's caller is: the page's configured user (there is no sign-in here). */
  readonly user: string;
}

export interface LocalServer {
  /** One request to `LOCAL_API/pure/v1/query...`, answered as the server answers it. */
  handle(request: Request): Promise<Response>;
  /** The same, shaped as `fetch`: what the client is handed. */
  readonly fetch: typeof fetch;
}

const answer = (status: number, body: string): Response =>
  new Response(status === 204 ? null : body, { status, headers: { 'Content-Type': 'application/json' } });

export function wasmQueryServer(options: WasmServerOptions): LocalServer {
  const { module, records, user } = options;
  // ONE CALL AT A TIME, as the server's `synchronized` methods: a read-modify-write is never interleaved in this tab
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const next = queue.then(f, f);
    queue = next.catch(() => undefined);
    return next;
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const at = url.pathname.indexOf('/pure/v1/query');
    if (at < 0) {
      return answer(404, JSON.stringify({ code: -1, message: `no such API in this page's query store: ${url.pathname}`, status: 'error' }));
    }
    const rest = url.pathname.slice(at + '/pure/v1/query'.length);
    const body = request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
    return serial(async () => {
      // every query's versions, by its id, as the rules read them
      const held: Record<string, readonly Query[]> = {};
      for (const versions of await records.all()) {
        const id = versions[0]?.id;
        if (id !== undefined) held[id] = versions;
      }
      const said = JSON.parse(module.exports.answer(request.method, rest, url.search.replace(/^\?/, ''), body, user,
        JSON.stringify(held))) as { status: number; body: string; changed: Record<string, Query[]> };
      for (const [id, versions] of Object.entries(said.changed)) await records.put(id, versions);
      return answer(said.status, said.body);
    });
  };

  return {
    handle,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init))) as typeof fetch,
  };
}
