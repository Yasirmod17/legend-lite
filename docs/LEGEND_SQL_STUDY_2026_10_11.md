# Legend SQL ("AlloySQL"): what upstream built, how to port it, and SQL/dbt as modeling surfaces

**Status: research and brainstorm (2026-10-11). Nothing here is decided, scheduled or announced in
`docs/IN_FLIGHT.md`.** It answers the user's question of 2026-10-11: study the Postgres-compatible SQL front end
of legend-engine/legend-pure deeply, port it to legend-lite, and consider (a) SQL as a modeling surface beside
Pure grammar and Python, and (b) a dbt-compatible front end ("Postgres-compatible for queries, dbt-compatible
for modeling, Postgres dialect throughout"). §0 is the answer; §1–§2 are the evidence; §3–§6 are the design;
§7–§8 are the plan and the open decisions.

Reference checkout used: `finos/legend-engine` at `e60ab67a` (2026-10-10). Paths below are relative to that
repository unless they start with `core/`, `docs/`, `python/`, `warehouse/`. "AlloySQL" does not occur in either
upstream repository. Alloy is Legend's internal name, and the thing the user means is legend-engine's
`legend-engine-xts-sql` module family plus its grammar in `legend-engine-xt-relationalStore-postgresSql`.
**legend-pure has no SQL front end at all.** Its only SQL code is the relational store's natives
(`legend-pure-store-relational`).

---

## 0. The answer: yes, and it is one project, not three

1. **The three ideas share one core.** Each is a **Postgres-SQL → Pure Relation translator** plus a shell:
   - *Query front end* = translator + Postgres wire server + a catalog.
   - *dbt front end* = translator (every dbt model body is a SELECT) + a project loader (YAML, a Jinja subset) +
     materializations (writes).
   - *SQL modeling* = translator (view and function bodies) + a DDL reader (CREATE TABLE/TYPE/DOMAIN/VIEW/FUNCTION
     → model elements).

   Build the translator once, well, and the rest are thin layers.

2. **Port the spec and the tests, not the code.** Upstream has three parts:
   - A **CrateDB grammar**. About 80% of it is dead surface that is parsed and then rejected.
   - An **8.2k-line translator written in Pure**. It builds Pure graphs by hand, prints them to text and recompiles
     them. It keeps a TDS branch and a Relation branch for almost every operation.
   - A **Crate-derived wire server**. It starts a Docker `postgres:10.5` to answer catalog queries and calls the
     engine over HTTP.

   legend-lite's tenets rule out running or porting engine Pure: the world map, C6, and the reference-checkout
   tenet. The code's quality argues the same way. What is worth taking:
   - the source conventions (`tb`/`func`/`service`/`csv`, the `tb__pkg` schema mangling);
   - the function table, as a spec;
   - above all, the **test corpora**:
     - 2,340 parity cases with a real-Postgres oracle;
     - 230 SQL→Pure transpile pairs;
     - about 1,060 reverse-PCT triples;
     - 83 parser round-trip cases.

3. **Target `protocol.spec.ValueSpecification` (Relation API), entering at `Compiler.query(ctx, vs)`; do not
   target the SQL IR.** Legend sources (functions, services, classes through mappings) are resolved in G and H,
   which the IR is downstream of. The real compiler then types the query **once**. Upstream instead re-derives
   the schema at 22 sites and re-compiles through text.

4. **"Postgres-compatible" must be defined honestly.** That means:
   - the wire protocol, the grammar, function names and the catalog are Postgres;
   - the **semantics are Pure's**, executed by whichever database the runtime names.

   Every place where the two differ (NULL `=`, identifier case, numeric literals, INTERSECT precedence…) is a
   `docs/SEMANTICS_REGISTER.md` row, never a silent default. Upstream already deviates (§1.3).

5. **SQL is the right modeling surface for the relational layer and the wrong one for the object layer.**
   - It fits stores, relation-valued functions, enums and constrained primitives.
   - It cannot say classes with inheritance, to-many properties, M2M mappings, milestoned navigation or graph
     fetch.

   dbt's YAML fills exactly that gap: columns, contracts, constraints, `semantic_models` (entities, dimensions,
   measures) and the open `meta:` key. So "dbt-shaped project, Postgres-dialect SQL" is coherent, and it maps
   almost one to one onto Legend (§5.1).

