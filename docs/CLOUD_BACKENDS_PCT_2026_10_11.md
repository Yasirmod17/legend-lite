# Cloud backends: Databricks, Snowflake and BigQuery, PCT on real accounts (2026-10-11)

> **The ask (the user, 2026-10-11):** add Snowflake, Databricks and BigQuery as backends "very similar to how we just
> added Postgres", passing the PCT suites, tested for real on accounts whose credentials live in AWS. Then, separately:
> query each one's HTTP SQL API straight from DataCube in the browser (Snowflake and BigQuery confirmed CORS support
> to the user; Databricks unknown).
>
> **Branch:** `claude/great-wright-p6t5s1`. **Companions:** `POSTGRES_BACKEND.md`, `POSTGRES_DIALECT_HOMEWORK_2026_10_01.md`
> (the Postgres recipe), `CLOUD_BACKENDS.md` (2026-07-31 desk research on free tiers; superseded for access by the
> user's own accounts).

## 1. The bar

Postgres today: **1,249 tests, 112 pinned expected failures** (Essential 69, Grammar 11, Relation 4, Standard 18,
Unclassified 10), from 267 at first measurement, burned down in five tiers on 2026-10-02 (`docs/GATES.md`, gate 7P).
The rows left are deliberate (Float is a double), the database's own error wording, or named work.

The same bar here: every suite green with the cloud's OWN pinned list, each row pinned by the text it fails with,
burned down until what is left is deliberate or a real limit of that database, each with its reason (and a
`SEMANTICS_REGISTER.md` row where it is a deliberate difference). Literally zero is not reachable on any backend.

The reference, legend-engine 4.145.0's own manifests (pinned tree, `pct-manifests/relational-<db>/*_manifest.json`),
counted 2026-10-11:

| Backend | Pinned exclusions | Essential | Grammar | Relation | Standard | Unclassified | Variant | ScenarioQuant |
|---|---|---|---|---|---|---|---|---|
| Snowflake | 276 | 139 | 46 | 17 | 51 | 5 | 16 | 2 |
| Databricks | 461 | 147 | 46 | 165 | 68 | 4 | 29 | 2 |
| Postgres | 501 | 206 | 59 | 95 | 96 | 8 | 36 | 1 |
| DuckDB | 261 | 146 | 44 | 2 | 44 | 8 | 17 | 0 |

legend-engine has **no BigQuery PCT module at all** at 4.145.0.

## 2. Order

1. **Databricks** first: Spark SQL is the closest to DuckDB -- typed `ARRAY<T>` with lambda functions (`transform`,
   `filter`, `aggregate`, `exists`, `forall`), `STRUCT`, `MAP`, `VARIANT`, `QUALIFY`, native `PIVOT`,
   `SELECT * EXCEPT`. Identifiers in backticks.
2. **Snowflake**: semi-structured `ARRAY`/`OBJECT`/`VARIANT` (untyped elements), `QUALIFY`, higher-order
   `TRANSFORM`/`FILTER`/`REDUCE`; an unquoted identifier folds to UPPER case, so every identifier is quoted (as
   Postgres quotes every one).
3. **BigQuery** last, the hardest: no `VALUES` clause (`UNNEST([STRUCT(...)])`), arrays hold no NULL and no array,
   strict types (`INT64`, `FLOAT64`, `NUMERIC`, `BIGNUMERIC`), backticks.

Each dialect is a sibling over `AnsiSqlRenderer`, as `Postgres` is: an exhaustive decision per `SqlFn` and
`SqlAgg.Fn` (a portable arm, the backend's arm, or a `DialectCapability` wall), wired through the `DatabaseType`
switches (`Databases.dialect`, `.servers`, `.loadsRowsInBulk`, `Sessions.jdbcProduct`, ...). Every spelling is
measured on the account before it is trusted (execution beats documentation).

## 3. What is in place (this branch)

- **Drivers** (`tools/deps/jars_table.bzl`, users `pct` only until the server opens these databases), each one
  self-contained jar, Apache-2.0, sha1 checked against Maven Central: `com.databricks:databricks-jdbc:3.4.3` (41 MB),
  `net.snowflake:snowflake-jdbc:4.4.0` (99 MB), `com.google.cloud:google-cloud-bigquery-jdbc:1.6.0:all` (68 MB, the
  shaded jar; the plain one declares 109 runtime dependencies). `jars.bzl` takes an optional classifier
  (`group:artifact:version:classifier`). Not in `THIRD_PARTY_NOTICES.md`: nothing ships them yet.
- **The lanes** (`pct/BUILD.bazel`): `//pct:pct_<cloud>_<suite>` for cloud in `databricks`, `snowflake`, `bigquery`
  and the five suites, and `//pct:pct_<cloud>` for all five. Tagged `manual` (out of `//...` and `//gates:local`),
  `external` (never cached) and `local` (no sandbox, no remote execution).
- **The plumbing** (`pct/.../extension/CloudLane.java`, `PctBackend`): `LEGENDLITE_PCT_BACKEND=<cloud>` selects the
  lane; one session per test JVM, held for the suite (a failed login fails every later test at once with its reason);
  the storeless runtime declares the cloud's coordinates and a credential REFERENCE, never the secret
  (`StorelessRuntime.declaring`).
- **The suites**: `Test_LegendLite_<Cloud>_<Suite>Functions_PCT`, fifteen classes with EMPTY expected-failure lists:
  the first run on each account fills them.
- **Not yet**: the three dialects (every test fails today with "SQL dialect for database type ... is not implemented
  yet", after a successful login), the credential fetch step, the CI workflow, the census ceilings
  (`PctCensusGate` is 0 for these lanes until measured).

## 4. The properties file

`LEGENDLITE_PCT_CLOUD_PROPERTIES` names a Java properties file (outside the repository; the lane inherits the
variable). For each cloud `c`:

```properties
# the JDBC URL, credentials left out
c.url=jdbc:...
# each driver property the session opens with -- the credentials among them
c.property.<name>=<value>
# the coordinates the runtime declares (not secret)
databricks.hostname=...        databricks.httpPath=...
snowflake.account=...          snowflake.warehouse=...   snowflake.region=...   snowflake.database=...
bigquery.projectId=...         bigquery.defaultDataset=...
```

A missing file or key is refused by name. Examples of the URL and properties, to confirm on the account:

- Databricks: `databricks.url=jdbc:databricks://<host>:443/default;transportMode=http;ssl=1;AuthMech=3;httpPath=<path>`,
  `databricks.property.UID=token`, `databricks.property.PWD=<personal access token>`.
- Snowflake: `snowflake.url=jdbc:snowflake://<account>.snowflakecomputing.com/?warehouse=<wh>&db=<db>&role=<role>`,
  `snowflake.property.user=...`, then key-pair (`private_key_file`, `private_key_pwd`) or `password`.
- BigQuery: `bigquery.url=jdbc:bigquery://https://www.googleapis.com/bigquery/v2:443;ProjectId=<p>;OAuthType=0;OAuthPvtKeyPath=<key.json>;DefaultDataset=<d>`.

**Where it comes from:** the user's AWS account holds the three databases' credentials (as legend-engine's own PCT
does: `AWSVaultImplementation`, Secrets Manager, us-east-1, secrets `snowflake.INTEGRATION_USER1` and `databricks`
there -- the user's names and region are to be read, not assumed). The AWS key reaches a session as the environment
variables `DB_AWS_ACCESS_KEY_ID` and `DB_AWS_SECRET_ACCESS_KEY` (the session environment's settings; prefixed because
the environment already sets `AWS_ACCESS_KEY_ID` as a proxy placeholder) and CI as the repository secret
`AWS_DB_CREDS` (five `KEY=VALUE` lines; only the access key id and secret are used -- never the console password).
The fetch step that writes the properties file from Secrets Manager is written once the secrets' layout is seen.

## 5. Running

```bash
LEGENDLITE_PCT_CLOUD_PROPERTIES=$HOME/.legendlite/cloud-pct.properties \
  bazel test //pct:pct_databricks_essential --test_output=errors
```

A run reports each failing test as an `Or add to expected failure: one("<test>", "<message>")` line, the rows to pin.

**Cost**, estimated, not measured: a full run of the five suites is a few thousand short statements -- roughly 20 to
40 minutes per cloud with one session. Snowflake X-Small: 1 credit an hour; Databricks 2X-Small serverless: a few
DBUs an hour; BigQuery bills 10 MB minimum per query, so a run is cents. Burning a cloud down takes dozens of runs.

## 6. A cloud session's own setup (not in the repository)

Measured 2026-10-11 in a Claude Code cloud container (4 cores, 15 GB, network access Full):

- Bazel: `bazelisk` from GitHub releases, with `BAZELISK_BASE_URL=https://github.com/bazelbuild/bazel/releases/download`
  (`releases.bazel.build` was refused before the network was opened).
- GitHub refuses `/archive/` downloads for any repository not attached to the session (a separate check from the
  network policy). Two kinds of repository need one; `~/.bazelrc` overrides them:
  - the bats toolchains, which `bazel_lib` and `aspect_bazel_lib` register and no Java target uses: an empty
    repository (`--override_repository=bazel_lib++toolchains+bats_toolchains=<empty dir>`, and the `aspect_` one);
  - `@legend_pure_src` and `@legend_engine_src`: `git clone --depth 1 --branch legend-pure-5.99.0` (and
    `legend-engine-4.145.0`), with `third_party/legend_*_src.BUILD` copied in as `BUILD.bazel` and an empty
    `REPO.bazel`, then `--override_repository=legend_pure_src=<dir>` (and `legend_engine_src`).
- The Postgres lane cannot run there: the container runs as root and `initdb` refuses root. The DuckDB lane passes
  (`//pct:pct_duckdb_essential`, 45 s).
- Maven Central rate-limits the shared address now and then (HTTP 429): retry.

## 7. DataCube straight to the warehouse's HTTP SQL API (CORS)

The second experiment: DataCube in the browser sending the planner's SQL to the warehouse's own HTTP API, with no
server between.

| | Endpoint | CORS preflight |
|---|---|---|
| BigQuery | `POST https://bigquery.googleapis.com/bigquery/v2/projects/<p>/queries` | **Passes** (measured 2026-10-11: `OPTIONS` from `Origin: http://localhost:5173` answers 200 with that origin, methods including POST, headers `authorization,content-type`, max-age 3600) |
| Snowflake | `POST https://<account>.snowflakecomputing.com/api/v2/statements` | to measure on the account's host |
| Databricks | `POST https://<host>/api/2.0/sql/statements` | to measure on the workspace host; results over `EXTERNAL_LINKS` are presigned cloud-storage URLs, which need their own CORS |

Questions it settles: whether each preflight answers for the page's origin; which credential a browser can hold
(BigQuery: an OAuth access token; Snowflake: OAuth or a key-pair JWT; Databricks: a token); and the result format
the grid needs (each API returns JSON rows; Databricks and Snowflake can also return Arrow).

**Where it plugs in** (surveyed 2026-10-11): the page's database is `QueryEngine` (`engine-client/src/engine.ts`:
`execute(plan)` to a `ResultTable`, `run(sql)` to a `RawTable`); a live source is also a `RemoteSource`
(`engine-client/src/snap.ts`: `arrowChunks`, Arrow IPC, which snapping loads into DuckDB-WASM). `WarehouseEngine`
(`engine-client/src/warehouse.ts`) is the model to follow: its statement protocol (submit, poll, fetch chunks,
cancel, a bearer token, sign-in in the source picker, nothing stored) is already the shape of Databricks' statement
API. The planner takes the dialect from the table model's connection `type` (`wasm/.../planner/Boundary.java`), so the
browser path needs the same three dialects as the PCT lanes: **the core dialect work serves both**. Order: first a
raw-SQL probe from the page (`run(sql)`: CORS, the credential, the result format) on each account, then an engine
per cloud behind `QueryEngine` once its dialect plans. A JSON result is decoded to the exact `Scalar`s
(`engine-client/src/values.ts`) and to Arrow IPC for snapping. Constraints: `datacube/test/guardrails.test.ts` (no
runtime fallback between engines) and the bundle budget.
