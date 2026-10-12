// PYTHON'S SERVICES (docs/DATACUBE_ONE_APP_DESIGN_2026_10_11.md §3.2, §4.3, §5; step 2a): what DataCube's app runs on
// when Python shows it -- in a tab of its own (demo/engine.ts, over HTTP to Python's engine with its token) or under a
// notebook's cell (demo/widget.ts, over the widget's channel, which the notebook authenticates). The app is the tab's;
// only these services differ.
//
// - THE ROWS ARE PYTHON'S (R4): the page sends Pure, never SQL. Python plans it with its planner and runs the SQL on its
//   DuckDB, and the rows come back in upstream's Arrow format, declared (RemoteRun over the engine's pure/v1 execute).
//   A grid's columns, a query's print, are Python's compiler's answers the same way.
// - THE DATA IN is Python's frames: each a model Python wrote when the frame was registered (`cube.json?table=`).
// - PYTHON IS ANOTHER EDITOR of what the page shows (§5): it changes the page (`ll.Page`) and its frames, the page
//   follows their versions (`version.json`, or the widget's), and it says what it is now, for `page.read()`
//   (`page.json`, with the version it opened: what it says of a page Python has replaced is refused).
//
// - A PAGE'S FILE (an upload, an example) goes into Python's DuckDB (step 2b): its bytes to Python (`file.json`), read
//   there by DataCube's own code (upload.ts, run headless), which writes its model; the grid's rows are then Python's
//   over that model, as a frame's are. Offered where Python says it takes files (`services.json`: the datacube extra).
//
// What Python does not answer yet is a service it does not give, and the app does not offer what reads it (§3.4): its
// page store (Save, Open…: step 2d), a remote file (2b's second part), the other planes (2c), its model home and saved
// queries (step 3). A share link needs an address others can open; Python's is this machine's loopback.

import { LegendEngineExecutor } from '../../../engine-client/src/engine-remote.ts';
import { ExactNumber, fromJson, type ValueSpecification } from '../../../pure-protocol/src/index.ts';
import { base64 } from '../headless/web.ts';
import { pageToJson, readPage, type PageDocument } from '../page-document.ts';
import { RemoteRun } from '../runner.ts';
import type { UploadResult } from '../upload.ts';
import type { BrowserService, DatabaseService, FrameModel, LivePage, PlaneService, Services, Versions } from '../app/services.ts';

/** How the page reaches Python's engine. */
export interface PythonLink {
  /** What every call's path goes under: a tab's own origin, or the widget channel's base (widget-loader.ts). */
  readonly baseUrl: string;
  /** What carries the calls: the page's fetch, or the widget channel's. */
  readonly fetch: typeof fetch;
  /** The `Authorization` header the engine asks for over HTTP (`Bearer <token>`); a notebook's channel needs none. */
  readonly authorization?: string;
}

/** What Python shows: a page of its own (`ll.Page`, by its key), or one frame (`ll.show(df)`: a page of one grid). */
export type PythonShows = { readonly page: string } | { readonly frame: string };

/** What Python's host offers beside its frames (`services.json`): whether it reads a page's file. */
export interface PythonOffers {
  readonly files: boolean;
}

export interface PythonServicesOptions {
  readonly link: PythonLink;
  readonly shows: PythonShows;
  /** What Python said it offers (`askedOffers`), asked once as the page starts. */
  readonly offers: PythonOffers;
  /**
   * How the page is told that Python moved what it shows: at once of the versions now, then as they move, or why
   * Python no longer says (a string). A tab asks (`askedVersions`, about once a second); a notebook's widget is told
   * (its `versions`, or its frame's `version`). Returns what stops it.
   */
  readonly watch: (moved: (now: Versions | string) => void) => () => void;
  /** The browser's own things where the page is: a tab's (its title too), a notebook's (no title of its own). */
  readonly browser: BrowserService;
}

/** Where the page plans: Python's planner, the one plane it offers until the planes come to Python (step 2c). */
const PYTHON_PLANE: PlaneService = { word: 'local', planes: [], choose: () => undefined };

const headers = (link: PythonLink): Record<string, string> =>
  (link.authorization === undefined ? {} : { Authorization: link.authorization });

/** What the engine answered to `path`, as text, or -- refused -- why, in the page's words. */
async function asked(link: PythonLink, path: string): Promise<string> {
  const answer = await link.fetch(`${link.baseUrl}/${path}`, { headers: headers(link) })
    .catch((e: unknown) => { throw new Error(`the engine did not answer: ${String(e)}`); });
  if (!answer.ok) throw new Error(`the engine did not say what to show: ${answer.status} ${await answer.text()}`);
  return answer.text();
}

/** A frame as Python says it is now (`cube.json`): the model Python wrote for it, and its version. */
async function frameOf(link: PythonLink, name: string): Promise<FrameModel> {
  const said = JSON.parse(await asked(link, `cube.json?table=${encodeURIComponent(name)}`)) as {
    model: string; runtime: string; source: ValueSpecification; version: number;
  };
  return { model: said.model, runtime: said.runtime, source: said.source, version: said.version };
}

