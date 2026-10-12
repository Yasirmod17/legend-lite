// THE SERVICES: everything a host gives DataCube's app (docs/DATACUBE_ONE_APP_DESIGN_2026_10_11.md §3.2). The app --
// the page, its sources, its saved pages, its model actions -- is written against these and nothing else of its host,
// so the browser tab, Python's tab and widget, and Python headless are each a set of services for the same app. Each
// service is an existing client over its host's transport, never a second implementation; what a host cannot do is a
// service it does not give, and the app does not offer its entries (§3.4).
//
// Types only: a host's services are built by the host (src/services/browser.ts for the tab).

import type { ModelHome } from '../../../depot-client/src/model-home.ts';
import type { QueryEngine } from '../../../engine-client/src/engine.ts';
import type { SeedSource } from '../../../engine-client/src/model-data.ts';
import type { CatalogObject, WarehouseEngine, WarehouseSession } from '../../../engine-client/src/warehouse.ts';
import type { QueryReader } from '../../../query-store/src/index.ts';
import type { HeldCopy } from '../app.ts';
import type { CubeConfiguration } from '../config.ts';
import type { Planner, SnapTarget } from '../cube.ts';
import type { CubeStore } from '../cube-store.ts';
import type { FileHandles } from '../file-handles.ts';
import type { InferredModel, TableModels } from '../infer.ts';
import type { ModelOptions } from '../planner.ts';
import type { S3Credentials } from '../remote.ts';
import type { CubeSnapshot } from '../snapshot.ts';
import type { UploadResult } from '../upload.ts';

/** Everything a host gives the app. */
export interface Services {
  /** Where queries are planned and run, and where data goes in (§4). */
  readonly engine: EngineService;
  /** Where pages are saved (§5): opened as the app starts, and waited for only where a page is saved or opened. */
  readonly pages: Promise<PageService>;
  /** Where saved queries are, and the projects they compile against. */
  readonly queries: QueryService;
  /** Where classes go: an SDLC and its Depot (§6). Absent: the page makes no class, and opens no project by name. */
  readonly modelHome?: ModelHomeService;
  /** A warehouse the page signs in to, its tables read Live there. Absent: the page offers none. */
  readonly warehouse?: WarehouseService;
  /** The browser's own things. */
  readonly browser: BrowserService;
}

// -------------------------------------------------------------------------------------------------------- the engine

/** Where the page plans: one word, as its status bar says it (`local`, `remote`, `engine`). */
export type PlaneWord = 'local' | 'remote' | 'engine';

/** A plane the page can open on, as its menu offers it. */
export interface Plane {
  readonly id: `host.plane.${string}`;
  readonly word: PlaneWord;
  readonly label: string;
}

/**
 * THE PLANE, chosen once as the app opens (the user, 2026-09-30, and the one-app design's R3): shown in the status bar,
 * never substituted -- a planner that does not answer is said, and the page stops. Another is chosen by opening the app
 * again on it.
 */
export interface PlaneService {
  readonly word: PlaneWord;
  readonly planes: readonly Plane[];
  /** Open the app again on `plane` (the tab: the same page, its `?planner=` the plane's). */
  choose(plane: Plane): void;
}

/** Where queries are planned and run, and where data comes in. */
export interface EngineService {
  readonly plane: PlaneService;
  /** The page's planner: the sample's, and the one a saved query's text is read by. */
  readonly planner: Planner;
  /** What the status bar says of the planner, in one word. */
  readonly label: string;
  /** A planner over another source's model (a page's grids share no model), on the same worker or server. */
  another(model: string, runtime: string, how?: ModelOptions): Planner;
  /** A model's elements as the compiler reads them: a saved query's project (data spaces, enumerations). */
  elements(text: string): Promise<unknown[]>;
  /** legend-lite's model writer for a table of the host's database, whichever planner plans it (infer.ts). */
  readonly tables: TableModels;
  /** legend-lite's planner for a project's test data: the statements that make and fill its tables (model-data.ts). */
  readonly seeds: SeedSource;
  /** The host's database. */
  readonly database: DatabaseService;
}

/** The host's database: where SQL runs, and every way data comes in -- a file, a remote file, a Snap (§4.2). */
export interface DatabaseService {
  /** Where a grid over one of its tables runs, its database type the model's connection names. */
  readonly engine: QueryEngine & { readonly databaseType: string; run(sql: string, epoch: number): Promise<unknown> };
  /** A file read into a table of its own (`table`), its model written from what the catalog found (upload.ts). */
  ingestFile(file: File, options: { readonly table: string }): Promise<UploadResult>;
  /** A file's table dropped, its name free again. */
  forgetFile(fileName: string, table: string): Promise<void>;
  /** A remote file mounted as a view named `name`, its model written from its catalog (read-only: no conversion). */
  mountRemote(url: string, s3: S3Credentials | undefined, name: string): Promise<InferredModel>;
}

