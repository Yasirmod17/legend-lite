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

4. **Then, after the three clouds, the open ones first (the user's order, 2026-10-11): SQLite, MariaDB/MySQL,
   Trino, ClickHouse, MongoDB, Elasticsearch, then SingleStore.** Each runs locally with no account (embedded, or a Docker
   image: this container has Docker):
   - **SQLite**: today it is no dialect class, only `Lexicon.SQLITE` handed to `AnsiSqlRenderer`, with the gaps
     that lexicon row's comment lists (no aliased `VALUES`, typed date literals, lists, `QUALIFY`, as-of, pivot). Make
     it a sibling dialect like the others, give it the five PCT suites as a lane over the embedded driver
     (`@sqlite_jdbc`, already a dependency), then pin and burn down. Starting point: `docs/SQLITE_BACKEND.md`.
   - **MariaDB / MySQL**: one dialect family over `AnsiSqlRenderer`. MariaDB embedded through MariaDB4j, as
     `docs/MARIADB_BACKEND.md` designs it (a feasibility design measured on MariaDB 11.4, not built); MySQL 8 as
     a sibling where the two differ (JSON functions, their regex engines). Lists have to be JSON arrays (neither has
     an array type), and neither has `FULL OUTER JOIN` or `QUALIFY`.
   - **Trino**: the `trinodb/trino` image with the memory connector; typed arrays, lambdas and maps, so much of
     `Databricks` carries over. One dialect covers Presto, Starburst and Athena.
   - **ClickHouse** (Apache-2.0): the `clickhouse/clickhouse-server` image; typed arrays, lambdas (`arrayMap`,
     `arrayFilter`, `arrayFold`), maps and tuples, so it builds on the Trino and Databricks work. Not in
     legend-engine, so no reference dialect to compare against; its own quirks first (a column is non-NULL unless
     `Nullable(T)`, `join_use_nulls` for SQL's outer-join NULLs, case-sensitive function names).
   - **MongoDB** and **Elasticsearch**: stores that are not SQL, translated from the same `SqlQuery` IR (§11).
   - **SingleStore**: its Dev Image (`ghcr.io/singlestore-labs/singlestoredb-dev`) runs one aggregator and one leaf
     with no licence key, for development and functional testing only, under SingleStore's Free Tier licence (not
     open source); it follows the MySQL dialect.
   - **On the AWS account** (an inventory of the `DB_AWS_*` credentials, secret names only, 2026-10-11): a
     **Redshift Serverless** workgroup (`default`, us-east-1) with integration and developer user secrets
     (`redshift.SERVERLESS_REDSHIFT_*`), set up like the Snowflake and BigQuery ones, so Redshift is reachable on top
     of the `Postgres` dialect; **Athena**'s `primary` workgroup (every account has it; whether these credentials
     may query it is not checked); and a secret named `mongoDbPassword...` (us-west-2, beside CI secrets, so likely
     not a test database). Not in the order above yet: the user's call.

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
- **Databricks: done** (2026-10-11, §8): the dialect, all five suites green on the account with 44 pinned rows of
  1,250 tests, the census at 0 divergence (no ceiling raised).
- **Snowflake: done** (2026-10-11, §9): the dialect, all five suites green on the account with 40 pinned rows of
  1,250 tests, the census at 0 divergence (no ceiling raised).
- **BigQuery: done** (2026-10-11, §10): the dialect, all five suites green on the account with 84 pinned rows of
  1,250 tests, the census at 0 divergence (no ceiling raised).
- **Not yet**: the CI workflow (step 4 of the ask; not requested in this pass).

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
**The secrets, as measured (2026-10-11):** Secrets Manager in `us-east-1` (mirrored in `us-east-2`) holds legend-engine's
own PCT secrets, read by key exactly as its `*TestConnectionIntegration` classes read them (legend-engine 4.145.0):