/** What Python's host offers the page (`services.json`), or why it did not say. */
export async function askedOffers(link: PythonLink): Promise<PythonOffers> {
  const said = JSON.parse(await asked(link, 'services.json')) as { files?: unknown };
  if (typeof said.files !== 'boolean') throw new Error(`the engine did not say whether it reads a page's file: ${JSON.stringify(said)}`);
  return { files: said.files };
}

/** A call carrying JSON to Python: its answer's text, or -- refused -- Python's reason. */
async function posted(link: PythonLink, path: string, body: unknown): Promise<string> {
  const answer = await link.fetch(`${link.baseUrl}/${path}`, {
    method: 'POST',
    headers: { ...headers(link), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((e: unknown) => { throw new Error(`the engine did not answer: ${String(e)}`); });
  const text = await answer.text();
  if (!answer.ok) throw new Error(text || `the engine answered ${answer.status}`);
  return text;
}

/**
 * Python's DuckDB as the page's database: its frames, and -- where Python takes them -- a page's file, read there by
 * DataCube's own code into the table the page named (the page's table names are its own: no grid's is replaced).
 */
function pythonDatabase(link: PythonLink, offers: PythonOffers): DatabaseService {
  return {
    frame: (name) => frameOf(link, name),
    ...(offers.files ? {
      ingestFile: async (file: File, options: { readonly table: string }) => JSON.parse(await posted(link, 'file.json', {
        name: file.name, bytes: base64(new Uint8Array(await file.arrayBuffer())), table: options.table,
      })) as UploadResult,
      forgetFile: async (fileName: string, table: string) => { await posted(link, 'forget.json', { name: fileName, table }); },
    } : {}),
  };
}

/** The page Python serves (`page.json`), as the protocol's exact JSON reads it: a calculated column's `12.30` stays. */
function livePage(link: PythonLink, key: string): LivePage {
  const at = `page.json?page=${encodeURIComponent(key)}`;
  return {
    read: async () => {
      const said = fromJson(await asked(link, at)) as { version: unknown; page: unknown };
      const version = said.version instanceof ExactNumber && said.version.isInteger ? Number(said.version.text) : NaN;
      if (!Number.isSafeInteger(version)) throw new Error('the engine said no version of the page');
      return { version, page: readPage(said.page) };
    },
    report: async (version: number, page: PageDocument) => {
      const answer = await link.fetch(`${link.baseUrl}/${at}&version=${version}`, {
        method: 'POST',
        headers: { ...headers(link), 'Content-Type': 'application/json' },
        body: pageToJson(page),
      });
      if (!answer.ok) throw new Error(`the engine refused the page: ${answer.status} ${await answer.text()}`);
    },
  };
}

/**
 * The versions Python says now (`version.json`) of what it shows -- a page's own and each of its frames', or one
 * frame's -- or why it does not say (the page or the frame closed, the engine gone).
 */
export async function askedVersions(link: PythonLink, shows: PythonShows): Promise<Versions | string> {
  const query = 'page' in shows ? `page=${encodeURIComponent(shows.page)}` : `table=${encodeURIComponent(shows.frame)}`;
  const answer = await link.fetch(`${link.baseUrl}/version.json?${query}`, { headers: headers(link) }).catch(() => undefined);
  if (answer === undefined) return 'the engine stopped';
  if (answer.status === 404) return 'page' in shows ? 'the page was closed' : 'the frame was closed';
  if (!answer.ok) return `the engine answered ${answer.status}`;
  const said = (await answer.json()) as { version: number; frames?: Record<string, number> };
  return 'page' in shows ? { version: said.version, frames: said.frames ?? {} } : { frames: { [shows.frame]: said.version } };
}

/** Python's services, over its link. */
export function pythonServices(o: PythonServicesOptions): Services {
  const { link } = o;
  return {
    engine: {
      plane: PYTHON_PLANE,
      label: 'Python',
      // planned and run by Python: the page sends Pure, and the rows come back (R4). A mapping or enumerations would
      // change the plan, and Python plans over the model it wrote: refused rather than dropped. Bit columns are a
      // reading of legend-engine's types (relation-type.ts, S23), not of legend-lite's, which Python plans with
      rows: (model, runtime, how) => {
        if (how?.mapping !== undefined || (how?.enumerations?.length ?? 0) > 0) {
          throw new Error('Python plans a source over the model it wrote: it takes no mapping or enumerations from the page');
        }
        return {
          runner: new RemoteRun(new LegendEngineExecutor({
            baseUrl: link.baseUrl,
            model,
            runtime,
            serializationFormat: 'ARROW_IPC',
            ...(link.authorization === undefined ? {} : { authorization: link.authorization }),
            fetch: link.fetch,
          })),
        };
      },
      database: pythonDatabase(link, o.offers),
    },
    live: {
      watch: o.watch,
      ...('page' in o.shows ? { page: livePage(link, o.shows.page) } : {}),
    },
    browser: o.browser,
  };
}