6. **The dbt angle has a real gap to fill.**
   - **What dbt v2 offers:** it is a Rust rewrite that "produces and validates a logical plan for every query"
     before running anything.
   - **Where it falls short:** strict type-checking needs `dbt login`, the type checker ("Level 2 SQL
     comprehension") is proprietary, and **Postgres is not a v2 adapter**.
   - **What legend-lite would add:** it would compile dbt-shaped Postgres projects with full typing, column
     lineage, a real semantic layer (classes and associations) and multi-backend rendering. dbt has none of
     these, and they come from legend-lite's own tenets. Sources: §9.

7. **The cost is real, and so is the contention.** Two things are missing in the compiler:
   - writes: `TypedWrite` to a store throws at `core/.../lowering/Lowerer.java:3062`;
   - `intersect`/`except` natives and recursive CTEs.

   There is also contention. pgwire is the paused server program's leg W3, and "Make a class" belongs to the
   DataCube line. A first useful slice is smaller: SQL over HTTP and in `#SQL{}#` islands, with no wire protocol
   (§7, phase 1).

---

## 1. What upstream built (the study)

### 1.1 Module map and sizes

| Part | Where | Size (lines) |
|---|---|---|
| Grammar (ANTLR4, **CrateDB's `SqlBase`**, Crate.io Apache header) | `legend-engine-xts-relationalStore/.../legend-engine-xt-relationalStore-postgresSql/...-grammar/src/main/antlr4/.../SqlBase{Lexer,Parser}.g4` | 497 + 868 |
| Parse tree → AST visitor | `...-grammar/.../from/SqlVisitor.java` | 2,327 (about 700 are `unsupported` stubs) |
| AST → SQL text | `...-grammar/.../to/SQLGrammarComposer.java` | 746 |
| Postgres date-string parser | `...-grammar/.../from/PostgresDateParser.java` | 485 |
| AST metamodel (Pure; Java POJOs generated from it) | `...-postgresSqlModel-pure/.../metamodel.pure` | 626 (81 classes, 15 enums) |
| SQL → Pure translator (**Pure**) | `legend-engine-xts-sql/legend-engine-xt-sql-transformation/legend-engine-xt-sql-pure/.../binding/fromPure/` | 8,159 (`fromPure.pure` alone 6,347) |
| Source providers (`service`, `func`, `relationalStore`) | `legend-engine-xts-sql/.../legend-engine-xt-sql-providers/*` | 1,334 |
| HTTP API (`/sql/v1/...`) | `legend-engine-xts-sql/legend-engine-xt-sql-http-api` | 2,034 |
| `#SQL{...}#` expression island | `legend-engine-xts-sql/legend-engine-xt-sql-expression/*` | 1,148 |
| Postgres wire server (Crate-derived pgwire, Netty) | `legend-engine-xts-sql/legend-engine-xt-sql-postgres-server` | 15,506 main + 5,557 test |
| reverse-PCT corpus | `legend-engine-xts-sql/.../legend-engine-xt-sql-reversePCT` | 15,244 Pure |
| e2e parity corpus | `legend-engine-xts-sql/legend-engine-xt-sql-e2e-tests/src/main/resources/parity-tests/` | 73 YAML files, **2,340 cases** |

### 1.2 Grammar and AST

**Surface.** The grammar has 41 statement alternatives: transactions, SET, SHOW, DDL, DML, GRANT, cursors, and
CrateDB-only constructs (BLOB TABLE, SNAPSHOT, KILL, OPTIMIZE, `SET LICENSE`). **Only the query alternative
produces an AST.** Every other alternative throws `Unsupported Operation` (119 call sites, `SqlVisitor.java:2323`).

**Supported in queries:**
- CTEs, including `RECURSIVE` (kept as a flag).
- UNION, INTERSECT and EXCEPT [ALL].
- CROSS, INNER, LEFT, RIGHT, FULL and NATURAL joins, with ON or USING, plus `LATERAL`.
- Scalar, IN, EXISTS and ANY/ALL subqueries.
- Windows: inline, named `WINDOW w AS`, ROWS/RANGE frames, `FILTER (WHERE)`, `WITHIN GROUP`, ordered
  aggregates.
- HAVING; `ORDER BY ... NULLS FIRST/LAST`; LIMIT, OFFSET and FETCH FIRST.
- VALUES.
- Table functions with `name => value` arguments.
- `CAST`, `::` and `type 'lit'`.
- INTERVAL, arrays and slices.
- `$n` and `?` parameters.
- `$$`/`$tag$` strings.
- Postgres regex operators (`~ ~* !~`) and JSON operators (`-> ->> #> @>`...).

**Absent:**
- GROUPING SETS, ROLLUP and CUBE (not even tokens).
- QUALIFY, DISTINCT ON, SIMILAR TO, GROUPS frames, `E''` strings, `TRY_CAST`, `AT TIME ZONE`.
- Multi-statement input.

**Quirks that must not be ported:**
- Unquoted identifiers **keep their case**; Postgres folds them to lowercase (`SqlVisitor.java:902`).
- INTERSECT binds with the same precedence as UNION (`:1010`); in Postgres it binds tighter.
- Every decimal literal becomes a `DoubleLiteral`.
- **Silent drops:**
  - a parenthesised query loses its trailing ORDER BY/LIMIT (`:1009`, `:1039-1052`);
  - interval signs, qualifiers and unknown units are dropped (the regex at `:43` uses a character class instead of
    alternation);
  - `WITH ORDINALITY` and `IGNORE NULLS` are dropped.
- A column named `user` parses as `CURRENT_USER`.
- The AST has **no source positions**, and no record of whether an identifier was quoted.

**The composer is not a fixpoint.** Its 83 round-trip tests compare text case-insensitively, and the lowercased
input is checked too. Bugs found by reading the code:
- `FULL JOIN` renders as `null JOIN`.
- `count(DISTINCT x) FILTER (...)` loses both the DISTINCT and the filter.
- `'` is not re-escaped.
- `NOT (a OR b)` renders as `not a OR b`.
- Arrays print in CrateDB's `[...]` syntax.

### 1.3 The translator (SQL AST → Pure)

**Pipeline**:
1. Java parses the SQL, and the generated `ProtocolToMetamodelTranslator` turns the AST into Pure instances
   (`.../http-api/.../SQLExecutor.java:452`).
2. Java `QueryRealiaser` gives every relation a unique alias.
3. Pure `sqlToPure` (`fromPure.pure:194-256`) builds `SimpleFunctionExpression` graphs by hand
   (`compileUtils.pure:67-111`, `TDSBuilder` `:5894-6328`).
4. In relation mode the result is **printed to Pure text together with every dependent element, wrapped in a
   container function, and recompiled** (`compileUtils.pure:247-283`).
5. Then the plan, then `PlanExecutor`.

**Target shape: two branches.**
- Legacy TDS (`project/restrict/olapGroupBy`, `$row.getInteger('X')`), or the Relation API (`~col`,
  `extend(over(...))`).
- The choice is made by the sources (`rootContext`, `:5540-5546`); mixing the two throws.
- A `$relation` flag is tested at 116 sites. Several features are Relation-only: intersect/except, subqueries,
  LATERAL, VALUES, recursive CTEs, ordered/filtered aggregates.
- **A port targets the Relation API only, which roughly halves the logic.**

Example (`testTranspile.pure`, `testGroupBy`):

```sql
SELECT count(Integer) AS "count" FROM service."/service/service1" GROUP BY String
```

```pure
...->groupBy(~[String], ~[count:{x|$x.Integer}:{y|$y->count()}])->select(~[count])
```

**Sources.** Every FROM item becomes `(type, args)`:

| SQL | Meaning | Provider |
|---|---|---|
| `service('/pattern', coordinates=>'g:a:v', p=>1)` or `service."/pattern"` | a Legend service (single or multi-execution) | Java `LegendServiceSQLSourceProvider` |
| `func('pkg::f__Relation_1_', p=>v)` | a function returning a Relation/TDS | Java `FunctionSQLSourceProvider`, Pure dynamic source |
| `relationalStore(connection=>.., store=>.., schema=>.., table=>..)` | a raw table plus a synthesised runtime | Java |
| `tb('pkg::DB.schema.table')` | `#>{pkg::DB.schema.table}#` | Pure dynamic source |
| `csv('a,b\n1,2')` | an inline `#TDS{}#` | Pure dynamic source |
| `unnest(arr)`, `var('name')` | flatten, or a Pure variable in scope (for `#SQL{}#`) | table-function processors |
| `x` (one part) | a CTE | — |
| `a.b` (two parts) | rewritten to `a('b')` | — |

There is no class, data space or data product source; Legend's object layer is not addressable from Legend SQL.

**Catalog exposure:**
- `sql/v1/schema/getSchema` publishes only Database tables, as `tb` relations.
- The schema name is mangled as `tb__<pkg>`, with `_` → `__` and `::` → `_`.

**Expressions:**
- `processExpression` handles 31 node kinds.
- `functionProcessors()` has about 110 named Postgres functions: 17 aggregate, 29 math, 33 string, 6 date,
  11 window, plus conditional, collection, JSON and `to_char` with its own token engine. Each one picks a Pure
  overload from its argument types. Unknown names fail.
- Types come from a hand-maintained `QueryColumn{name,type,multiplicity}` environment, re-derived by `clone()`
  (`:5832-5865`, "resolve schema is expensive").
- A contextual "expected type" slot coerces literals. In `DateCol > '2023-01-01'`, the string becomes a date
  through the **Java native `parsePostgresDate` at translation time**. Under legend-lite's C2 that is a host
  computation, and a port must not do it (§3.4).
- **NULL semantics:**
  - Comparisons choose `[0..1]`-aware overloads.
  - `NOT IN (subquery)` is spelled out three-valued.
  - `=` keeps SQL three-valued logic only through a **plan-level flag**, `LEGACY_SQL_NULL_UNSAFE_EQUALS`
    (`fromPure.pure:326`). This is upstream conceding that SQL `=` is not Pure `==`.

**Explicitly unsupported (throws):**
- NATURAL JOIN; LEFT, RIGHT or FULL LATERAL.
- Interval frame bounds.
- Multi-column IN.
- Duplicate output names.
- WITH across runtimes.
- WITH RECURSIVE with UNION, or with ORDER BY/LIMIT.
- DDL, DML and SET.

The parity corpus quantifies the gap. Its per-case `expected_rel_status` columns read **1,106 PASS / 1,039
ERROR / 88 BUG / 45 FAIL / 62 SKIP of 2,340** for the Relation path.

**The `#SQL{...}#` island** (`xt-sql-expression`) makes SQL a Pure *expression*: `#SQL{select a from tb('p::DB.t')}#->filter(x|$x.a==1)`.
- Lambda variables in scope are visible through `var('name')`.
- legend-lite already parses the island (`core/.../parser/SpecParser.java:3140`) and refuses it at the Typer
  (`core/.../compiler/spec/Typer.java:180`).
- Once a translator exists, that refusal becomes a call to it.

### 1.4 The wire server

- **Inherited from CrateDB:**
  - **Protocol:** Netty, protocol v3, simple and extended query (Parse, Bind, Describe, Execute, Sync, Close,
    portals). No COPY.
  - **Authentication:** cleartext, GSS/Kerberos with credential delegation, or none. No MD5 or SCRAM, and **no
    TLS** (always answers `N`).
  - **Cancel:** BackendKeyData is commented out, so a client's cancel only closes a connection.
  - **Transaction status:** ReadyForQuery always reports `I`.
  - **Errors:** every error is SQLSTATE `XX000`, and a 20-frame Java stack trace goes back to the client in the
    `W` field.
- **Dispatch:**
  - The raw ANTLR tree classifies each statement:
    - BEGIN and SET are no-ops ("TODO: Handle set queries");
    - `SHOW TRANSACTION ISOLATION LEVEL` gets a constant answer;
    - a query with no table, or one naming `information_schema` or `pg_*`, is sent to the metadata database;
    - everything else is a Legend query.
- **Catalog:** the server **starts a Docker `postgres:10.5`** (`.../protocol/sql/SQLManager.java:110`) with a
  90-connection Hikari pool.
  - Per session it creates a `metadata_<n>` schema, copies `pg_class`/`pg_attribute`, and inserts Legend's
    tables and columns.
  - Only the five *qualified* `pg_catalog.pg_*` names are rewritten. Unqualified `pg_class`, `pg_type` and
    `information_schema.*` read the container's real catalog.
- **Legend execution:**
  - **Remote:** the SQL text goes over HTTP to `/api/sql/v1/execution/executeQueryString`, or, for databases
    named `projects|g:a:v|...`, as `#SQL{q}#->from(runtime)` to `pure/v1/execution/execute`. The TDS JSON comes
    back stream-parsed.
  - **Describe:** it does a second full compile.
  - **Parameters:** bind parameters are **unsupported** on Legend queries (`setObject` throws).
- **Types:**
  - Decimal, Number and Numeric are sent as `float8`.
  - Timestamps are carried as epoch milliseconds.
  - Unknown types fall back to `varchar`.
- **Tests:**
  - pgjdbc only. There are no psql `\d`, DBeaver, Tableau or Power BI probe tests, and the README says "More
    details to follow".
  - The e2e suite uses Testcontainers `postgres:16-alpine` as the oracle and ratchets per-case statuses.

**What is portable as plumbing (about 7–8k lines, Apache-2.0, keep the Crate NOTICE):**
- the decoder, messages, type codecs, `Session`/`Portal`, the per-connection future chain, and `DelayableWriteChannel`.

**What must be replaced:**
- the HTTP bridge, the Docker catalog, the type table, the `projects|` database convention, and Kerberos
  `Subject.doAs`.

### 1.5 The test estates, and how legend-lite may use them

Under the reference-checkout tenet these files are **test input**, never runtime.

| Corpus | Content | Use |
|---|---|---|
| `parity-tests/**/*.yaml` + `schema.yaml` | 2,340 SQL cases over a seeded schema (persons, departments, orders…), categorised (functions 882, operators 638, structural 590, format_tokens 80, compositions 59, window_frames 44, predicates 37), oracle = real Postgres | **The conformance target.** Commit the oracle's answers as fixtures generated once against PG16, so CI needs no Docker, and ratchet statuses as upstream does |
| `testTranspile.pure` | 230 SQL → expected Pure pairs (TDS and/or Relation) | Translator unit tests: the Relation half, normalised to legend-lite's canonical Pure text |
| reverse-PCT | about 1,060 `(PCT id, Pure expr, SQL)` triples, self-contained through `csv()`, plus 259 expected errors | Ties the function table to the PCT lane: each SQL string must agree with the PCT expectation of its Pure twin |
| `TestSQLRoundTrip.java` | 83 parse/compose cases | Parser round trip, rebased onto a real AST fixpoint |
| `parsePostgresDate.pure` | 27 date-format cases | Spec for which literal spellings to accept (§3.4) |

---

## 2. What legend-lite has today (the seams)

- **No SQL text parser of any kind.** `docs/LEGEND_SQL_VISION.md`'s "N-in readers" were never built:
  - its writers (dialects) and its two prerequisites (`SqlType`, `ArchitectureTest.sqlLayerIsStandalone`) are done;
  - its parser core and its "SQL → Pure writer" are not.

  The closest relatives:
  - `normalizer/RelOpTranslator` turns `###Relational` dynaFunction trees, which are SQL-ish, into Pure.
  - `parser/GqlParser` (720 lines) is a hand-written parser for a foreign grammar.
  - `sql/dialect/RawSqlBoundary` is a regex H2→backend shim. Its own javadoc names the parser leg as its
    replacement.
- **No pgwire.** The paused `docs/SERVER_PROGRAM_2026_09_26.md` plans it as leg W3 (decision 5, pgwire before
  Flight SQL), but for the *warehouse*, a DuckDB SQL passthrough, not for Legend SQL.
- **Entry points a front end needs, which exist:**
  - **Queries:** `Compiler.query(ModelContext, protocol.spec.ValueSpecification)` (`core/.../Compiler.java:559`),
    "a query that arrives ALREADY PARSED… nothing is re-spelled as text". `TypedQuery.plan`/`.resultType` then
    give Describe its columns without a second compile.
  - **Models:** `Protocol` records → `model/FromProtocol` → `ParsedModel` → `Compiler.buildModel`
    (`Compiler.java:221`). `FromProtocol` says "everything legend-lite compiles comes through here".
  - `protocol.spec` records (`AppliedFunction`, `LambdaFunction`, `ColSpec`, `AppliedFunction.tableReference`
    for `#>{}#`) are the construction surface. `pure-protocol/src/relation.ts` is a working Relation builder
    that is byte-identical to the parser's output, and the best model for a SQL→Relation emitter.
- **Relation natives** cover what a SELECT needs: filter, extend, groupBy, aggregate, join, asOfJoin, lateral,
  concatenate, distinct, select, rename, sort, limit/drop/slice, over and frames, the ranking/value windows,
  `exists`/`in`, quantified comparisons. **Missing:** intersect, except, unpivot, recursion.
- **Writes are absent:**
  - `Lowerer.java:3062` "TypedWrite to a store destination is not yet implemented";
  - `SqlDdl` has only Create/Drop Table/Schema;
  - `SqlDml` has no MERGE or UPDATE.

  `docs/BI_AND_ETL_PLAN_2026_09_29.md` F1 and Track C (C1 materialize, C2 pipelines of Pure functions, C4
  incremental, C5 compiled data-quality checks) plan exactly what dbt materializations need.
- **Modeling:**
  - **Parse-only today:** `PersistenceDefinition` (nothing executes it), `MeasureDefinition` (units, not
    metrics), `DataDefinition`, `PrimitiveExtensionDefinition`.
  - **Working:** the relation class mapping `ClassMapping.RelationFunction` (`~func`), which is what "a SQL view
    becomes a class" lowers to.
  - **Planned:** `docs/DATACUBE_MODEL_DESIGN_2026_10_10.md` plans "Make a class" (upstream's
    `promoteRelationToModel`) and Python's `grid.make_class`, `page.relate`.
- **Python** (`python/legend_lite`) works on Pure text and protocol JSON through the native library. **There is
  no Pythonic class/mapping/store API yet**, and PMCD JSON is not compiled directly: `protocol/ModelReader` feeds
  only the composer, and `PureV1Api` refuses non-text contexts.
- **Overlay grammars are opaque** (`parser/OverlayElementSink`, pinned by
  `ArchitectureTest.opaqueCarrierIsLockedToTheOverlaySeam`). A SQL modeling section that should *compile* must
  therefore be built in, or must emit `Protocol` records outside the grammar SPI.

---

## 3. The query front end: port design

```
Postgres SQL text ─┐
#SQL{...}# island ─┼─▶ sql lexer + parser ─▶ syntax AST ─▶ translator ─▶ protocol.spec.ValueSpecification
pgwire Q/P         ┘    (hand-written)       (records,       (scopes,      (Relation API calls)
/api/sql/v1/*                                 spans)          functions)          │
                                                                                  ▼
                                    Compiler.query ─▶ G ─▶ G½ ─▶ H ─▶ I ─▶ J ─▶ K   (unchanged)
```

### 3.1 Parser and AST

- **Hand-written** (lexer plus Pratt/recursive descent), like `GqlParser` and the Pure lexer. Core compiles to
  TeaVM WebAssembly and GraalVM native-image, and an ANTLR runtime, Calcite or JSqlParser is a poor fit for both.
- **Grammar:**
  - the **Postgres** query subset, with Postgres precedence (INTERSECT tighter than UNION);
  - session statements (SET, SHOW, BEGIN/COMMIT/ROLLBACK, DISCARD) as typed nodes for the wire layer;
  - a DDL subset only when §4 needs it;
  - spec: the Postgres manual, not Crate's grammar.
- **AST:** about 60 immutable records with **source spans** and a **quoted-identifier flag**. Errors carry
  positions so the LSP can underline SQL.
- **Placement:** a syntax AST in its own package, *not* `com.legend.sql`. The IR is a back-end IR. It carries
  `TypeFact`s and lowering-only variants (`CheckedDefects`, `DeferredTdsString`, `PlanParam`…), and
  `docs/LEGEND_SQL_VISION.md`'s "standalone N-in" reader can later add a syntax-AST → IR step for raw-SQL transpiling (`RawSqlBoundary`'s
  replacement). This is decision D2 (§8).
- **Printer:** a true fixpoint, checked as `parse(print(ast)) == ast` over a property corpus and the 83 upstream
  cases.

### 3.2 Translator (SQL AST → Relation `ValueSpecification`)

- **Relation API only. No TDS branch.**
- **Scopes:**
  - each FROM item contributes a column environment;
  - correlated subqueries see outer scopes;
  - CTEs become `let` bindings.

  The environment of a source comes from **the compiler**: the relation type of the source sub-expression,
  computed by the same routine that `compilation/lambdaRelationType` serves. The translator does not keep a
  parallel type system; the final query is typed once by G (invariant 1).
- **Clause mapping:**

  | SQL clause | Relation API |
  |---|---|
  | FROM / JOIN | `join(..., JoinKind, {l,r|...})` |
  | WHERE | `filter` |
  | SELECT expressions | `extend` + `select`/`rename` |
  | GROUP BY / HAVING | `groupBy` + `filter` |
  | window | `extend(over(...))` |
  | ORDER BY | `sort` |
  | LIMIT / OFFSET | `limit` / `drop` / `slice` |
  | DISTINCT | `distinct` |
  | UNION ALL | `concatenate` |
  | UNION | `concatenate->distinct` |
  | EXISTS / IN | `exists` / `in` |

  `intersect` and `except` need new natives (or a desugaring into `exists`, registered).
- **Function table:**
  - **data, not code:** Postgres name → Pure native, plus the argument and type rule that chooses the overload;
  - **spec:** upstream's about 110 processors;
  - **verification:** every entry's Pure side against the registry's signatures, in the "spec by VERIFICATION"
    spirit of the reference-checkout tenet;
  - an unknown function is a positioned compile error.
- **Expected outputs:**
  - Upstream's join column renaming (`col_<alias>`), HAVING matched by expression text and `_1` suffixes are
    artifacts of its typing. The port drops them.
  - The emitted Relation text should read like hand-written Pure. This is the "adoption weapon" of
    `LEGEND_SQL_VISION.md`: SQL in, idiomatic Pure out.

### 3.3 Sources (what a table name means)

Upstream's conventions are kept so that existing queries run: `tb`, `func`, `service`, `csv`, `var`,
`relationalStore`, CTEs, and `a.b` → `a('b')`. The `tb__pkg` mangling is accepted on input. **The proposal
adds** a *catalog-native* naming, so that BI tools browsing `information_schema` see something sensible:

| Postgres | Legend |
|---|---|
| database (startup `database=`) | a project or **data space**: its default mapping and runtime supply execution context |
| schema | a package |
| table | a zero-parameter Relation function, a Database table, a service, or a **class** (projected through the data space's mapping) |
| table function `f(...)` | a parameterised function or a service with parameters |
| foreign keys in `pg_constraint` | **associations**, so BI tools auto-join along the semantic model |

Classes as tables is the feature upstream lacks, and it is where Legend beats a raw warehouse: the SQL user
queries the *logical* model. How to flatten a class is open (D6):
- a class's primitive properties become columns;
- to-one paths could appear as dotted columns (`"firm.legalName"`);
- to-many associations become separate tables joined through the published FK.

### 3.4 Semantics: each difference is a register row

| Topic | Postgres | Upstream | Proposal |
|---|---|---|---|
| Unquoted identifier case | folded to lowercase | preserved | **D1**: preserve and match exactly (as upstream), or match case-insensitively with ambiguity as an error. Never "try both" (invariant 4) |
| `=` with NULL | three-valued | plan flag `LEGACY_SQL_NULL_UNSAFE_EQUALS` | explicit three-valued translation; a row against Pure `==` |
| Numeric literals | exact `numeric` | `DoubleLiteral` | exact Decimal, sent as OID `numeric` |
| `'2023-01-01'` against a date column | an implicit cast in the database | parsed in Java (`parsePostgresDate`) | a cast **executed by the database** (`docs/TENET_CHARTER.md` C2.1/C2.2; register S2). `now`/`today` become the current-date natives, never JVM clock values. Whether a canonical ISO *token* may instead be re-spelled as a Pure date literal (compare, don't compute) is for the charter to adjudicate |
| INTERSECT precedence | tighter than UNION | equal | Postgres |
| NULL order for ASC | NULLS LAST | — | explicit in the translation (the dialects differ) |
| Integer `/` | truncates | — | explicit |
| Unknown result type over the wire | n/a | falls back to `varchar` | compile error |

### 3.5 HTTP, island, wire

- **HTTP.** Upstream's `/api/sql/v1/execution/{execute,lambda,plan,schema,parseToMetamodel}`,
  `/sql/v1/schema/getSchema` and `/sql/v1/grammar/*`, with upstream's shapes, following the ruling "lite serves
  upstream's APIs and nothing of its own" (`docs/UPSTREAM_ENDPOINTS_DESIGN_2026_09_27.md`). `lambda` returning the
  generated Pure is the cheapest demo of the whole thing.
- **Island.** The `Typer` arm for `SqlIsland` calls the translator, so `#SQL{}#` composes with Pure.
- **pgwire.** **One** wire module, shared with the warehouse's W3. The warehouse passes DuckDB SQL through; the
  Legend handler translates. Requirements:
  - real BackendKeyData and cancel;
  - transaction status;
  - TLS and SCRAM;
  - honoured result format codes;
  - real SQLSTATEs and no stack traces;
  - a bounded executor;
  - `numeric` for Decimal.

  The **catalog** is a set of `pg_catalog`/`information_schema` views generated from the `ModelContext` and
  **executed by DuckDB**, never a Docker Postgres. The model's metadata is seeded as rows and the catalog is a set
  of views over them. That is the shape of `docs/WORLD_MAP.md` §3's one narrow exception (queries over the
  platform's own system tables), and it keeps "the DATABASE executes". SET and SHOW keep real session state; a parameter
  that is not honoured is an error or a named register row, not a no-op.

  Probe suites must cover psql `\d`, pgjdbc metadata, DBeaver, Tableau, Power BI/ODBC and psycopg. Upstream tests
  only pgjdbc.

---

## 4. SQL as a modeling surface (brainstorm)

Postgres DDL already names most Legend relational concepts:

| Postgres DDL | Legend element | legend-lite today |
|---|---|---|
| `CREATE SCHEMA s` | package (and Database schema) | yes |
| `CREATE TABLE t (... NOT NULL, PRIMARY KEY, REFERENCES)` | `Database` table + `Join` per FK | yes (`DatabaseDefinition`; `CatalogModel` already builds Databases from catalog rows) |
| `CREATE TYPE e AS ENUM (...)` | `Enumeration` | yes |
| `CREATE DOMAIN d AS text CHECK (...)` | primitive extension with constraints | parse-only (`PrimitiveExtensionDefinition`) |
| `CREATE VIEW v AS SELECT ...` | `function v(): Relation<(...)>[1] { <translated> }` | yes, given §3 |
| `CREATE FUNCTION f(p int) RETURNS TABLE(...) LANGUAGE sql AS $$...$$` | parameterised Relation function (and a service) | yes, given §3 |
| `CREATE MATERIALIZED VIEW` | function + materialization (`Persistence`) | parse-only / F1 |
| `COMMENT ON ...` | `doc` tagged values | yes |
| `GRANT` | entitlements | out of scope (warehouse grants) |

**Where SQL runs out: the object layer.** Postgres can say none of the following without abuse:
- class inheritance (`INHERITS` is not it);
- to-many properties (arrays of composites are not it);
- qualified properties with parameters;
- cross-object constraints;
- M2M mappings; union, merge or operation mappings;
- milestoned navigation;
- graph fetch.

A SQL surface for classes needs a side channel, and dbt's YAML is the one people already write (§5).

**How it enters the compiler.** A reader turns DDL into `Protocol` records → `FromProtocol` → `ParsedModel`. In
practice that is `.sql` files in a project, or a built-in `###SQL` section (an overlay grammar would be opaque).

**Round trip.** Every model prints as Pure through the existing emitter. A SQL-authored model can therefore be
"ejected" to Pure, and a Pure model's stores and relation functions can be printed back as DDL. That makes SQL a
*view* of the one model, not a second model.

**Python is the same shape.** A Pythonic API (`Class`, `Database`, `relate`) builds the same records, through PMCD
JSON and the native library. All three non-Pure surfaces share one prerequisite: compiling `Protocol` records
that did not come from Pure text. In Java this is already possible (`Compiler.buildModel`). Over JSON it is not
(`ModelReader` → `FromProtocol` is not wired into compile).

---

## 5. A dbt-compatible front end (brainstorm)

### 5.1 dbt ↔ Legend

| dbt | Legend | legend-lite today |
|---|---|---|
| `source()` (`sources.yml`: database/schema/tables/columns) | `Database` tables | yes |
| model `.sql` (a SELECT) | Relation function, body translated by §3 | needs §3 |
| `ref('m')` | a call to function `m()` | yes (G½ inlines it) |
| `materialized: view` / `ephemeral` | the function itself, inlined (Legend's default) | yes |
| `materialized: table` | `write` → CTAS | **missing** (F1) |
| `materialized: incremental` (append, merge, delete+insert; `unique_key`) | `Persistence`: AppendOnly / NontemporalDelta | parse-only |
| `snapshot` (SCD2, `dbt_valid_from/to`) | Persistence UnitemporalDelta + **processing milestoning** | parse-only / milestoning on tables yes |
| `columns:` + `data_type` + `contract: {enforced: true}` | the function's declared `Relation<(...)>` return type | yes, and **always** enforced |
| `constraints` (not_null, unique, PK, FK, check) | multiplicity `[1]`, Database PK/Join, class constraints | partial |
| data tests (unique, not_null, accepted_values, relationships, singular) | constraints/assertions compiled to SQL (Track C5) | planned |
| unit tests (given/expect) | function tests with test data | deferred (`docs/DEFERRED_TEST_EXECUTION.md`) |
| seeds (CSV) | `Data` elements / `csv()` | parse-level |
| `semantic_models` (entities, dimensions, measures) | **Class + Association + `~func` mapping** ("Make a class") | mapping yes; promotion planned |
| metrics | qualified properties / DataCube measures | partial |
| exposures | services, data spaces, DataCube pages | yes |
| macros (Jinja) | Pure functions, typed rather than text-templated | conceptual mismatch (§5.3) |
| packages (`dbt_utils`) | Pure libraries | per-macro mapping |
| Mesh cross-project `ref`, groups, `access` | project dependencies (depot), package visibility | partial |
| `profiles.yml` targets | `Runtime` + `Connection` | yes |
| `vars` | function/service parameters | yes |

The fit is close because the two tools model the same thing: dbt *adds* a semantic layer after the SQL, while
Legend *starts* from one (`docs/BI_AND_ETL_PLAN_2026_09_29.md:25`, "for us the model is the semantic layer").

### 5.2 Compatibility levels (each one is useful alone)

1. **L1, read: ingest `manifest.json`.**
   - Real dbt (`dbt compile`, v1 or v2: both write manifest **v12**) does the Jinja and dependency work.
   - legend-lite reads `nodes[*].compiled_code`, `depends_on`, `columns`, `contract`, `semantic_models`, and
     produces a Legend model.
   - **Gives:** typed compilation of every model, column lineage, a semantic layer, DataCube on top, and
     execution on any legend-lite backend.
   - **Needs:** no Jinja and no YAML parser in legend-lite.
   - **Limit:** compiled SQL is in the project adapter's dialect, so this means dbt-postgres projects (and
     DuckDB-dialect ones as a near neighbour).
2. **L2, author: read dbt project files natively.** `dbt_project.yml`, `models/**/*.sql`, `*.yml`.
   - **A Jinja *subset*:** `ref`, `source`, `config`, `var`, `this`, `is_incremental()`, plus a mapped list of
     common `dbt_utils` macros.
   - **Anything else** is a positioned compile error (invariant 4).
   - **Mixing:** projects may hold `.pure` and `.sql` side by side, and the LSP underlines SQL.
   - **Needs:** a YAML reader.
3. **L3, run: materializations.**
   - A `build` walks the DAG and emits CTAS / INSERT…SELECT / MERGE per dialect, and runs tests as SQL assertion
     queries.
   - **Needs:** F1 writes, plus `Persistence` given meaning.
4. **L4, be a dbt target.** Real dbt with dbt-postgres runs against legend-lite's pgwire:
   - `CREATE VIEW` registers a function in a workspace;
   - `CREATE TABLE AS` materializes it;
   - dbt-postgres's `pg_namespace`/`information_schema` introspection and rename-swap dance must also work.

   This is the most drop-in level and has the longest compatibility tail. Defer it.

The reverse direction is cheap once §4's printer exists: **emit a dbt project from a Legend model** (stores →
sources, relation functions → models, classes → semantic models). It is an adoption path for Legend users who
deploy with dbt.

### 5.3 The honest frictions

- **Jinja is text templating; Legend is typed functions.** Macros that generate SQL text can only be supported by
  *running* them (L1, through dbt itself) or by mapping known ones. Arbitrary macros are out at L2. Most model
  files use only `ref`/`source`/`config`, so the subset covers the common case. Measure it on real projects
  before promising anything.
- **Hooks** (`pre_hook`/`post_hook`), `run-operation` and `grants` execute arbitrary SQL. Refuse them, or pass
  them through as named residue, never silently.
- **Dialect lock.** dbt models are written in one warehouse's SQL, so "Postgres dialect" must be the *declared*
  input. The win is that legend-lite then renders it for DuckDB, Postgres, Snowflake or H2: write once, run on
  several backends, which dbt cannot do.
- **dbt's semantics are the warehouse's.** A dbt user expects Postgres results. §3.4's rows apply in full, and
  the parity corpus is the evidence.

---

## 6. One model, many surfaces

```
 Pure text    ─(parser)──────────┐
 Python       ─(PMCD JSON)───────┤
 SQL DDL      ─(sql reader)──────┼─▶ Protocol records ─▶ FromProtocol ─▶ ParsedModel ─▶ D–F (the model)
 dbt project  ─(manifest/loader)─┘

 Pure query   ─(SpecParser)──────┐
 Postgres SQL ─(translator)──────┼─▶ protocol.spec.ValueSpecification ─▶ Compiler.query ─▶ G … K
 #SQL{}#      ─(translator)──────┤
 DataCube / pure-protocol JSON ──┘
```

**Invariant for every surface:** it produces the same records the Pure parser produces, and **prints back as
Pure**. Pure text stays the canonical, reviewable form. No surface carries semantics the others cannot express;
anything SQL or dbt cannot say is written in Pure, or in Python once that exists.

---

## 7. A phased plan (if the user starts it)

Sizes are rough Java line counts, for comparison with upstream (§1.1).

| Phase | Content | Gate | Size |
|---|---|---|---|
| **0. Decide** | §8's decisions; register rows (§3.4); package placement; an `IN_FLIGHT` slot (the DataCube line owns "Make a class"; the database-owner line owns `sql/dialect`/`lowering`) | — | doc |
| **1. SQL over HTTP and islands** | parser + AST + printer; translator for `tb`/`func`/`csv`/CTE sources; function table; `/api/sql/v1/execution/*` + `getSchema`; the `#SQL{}#` Typer arm | 83 round-trip cases; the transpile pairs (Relation half); **parity corpus ratchet** (DuckDB execution against committed PG16 oracle answers) | 8–11k |
| **2. Wire** | the shared pgwire module (with the warehouse's W3); a DuckDB-executed catalog generated from the model; session statements | probe suites per client (psql, pgjdbc, DBeaver, Tableau, ODBC, psycopg) | 6–9k |
| **3. Legend sources** | `service`, data space as database, classes as tables, associations as FKs, bind parameters | parity corpus re-run through classes | 2–4k |
| **4. SQL/dbt modeling, read** | DDL reader → `Protocol`; dbt **L1** (manifest ingest); YAML contracts → declared return types; `semantic_models` → "Make a class" (shared with DataCube) | sample dbt projects compile; Pure print-back round trip | 3–5k |
| **5. dbt author and run** | **L2** (YAML reader, Jinja subset, LSP); **L3** (needs BI-plan F1 writes, `Persistence`, tests as assertions) | `jaffle_shop`-class projects build on DuckDB and Postgres | 5–8k + F1 |
| **6. Optional** | **L4** (dbt-postgres against pgwire); Legend → dbt export | dbt-postgres's own integration tests | — |

**First slice:** phase 1 alone. It ships Postgres SQL against Legend models over HTTP and inside Pure, and it
proves the translator against 2,340 oracle cases before any wire or dbt work starts.

---

## 8. Open decisions (the user's)

- **D1. Identifier case:** preserve and match exactly (upstream), or match case-insensitively with ambiguity as
  an error (DuckDB/Snowflake-like)? Postgres folding to lowercase would break camelCase Legend names for anyone
  who does not quote.
- **D2. Where the syntax AST lives:** a new front-end package (recommended), or readers into `com.legend.sql` per
  `LEGEND_SQL_VISION.md`?
- **D3. pgwire:** port Crate's plumbing (Apache-2.0, NOTICE kept), or hand-write it? Either way, one module shared
  with the warehouse's W3, which means un-pausing part of the server program.
- **D4. Priority:** where this sits against Bazel, Studio and the database-owner line (`docs/IN_FLIGHT.md`).
- **D5. dbt target level:** L1+L2 (recommended), or aim for L4 drop-in?
- **D6. Classes as SQL tables:** the flattening rule for to-one and to-many properties, and whether a data space
  is the Postgres "database".

---

## 9. Sources

- **Upstream code:** `finos/legend-engine` `e60ab67a`, sparse checkout of `legend-engine-xts-sql/`,
  `legend-engine-xts-relationalStore/.../legend-engine-xt-relationalStore-postgresSql/`, and `docs/`.
  `finos/legend-pure` was searched for SQL front-end code and has none.
- **dbt v2** (Rust engine, static analysis, adapters, manifest v12):
  https://docs.getdbt.com/docs/dbt-versions/core-upgrade/upgrading-to-v2. Read 2026-10-11; check it again
  before relying on the adapter list.
- **dbt Fusion components and licenses** (2025-05-28; Level 2 SQL comprehension is proprietary; the authoring
  layer and artifact schemas are Apache 2.0): https://docs.getdbt.com/blog/dbt-fusion-engine-components
- **Manifest schemas:** https://schemas.getdbt.com/
