# The rest of the program: twin hosts, one implementation, and legend-lite as a drop-in legend-engine (proposed 2026-10-12)

The user, 2026-10-12: "lets plot out the whole rest of the program completely so we can see every step"; on the
stores, "we should try as hard as we can to use the same interfaces inside them - with only the 'storage' part
different"; and on legacy mode, "really why we want legacy mode is actually so that legend-lite can be a drop in
replacement for legend-engine - and so legacy mode really has two parts the UI talking to real legend-engine and the
UIs talking to a real legend-lite server over the EXACT same protocols/APIs".

Where this starts: DataCube is one app on every host (`docs/DATACUBE_ONE_APP_DESIGN_2026_10_11.md`). Steps 1 and 2 and
PlanAndRun (its §15) landed 2026-10-12 (36b72ee13, PR #31). The Compiler Rewrite line's fix answering every stored Variant as
JSON landed after it (47349d82a).

## 1. The three rules

1. **Twin hosts.** The browser and Python give the same capabilities. A feature's code comes with the app; a host
   gives only services (one-app design §12: "on Python, the work is services, never features"). A check in the app
   for a host's own pieces, rather than for a service, is a bug.
2. **One implementation, storage per host.** Logic that runs on more than one host (the browser, Python, a server)
   exists once. Only where it keeps its records, and how a call reaches it, differ.
   - The SDLC already works this way: `Sdlc.java` and `Depot.java` over `Storage` (`get`, `put`, `delete`,
     `keys`), with memory the page keeps in IndexedDB in the browser, and a git folder on a server (`GitStorage`).
   - **A remote git (GitHub) is a push and pull of the local git store, not a `Storage`.** One SDLC call reads and
     writes many small objects: live over GitHub's API it would be slow, rate-limited and without a transaction.
3. **legend-lite is a drop-in legend-engine.** Over the exact same protocols, the UIs (Studio, Query, DataCube) work
   against a real legend-engine, and against a legend-lite server with the same answers. New features that need
   legend-lite's own routes (Create a Class…) are offered only where those routes answer, as every action is
   (one-app design §3.4).

## 2. Logic that exists twice today (measured 2026-10-12)

| Logic | Where it is now | The move |
|---|---|---|
| Saved-query rules | Java `core/.../server/SavedQueries.java` (files written directly, no storage interface); a TypeScript port, `query-store/src/local-server.ts` ("rule for rule, word for word"), over IndexedDB | The Java over a records interface, answered by the browser's WebAssembly module, Python's native library and the server; the port deleted (B5) |
| legend-engine's execute API in the tab | `engine-client/src/legend/browser-engine.ts`: parameters bound as `let`s, "Missing external parameter(s)", a graph fetch's one object written bare, the TDS answer's shape. The same rules are Java (`PureV1Api`), used by legend-lite's server and Python (`Boundary.executePlan`) | The tab asks the module's Java for the API part; its TypeScript executor still runs the SQL and types the rows (C1) |
| The warehouse's SQL API client | TypeScript `engine-client/src/warehouse.ts`; the Java binding `warehouse/.../sqlapi/SqlApiBinding.java` (meant to be the only one, built for neither the browser nor Python) | The binding built into the module and the native library; TypeScript and Python only make the HTTP calls it describes (C3) |
| Saved-page rules | TypeScript `datacube/src/cube-store.ts` `RuleStore`, records per host (IndexedDB, Python's folder) | Java beside saved queries, the same pattern, so a server can keep pages too (B6) |
| Two planner protocols | DataCube's (`planner-protocol.ts`, Python's `_planner.py`) and Query/Studio's (`engine-client/src/legend/planner-answer.ts`), over the same `Boundary` | One protocol (C2) |
| Small copies | The site's file-type table (Python's `engine.py`, `WarehouseServer.java`); saved-query read and write rules (DataCube's `saved-queries.ts`, Query's `persist.ts`) | One each (C4) |

Also measured:
- Python's page gets a new origin every run (the engine binds port 0), so whatever the browser keeps per origin (grid
  settings, a remembered warehouse) is lost each run.
- The in-page stores trust a configured user name: fine on one's own machine; a shared server needs sign-in (G10).

## 3. The phases

Each step lands on its own: an audit, the local gate, CI, the user's OK. Steps that touch another line's files are
built here and reviewed by that line (Compiler Rewrite for Bazel, Plan Gen for the planner boundary, Studio for
`sdlc-server/`, `query-store/` and `studio/`).

### L. Legacy mode: legend-lite as a drop-in legend-engine (its check first, early)

1. **The check.** Each UI's flows (Query: a data space, a query built, run and saved; Studio: a project opened,
   edited, compiled, tested, reviewed; DataCube: a source on the engine plane) run against:
   - a real legend-engine (4.145.0, the pinned reference), with legend-sdlc and the Depot for Studio;
   - a legend-lite server, the same flows.

   Every request and answer is recorded. Per app and per call, the outcome is the same, different, or missing on one
   side. This is a differential at the API's level, as the cube corpus is at the query's.
