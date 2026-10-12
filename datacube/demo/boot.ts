// A runnable demo: real DuckDB-WASM in the browser, real snap mode, the real grid.
//
// ONE PAGE, its planner a setting (`chosenPlane`, `?planner=`): in this tab, legend-lite or
// legend-engine -- three addresses of the same service, built by planners.ts. The planner writes
// the SQL; DuckDB in this tab runs it. There is no fallback: a planner that does not answer is
// said (`refusePlanner`) and the page stops.

import { UI_LOCALE } from '../../engine-client/src/locale.ts';
import * as duckdb from '../../engine-client/src/duckdb-wasm.ts';

import { CubeApp, type HeldCopy } from '../src/app.ts';
import { PageApp, type GridMaker } from '../src/page/page-app.ts';
import { DEFAULT_CONFIGURATION, type CubeConfiguration } from '../src/config.ts';
import type { Planner } from '../src/cube.ts';
import type { ModelOptions } from '../src/planner.ts';
import { DuckDbEngine, type ArrowishConnection } from '../../engine-client/src/duckdb.ts';
import type { SeedSource } from '../../engine-client/src/model-data.ts';
import { mountRemote } from '../src/remote.ts';
import type { SectionId } from '../src/ui/source-picker.ts';
import { saveDialog } from '../src/ui/save-dialog.ts';
import { Latest, TabWork, mayLeave } from '../src/host.ts';
import { isPageFragment, readPageFragment, shareLink } from '../src/share/link.ts';
import type { CubeDocument } from '../src/cube-document.ts';
import { CubeLibrary } from '../src/ui/cube-library.ts';
import {
  pageContent,
  pageDefinitionText,
  readSaved,
  oneSheet,
  PAGE_VERSION,
  type PageDocument,
  type SavedDocument,
} from '../src/page-document.ts';
import type { TableModels } from '../src/infer.ts';
import { pageConfig } from './page-config.ts';
import { browserServices } from '../src/services/browser.ts';
import { pageSources, type Chosen, type GridPlace, type Opened, type SignedIn } from '../src/app/sources.ts';
import type { PlaneService, PlaneWord, Services } from '../src/app/services.ts';

// the query store's code, fetched the first time it is needed -- a query link -- as charts are: a grid-only page never
// downloads it (test/bundle-budget.test.ts)
const queryStores = () => import('../../query-store/src/index.ts');
import { makeWindow, type WindowSpec } from '../src/ui/window.ts';
import type { MenuItem } from '../src/ui/menu.ts';
import type { ColumnFormat } from '../src/format.ts';
import type { CubeSnapshot } from '../src/snapshot.ts';
import { sourceColumns } from '../src/source-columns.ts';
import { accessor, fn, type ValueSpecification } from '../../pure-protocol/src/index.ts';
import { classLambda, duplicateLambda, sampleLambda, storeTableOf } from '../src/query.ts';
import { writesModels } from '../src/model-writer.ts';
import type { PageModelRef } from '../src/page-model.ts';
import type { SnapTarget } from '../src/cube.ts';

const ROWS = 200_000;

/**
 * THE THREE PLANES, as data rather than as three copies of a menu.
 *
 * Each is one page loading one arrangement, statically: a bundle
 * decides who compiles the Pure and who runs it, and nothing at
 * runtime can change that (`test/guardrails.test.ts` -- the one time
 * shipped code could pick a planner by health check, the fallback hid
 * three real bugs for the life of the project). The menu navigates;
 * it does not switch.
 */
export const PLANES: readonly {
  readonly id: `host.plane.${string}`;
  /** Its `?planner=` word, and the status bar's. */
  readonly word: PlaneWord;
  readonly label: string;
}[] = [
  { id: 'host.plane.wasm', word: 'local', label: 'Plan local (in this tab)' },
  { id: 'host.plane.server', word: 'remote', label: 'Plan remote (legend-lite on :8080)' },
  { id: 'host.plane.engine', word: 'engine', label: 'Plan on the engine (legend-engine on :6300)' },
];

/** Where the page plans: in this tab, on legend-lite, or on legend-engine -- the same API (src/app/services.ts). */
export type { PlaneWord };

/** CREATE A CLASS… (docs/DATACUBE_MODEL_DESIGN_2026_10_10.md §15.1): a grid's own entry, in its menu's data group. */
const CREATE_CLASS = { id: 'host.createClass', label: 'Create a Class\u2026', section: 'data' } as const;
/** CREATE AN ASSOCIATION… and A DATA SPACE… (§15.1, §15.6a): the page's, in its menu's Model group; the first a grid's
 *  too, its class one end. */
const CREATE_ASSOCIATION = { id: 'host.createAssociation', label: 'Create an Association\u2026', section: 'data' } as const;
const CREATE_DATA_SPACE = { id: 'host.createDataSpace', label: 'Create a Data Space\u2026', section: 'data' } as const;

/**
 * THE ONE PLACE A PLANNER IS CHOSEN (the user, 2026-09-30): the page's `?planner=`, read once
 * as the page loads -- absent, the planner in this tab. ONE PAGE, three planners at three
 * addresses of the same API: the in-tab one by WebAssembly calls, legend-lite and legend-engine
 * over HTTP. The choice is explicit (the address, the status bar's picker), always shown (the
 * status bar names it), and never changed behind the user's back: an unknown word is refused,
 * and a planner that does not answer is SAID, never substituted (test/guardrails.test.ts).
 */
/**
 * WHAT THE PAGE WAS ASKED TO OPEN, decided before anything is generated or mounted
 * (docs/DATACUBE_APP_PLAN_2026_10_02.md, A3). Only `sample` builds the sample cube -- over the
 * generated trades, or over a `?remote=` file read through the same model. A share link or a saved
 * page in the address opens in place of nothing; so does the single-user app's launch key
 * (`#key=…&table=schema.name`, a fragment: never sent to a server).
 */
type Start =
  | { readonly kind: 'sample' }
  | { readonly kind: 'link' }
  | { readonly kind: 'warehouse'; readonly key: string; readonly table?: string };