| Cloud | Secret | Keys used | Coordinates (legend-engine's, not secret) |
|---|---|---|---|
| Databricks | `databricks` | `integration_test.apitoken` (a personal access token) | host `dbc-f0687849-717f.cloud.databricks.com`, httpPath `/sql/1.0/warehouses/c56852187940e5a3` |
| Snowflake | `snowflake.INTEGRATION_USER1` | `encrypted_private_key` (PKCS#8, stored without PEM armour), `private_key_encryption_password` | account `ki79827`, region `us-east-2` (aws), warehouse `INTEGRATION_WH1`, database `INTEGRATION_DB1`, role `INTEGRATION_ROLE1`, user `INTEGRATION_USER1` |
| BigQuery | `bigquery.integration-bq-sa1` | `service_account_json` (a service-account key) | project `legend-integration-testing` |

The fetch is a short script (in the session's scratchpad, not the repository): `GetSecretValue` signed with SigV4 by
`curl --aws-sigv4` (the key pair read from stdin, never the command line), each secret written into `~/.legendlite/` at
mode 0600 -- the properties file, the Snowflake key re-armoured as PEM (`snowflake.property.private_key_file` +
`private_key_file_pwd`), the BigQuery key file -- and nothing printed but key names. The Snowflake JDBC URL is
`jdbc:snowflake://ki79827.us-east-2.aws.snowflakecomputing.com/?warehouse=INTEGRATION_WH1&db=INTEGRATION_DB1&role=INTEGRATION_ROLE1`.

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
- The cloud lanes' test JVMs need the container's egress proxy and its CA: Bazel's test environment drops
  `JAVA_TOOL_OPTIONS`, so without it Snowflake fails PKIX and Databricks cannot connect. In `~/.bazelrc`:
  `test --test_env=JAVA_TOOL_OPTIONS --test_env=HTTPS_PROXY --test_env=https_proxy --test_env=NO_PROXY --test_env=no_proxy`.
- Disk: one output base is about 15 GB of the container's ~39 GB allowance, so a second checkout with its own output
  base does not fit; one tree, one Bazel server. A first build of the PCT lanes takes about 6 minutes.
- Measured 2026-10-11 with those settings: Databricks and Snowflake log in (their drivers authenticate when the
  connection opens) and the Grammar lane fails at `Sessions.jdbcProduct`, as expected before a dialect; BigQuery's
  connection opens too (its driver may authenticate lazily: its first query proves it).

## 7. DataCube straight to the warehouse's HTTP SQL API (CORS)

The second experiment: DataCube in the browser sending the planner's SQL to the warehouse's own HTTP API, with no
server between.

| | Endpoint | CORS preflight |
|---|---|---|
| BigQuery | `POST https://bigquery.googleapis.com/bigquery/v2/projects/<p>/queries` | **Passes** (measured 2026-10-11: `OPTIONS` from `Origin: http://localhost:5173` answers 200 with that origin, methods including POST, headers `authorization,content-type`, max-age 3600) |
| Snowflake | `POST https://ki79827.us-east-2.aws.snowflakecomputing.com/api/v2/statements` | **Passes** (measured 2026-10-11: `OPTIONS` answers 204 echoing ANY origin -- `http://localhost:5173` and `https://claude.ai` alike -- methods `GET,POST`, headers `Authorization,Content-Type,User-Agent,Accept,X-Snowflake-Authorization-Token-Type`, max-age 86400) |
| Databricks | `POST https://dbc-f0687849-717f.cloud.databricks.com/api/2.0/sql/statements` | **Fails** (measured 2026-10-11: `OPTIONS` answers 401 `WWW-Authenticate: Bearer` with no `Access-Control-*` header, on every path tried; a simple GET answers 401 without one too). A browser cannot call the workspace's API directly: it needs a relay (the warehouse server, or a Databricks App on the workspace's own origin) |

**From a page (measured 2026-10-11):** a page served at `http://localhost:5173`, in the container's pinned Chromium
(headless, through the egress proxy), `fetch`es each endpoint with `SELECT 1` and a deliberately invalid bearer token:
Snowflake and BigQuery are REACHED (the preflight passes; the page reads each one's JSON 401 --
`{"code":"390303","message":"Invalid OAuth access token..."}` and `{"error":{"code":401,...}}`), Databricks is BLOCKED
by the browser (`TypeError: Failed to fetch`). A real query from the page needs a real short-lived credential in the
browser -- a Snowflake key-pair JWT (`X-Snowflake-Authorization-Token-Type: KEYPAIR_JWT`, minted from the
`snowflake.INTEGRATION_USER1` key) and a BigQuery OAuth access token (from the service account) -- which this session did
not mint into a page (the session's safety review stopped it as credential materialisation): **open, the user's call**.

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

## 8. Databricks, measured (2026-10-11)

**Result:** all five suites pass on the account, each failure pinned by its message: 1,250 tests, 44 pinned (Grammar
10 of 137, Essential 26 of 346, Relation 5 of 469, Standard 1 of 205, Unclassified 2 of 93), the census divergence 0
in every suite. Burned down in six runs from 185 failing (the first run: Grammar 10, Essential 77, Relation 77,
Standard 18, Unclassified 3). A run of the five is about 10.5 minutes with three suites at a time.

What the 44 are: 30 are the platform's own, pinned on the DuckDB lane by the same cause (instance identity, fold name
resolution, error positions and messages, the 0-based `indexOf`, `testBigFloatAbs`, the class `toString`, the
variant-array `joinStrings`, the ExtendedInteger type, the harness's lost `$address`); the other 14 are Databricks'
own, each measured: a date-time past Spark's range overflows (4), the driver gives a BC date-time back as the
Timestamp's text with its sign lost (1), no Jaro-Winkler function (2), no as-of join and no correlated subquery in a
join condition to emulate one (4), the lowering's subquery inside a higher-order function (1; Postgres refuses it
too), the moments computed in double precision (1), and `Class.all()` over the platform's in-process metamodel (1).

The account: a Databricks SQL warehouse (`dbsql_version` 2026.39); the JDBC driver (databricks-jdbc 3.4.3) reports the
product `SparkSQL` (`Sessions.jdbcProduct`). Every spelling in `core/.../sql/dialect/Databricks.java` was measured there
first with a scratch JDBC probe (statements over literals and `VALUES` only). What differs from DuckDB, and the dialect's
answer:

| Measured | Consequence |
|---|---|
| `'it''s'` is `its`: two adjacent literals concatenate; backslash escapes are read | a quote is written `\'`, a backslash `\\` |
| a bare integer literal is a 32-bit INT; `2147483647 + 1` wraps to `-2147483648` with ANSI mode off | every integer literal is a BIGINT, `1L`; a window function's offset stays an INT |
| the warehouse's ANSI mode is OFF by default: overflow wraps, `CAST('abc' AS BIGINT)` is NULL, `x/0` is NULL, `element_at` out of range is NULL | the session sets `ANSI_MODE = true` (each then raises, as DuckDB does) and `TIME ZONE 'UTC'` |
| `concat('a', NULL)` and `'a' \|\| NULL` are NULL | concat is `concat_ws('', ...)`, each argument as text |
| `regexp_extract` defaults to group 1 (and refuses a pattern without one); `split` takes a regex; `regexp_replace` replaces every match | group 0 is passed; the delimiter is `\Q..\E`-quoted; a first-match replace is `^(?s:(.*?))(?:p)` → `$1` + the replacement, its groups shifted by one |
| `round` is half-up, `bround` half-even | ROUND is `bround`, ROUND_HALF_UP `round` |
| `timestampdiff` counts whole units; DuckDB's date_diff counts boundaries | year/quarter/month by the calendar, day by `datediff` of dates, sub-day by the floored `unix_micros` |
| `extract(DOW ...)` is Sunday 1 | DuckDB's dow is `extract(DOW ...) - 1`; isodow is `DOW_ISO` |
| a lambda's index parameter is 0-based | the body reads `i + 1` (DuckDB's is 1-based) |
| a bare `NULL` where an array is required is refused (`VOID`) | the empty collection is `CAST(NULL AS ARRAY<VOID>)`; a list function over it answers `CAST(NULL AS <its type>)` |
| a parenthesized `(VALUES ...) AS t(c)` is a syntax error | `VALUES (..), (..) AS t(c)` |
| no quantified comparison (`x = ALL (subquery)`) | its SQL truth table over `EXISTS`, NULLs included |
| a RANGE frame's offset must have its ORDER BY key's type | `1L PRECEDING` over a BIGINT key |
| `map_concat` refuses a duplicate key (its dedup policy is not a warehouse setting) | each map less the keys a later one sets (`map_filter`), then concatenated |
| `CAST(struct AS VARIANT)` is refused; `to_variant_object` converts; a variant takes no `[...]` subscript; object keys come back sorted | variant navigation casts to `MAP<STRING, VARIANT>` / `ARRAY<VARIANT>` (`try_element_at`) |
| arrays, structs, maps and variants arrive over JDBC as JSON text; `getObject(i, LocalDateTime.class)` answers a String | the executor's JSON carrier parses lists; a struct's text is decoded by the dialect's `normalize`; the timestamp re-fetch keeps the driver's `Timestamp` when the driver answers another class |
| a correlated scalar subquery in a join condition is refused | the as-of join is a wall (a window-based form is possible later) |
| `QUALIFY`, `SELECT * EXCEPT`, native `PIVOT` (columns named by the `IN` aliases), `listagg ... WITHIN GROUP`, `median`, `mode`, `percentile_cont/disc ... WITHIN GROUP`, `max_by`, `max(boolean)`, `explode`, correlated `(SELECT agg FROM explode(t.xs))` | used as they are |

## 9. Snowflake, measured (2026-10-11)

**Result:** all five suites pass on the account, each failure pinned by its message: 1,250 tests, 40 pinned (Grammar
10 of 137, Essential 27 of 346, Relation 1 of 469, Standard 0 of 205, Unclassified 2 of 93), the census divergence 0
in every suite. Burned down in seven runs from 144 failing (the first run: Essential 70, Relation 35, Standard 34,
Unclassified 5; Grammar's 10 pinned from the start).

What the 40 are: 34 are the platform's own, pinned on the DuckDB lane by the same cause (instance identity, fold name
resolution, error positions and messages, the 0-based `indexOf`, `testBigFloatAbs`, the class `toString`, the
variant-array `joinStrings`, the ExtendedInteger type, the harness's lost `$address`, a date-time out of range); the
other 6 are Snowflake's own, each measured: `JAROWINKLER_SIMILARITY` answers an integer percentage (2), a lambda cannot
read an enclosing lambda's parameter, which the comparator dedup needs (2), the driver's Timestamp drops a BC year's
sign (1), and `Class.all()` over the platform's in-process metamodel (1).

The account: warehouse `INTEGRATION_WH1`, database `INTEGRATION_DB1`, key-pair login; the JDBC driver
(snowflake-jdbc 4.4.0) reports the product `Snowflake` (`Sessions.jdbcProduct`), version 10.36. Every spelling in
`core/.../sql/dialect/Snowflake.java` was measured there first with the scratch JDBC probe. What differs from DuckDB,
and the dialect's answer:

| Measured | Consequence |
|---|---|
| an unquoted identifier folds to UPPER case | every identifier is quoted |
| an integer is a `NUMBER(p,0)` at the value's own precision, which the driver hands back as a `Long`; `17.0` and `1.0` are `NUMBER(2,0)` (a trailing zero's scale is dropped, so their text is `17`) | the census reads `NUMBER(p,0)` as delivering an integer label; a decimal cell read as a `Long` becomes a `BigDecimal` (`normalize`); a Float or Decimal literal with a trailing zero spells its type (`CAST(17.0 AS NUMBER(3,1))`) |
| a DOUBLE's text drops an integral value's `.0` (`-1`, not DuckDB's `-1.0`) | a Float cast to text appends it (`REGEXP_REPLACE(..., '^(-?[0-9]+)$', '\\1.0')`) |
| lists are semi-structured `ARRAY`s of `VARIANT`; `ARRAY_AGG` drops a NULL, `OBJECT_INSERT` drops a NULL value's key; an `OBJECT`'s keys compare in name order | elements are cast where read; NULLs kept as JSON null; a list of structs sorts as an `ARRAY` of its fields in declared order (minBy/maxBy, sort with a key) |
| a lambda reads no enclosing lambda's parameter; a correlated subquery over `FLATTEN` (scalar or lateral) is refused (`Unsupported subquery type`) | list statistics are `REDUCE`s: variance and standard deviation as DuckDB's own Welford update, mode as runs over the sorted elements (the earliest-seen on a tie, as DuckDB), median and `quantile_cont`; an explosion is a bare `LATERAL FLATTEN` over the positions, `SELECT *` over it spelled out; the comparator dedup is pinned |
| regular expressions are POSIX: no `(?:`, no lazy quantifier, no inline flags | flags become parameters; `(?:` a plain group where no numbered group follows; `regexpIndexOf` is `REGEXP_INSTR` of the original pattern (its lowering's lazy prefix cannot run here) |
| no printf | `format`'s `%s`, `%d` and `%.Nf` are unrolled (`%f` keeps Java's `-0.00`) |
| `LISTAGG`, `MEDIAN` and the percentiles take no ordered window; `WITHIN GROUP` is refused beside an `OVER`'s `ORDER BY`; an `ARRAY_AGG` over an ordered whole-partition frame keeps no order | a cumulative ordered string aggregate is `ARRAY_TO_STRING(ARRAY_AGG(..) OVER (...))`; a whole-partition one the partition's `LISTAGG ... WITHIN GROUP` |
| `FIRST_VALUE`/`LAST_VALUE`/`NTH_VALUE` refuse a cumulative frame, and default to the whole partition (not ANSI's) | first: the partition's first; last: the current row (ROWS) or the last of its peers (RANGE); nth: the partition's nth once the frame holds n rows |
| a frame needs an `ORDER BY`; `RANGE` `CURRENT ROW` to `CURRENT ROW` over a date or timestamp is refused | a whole-partition frame without one is no frame; the peers are the zero-interval frame |
| `ASOF JOIN` takes its inequality as a `MATCH_CONDITION`, apart from `ON` | the ON's conjuncts split |
| a `+HHMM` offset is "not recognized" (`+HH:MM` is) | text to an instant rewrites the offset |
| `getObject(i, LocalDateTime.class)` throws a plain `SQLException` | the executor keeps the `Timestamp` it already read (the BC sign loss is pinned) |
| a VARIANT column is a JSON carrier; DuckDB's JSON travels as VARCHAR, which the plan labels; `ARRAY_MIN(NULL)` and `GET(NULL, 0)` are VARIANT columns | a JSON root column under a VARCHAR label is `TO_JSON(..)`; an exploded NULL list's column takes its label's type, and a min, max or element of the NULL list is its label's NULL (the root's labels as planned, before the dialect's passes) |
| the session: `TIMEZONE = 'UTC'`, `WEEK_START = 1`, `TIMESTAMP_TYPE_MAPPING = 'TIMESTAMP_NTZ'`, `QUOTED_IDENTIFIERS_IGNORE_CASE = FALSE`, `JSON_INDENT = 0`, `STRICT_JSON_OUTPUT = TRUE` | set at session start (`sessionSetup`) |
| `QUALIFY`, `EXCLUDE`, `MAX_BY`/`MIN_BY`, `BOOLAND_AGG`, `REDUCE`/`TRANSFORM`/`FILTER`, `ARRAY_*`, `OBJECT_*`, `CONVERT_TIMEZONE`, `DATEADD`/`DATEDIFF` | used as they are (with DuckDB's boundary-count `date_diff` per unit) |

## 10. BigQuery, measured (2026-10-11)

**Result:** all five suites pass on the account, each failure pinned by its message: 1,250 tests, 84 pinned (Grammar
12 of 137, Essential 49 of 345, Relation 13 of 469, Standard 8 of 206, Unclassified 2 of 93), the census divergence 0
in every suite. Burned down in five runs from 347 failing (the first run: Essential 107, Grammar 31, Relation 112,
Standard 75, Unclassified 22).

What the 84 are: 34 are the platform's own, pinned on the DuckDB lane by the same cause (as on Snowflake); 2 are the
portable carrier strategies' own, pinned on Postgres too (a filter's lambda parameter left unbound on a lambda-less
dialect); 1 is the dialect's own gap, named (a lambda parameter over a JSON array carries no type, so its cast is a
scalar CAST, refused on JSON); the other 47 are BigQuery's own limits, each measured: no MAP type (11), no lambdas
and no correlated recursion to fold with (10), no correlated derived table -- only an UNNEST correlates (8), no mode
(6), an empty list of no element type (a bare NULL is an INT64, and UNNEST refuses it: 3), a date-time past years
1 to 9999 (2), no Jaro-Winkler function (2), PERCENTILE_CONT over a window ascending only (1), a statement past the
maximum query length (1), no minimal-fraction date format code (1), FARM_FINGERPRINT(NULL) is NULL (1), and
`Class.all()` over the platform's in-process metamodel (1).

The account: project `legend-integration-testing`, a service-account key; the JDBC driver (Google's
google-cloud-bigquery-jdbc 1.6.0, the shaded jar) reports the product `Google BigQuery` (`Sessions.jdbcProduct`).
`core/.../sql/dialect/BigQuery.java` was drafted against the account (its own probes, kept in the dialect's javadoc)
and burned down on the lanes. What differs from DuckDB, and the dialect's answer:

| Measured | Consequence |
|---|---|
| a string literal reads backslash escapes and refuses `''`; the driver counts every `?` as a parameter, inside a literal too | a quote is `\'`, a `?` is `\x3f` |
| `1.5` is a FLOAT64 (DuckDB's is a DECIMAL); a parameterized type cannot be cast to; a BIGNUMERIC drops a trailing zero's scale (`'3.0'` reads 3) | a decimal literal is `BIGNUMERIC '1.5'`; a decimal cast a rounded BIGNUMERIC; its text has its scale's digits (`FORMAT('%.Nf')`); a decimal read back is padded to its declared scale (`normalize`); the census reads BIGNUMERIC as delivering decimal, HUGEINT and Float labels |
| no VALUES clause, no bare UNION, no OFFSET without LIMIT, no lambdas, no lateral derived table, no MAP type | rows are `UNNEST(ARRAY<STRUCT<..>>[..])`; `UNION ALL`/`UNION DISTINCT`; every list operation a correlated subquery over `UNNEST(xs) WITH OFFSET` |
| no set-returning projection | an explosion is a marker (`ExplosionMarkers`, shared with Snowflake) written as `UNNEST(GENERATE_ARRAY(0, n - 1))` over its longest list, a lateral one `CROSS`/`LEFT JOIN UNNEST`, each exploded column `list[SAFE_OFFSET(position)]`, a root one ordered by its position |
| a FROM-less select takes no WHERE | it runs over one row |
| no quantified comparison, and no derived-column alias list | `x op ANY/ALL (q)` is its three-valued count over `UNNEST(ARRAY(q))` |
| no `=` on STRUCT or ARRAY | compared through `TO_JSON_STRING` (DuckDB's nested NULLs compare equal, as the texts do); a NULL operand is NULL |
| a CASE's branches need a common type (INT64 and STRING have none); a column's text label may not be its value's (a pivot's) | a text cast is always written, but on a string literal |
| `ROUND` of a FLOAT64 is exact (31.41499... is 31.41) | DuckDB's own algorithm: `ROUND(x * 10^n) / 10^n` (31.42) |
| `FORMAT`'s `%s` takes a STRING only | a `%s` argument is cast to text |
| a bare NULL is an INT64 (`COALESCE(NULL, NULL)`, `UNNEST(NULL)`) | at the root, a value NULL by its shape is its label's NULL; a NULL list of known element type is `CAST(NULL AS ARRAY<T>)` |
| the driver's type names: INT64, FLOAT64, DATETIME (naive), TIMESTAMP (an instant) | the census reads them (`SqlTypeCensus.dialectSpelling`) |
| `QUALIFY`, `SELECT * EXCEPT`, `PERCENTILE_CONT/DISC` (analytic), `ARRAY_AGG ... ORDER BY`, `STRING_AGG ... ORDER BY`, `IEEE_DIVIDE`, `SAFE_OFFSET` | used as they are |

## 11. Further backends: candidates

The order for the open ones is decided (§2, item 4); the rest of this list is not. legend-lite replaces
legend-engine, so the first list is the relational databases the engine supports (`DynaFn` names several: MemSQL,
Spanner, Trino), ordered by how much an existing dialect carries over and by what users run:

| Backend | Carried over from | How it is tested | Notes |
|---|---|---|---|
| Redshift | `Postgres` (Redshift forked Postgres 8) | the account's Redshift Serverless workgroup (§2, item 4; it has a running cost) | the cheapest to add: mostly walls where Redshift lacks newer Postgres features |
| Trino (Presto, Athena, Starburst) | `Databricks` (typed arrays, lambdas, maps) | the `trinodb/trino` image with the memory connector | one dialect covers Athena too |
| SQL Server | none | the `mssql/server` image (free Developer edition) | large enterprise use; the hardest of these: no boolean type, `TOP` and `OFFSET ... FETCH`, lists through JSON (`OPENJSON`) |
| Oracle | none | the `gvenzl/oracle-free` image (23ai) | `''` is NULL, a deep divergence that will pin many tests; BOOLEAN only since 23ai |
| SingleStore (MemSQL) | MySQL | its free developer image | follows the MySQL dialect |
| Spanner | `BigQuery` (GoogleSQL) | Google's Spanner emulator | |
| DB2, Sybase ASE/IQ | the engine-text printers (`EngineStyleDB2`) are text only, not an execution dialect | licences make a lane hard | low priority |

The images need Docker, which this cloud container has (`/usr/bin/docker`); CI would need it too, or the engines' own
packages.

**Stores that are not SQL.** legend-engine has both: a MongoDB store (class queries to aggregation pipelines) and an
Elasticsearch store (relation queries to the query DSL). In legend-lite they fit beside `SqlDialect`, not inside it:
the Lowerer's output (the `SqlQuery` IR) stays the input, and a new target translates it into the store's own query
language. The executor gains a second chartered seam beside JDBC (the store's own client). The execution tenet still
holds: the store executes, and what it cannot express is a `DialectCapability` wall, never a fallback computed in Java.

- **MongoDB: a good fit.** The aggregation pipeline covers most of the relation algebra: `$match` (filter), `$set`
  (extend), `$project` (select), `$group` (groupBy), `$sort`, `$limit`/`$skip`, `$lookup` (join), `$setWindowFields`
  (over), `$unionWith` (concatenate), and `$documents` for a literal relation (so the PCT's `#TDS` literals need no
  loading). Its expression language has lambdas (`$map`, `$filter`, `$reduce`), so lists are native. Nested
  documents suit Pure classes. Scalar PCT runs as `$documents: [{}]` then `$project`. Tested with the `mongo` image or
  an embedded `mongod`.
- **Elasticsearch / OpenSearch: narrower.** Filter, sort, page, and grouped aggregates map well (DataCube's
  dashboard shape). There is no general join, window or computed-list support, so most of the relation PCT would be
  walls. Two ways in: ES|QL, a pipe language that reads like a relation chain (`FROM | WHERE | EVAL | STATS ... BY |
  SORT | LIMIT`), or the query DSL. A literal relation must be loaded into an index first, since ES|QL's `ROW` is a
  single row. Licences: Elasticsearch server is under Elastic, SSPL or AGPL licences; OpenSearch is Apache-2.0 and
  has its own SQL and PPL.