2. **The guard.** In legacy mode a UI sends nothing legend-engine does not answer: no legend-lite-only route, and
   nothing answered in the tab that legend-engine would answer. Measure first whether Query's server mode keeps
   grammar in the tab.
3. **legend-lite answers every call exactly.** Each difference the check finds is fixed on legend-lite's side: the
   compatibility plan mode, and the answer's exact value and text (PARK-24's rule). The differential becomes a test in
   a lane.
4. **Beyond the UIs.** "Everything legend-engine can do" is the API surface as a whole, held by the compiler line's
   parity work (PCT, the corpora) and by this differential, widened call by call.

### B. One implementation per store, storage per host (the one-app design's step 3, widened)

1. **The model actions depend only on services.** Create a Class…, Create an Association… and Create a Data Space…
   today need the tab's own planner (`services.engine.local`), skip a grid whose rows come from a runner (every Python
   grid since PlanAndRun) and name the place `Browser` in the code. Instead: a model writer and sample rows through
   PlanAndRun from every host, the place named by the host. Then sweep the app for every other host-only check.
2. **Python's page keeps its origin.** A fixed port per user (or the host's own settings), so what the browser keeps
   per origin survives a run.
3. **The SDLC and the Depot in Python's native library,** the same Java over `GitStorage` in this user's folder
   (`ll.home()/projects`), a lock held across Python processes around each call. Python serves `/sdlc/api` and
   `/depot/api`, headless calls them in-process. The SDLC's conformance suite (`sdlc-client/test/conformance.ts`)
   runs against the server, the browser's module and Python. Python's pages get Create a Class… and the rest.
   - Build: `GitStorage` its own target, `sdlc-server`'s rules visible to `//native` (the Studio line's file).
4. **Python's own `grid.create_class`, `page.create_association`, `page.create_data_space`,** back from
   `datacube/python-model-parked` on this home, as the cores of the same actions (one-app design §8). The page
   document records the revision a page is pinned to (owed: `PageModelRef`).
5. **Saved queries, one implementation.** `SavedQueries.java` over a records interface (a query's versions, put, all),
   the file layout as today; its routes answered by the browser's module, Python's native library and the server; the
   conformance suite (`query-store/test/conformance.ts`) against all three; `local-server.ts` deleted; Python's pages
   get saved queries. Core's file split is announced in IN_FLIGHT first.
6. **Saved pages, one implementation.** `RuleStore`'s rules in Java beside saved queries, records per host.
7. **A remote git.** A project's git store pushed to and pulled from a remote (GitHub): what promotion (F4) builds on.

### C. One engine path

1. **The tab's execute API from the module's Java** (§2's second row), the TypeScript executor unchanged; a lambda's
   return type and an execution plan answered in the tab, which the module already can (Query's SQL button with no
   server).
2. **One planner protocol** for DataCube, Query and Studio.
3. **The warehouse's binding in the module and the native library.** Warehouse tables on Python's pages: Python plans
   and runs on the warehouse (the page sends Pure, never SQL), Snap lands in Python's DuckDB.
4. The small copies (§2) made one.

### D. Headless pages (the one-app design's step 4)

Every window's action a core of its own (Save, export, the model actions); `page.export` from Python.

### E. Studio and Query from Python (the one-app design's step 5, with the Studio line)

Python serves the site; `ll.studio()` and `ll.query()` open them, pointed at Python's SDLC, Depot, saved queries and
engine. Needs B3 and B5.

### F. The model plan's remaining steps (`docs/DATACUBE_MODEL_DESIGN_2026_10_10.md` §13), on both hosts by construction

1. Dashboards on classes: page filters and cross-filtering by a class's property.
2. Combining in prep: the join dialog in every form legend-lite has.
3. The model view: classes and associations, related properties walked, filters through named ends.
4. Promote and publish: a page's project to a team SDLC or a remote git (B7), export as Pure, publishing on a released
   model.
5. Measures in the model.

### G. Follow-ups (the one-app design's §15.7 and after)

1. Remote planners on Python (legend-lite's server, legend-engine): the seams are there.
2. Python's results streamed back in chunks.
3. One DuckDB 1.5 release everywhere, the corpus tests' included (today 1.5.4 in the tab, 1.5.5 in Python).
4. Text encodings: UTF-16, gzipped files, Latin-1 read as Latin-1.
5. Iceberg files on Python (the user's call: the extension adds 13 to 22 MB per wheel).
6. A connection per page on Python (optional: today one shared connection, a feature).
7. A page plan's `sourceUrl('file:...')` refused (optional hardening; accepted as is, §15.4).
8. The upload's SQL into the dialect (D9, with the dialect program).
9. One result-typing table for the Java, TypeScript and Python executors (the Plan Gen line's phase 3).
10. Sign-in where a store is shared (§2's last point).

### H. Publishing

PyPI; the npm packages' third-party notices; the FINOS name; the copyright-holder sweep.

## 4. The order

L1 (the check) now. It is cheap, and it says where the drop-in stands before more is built.

Then B (B1 to B4 first: Python's model home and Create a Class… on its pages), C, then E, with D beside them. L2 and L3
run alongside, as the check's findings come in.

F's features follow the foundations, so each lands once on both hosts. G's items are taken where they block something.
