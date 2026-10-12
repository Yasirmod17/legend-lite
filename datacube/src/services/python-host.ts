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
import { HostRecords, RuleStore, type HostRecordsCall } from '../cube-store.ts';
import { pageToJson, readPage, type PageDocument } from '../page-document.ts';
import { RemoteRun } from '../runner.ts';
import type { InferredModel } from '../infer.ts';
import type { S3Credentials } from '../remote.ts';
import { fileBytes, type UploadResult } from '../upload.ts';
import type {
  BrowserService, DatabaseService, FrameModel, LivePage, PageService, Plane, PlaneService, PlaneWord, Services, Versions,
} from '../app/services.ts';

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

/** A plane as Python names it: its word, and what the planner menu says of it. */
export interface PythonPlane {
  readonly word: PlaneWord;
  readonly label: string;
}

/** What Python's host offers beside its frames (`services.json`): whether it reads a page's file, the plane it plans on
 *  (chosen once, in Python: R3), and every plane it offers (today only that one: another is step 2c's). */
export interface PythonOffers {
  readonly files: boolean;
  /** Whether it reads a page's remote file (the httpfs extension it carries). */
  readonly remote: boolean;
  /** Where it keeps the page's saved pages (this user's folder), and whose they are. */
  readonly pages: { readonly where: string; readonly user: string };
  readonly plane: PythonPlane;
  readonly planes: readonly PythonPlane[];
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

const WORDS: readonly PlaneWord[] = ['local', 'remote', 'engine'];

/** A plane Python said, read: its word one of the three every host says (§4.1), or refused. */
function planeOf(said: unknown): PythonPlane {
  const p = said as { word?: unknown; label?: unknown } | null;
  if (p === null || typeof p !== 'object' || !WORDS.includes(p.word as PlaneWord) || typeof p.label !== 'string') {
    throw new Error(`the engine named a plane this page does not know: ${JSON.stringify(said)}`);
  }
  return { word: p.word as PlaneWord, label: p.label };
}

/**
 * WHERE THE PAGE PLANS, as Python says (§4.1, R3): the plane Python plans on, chosen once in Python, and the planes it
 * offers, which the planner menu lists (the one the page is on disabled). Another plane is chosen in Python
 * (`ll.show(..., planner=...)`, step 2c), so a page asks for none: Python offers only its own until then.
 */
function pythonPlanes(offers: PythonOffers): PlaneService {
  // a plane offered here would be one the page could choose, which it cannot yet: refused, never a menu entry that
  // asks to reload and then fails
  const other = offers.planes.find((p) => p.word !== offers.plane.word);
  if (other) throw new Error(`the engine offers ${other.label}, and this page chooses no plane on Python yet (step 2c)`);
  const asPlane = (p: PythonPlane): Plane => ({ id: `host.plane.${p.word}`, word: p.word, label: p.label });
  return {
    word: offers.plane.word,
    planes: offers.planes.map(asPlane),
    choose: (plane) => {
      throw new Error(`${plane.label}: Python plans on ${offers.plane.word}, chosen in Python, not on this page`);
    },
  };
}

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
  const said = JSON.parse(await asked(link, 'services.json')) as {
    files?: unknown; remote?: unknown; pages?: { where?: unknown; user?: unknown }; plane?: unknown; planes?: unknown;
  };
  if (typeof said.files !== 'boolean' || typeof said.remote !== 'boolean') {
    throw new Error(`the engine did not say which of a page's files it reads: ${JSON.stringify(said)}`);
  }
  if (typeof said.pages?.where !== 'string' || typeof said.pages.user !== 'string') {
    throw new Error(`the engine did not say where it keeps saved pages: ${JSON.stringify(said)}`);
  }
  if (!Array.isArray(said.planes)) throw new Error(`the engine did not say which planes it offers: ${JSON.stringify(said)}`);
  return {
    files: said.files, remote: said.remote, pages: { where: said.pages.where, user: said.pages.user },
    plane: planeOf(said.plane), planes: said.planes.map(planeOf),
  };
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
        // the bytes the tab's DuckDB is given (upload.ts fileBytes): a text file decoded as the tab always has
        name: file.name, bytes: base64(await fileBytes(file)), table: options.table,
      })) as UploadResult,
      forgetFile: async (fileName: string, table: string) => { await posted(link, 'forget.json', { name: fileName, table }); },
    } : {}),
    // a remote file, read by Python's DuckDB through the httpfs extension Python carries; Python reads it only from a
    // remote URL, never from its own machine's files
    ...(offers.remote ? {
      mountRemote: async (url: string, s3: S3Credentials | undefined, name: string) =>
        JSON.parse(await posted(link, 'remote.json', { url, name, ...(s3 ? { s3 } : {}) })) as InferredModel,
    } : {}),
  };
}

/**
 * THE SAVED PAGES, in this user's folder (step 2d): the store's rules the page's own (RuleStore), over the records
 * Python keeps -- the browser's IndexedDB, in Python's terms (§6, Q1). Kept on disk, so nothing more to ask for to keep
 * them.
 */
function pythonPages(link: PythonLink, offers: PythonOffers): PageService {
  const carry = async (call: HostRecordsCall): Promise<unknown> => {
    const answer = await link.fetch(`${link.baseUrl}/saved-pages.json`, {
      method: 'POST',
      headers: { ...headers(link), 'Content-Type': 'application/json' },
      body: JSON.stringify(call),
    }).catch((e: unknown) => { throw new Error(`the engine did not answer: ${String(e)}`); });
    // every answer read whole, an empty one too: a response left unread is cancelled by the browser (it reported the
    // put as aborted, though Python had kept the record)
    const text = await answer.text();
    if (!answer.ok) throw new Error(`the engine refused the saved pages' ${call.call}: ${answer.status} ${text}`);
    // a record, the records, or -- none found, or put and removed -- nothing
    return text === '' ? undefined : (JSON.parse(text) as unknown) ?? undefined;
  };
  return {
    store: new RuleStore(new HostRecords(carry), offers.pages.user),
    where: `in ${offers.pages.where}`,
    memoryOnly: false,
    persist: async () => true,
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
      plane: pythonPlanes(o.offers),
      label: o.offers.plane.word,
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
    pages: Promise.resolve(pythonPages(link, o.offers)),
    live: {
      watch: o.watch,
      ...('page' in o.shows ? { page: livePage(link, o.shows.page) } : {}),
    },
    browser: o.browser,
  };
}