// --------------------------------------------------------------------------------------------------------- the pages

/** Where pages are saved: upstream's DataCube query API (cube-store.ts). */
export interface PageService {
  readonly store: CubeStore;
  /** Said where a page is saved and opened: "in this browser", "for this visit only (...)". */
  readonly where: string;
  /** What the store keeps lasts only this visit (the browser refused storage). */
  readonly memoryOnly: boolean;
  /** Where a page keeps the handle each grid's file was picked through, when the host can keep one. */
  readonly handles?: FileHandles;
  /** Ask that what is saved be kept (the browser's persistent storage): whether it was promised. */
  persist(): Promise<boolean>;
}

// ------------------------------------------------------------------------------------------------------- the queries

/**
 * A project a saved query can belong to, as the host's configuration names it: what it compiles against (`models`,
 * Pure text joined in order) and the SQL that puts its rows in the host's database (`seed`, one statement per line).
 */
export interface ConfiguredProject {
  readonly groupId: string;
  readonly artifactId: string;
  readonly versionId: string;
  readonly title: string;
  readonly models: readonly string[];
  readonly seed: readonly string[];
}

/** Where saved queries are (upstream's query store API), and the projects the host configured for them. */
export interface QueryService {
  readonly store: () => Promise<QueryReader>;
  /** Said where they are: "in this browser", "on host:port". */
  readonly where: string;
  /** Told when another app on the host saves one (the browser's own store), when the host can say. */
  readonly watch?: (changed: () => void) => () => void;
  readonly projects: readonly ConfiguredProject[];
  /** A file of a configured project (a model, a seed), by its URL. */
  fetchText(url: string): Promise<string>;
}

// ----------------------------------------------------------------------------------------------------- the model home

/** Where classes go, and where a saved query's project is opened by name (§6). */
export interface ModelHomeService {
  /** The SDLC and its Depot, connected the first time they are asked for. */
  connect(): Promise<ModelHome>;
  /** Studio, opened on a project's workspace, where the host serves it. */
  studio(project: string, workspace: string): string;
}

// ------------------------------------------------------------------------------------------------------ the warehouse

/** A warehouse the page signs in to as its user (engine-client/src/warehouse.ts). */
export interface WarehouseService {
  /** The warehouse the picker offers first: the deployment's, else the one this browser signed in to last. */
  offered(): string;
  /** Remember the warehouse signed in to, for the next visit. */
  remember(url: string): void;
  connect(url: string, user: string, password: string): Promise<{ session: WarehouseSession; objects: CatalogObject[] }>;
  /** The single-user app's launch key: signed in with it, at the warehouse that served the page. */
  signInWithKey(key: string): Promise<{ session: WarehouseSession; objects: CatalogObject[] }>;
  /** A table's rows read Live there, as the signed-in user. */
  live(session: WarehouseSession, catalog: string): WarehouseEngine;
}

// -------------------------------------------------------------------------------------------------------- the browser

/** The browser's own things: the same in a tab and under a notebook's cell. */
export interface BrowserService {
  download(name: string, mime: string, content: string | Uint8Array): void;
  /** Text onto the clipboard; refused, in words, where the browser does not let the page copy. */
  writeClipboard(text: string): Promise<void>;
  /** The grids' settings kept between visits (upstream's settingsData); undefined when none or not readable. */
  readSettings(): Record<string, unknown> | undefined;
  writeSettings(values: Record<string, unknown>): void;
  /** This page's address, which a share link opens; absent where no one else can open it, and no link is offered. */
  readonly address?: () => string;
  /** The page's own tab's title (its name, and whether it changed); absent where the page is not a tab of its own. */
  readonly title?: { readonly base: string; set(text: string): void };
}

// --------------------------------------------------------------------------------------------------------- the start

/** The tab's sample: generated rows (or a remote file read through the same model) under the demo's model. */
export interface Sample {
  /** Its opening view, typed by the compiler over its source. */
  readonly snapshot: () => Promise<CubeSnapshot>;
  readonly snapTarget: SnapTarget;
  /** Generated rows are a copy in the host's database from the start; a mounted remote file is live. */
  readonly heldCopy?: HeldCopy;
  readonly configuration: CubeConfiguration;
  readonly dimensions: { name: string; columns: string[] }[];
}