async function startOf(where: Location): Promise<Start> {
  if (where.hash.startsWith('#key=')) {
    const p = new URLSearchParams(where.hash.slice(1));
    const table = p.get('table');
    return { kind: 'warehouse', key: p.get('key') ?? '', ...(table ? { table } : {}) };
  }
  if (isPageFragment(where.hash)) return { kind: 'link' };
  const queryLink = where.hash.replace(/^#\/shared\//, '#');
  if (queryLink.length > 1 && (await queryStores()).isQueryFragment(queryLink)) return { kind: 'link' };
  return { kind: 'sample' };
}

export function chosenPlane(): PlaneWord {
  const word = new URLSearchParams(location.search).get('planner') ?? 'local';
  const known = PLANES.find((plane) => plane.word === word);
  if (!known) {
    throw new Error(`?planner=${word} is not a planner: one of ${PLANES.map((p) => p.word).join(', ')}`);
  }
  return known.word;
}

/**
 * THE REFUSAL, when the chosen planner does not answer: said on the page, in words that name what
 * was wanted and where, with the way to another -- and the page stops there. It never switches
 * planners for the user (test/guardrails.test.ts).
 */
export function refusePlanner(what: string, where: string, start: string): never {
  const box = must('plannermissing');
  box.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = `${what} is not answering on ${where || 'no configured address'}.`;
  const rest = document.createElement('span');
  rest.textContent = ` This page does not switch planners on its own, and will not show numbers it made up: ${start}, and reload -- or plan in this tab: `;
  const local = document.createElement('a');
  const url = new URL(location.href);
  url.searchParams.delete('planner');
  local.href = url.href;
  local.textContent = 'index.html';
  box.append(strong, rest, local, document.createTextNode('.'));
  box.hidden = false;
  throw new Error(`${what} is not answering on ${where || 'no configured address'}`);
}

/** Which planner the page plans on. */
export function currentPlane(): string {
  return chosenPlane();
}

/** The plane entries, with the one you are ON disabled, not hidden. */
export function planeMenu(): MenuItem[] {
  const now = currentPlane();
  return PLANES.map((plane) => ({
    id: plane.id,
    label: plane.label,
    // where the planner runs: the status bar's readout opens these
    section: 'plane' as const,
    ...(plane.word === now ? { disabled: true as const } : {}),
  }));
}

/** The tab's plane, as its services take it: the one `?planner=` chose, opened again on another by navigating. */
function tabPlane(): PlaneService {
  return { word: chosenPlane(), planes: PLANES, choose: (plane) => void goToPlane(plane.id) };
}

/** Navigate to a plane, if that is what was chosen. */
export function goToPlane(id: string | undefined): boolean {
  const found = PLANES.find((plane) => plane.id === id);
  if (!found) return false;
  // THE SAME PAGE, its planner named in the address; the page's other settings go with it
  // (?remote=, ?warehouse=, ...). A NAVIGATION: a cube never changes planner while it runs.
  const url = new URL(location.href);
  url.pathname = url.pathname.replace(/[^/]*$/, 'index.html');
  url.searchParams.set('planner', found.word);
  location.href = url.href;
  return true;
}

/**
 * The formats the HOST knows and the snapshot cannot: notional and
 * pnl are money, qty is a count. Rendering a trade count as $10,005
 * is the kind of wrong that looks plausible.
 */
export const MONEY: ColumnFormat = {
  kind: 'currency',
  currency: 'USD',
  locale: 'en-US',
  maximumFractionDigits: 0,
  negativeParens: true,
};

/** The demo's own configuration, shared by every plane. */
export function demoConfiguration(title: string): CubeConfiguration {
  return {
    ...DEFAULT_CONFIGURATION,
    reportTitle: title,
    showSelectionStats: true,
    columns: {
      notional: { format: MONEY },
      pnl: { format: MONEY },
      qty: {
        format: { kind: 'number', locale: 'en-US', maximumFractionDigits: 0 },
      },
    },
  };
}

/** The named hierarchies the demo offers, shared by every plane. */
export const DEMO_DIMENSIONS: readonly {
  readonly name: string;
  readonly columns: readonly string[];
}[] = [
  { name: 'Geography', columns: ['region', 'desk', 'book'] },
  { name: 'Calendar', columns: ['year', 'qtr'] },
];

/** What the page hands `boot`: its planner and what it reads. */
export interface Engine {
  readonly planner: Planner;
  readonly source: ValueSpecification;
  readonly snapTarget: SnapTarget;
  /**
   * legend-lite's model writer for a table opened on the page -- a file, a remote file, a warehouse
   * table -- whichever planner plans it (infer.ts): the planner itself in this tab; legend-lite's
   * module, loaded when first asked, beside a planner on a server (planners.ts).
   */
  readonly tables: TableModels;
  /**
   * legend-lite's planner in this tab for a project's test data (a saved query opened by name): the server's statements
   * that make and fill its tables (engine-client's model-data.ts) -- the same module as `tables`.
   */
  readonly seeds: SeedSource;
  /**
   * A file opened in this tab: the planner repointed at the model written for it from DuckDB's
   * catalog (`tables`, infer.ts). Every planner takes one (planners.ts).
   */
  readonly models: {
    use(model: string, runtime: string, how?: ModelOptions): void;
    /** ANOTHER source on the page: a planner over its model, on the same worker or server. */
    another(model: string, runtime: string, how?: ModelOptions): Planner;
    /** A model's elements as the compiler reads them: a saved query's project (data spaces, enumerations). */
    elements(text: string): Promise<unknown[]>;
  };
  /**
   * What the status line should say about this planner.
   *
   * Returned rather than written, because `boot` starts the planner
   * CONCURRENTLY with DuckDB: two writers racing on one status line
   * produce flicker and, worse, a final message that depends on
   * which finished last. `boot` owns the line and writes this when
   * both are ready.
   */
  /**
   * WHICH BACKEND ANSWERED, in one word.
   *
   * `local` plans in this tab, `remote` on legend-lite over HTTP,
   * `engine` on the real legend-engine. It sits in a 20px strip
   * beside the row count, where "planner: legend-lite (wasm, no
   * server)" was most of the bar -- and three planes want three
   * words a person can tell apart at a glance, not three sentences.
   */
  readonly label: string;
}

/**
 * How the page supplies its planner: the one `chosenPlane` names, built by planners.ts (main.ts).
 * Passed in so `boot` starts it concurrently with DuckDB.
 */
export type MakePlanner = (status: HTMLElement) => Promise<Engine>;

/** Where the demo's shared model and tables live: `#>{trades::DB.TRADES}#`. */
export const SOURCE = accessor('trades::DB', 'TRADES');
/** Where the demo cube snaps; its copy is planned by the page's own planner (the model is DuckDB's). */
export const SNAP_TARGET: Omit<SnapTarget, 'planner'> = {
  table: 'TRADES_SNAP',
  source: accessor('trades::DB', 'TRADES_SNAP'),
  conversions: [],
};
export const RUNTIME = 'trades::RT';

/** One copy of the model text, fetched so the file is the source. */
export async function loadModel(): Promise<string> {
  return (await fetch('./trades.pure')).text();
}

// -- sample data ----------------------------------------------------

const REGIONS = ['EMEA', 'AMER', 'APAC'];
const DESKS = ['Rates', 'Credit', 'FX', 'Equity', 'Commodities'];

/**
 * DuckDB in this tab: its bundle from our own origin, its worker, one connection -- the engine,
 * and the database itself (files are registered on it). Shared by the demo page and the page of
 * several cubes (page.ts).
 */
export async function startDuckDb(): Promise<{ readonly engine: DuckDbEngine; readonly db: duckdb.AsyncDuckDB }> {
  // Bundles are served from OUR origin, copied out of node_modules by
  // `bazel build //datacube:vendor`. Loading them from a CDN instead forces a
  // cross-origin Worker, which the platform forbids outright and which
  // is then usually worked around with a blob that importScripts the
  // CDN url. That workaround exists to solve a problem worth not
  // having: a deployment behind a firewall is not fetching its query
  // engine from a CDN anyway.
  // Absolute URLs, not relative ones. The WORKER resolves mainModule
  // against its own location, so './vendor/x.wasm' becomes
  // '/demo/vendor/vendor/x.wasm' and fails as an opaque
  // "WebAssembly.compile: HTTP status code is not ok".
  const asset = (f: string) => new URL(`./vendor/${f}`, location.href).href;
  const bundle = await duckdb.selectBundle({
    mvp: {
      mainModule: asset('duckdb-mvp.wasm'),
      mainWorker: asset('duckdb-browser-mvp.worker.js'),
    },
    eh: {
      mainModule: asset('duckdb-eh.wasm'),
      mainWorker: asset('duckdb-browser-eh.worker.js'),
    },
  });
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const conn = await db.connect();
  return { engine: new DuckDbEngine(conn as unknown as ArrowishConnection), db };
}

/** The demo's trades, generated in this tab's DuckDB as the table the model reads. */
export async function generateTrades(engine: DuckDbEngine): Promise<void> {
  await engine.run(
    `CREATE OR REPLACE TABLE trades AS
     SELECT
       ${sqlPick(REGIONS, 'i % 3')}            AS region,
       ${sqlPick(DESKS, '(i // 3) % 5')}       AS desk,
       (2021 + ((i // 15) % 5))                AS year,
       ('Q' || (1 + ((i // 75) % 4)))          AS qtr,
       ('Book ' || (1 + ((i // 300) % 4)))     AS book,
       ((i * 7919) % 1000000) / 100.0  AS notional,
       ((i * 104729) % 200000) / 100.0 - 1000.0 AS pnl,
       ((i * 31) % 97) + 1             AS qty
     FROM range(${ROWS}) t(i)`,
    0,
  );
}

/**
 * DataCube's app, started: the page, and what the address asks it to open. A start that throws leaves the empty page
 * saying so -- never an empty page without a word (the status line is in a grid's bar, and there may be none).
 */
export async function boot(makePlanner: MakePlanner): Promise<void> {
  const settled = { show: (_reason: string): void => {} };
  try {
    await startPage(makePlanner, settled);
  } catch (e) {
    settled.show(`failed to start: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

/** The start itself; `settled.show` is set once the page has its empty card, to show it with a reason. */
async function startPage(makePlanner: MakePlanner, settled: { show: (reason: string) => void }): Promise<void> {
  const status = must('status');

  // Start the planner NOW, and await it further down where it is
  // first needed.
  //
  // It needs nothing from DuckDB and DuckDB needs nothing from it,
  // but boot used to run them in series, so ~1.3s of boot-layer
  // construction (prelude parse, system metamodel, resolve and
  // normalize) waited for a 36 MB WASM instantiate that had already
  // finished nothing useful for it. Overlapped, the slower of the
  // two sets the floor instead of their sum.
  performance.mark('dc:boot-start');
  const engineReady = makePlanner(status);
  void engineReady.then(() => performance.mark('dc:planner-ready'));
  // Await happens below; this only stops an early rejection being
  // reported as unhandled in the window before that.
  engineReady.catch(() => {});

  const start = await startOf(location);
  // the deployment's settings (config.json, the address's overrides), read once: the services hold what they say
  const configured = pageConfig();
  configured.catch(() => {});
  status.textContent = 'starting DuckDB…';

  const duck = await startDuckDb();
  performance.mark('dc:duckdb-ready');

  // A REMOTE SOURCE, when one is named.
  //
  //   ?remote=https://host/trades.parquet
  //   ?remote=s3://bucket/table&format=iceberg
  //
  // The data stays where it is: DuckDB reads it over HTTP range
  // requests, so the cube pulls the bytes a query needs rather than
  // the file. Everything downstream is unchanged, because the remote
  // file is mounted as a VIEW called `trades` -- the same name the
  // generated table would have had, and the name the model already
  // refers to.
  const params = new URLSearchParams(location.search);
  const remote = params.get('remote');
  /** Generated rows are a copy in this tab from the start; a mounted remote file is live. */
  let generated: HeldCopy | undefined;
  if (start.kind === 'sample' && remote) {
    status.textContent = `mounting ${remote}…`;
    const format = params.get('format');
    await mountRemote(duck.engine, {
      sources: [{
        name: 'trades',
        url: remote,
        ...(format === 'parquet' || format === 'csv' || format === 'iceberg'
          ? { format }
          : {}),
      }],
      // Credentials come from the host, never from the URL bar: a
      // query string lands in history, logs and shoulder-surfing
      // range. A bucket that needs them is configured by the
      // embedding application.
    });
    // said on every receipt: this tab's DuckDB answers, reading the file over HTTP
    duck.engine.readsRemote(remote);
    status.textContent = `reading ${remote}`;
  } else if (start.kind === 'sample') {

  status.textContent = `generating ${ROWS.toLocaleString(UI_LOCALE)} rows…`;
  await generateTrades(duck.engine);
  generated = { label: 'trades (generated in this tab)', takenAt: new Date(), rowCount: ROWS };
  }

  // -- the cube ------------------------------------------------------

  performance.mark('dc:data-ready');
  status.textContent = 'starting planner…';
  const chosen = await engineReady;
  const { planner, source, snapTarget, label } = chosen;
  status.textContent = label;
  // THE TAB'S SERVICES (src/services/browser.ts): everything below reads its planner, its database, its stores and its
  // browser through them
  const services: Services = await browserServices({
    plane: tabPlane(),
    planner: chosen,
    duckdb: duck,
    config: await configured,
    location,
  });
  const engine = services.engine.database.engine;
  const { tables } = services.engine;

  /** The sample cube's opening view. */
  const sampleSnapshot = async (): Promise<CubeSnapshot> => ({
    source: { query: source },
    // the compiler types every column; the page declares only that year is a dimension
    columns: await sourceColumns(planner, source, [{ name: 'year', kind: 'dimension' }]),
    derived: [],
    rows: ['region', 'desk', 'book'],
    pivotOn: ['year'],
    measures: [{ name: 'notional', column: 'notional', fn: 'sum' }],
    sorts: [],
    epoch: 1,
  });


  // The page builds the APP, not a grid and a pile of checkboxes.
  // Those checkboxes were the demo standing in for a product; what
  // they reached is now reachable from the toolbar, the drag zones,
  // the context menu and the properties editor -- which is the whole
  // reason src/app.ts exists.
  // The host knows what the snapshot cannot: that notional and pnl
  // are money and qty is a count. Rendering a trade count as $10,005
  // is the kind of wrong that looks plausible.
  const configuration: CubeConfiguration = demoConfiguration('Trades');

  // The close button on each host window. Wired once, by delegation,
  // so a window can be added to the markup without another listener.
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const close = target.closest('.hostwin-close');
    if (!(close instanceof HTMLElement)) return;
    const id = close.dataset['win'];
    if (id) must(id).hidden = true;
  });

  // The cube, built so it can be built AGAIN.
  //
  // Opening a file replaces the model, and therefore the columns and
  // the source relation, so the app is recreated rather than mutated
  // -- a cube whose snapshot no longer matches its model is not a
  // state worth supporting. Everything the construction needs is a
  // parameter so there is only one copy of it.
  const host = must('app');
  const DEMO_DIMENSIONS = [
    { name: 'Geography', columns: ['region', 'desk', 'book'] },
    { name: 'Calendar', columns: ['year', 'qtr'] },
  ];

  /**
   * WORK THIS TAB HOLDS that leaving would lose: each part of the page adds what it knows (an
   * opened file lives only in this tab's database; a warehouse session only in memory; unsaved
   * changes). Asked before leaving the page and before switching plane (P2-337).
   */
  const work = new TabWork();
  /** Set once the person has agreed to leave: the browser's own question is not asked twice. */
  let leaving = false;

  /**
   * FOR THE BROWSER HARNESSES: when the page has finished what an action started, as a fact
   * rather than a guess. `changes` counts every change the cube reports (a view landing, a
   * presentation change, a refusal, the Pure pane written); `printing` is the Pure prints still
   * out. With the cube's own `busy`, a harness waits until nothing is in flight and nothing has
   * changed for a moment -- the time the action took, not a fixed sleep (a 4s fall-through on
   * every change that runs no query made verify-features take 8 minutes, and a 150ms sleep read
   * the page before a slower machine had re-queried). Not product code: the demo page.
   */
  const harnessSignal = { changes: 0, printing: 0 };
  (window as unknown as { __dataCubeSignal?: typeof harnessSignal }).__dataCubeSignal = harnessSignal;

  /**
   * A GRID ON THE PAGE, as DataCube's app makes one (docs/DATACUBE_PAGES_DESIGN_2026_10_09.md §6): a compact cube in a
   * tile, its windows floating over the whole page, wired to the page by `spawned` (its charts, copies, removal,
   * export, settings). Every grid is made here, the first as the fifth.
   */
  function gridMaker(
    snap: CubeSnapshot,
    config: CubeConfiguration,
    dims: { name: string; columns: string[] }[],
    place: GridPlace = {},
  ): GridMaker {
    // `start`: a copy of a grid of this source (Copy of Grid), starting where that grid is now
    return (gridHost, spawned, start) => {
      let printed = 0;
      const kept = services.browser.readSettings();
      const created: CubeApp = new CubeApp(gridHost, start?.snapshot ?? snap, {
        engine: place.engine ?? engine,
        planner: place.planner ?? planner,
        // Where the rows are (Live on a warehouse, or Snapped in this tab) is the grid's plane
        // button, and who read them the status bar's receipt.
        ...(place.live ? { live: place.live } : {}),
        configuration: start?.configuration ?? config,
        // Snap only where the place says what to copy: no other source's target stands in for it
        ...(place.snapTarget ? { snapTarget: place.snapTarget } : {}),
        ...(place.cubeSource ? { cubeSource: place.cubeSource } : {}),
        // the groups a saved cube had open: its own grid's, not a copy's (a copy starts collapsed, as a new grid)
        ...(place.tree && !start ? { tree: place.tree } : {}),
        ...(place.heldCopy ? { heldCopy: place.heldCopy } : {}),
        ...(place.label !== undefined ? { sourceLabel: place.label } : {}),
        compact: true,
        // a copy is a grid added beside others
        foldPanel: start !== undefined || place.foldPanel === true,
        // WHERE THE PLANNER RUNS, changed where it is read: the status bar's readout offers the planes; and, where the
        // page has a model home and the grid's planner writes classes, Create a Class… of the grid's rows
        hostMenu: () => [
          ...planeMenu(),
          ...(createClass && (place.planner ?? planner).source ? [CREATE_CLASS, CREATE_ASSOCIATION] : []),
        ],
        onHostMenu: (item) => {
          if (item.id === CREATE_CLASS.id) createClass?.(created, place, spawned.id);
          else if (item.id === CREATE_ASSOCIATION.id) createAssociation?.(spawned.id === undefined ? undefined : pageModelNow?.()?.classes?.[spawned.id]);
          else onHostItem(item);
        },
        // its windows float over the page, not squeezed into its tile
        windowHost: page.root,
        // "Changed since saved" is re-read on every change of the cube's state,
        // a presentation change (a width, a colour) included: it runs no query.
        onChange: () => {
          harnessSignal.changes += 1;
          onCubeView?.();
        },
        showColumnZone: true,
        dimensions: dims,
        writeClipboard: (text) => services.browser.writeClipboard(text),
        // Settings kept between visits, as upstream's hosts keep them
        // (settingsData.values / onSettingsChanged); the page keeps them for every grid.
        ...(kept ? { settings: kept } : {}),
        download,
        onStatus: (text, kind) => {
          // ERRORS ONLY. The cube's own status bar carries the result
          // and the timing; a host that echoed the same line beside it
          // said one fact twice in a 20px strip. What a host is for is
          // saying what the cube cannot -- a planner that failed.
          if (kind !== 'error') return;
          harnessSignal.changes += 1;
          status.textContent = text;
          status.classList.add('bad');
          status.classList.remove('warn-text');
        },
        onView: (view) => {
          // For the browser harness: how many views have landed.
          const w = window as unknown as { __dataCubeViews?: number };
          w.__dataCubeViews = (w.__dataCubeViews ?? 0) + 1;
          harnessSignal.changes += 1;
          // A VIEW LANDED, SO THE LAST ERROR IS OVER: a status line says what is true NOW.
          if (status.classList.contains('bad')) {
            status.classList.remove('bad');
            status.textContent = label;
          }
          // The query this product built, as the compiler prints it, and
          // the SQL the planner made of it. Both, because they answer
          // different questions -- the last view of any grid on the page.
          // The print is asked for; a later view's print wins.
          const printing = (printed += 1);
          harnessSignal.printing += 1;
          void created.controller.print(view.query, 'STANDARD').then(
            (text) => { if (printing === printed) must('pure').textContent = text; },
            (error: unknown) => { if (printing === printed) must('pure').textContent = String(error); },
          ).finally(() => {
            harnessSignal.printing -= 1;
            harnessSignal.changes += 1;
          });
          must('sql').textContent =
            view.sql || '(no SQL for this view)';
        },
        ...spawned,
      });
      if (spawned.id !== undefined) madeGrid?.(spawned.id, place);
      // a grid on the page: the start's reason for a blank one is over
      sayWhyBlank(undefined);
      return created;
    };
  }

  /** The host's own entries, from the page's menu or a grid's status bar. */
  function onHostItem(item: MenuItem): void {
    if (item.id === 'host.open') showCubes?.();
    if (item.id === 'host.save') saveCube?.(false);
    if (item.id === 'host.saveAs') saveCube?.(true);
    if (item.id === 'host.share') void copyShareLink?.();
    if (item.id === 'host.query') toggleHostWindow('querywin');
    if (item.id === CREATE_ASSOCIATION.id) createAssociation?.();
    if (item.id === CREATE_DATA_SPACE.id) createDataSpace?.();
    // A NAVIGATION, not a switch: the same page loads again with the chosen ?planner= (a cube
    // never changes planner while it runs). Asked first when leaving would lose work here.
    const plane = services.engine.plane.planes.find((p) => p.id === item.id);
    if (plane) {
      if (!mayLeave(work, (q) => window.confirm(q), 'Choosing another planner reloads the page')) return;
      leaving = true;
      services.engine.plane.choose(plane);
    }
  }

  /** Hand a file to the user. */
  const download = (name: string, mime: string, text: string | Uint8Array): void => services.browser.download(name, mime, text);

  /** Opens the saved cubes' window; set once the page can open files. */
  let showCubes: (() => void) | undefined;
  /** Close the Open… window, when it is open. */
  let closeCubes: (() => void) | undefined;
  /** Save the page (over the one it was opened from), or Save As a new one. */
  let saveCube: ((asNew: boolean) => void) | undefined;
  /** Copies the page's share link; set once the page can open files. */
  let copyShareLink: (() => Promise<void>) | undefined;
  /** Told when a view lands: "changed since saved" is re-read then. */
  let onCubeView: (() => void) | undefined;
  /**
   * CREATE A CLASS… of a grid (docs/DATACUBE_MODEL_DESIGN_2026_10_10.md §15): set once the page has a model home to
   * write its classes to (config.json's `depot`); offered only on a grid whose planner writes classes.
   */
  let createClass: ((grid: CubeApp, place: GridPlace, cube: string | undefined) => void) | undefined;
  /** CREATE AN ASSOCIATION… (from a grid: its class one end) and CREATE A DATA SPACE… of the page, once it has a model
   *  home. */
  let createAssociation: ((first?: string) => void) | undefined;
  let createDataSpace: (() => void) | undefined;
  /** The page's model now (where its classes are), once the page can make them. */
  let pageModelNow: (() => PageModelRef | undefined) | undefined;
  /** The page renamed in its name box: its name from now (once the page can be saved, a change until it is). */
  let renamePage = (name: string): void => page.setTitle(name);
  /** Told when a grid is made on the page, by its tile's id: what the page keeps of it (its file). */
  let madeGrid: ((id: string, place: GridPlace) => void) | undefined;
  /** Told of every change on the page: the tables no grid reads any more are dropped. */
  let dropUnread: (() => void) | undefined;
  /** The source picker, once the page can open sources: New ▸ Data Source… adds a grid over one; a blank page opens one. */
  let picker: ((purpose: 'add' | 'open', start?: SectionId) => Promise<GridMaker | undefined>) | undefined;
  /** New ▸ Blank Page: everything goes, for a first data source. */
  let blankPage: ((reason?: string) => void) | undefined;
  /** Why the page's start opened nothing (a link that failed, a key refused): the empty page says it. */
  let startProblem: string | undefined;
  /** The empty page's card: hidden until the start has settled -- a page still signing in, or opening a link, is not blank. */
  let blankCard: HTMLElement | undefined;
  /** Where the card says why the start opened nothing: after its lead. */
  let blankLead: HTMLElement | undefined;
  /** The card's line saying why, while it says it. */
  let blankWhy: HTMLElement | undefined;
  /** The empty page's card says why the start opened nothing, or -- undefined -- says nothing of it. */
  const sayWhyBlank = (reason: string | undefined): void => {
    blankWhy?.remove();
    blankWhy = undefined;
    if (!reason || !blankLead) return;
    const why = document.createElement('p');
    why.className = 'dc-blank-reason';
    why.setAttribute('role', 'alert');
    why.textContent = reason;
    blankLead.after(why);
    blankWhy = why;
  };

  /**
   * THE PAGE (src/page/page-app.ts): its bar -- the page's menu, its name, its fold -- and its grids.
   * The page's menu carries the host's entries: Save, Open, Share, the generated Pure and SQL, the planner planes.
   */
  const page = new PageApp({
    host,
    hostMenu: () => [
      // saved pages: in this browser, over the sources they were built on
      { id: 'host.save' as const, label: 'Save', section: 'file' as const },
      { id: 'host.saveAs' as const, label: 'Save As\u2026', section: 'file' as const },
      { id: 'host.open' as const, label: 'Open\u2026', section: 'file' as const },
      // the page's settings in a link: never a row of data (src/share/link.ts)
      { id: 'host.share' as const, label: 'Share\u2026', section: 'file' as const },
      { id: 'host.query', label: 'Generated Pure & SQL\u2026', section: 'view' as const },
      // THE PAGE'S MODEL: its associations and its data space, once the page has a model home
      ...(createDataSpace ? [{ label: 'Model', section: 'data' as const, submenu: [CREATE_ASSOCIATION, CREATE_DATA_SPACE] }] : []),
      // The planes, as entries rather than a control: the bar is
      // for what you watch, the menu for what you do occasionally.
      // The one you are ON is disabled rather than hidden, so the
      // menu still says where the work happens.
      ...planeMenu(),
    ],
    onHostMenu: (item) => onHostItem(item),
    // A PAGE FILE carries the page, not the classes of its project in this browser's model home: refused while it has
    // them (§15.3; a file carrying its model comes with the Studio line's export, S23)
    exportRefusal: () => (pageModelNow?.()
      ? `This page's classes are in ${pageModelNow()!.project}, in this browser: a page file cannot carry them yet. `
        + 'Save the page here, or open the project in Studio.'
      : undefined),
    refuse: (text) => window.alert(text),
    // THE HOST'S TEXT, IN THE STATUS BAR (planner progress, errors, the planner's word): the page's first grid's, at the
    // right of its status bar -- a readout belongs there, not in the bar that says what is on screen. MOVED rather than
    // copied, on each render of that bar: `status` is the same node the planner writes to.
    hostStatus: (slot) => slot.append(status),
    // THE NAME BOX renamed: the page's name from now, saved by Save (a change of the page until then)
    onRename: (name) => renamePage(name),
    // THE EMPTY PAGE (New ▸ Blank Page, the last grid removed, a start that opened nothing): what to do first -- a
    // data source (the picker, opening in place) or a saved page
    empty: (slot) => {
      const doc = document;
      const blank = doc.createElement('div');
      blank.className = 'dc-blank';
      const card = doc.createElement('div');
      card.className = 'dc-blank-card';
      const title = doc.createElement('h2');
      title.className = 'dc-blank-title';
      title.textContent = 'A blank page';
      const lead = doc.createElement('p');
      lead.className = 'dc-blank-lead';
      lead.textContent = 'Start with a data source: a file from your computer, an example, a table in a warehouse, or a remote Parquet, CSV or Iceberg file.';
      blankLead = lead;
      card.append(title, lead);
      {
        const actions = doc.createElement('div');
        actions.className = 'dc-blank-actions';
        const add = doc.createElement('button');
        add.type = 'button';
        add.className = 'dc-picker-button dc-primary';
        add.textContent = 'Add a data source';
        add.addEventListener('click', () => void picker?.('open'));
        const saved = doc.createElement('button');
        saved.type = 'button';
        saved.className = 'dc-picker-button dc-quiet';
        saved.textContent = 'Open a saved cube';
        saved.addEventListener('click', () => showCubes?.());
        actions.append(add, saved);
        card.append(actions);
      }
      blank.append(card);
      blank.hidden = true;
      blankCard = blank;
      slot.append(blank);
    },
    // New ▸ Data Source…: a grid over another source, through the picker, beside the others
    openSource: () => picker?.('add') ?? Promise.resolve(undefined),
    onBlankPage: () => blankPage?.(),
    onChange: () => {
      harnessSignal.changes += 1;
      dropUnread?.();
      onCubeView?.();
    },
    onSettingsChanged: (values) => services.browser.writeSettings(values),
    download: (name, mime, text) => download(name, mime, text),
  });
  // a start that throws, from here on: the empty page shows its card, saying why
  settled.show = (reason) => {
    if (!page.empty) return;
    sayWhyBlank(reason);
    if (blankCard) blankCard.hidden = false;
  };
  // For the browser harness ONLY: the page, its views and its layout; and its first grid (a CubeApp), so a check can
  // read that grid's own configuration and snapshot when what it sees on screen disagrees. Not product code.
  (window as unknown as { __dataPage?: PageApp }).__dataPage = page;
  Object.defineProperty(window, '__dataCube', {
    configurable: true,
    get: () => (page.grids[0] !== undefined ? page.grid(page.grids[0]) : undefined),
  });

  if (start.kind === 'sample') {
    page.addGrid(gridMaker(await sampleSnapshot(), configuration, DEMO_DIMENSIONS,
      { snapTarget, ...(generated ? { heldCopy: generated } : {}) }));
    await page.ready();
  }

  // OPENING A FILE.
  //
  // DuckDB reads it and sniffs the schema, legend-lite's writer (`tables.tableModel`) writes the
  // Pure model from what its catalog found, and the cube is rebuilt against that.
  // Nothing downstream learns the data was uploaded: the planner
  // compiles an ordinary model over an ordinary table, which is why
  // the SQL panel, the tree and the snap plane all keep working
  // without a second code path.
  {
    // THE PAGE'S SOURCES (src/app/sources.ts): each kind opened through the services, a grid's file and planners kept
    const sources = pageSources({
      services, page, gridMaker, work, taken: ['trades'], ask: (content) => library?.ask(content),
    });

    // THE PAGE ON SCREEN, as a saved page sees it: the saved page it came from (a Save then saves over it), its name,
    // what a newer writer put in it (written back as it was), the definition it had when saved or first opened
    // ("changed since saved" compares to it), and what opening left out of it. And each grid's file (by the grid's
    // id): the File itself, so a page saved over the same file reopens without asking, and the handle the browser gave
    // for it, to reopen it from where it was picked.
    let library: CubeLibrary | undefined;
    let current: {
      cubeId?: string;
      name?: string;
      /** The name it was saved (or opened) under: a name given in the name box since is a change of the page. */
      savedName?: string;
      /** Fields of the saved PAGE this reader does not know, and of each of its cubes, written back as they were. */
      pageUnknown?: Readonly<Record<string, unknown>>;
      cubeUnknown?: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
      /** The definition as saved, or as first opened: "changed since saved" compares to it. */
      baseline?: string;
      /** What opening left out of the saved page (a file changed, a source not opened): saving over it loses them. */
      lost?: readonly string[];
      /** Where the page's classes are (Create a Class…): its project in the model home, made with its first class. */
      model?: PageModelRef;
    } = {};
    renamePage = (name) => {
      current = { ...current, name };
      page.setTitle(name);
      onCubeView?.();
    };
    madeGrid = (id, place) => sources.madeGrid(id, place);
    dropUnread = () => sources.dropUnread();

    /**
     * What saving now would write -- always ONE kind of thing, the page (page-document.ts): one cube per grid, its
     * charts and layout -- and its definition, for "changed since saved".
     */
    const savedForm = (name: string): { content: Record<string, unknown>; definition: string } | undefined => {
      const doc = page.document(name, {
        ...(current.pageUnknown ? { page: current.pageUnknown } : {}),
        ...(current.cubeUnknown ? { cubes: current.cubeUnknown } : {}),
        ...(current.model ? { model: current.model } : {}),
      });
      return doc && { content: pageContent(doc), definition: pageDefinitionText(doc) };
    };

    /** The page on screen differs from what was saved (or first opened). */
    const dirty = (): boolean => {
      if (current.baseline === undefined) return false;
      if ((current.lost?.length ?? 0) > 0) return true;
      if (current.name !== current.savedName) return true;
      const now = savedForm(current.name ?? (page.suggestedName || 'page'));
      return now !== undefined && now.definition !== current.baseline;
    };
    const baseTitle = document.title;
    onCubeView = () => {
      const changed = dirty();
      page.setChanged(changed);
      document.title = page.empty
        ? baseTitle
        : `${changed ? '\u2022 ' : ''}${current.name ?? (page.suggestedName || 'page')} \u2013 ${baseTitle}`;
      library?.sync();
    };
    // Leaving the page with unsaved changes asks, the browser's way.
    work.add(() => (dirty() ? 'unsaved changes' : undefined));
    window.addEventListener('beforeunload', (event) => {
      if (leaving || work.what() === undefined) return;
      event.preventDefault();
      event.returnValue = '';
    });

    /** LATEST WINS: each open in place takes a number, and one overtaken by a newer open lands nothing (P2-330). */
    const opens = new Latest();
    /**
     * WHICH PAGE IS ON SCREEN: each page put there (opened in place, a saved one restored, a blank one) takes a number,
     * and `current` -- what Save writes over -- is set with it. One that lands after another page was put there keeps
     * no baseline of the newer page.
     */
    let placed = 0;
    const place = (): (() => boolean) => {
      const mine = (placed += 1);
      return () => placed === mine;
    };

    /**
     * A SOURCE IN PLACE of the page: everything on it goes (asked first when there are unsaved changes), then one grid
     * over the source -- fresh, the page's name its. An open overtaken by a newer one lands nothing.
     */
    async function inPlace(open: () => Promise<Opened>, what: string): Promise<readonly string[]> {
      if (dirty() && !window.confirm(`The page has unsaved changes. Open ${what} anyway?`)) return [];
      const newest = opens.start();
      const o = await open();
      if (!newest()) {
        await o.discard?.();
        return [];
      }
      const onScreen = place();
      page.clear();
      current = {};
      // the page has no name of its own until saved: its bar says the grid's report title (its source's name)
      page.setTitle('');
      page.addGrid(o.make);
      await page.ready();
      // another page put on screen while this one landed: that page is the one to keep a baseline of
      if (!onScreen()) return [];
      // The baseline is the page as it LANDED (normalized by its first refresh); a name given in the name box while it
      // landed stays (a change, as a rename is)
      const landed = savedForm(page.suggestedName || 'page');
      current = { ...(current.name !== undefined ? { name: current.name } : {}), ...(landed ? { baseline: landed.definition } : {}), lost: [] };
      onCubeView?.();
      library?.sync();
      return o.notes;
    }

    // SAVED PAGES (the services' page store): in this browser, IndexedDB when the browser gives it, else memory (this
    // visit only, and said so); and their files' handles
    const { store, handles, memoryOnly } = services.pages;
    let persistent = false;

    /**
     * Where a saved page keeps the handle of the file a grid reads: by the page and the grid -- or, saved before a page
     * held several grids, by the page alone.
     */
    const handleKeys = (pageId: string | undefined, grid: string): string[] => (pageId === undefined ? [] : [`${pageId}#${grid}`, pageId]);

    /** A cube saved alone, before pages: a page of its one grid, the whole board. */
    const pageOf = (cube: CubeDocument): PageDocument => ({
      kind: 'datacube.page',
      version: PAGE_VERSION,
      name: cube.name,
      cubes: [{ id: 'cube', cube }],
      views: [{ id: 'grid', kind: 'grid', cube: 'cube' }],
      sheets: oneSheet({ kind: 'bands', fit: true, bands: [{ height: 1, node: { tile: 'grid' } }] }),
    });

    /**
     * OPEN A SAVED PAGE (from the store, a file someone handed over, a share link): each of its cubes through its own
     * source, in turn, then the page laid out as it was saved -- its grids under their saved ids, its charts, its
     * layout. A cube whose source was not opened is left out, and said; saving over the page would lose it.
     */
    async function openSaved(saved: SavedDocument, id: string | undefined): Promise<void> {
      const doc = saved.kind === 'page' ? saved.page : pageOf(saved.cube);
      if (dirty() && !window.confirm(`The page has unsaved changes. Open "${doc.name}" anyway?`)) return;
      // LATEST WINS (P2-330), as an open in place: each source is a wait (a file asked for, a sign-in), and an open
      // overtaken meanwhile lands nothing -- what it read is dropped
      const newest = opens.start();
      const makers = new Map<string, GridMaker>();
      const read: Opened[] = [];
      const notes: string[] = [];
      sources.reserve(Object.values(doc.model?.tables ?? {}));
      try {
        for (const { id: cubeId, cube } of doc.cubes) {
          const o = await sources.reopened(cube, handleKeys(id, gridOfCube(doc, cubeId)), doc.cubes.length > 1, doc.model?.tables[cubeId]);
          if (o) read.push(o);
          if (!newest()) {
            for (const r of read) await r.discard?.();
            return;
          }
          if (!o) {
            notes.push(`left out: ${cube.source.name} (not opened)`);
            continue;
          }
          makers.set(cubeId, o.make);
          notes.push(...o.notes);
        }
      } catch (e) {
        // a source that could not be opened: what the others read goes, and the page on screen stays
        for (const r of read) await r.discard?.();
        throw e;
      } finally {
        sources.release();
      }
      if (makers.size === 0) {
        library?.say(`not opened: "${doc.name}" -- none of its sources was opened`, 'warn');
        return;
      }
      // the page on screen is this one from now: Save writes over it, never over the page it replaced
      const onScreen = place();
      page.restore(doc, makers);
      current = {
        ...(id !== undefined ? { cubeId: id } : {}),
        name: doc.name,
        savedName: doc.name,
        ...(doc.unknown ? { pageUnknown: doc.unknown } : {}),
        cubeUnknown: new Map(doc.cubes.filter((c) => c.cube.unknown).map((c) => [gridOfCube(doc, c.id), c.cube.unknown!])),
        ...(doc.model ? { model: doc.model } : {}),
      };
      page.setTitle(doc.name);
      await page.ready();
      // another page put on screen while this one landed: that page is the one to keep
      if (!onScreen()) return;
      // each file the page reads, where it was picked: kept for the next time it is opened
      if (id !== undefined) await keepHandles(id);
      // The baseline is the page as it LANDED (normalized by its first refresh); a page opened with parts left out is
      // changed from the start.
      const landed = savedForm(doc.name);
      current = { ...current, ...(landed ? { baseline: landed.definition } : {}), lost: notes.filter((n) => n.startsWith('left out')) };
      onCubeView?.();
      library?.sync();
      library?.say(notes.length === 0
        ? `opened "${doc.name}"`
        : `opened "${doc.name}", with changes since it was saved:\n${notes.map((n) => `- ${n}`).join('\n')}`,
      notes.length === 0 ? 'ok' : 'warn');
      // opened cleanly: the window goes, the page is what the person wanted to see
      if (notes.length === 0) closeCubes?.();
    }

    /**
     * Each grid's file, where it was picked: kept by the page and the grid (a grid kept off the board for a detached
     * chart included), so opening the page again reads it from there.
     */
    async function keepHandles(pageId: string): Promise<void> {
      for (const f of sources.filesNow()) if (f.handle) await handles?.put(`${pageId}#${f.grid}`, f.handle);
    }

    /** The grid a saved page's cube is shown in (its grid view's id), or the cube's own id (a detached chart's). */
    const gridOfCube = (doc: PageDocument, cube: string): string =>
      doc.views.find((v) => v.kind === 'grid' && v.cube === cube)?.id ?? cube;

    /** Save the page on screen: over its saved copy, or as a new one (the Save window's act). */
    async function saveTo(name: string, asNew: boolean): Promise<void> {
      const refused = page.saveRefusal();
      if (refused) throw new Error(refused);
      const form = savedForm(name);
      if (!form) throw new Error('This page cannot be saved yet: a grid on it does not know its source.');
      const id = !asNew && current.cubeId !== undefined ? current.cubeId : crypto.randomUUID();
      const record = { id, name, content: form.content };
      if (id === current.cubeId) await store.update(id, record);
      else await store.create(record);
      await keepHandles(id);
      current = { ...current, cubeId: id, name, savedName: name, baseline: form.definition, lost: [] };
      page.setTitle(name);
      onCubeView?.();
      if (!persistent) persistent = await services.pages.persist();
      library?.sync();
    }

    library = new CubeLibrary(must('cubelib'), store, {
      currentId: () => current.cubeId,
      dirty,
      open: async (id) => openSaved(readSaved((await store.get(id)).content), id),
      openText: async (text) => openSaved(readSaved(text), undefined),
      forget: async (id) => {
        // every handle the page kept, whichever page is on screen
        await handles?.removePage(id);
        if (current.cubeId === id) {
          const { cubeId: _gone, ...rest } = current;
          current = rest;
        }
      },
    });
    // OPEN… (the user, 2026-10-01: "fix the Open dialog now too"): the saved cubes in a window of
    // their own, as the source picker and Save are -- searched, sorted, opened, deleted, or a cube
    // file opened. It closes once a cube opens cleanly; what an open has to say (a file to choose,
    // changes since it was saved) keeps it open.
    showCubes = () => {
      if (!closeCubes) {
        const backdrop = document.createElement('div');
        backdrop.id = 'cubeswin';
        backdrop.className = 'dc-picker-backdrop';
        const win = document.createElement('div');
        win.className = 'dc-picker dc-open dc-app-floating';
        win.setAttribute('role', 'dialog');
        win.setAttribute('aria-modal', 'true');
        win.setAttribute('aria-labelledby', 'dc-open-title');
        const head = document.createElement('div');
        head.className = 'dc-picker-head';
        const titles = document.createElement('div');
        titles.className = 'dc-picker-titles';
        const title = document.createElement('h2');
        title.className = 'dc-picker-title';
        title.id = 'dc-open-title';
        title.textContent = 'Open a saved cube';
        const sub = document.createElement('p');
        sub.className = 'dc-picker-subtitle';
        sub.textContent = memoryOnly
          ? 'Kept for this visit only (this browser refused storage). Each reopens over its own file, or regenerates its example.'
          : 'Saved in this browser. Each reopens over its own file (asked for when needed), or regenerates its example.';
        titles.append(title, sub);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'dc-picker-close';
        close.setAttribute('aria-label', 'Close');
        close.textContent = '\u00d7';
        head.append(titles, close);
        const body = document.createElement('div');
        body.className = 'dc-open-body';
        body.append(must('cubelib'));
        win.append(head, body);
        backdrop.append(win);
        document.body.append(backdrop);
        const onKey = (e: KeyboardEvent): void => {
          if (e.key === 'Escape') { e.preventDefault(); closeCubes?.(); }
        };
        document.addEventListener('keydown', onKey, true);
        closeCubes = () => {
          must('cubeholder').append(must('cubelib'));
          document.removeEventListener('keydown', onKey, true);
          backdrop.remove();
          closeCubes = undefined;
        };
        close.addEventListener('click', () => closeCubes?.());
        backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeCubes?.(); });
      }
      library?.sync();
      void library?.refresh();
      (document.querySelector('#cubelib .dc-lib-search') as HTMLElement | null)?.focus();
    };
    // THE MENU'S SAVE AND SAVE AS: a window of their own (src/ui/save-dialog.ts) -- the name, where
    // it is kept, what is saved and what is not (the rows), and what saving over would drop
    /** What each grid's source needs to be read again, in words, once per kind of source on the page. */
    const sourcesSaid = (doc: PageDocument | undefined, how: 'save' | 'share'): string => {
      const said = new Set<string>();
      for (const { cube } of doc?.cubes ?? []) {
        const src = cube.source;
        said.add(how === 'save'
          ? src._type === 'savedQuery' ? `opening it runs the saved query “${src.name}” again`
            : src._type === 'warehouseTable' ? `opening it reads ${src.name} on the warehouse again, signed in as whoever opens it`
              : src._type === 'remoteFile' ? `opening it reads ${src.name} again from its URL`
                : src._type === 'frame' ? `it reads the dataframe ${src.name}: it opens where Python serves it`
                : src.sample ? `the example (${src.sample.rows.toLocaleString(UI_LOCALE)} rows) is generated again when it opens`
                  : `opening it reads ${src.name} again, from your computer`
          : src._type === 'savedQuery' ? `it reads the saved query “${src.name}” again, where its project (${src.query.groupId}:${src.query.artifactId}) is known`
            : src._type === 'warehouseTable' ? `whoever opens it signs in to the warehouse as themselves and needs to be granted ${src.name}; no sign-in is in the link`
              : src._type === 'remoteFile' ? `it reads ${src.url} again; no keys are in the link, a private bucket asks for them`
                : src._type === 'frame' ? `it reads the dataframe ${src.name}, which only the Python that serves it has`
                : src.sample ? 'it rebuilds its sample on its own'
                  : `whoever opens it needs ${src.name}`);
      }
      return [...said].join('; ');
    };

    // THE MENU'S SAVE AND SAVE AS: a window of their own (src/ui/save-dialog.ts) -- the name, where
    // it is kept, what is saved and what is not (the rows), and what saving over would drop
    saveCube = (asNew) => {
      if (page.empty) {
        library?.say('There is nothing on this page to save: add a data source first.', 'warn');
        return;
      }
      void (async () => {
        const refused = page.saveRefusal();
        const offered = current.name ?? (page.suggestedName || 'page');
        const savedAt = current.cubeId !== undefined ? (await store.get(current.cubeId).catch(() => undefined))?.lastUpdatedAt : undefined;
        const doc = page.document(offered);
        const views = page.views().views;
        const charts = views.filter((v) => v.kind === 'chart').length;
        const grids = page.grids.map((id) => ({ title: views.find((v) => v.id === id && v.kind === 'grid')?.title ?? id, grid: page.grid(id)! }));
        const shape = (s: CubeSnapshot): string => [
          s.rows.length > 0 ? `grouped by ${s.rows.join(', ')}` : 'its rows as they are, grouped by nothing',
          ...(s.pivotOn.length > 0 ? [`pivoted on ${s.pivotOn.join(', ')}`] : []),
          ...(s.filter ? ['its filter'] : []),
          ...(s.derived.length + (s.groupDerived?.length ?? 0) > 0
            ? [`${s.derived.length + (s.groupDerived?.length ?? 0)} calculated column${s.derived.length + (s.groupDerived?.length ?? 0) === 1 ? '' : 's'}`] : []),
        ].join(', ');
        const keeps = [
          ...(grids.length === 1
            ? [shape(grids[0]!.grid.snapshot).replace(/^./, (c) => c.toUpperCase())]
            : grids.map(({ title, grid }) => `${title}: ${shape(grid.snapshot)}`)),
          ...(charts > 0 ? [`${charts} visualization${charts === 1 ? '' : 's'}, and the page's layout`] : []),
          grids.length > 1 ? 'Each grid\'s formats, widths, colours and settings' : 'Its formats, widths, colours and settings',
        ];
        const leaves = `Not the rows: ${sourcesSaid(doc, 'save') || 'opening it reads its sources again'}.`;
        await saveDialog(document, {
          purpose: asNew ? 'saveAs' : 'save',
          name: offered,
          ...(current.cubeId !== undefined
            ? { over: { name: current.name ?? offered, ...(savedAt !== undefined ? { savedAt } : {}) } } : {}),
          where: services.pages.where,
          keeps,
          leaves,
          ...(current.lost?.length
            ? { warning: `The saved “${current.name ?? 'page'}” has parts this page cannot show: ${current.lost.join('; ')}.` } : {}),
          save: async (name, saveAsNew) => {
            if (refused) throw new Error(refused);
            await saveTo(name, saveAsNew);
          },
        });
      })();
    };

    // THE SHARE LINK: the page's settings, never its data. It is said HOW LONG it is, and a long
    // one -- which some mail and chat tools cut -- is said so, with the file suggested instead.
    // SHARE: the link in a window of its own, shown and copied to the clipboard at once, with a
    // way to copy it again -- and what it holds (the page's settings, never its data) said there.
    copyShareLink = async () => {
      // nothing on screen is said the way any unsharable page is: in the window, not as a dead button
      const refused = page.saveRefusal();
      const name = current.name ?? (page.suggestedName || 'page');
      const shared = refused ? undefined : page.document(name, {
        ...(current.pageUnknown ? { page: current.pageUnknown } : {}),
        ...(current.cubeUnknown ? { cubes: current.cubeUnknown } : {}),
      });
      const field = must('sharelink') as HTMLTextAreaElement;
      const note = must('sharenote');
      const copy = must('sharecopy') as HTMLButtonElement;
      showHostWindow('sharewin', { width: 560, height: 200 });
      // nothing to copy: the window says why, without an empty link and a dead button
      field.hidden = !shared;
      copy.hidden = !shared;
      if (!shared) {
        field.value = '';
        note.textContent = refused ?? 'This page cannot be shared yet: a grid on it does not know its source.';
        note.className = 'sharenote bad';
        return;
      }
      const link = shareLink(location.href, shared);
      field.value = link.url;
      const about = `It holds the page's settings, filter values included, not its data; ${sourcesSaid(shared, 'share')}.`
        // the page's classes are in this browser's model home (Studio's): a link carries none of them
        + (current.model ? ` Its classes stay in ${current.model.project}, in this browser: the link does not carry them.` : '');
      const put = async (): Promise<void> => {
        field.select();
        try {
          await navigator.clipboard.writeText(link.url);
        } catch {
          note.textContent = `The browser did not allow copying: select the link and copy it. ${about}`;
          note.className = 'sharenote bad';
          return;
        }
        note.textContent = link.long
          ? `Copied, but it is long (${link.length.toLocaleString(UI_LOCALE)} characters): some mail and chat tools cut links this long. ${about}`
          : `Copied to the clipboard (${link.length.toLocaleString(UI_LOCALE)} characters). ${about}`;
        note.className = link.long ? 'sharenote warn' : 'sharenote';
      };
      copy.onclick = () => void put();
      await put();
    };

    /** The model home (the page's own SDLC and Depot, or servers), when the page has one: the services'. */
    const modelHome = services.modelHome;

    /** CREATE A CLASS… of a grid (src/create-class.ts, fetched the first time it is asked for). */
    const makeClass = async (grid: CubeApp, place: GridPlace, cube: string | undefined): Promise<void> => {
      const grid0 = place.planner ?? planner;
      const source = grid0.source?.();
      // the model's writer: the tab's module, on every plane (the one beside a server's planner writes table models too)
      if (!modelHome || !source || !writesModels(tables)) return;
      const sourceName = place.label ?? 'this source';
      const snapshot = grid.snapshot;
      // refused before the window opens, in words: a source read from no table of its own, a pivot, a lone total
      const table = storeTableOf(snapshot.source.query);
      if (!table) {
        window.alert(`Create a Class makes a class of a table's rows; ${sourceName} is not read from a table of its own.`);
        return;
      }
      let query;
      try {
        query = classLambda(snapshot);
      } catch (e) {
        window.alert(`Cannot create a class of this grid: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      const [{ createClassOf }, home] = await Promise.all([import('../src/create-class.ts'), modelHome.connect()]);
      const model = await createClassOf({
        query,
        table,
        sample: sampleLambda(snapshot.source.query),
        planner: grid0,
        source,
        writer: tables,
        engine: place.engine ?? engine,
        sourceName,
        cube,
        // the page's name, or -- never saved -- its grid's source, without its file's extension (`trades.csv` trades)
        pageName: current.name ?? ((page.suggestedName || sourceName).replace(/\.[A-Za-z0-9]+$/, '') || 'page'),
        model: current.model,
        client: home.client,
        studio: (project, workspace) => modelHome.studio(project, workspace),
        persist: async () => (persistent ||= await services.pages.persist()),
      });
      if (!model) return;
      // the page's model, made with its first class or a grid's table kept: the page has changed
      current = { ...current, model };
      onCubeView?.();
    };
    pageModelNow = () => current.model;
    /**
     * THE PAGE'S MODEL ACTIONS (src/model-actions.ts, fetched the first time either is asked for): each grid of the
     * page as they read it -- its class when it is one, else its rows as a class's, or why they cannot be one.
     */
    const modelActions = async (): Promise<{ actions: typeof import('../src/model-actions.ts'); of: import('../src/model-actions.ts').ModelActionsOf } | undefined> => {
      if (!modelHome || !writesModels(tables)) return undefined;
      const [actions, home] = await Promise.all([import('../src/model-actions.ts'), modelHome.connect()]);
      const grids = actions.pageGrids(page.grids, (id) => {
        const place = sources.place(id);
        const grid = page.grid(id);
        return place && grid ? { snapshot: grid.snapshot, label: place.label ?? id, planner: place.planner ?? planner,
          engine: place.engine ?? engine } : undefined;
      }, (id) => current.model?.classes?.[id], { classLambda, storeTableOf, sampleLambda });
      const sourceName = grids[0]?.label ?? 'page';
      return {
        actions,
        of: {
          writer: tables,
          engine,
          pageName: current.name ?? ((page.suggestedName || sourceName).replace(/\.[A-Za-z0-9]+$/, '') || 'page'),
          model: current.model,
          client: home.client,
          grids,
          studio: (project, workspace) => modelHome.studio(project, workspace),
          persist: async () => (persistent ||= await services.pages.persist()),
          duplicate: duplicateLambda,
          call: (path) => fn(path),
        },
      };
    };
    const landed = (model: PageModelRef | undefined): void => {
      if (!model) return;
      current = { ...current, model };
      onCubeView?.();
    };
    const said = (e: unknown): void => window.alert(e instanceof Error ? e.message : String(e));
    createAssociation = (first) => {
      void modelActions().then(async (m) => m && landed(await m.actions.createAssociationOf(m.of, first))).catch(said);
    };
    createDataSpace = () => {
      void modelActions().then(async (m) => m && landed(await m.actions.createDataSpaceOf(m.of))).catch(said);
    };
    createClass = (grid, place, cube) => {
      void makeClass(grid, place, cube).catch((e: unknown) => window.alert(`Create a Class: ${e instanceof Error ? e.message : String(e)}`));
    };
    /** The chosen source IN PLACE of the page: it empties, then one grid over the source. */
    async function openInPlace(chosen: Chosen): Promise<void> {
      await inPlace(() => sources.opened(chosen, false), sources.named(chosen));
    }

    // THE SOURCE PICKER (the sources'): "add" makes a grid over the chosen source, beside the others; "open" puts it in
    // place of the page
    picker = (purpose: 'add' | 'open', start?: SectionId): Promise<GridMaker | undefined> => sources.pick<GridMaker>(purpose,
      async (chosen) => {
        if (purpose === 'add') return (await sources.opened(chosen, true)).make;
        await openInPlace(chosen);
        return null;
      }, start);

    // A BLANK PAGE (New ▸ Blank Page; the user, 2026-10-01): every grid and chart goes, and the page
    // says what to do first -- a data source (the picker, opening in place) or a saved page (PageApp's empty page,
    // `empty` above). Asked first when there are unsaved changes; the page stays until the person agrees.
    blankPage = (reason?: string) => {
      if (dirty() && !window.confirm('The page has unsaved changes. Start a blank page anyway?')) return;
      place();
      page.clear();
      current = {};
      page.setTitle('');
      sayWhyBlank(reason);
      if (blankCard) blankCard.hidden = false;
      document.title = 'New page';
      (host.querySelector('.dc-blank-actions .dc-primary') as HTMLElement | null)?.focus();
    };

    // A SHARE LINK in the address opens its page, found the way a saved one is (a sample rebuilt,
    // a file asked for). Then the link is taken out of the address: a reload never reopens it over
    // what the person has done since. Last in the setup: opening one reaches everything above
    // (a sample's rebuild included).
    // A SAVED QUERY'S SHARE LINK (query-store/src/share.ts): `#q1.<data>`, or Legend Query's own
    // `#/shared/q1.<data>` -- the query, opened as the cube's source; taken out of the address, as above
    const queryLink = location.hash.replace(/^#\/shared\//, '#');
    const links = queryLink.length > 1 ? await queryStores() : undefined;
    if (links?.isQueryFragment(queryLink)) {
      history.replaceState(null, '', location.pathname + location.search);
      try {
        await openInPlace({ kind: 'saved', query: await sources.openedRecord(await links.readQueryFragment(queryLink)) });
      } catch (e) {
        failedStart(e);
      }
    }
    if (isPageFragment(location.hash)) {
      const fragment = location.hash;
      history.replaceState(null, '', location.pathname + location.search);
      showCubes();
      try {
        await openSaved({ kind: 'page', page: readPageFragment(fragment) }, undefined);
        // a page someone shared opens locked: nothing moves by accident (docs/DATACUBE_PAGES_DESIGN_2026_10_09.md
        // §3.3, 5); its menu's Edit Layout unlocks it
        page.setLayoutEditing(false);
      } catch (e) {
        library?.say(e instanceof Error ? e.message : String(e), 'error');
      }
    }

    // THE SINGLE-USER APP'S START (docs/DATACUBE_APP_PLAN_2026_10_02.md, A3): the launch key signs in
    // to the warehouse that served this page (its config.json names it), then the table asked for is
    // opened, or the tables are offered. The key stays in the address: a reload signs in again.
    if (start.kind === 'warehouse') {
      let on: SignedIn | undefined;
      try {
        on = await sources.signInWithKey(start.key);
      } catch (e) {
        failedStart(e);
      }
      const asked = start.table;
      const found = on && asked ? on.objects.filter((o) => `${o.schema}.${o.name}` === asked) : [];
      if (on && found.length === 1 && found[0]) {
        await openInPlace({ kind: 'table', session: on.session, object: found[0] });
      } else if (on) {
        if (asked) {
          failedStart(new Error(found.length === 0
            ? `${asked} is not a table you may read here`
            : `${asked} is in ${found.length} catalogs (${found.map((o) => o.catalog).join(', ')}): choose one`));
        }
        blankPage(startProblem);
        void picker('open', 'database');
      }
    }
    // A START THAT OPENED NOTHING (a link that failed, a key refused) leaves the blank page, saying
    // why: never an empty page without a word
    if (page.empty) blankPage(startProblem);
  }
  // the start has settled: from now on an empty page is a blank one
  if (blankCard) blankCard.hidden = false;

  /** The reason a start opened nothing, said where the page says what is wrong. */
  function failedStart(e: unknown): void {
    harnessSignal.changes += 1;
    startProblem = e instanceof Error ? e.message : String(e);
    status.textContent = startProblem;
    status.classList.add('bad');
  }
}

/**
 * A host panel, shown as a floating window.
 *
 * The same window the cube uses for its own dialogs
 * (`src/ui/window.ts`), so a panel the host adds behaves like the
 * ones it did not: dragged by its header, resized from any edge, and
 * remembering where it was left.
 */
const hostWindows = new Map<string, WindowSpec>();

function toggleHostWindow(id: string): void {
  const el = must(id);
  if (!el.hidden) {
    el.hidden = true;
    return;
  }
  showHostWindow(id);
}

/** Show a host window (left where it is if already shown), at `size` the first time. */
function showHostWindow(id: string, size: { width: number; height: number } = { width: 720, height: 420 }): void {
  const el = must(id);
  if (!el.hidden) return;
  el.hidden = false;
  const head = el.querySelector('.hostwin-head');
  if (!(head instanceof HTMLElement)) return;
  hostWindows.set(id, makeWindow(el, head, document.body, {
    ...size,
    ...(hostWindows.get(id) ? { spec: hostWindows.get(id) } : {}),
    onChange: (spec) => hostWindows.set(id, spec),
  }));
}


/**
 * Pick a label by an explicit index expression.
 *
 * The index is passed in rather than derived from the value count,
 * because deriving it gave every dimension the same `i % n` and made
 * them perfectly correlated: each desk then had exactly one year, so
 * four of five pivot columns were legitimately null and the grid
 * looked broken. Independent divisors make every combination occur.
 */
function sqlPick(values: readonly string[], indexExpr: string): string {
  const cases = values.map((v, i) => `WHEN ${i} THEN '${v}'`).join(' ');
  return `CASE (${indexExpr}) ${cases} END`;
}

export function must(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}
