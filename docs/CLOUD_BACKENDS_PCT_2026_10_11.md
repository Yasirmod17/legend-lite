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
   - **SQLite: done** (§12): a sibling dialect like the others, the five PCT suites as a lane over the embedded
     driver (`@sqlite_jdbc`, already a dependency), pinned and burned down. Until then it was no dialect class, only
     `Lexicon.SQLITE` handed to `AnsiSqlRenderer`.
   - **MariaDB: done** (§13): a sibling dialect, the five PCT suites as a lane over a real MariaDB 11.4 server that
     Bazel unpacks (not MariaDB4j, as `docs/MARIADB_BACKEND.md` designed it), pinned and burned down.
   - **MySQL**: a sibling of the MariaDB dialect where the two differ (JSON functions, their regex engines), over
     MySQL 8.4's server tarball. Lists have to be JSON arrays (neither has an array type), and neither has
     `FULL OUTER JOIN` or `QUALIFY`.
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
- **Databricks: done** (2026-10-11, §8): the dialect, all five suites green on the account with 35 pinned rows of
  1,250 tests, the census at 0 divergence (no ceiling raised).
- **Snowflake: done** (2026-10-11, §9): the dialect, all five suites green on the account with 35 pinned rows of
  1,250 tests, the census at 0 divergence (no ceiling raised).
- **BigQuery: done** (2026-10-11, §10): the dialect, all five suites green on the account with 82 pinned rows of
  1,250 tests, the census at 0 divergence (no ceiling raised).
- **SQLite: done** (2026-10-11, §12): the dialect, all five suites green in-process with 52 pinned rows of 1,249
  tests, the census at 0 divergence (no ceiling raised).
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
# the SYSTEM connection's own driver properties, added to the session's (§14; not secret)
snowflake.system.property.schema=INTEGRATION_SCHEMA1
bigquery.system.property.EnableSession=1
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

**Result:** all five suites pass on the account, each failure pinned by its message: 1,249 tests, 35 pinned (Grammar
9 of 137, Essential 25 of 345, Relation 1 of 469, Standard 0 of 205, Unclassified 0 of 93), the census divergence 0
in every suite. Burned down in six runs from 185 failing (the first run: Grammar 10, Essential 77, Relation 77,
Standard 18, Unclassified 3); 44 -> 42 later the same day, when Jaro-Winkler was written exactly (§9; Unclassified
re-run on the account, 93 green); 42 -> 41 when the system database came to the server (§14; Grammar re-run on the
account, 137 green); 41 -> 36 when the as-of join became a window pick and a list's moments DuckDB's own update
(below; Relation and Standard re-run on the account, 469 and 205 green); 36 -> 35 when a list's compaction became
`array_compact` (below; all five re-run on the account, 1,249 green). Every row but one is now pinned on the DuckDB
lane too (by test): the one is the BC date-time (§15). A run of the five is about 10.5 minutes with three suites at
a time.

What the 35 are: 30 are the platform's own, pinned on the DuckDB lane by the same cause (instance identity, fold name
resolution, error positions and messages, the 0-based `indexOf`, `testBigFloatAbs`, the class `toString`, the
variant-array `joinStrings`, the ExtendedInteger type, the harness's lost `$address`); the other 5 are Databricks'
own, each measured: a date-time past Spark's range overflows (4; the DuckDB lane pins the same tests, by its own
messages), and the driver gives a BC date-time back as the Timestamp's text with its sign lost (1, §15).

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
| no as-of join, and a correlated scalar subquery in a join condition (the portable form's correlated MAX) is refused | an as-of join is a LEFT JOIN on its condition whose select keeps, per left row, the matches with the extreme right key: `QUALIFY k = MAX(k) OVER (PARTITION BY every left column) OR MAX(k) OVER (...) IS NULL` (MIN when bounded below; the portable form's rows, ties included; only under a select that filters, groups and windows nothing of its own) |
| no subquery inside a higher-order function's arguments (`UNSUPPORTED_SUBQUERY_EXPRESSION_CATEGORY.HIGHER_ORDER_FUNCTION`): the mixed sort's ordered subquery sat under the PCT root's NULL-dropping `filter` | a list's compaction is `array_compact` (no lambda; the same rows: a NULL list NULL, an empty one empty, a nested list's NULLs kept) |
| Spark's variance and standard deviation are another update than DuckDB's, equal in algebra but not in rounding (3.14's came back 3.1399999999999997) | a list's moments are DuckDB's own update in an `aggregate` whose finish is the result (40 values over 10 lists equal to DuckDB's, measured) |
| `QUALIFY`, `SELECT * EXCEPT`, native `PIVOT` (columns named by the `IN` aliases), `listagg ... WITHIN GROUP`, `median`, `mode`, `percentile_cont/disc ... WITHIN GROUP`, `max_by`, `max(boolean)`, `explode`, correlated `(SELECT agg FROM explode(t.xs))` | used as they are |

## 9. Snowflake, measured (2026-10-11)

**Result:** all five suites pass on the account, each failure pinned by its message: 1,250 tests, 35 pinned (Grammar
9 of 137, Essential 25 of 345, Relation 1 of 469, Standard 0 of 205, Unclassified 0 of 93), the census divergence 0
in every suite. Burned down in seven runs from 144 failing (the first run: Essential 70, Relation 35, Standard 34,
Unclassified 5; Grammar's 10 pinned from the start); 40 -> 38 later the same day, when the comparator dedup's nested
lambda was carried (below; Essential re-run on the account, 345 green); 38 -> 36 when Jaro-Winkler was written exactly
(below; Unclassified re-run on the account, 93 green); 36 -> 35 when the system database came to the server (§14;
Grammar re-run on the account, 137 green).

What the 35 are: 34 are the platform's own, pinned on the DuckDB lane by the same cause (instance identity, fold name
resolution, error positions and messages, the 0-based `indexOf`, `testBigFloatAbs`, the class `toString`, the
variant-array `joinStrings`, the ExtendedInteger type, the harness's lost `$address`, a date-time out of range); the
other 1 is Snowflake's own, measured: the driver's Timestamp drops a BC year's sign.

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
| a lambda reads no enclosing lambda's parameter; a correlated subquery over `FLATTEN` (scalar or lateral) is refused (`Unsupported subquery type`) | list statistics are `REDUCE`s: variance and standard deviation as DuckDB's own Welford update, mode as runs over the sorted elements (the earliest-seen on a tie, as DuckDB), median and `quantile_cont`; an explosion is a bare `LATERAL FLATTEN` over the positions, `SELECT *` over it spelled out; a `FILTER` or `TRANSFORM` whose lambda reads an enclosing lambda's names (the comparator dedup's) is a `REDUCE` whose accumulator carries them, its start written where they are in scope (an enclosing parameter is legal there, measured) |
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

**Jaro-Winkler, written exactly (2026-10-11, the user's ruling: exact SQL where the backend has lambdas).** Snowflake's
`JAROWINKLER_SIMILARITY` is another function: an integer percentage, case-insensitive (96 for MARTHA/MARHTA, 100 for
abc/ABC, 0 for two empty strings), so dividing by 100 does not give DuckDB's fraction; Databricks has none. Both now
write DuckDB's own algorithm (rapidfuzz's) in SQL: the match window `max(|p|, |t|) / 2 - 1`, at least 0; each
character of `t` in turn takes the first unmatched equal character of `p` in its window; half the matches out of
order, ROUNDED DOWN, are the transpositions (rapidfuzz's integer division: 181 of 1,585 pairs differ with the
textbook's half); a Jaro score above 0.7 gains a tenth of its distance to 1 per character of a common prefix of up to
four; an empty string scores 0. The score is computed in DOUBLE in DuckDB's order of operations, so the bits agree:
measured on 1,585 pairs (alphabets of 2 to 8 letters, lengths 0 to 140, past the 64-character block of rapidfuzz's
bit-parallel matcher), every result equal to DuckDB's on both accounts. Snowflake's is three `REDUCE`s over `OBJECT`
states, each start carrying what the next lambda reads (a lambda reads no enclosing lambda's parameter); Databricks' is
`aggregate`s whose finish lambdas chain the passes. One difference remains, DuckDB's own: it compares UTF-8 bytes,
these compare characters, so a non-ASCII pair can differ (no test has one). SQLite, MariaDB, MySQL, Postgres and
BigQuery have no lambdas and keep their wall.

## 10. BigQuery, measured (2026-10-11)

**Result:** all five suites pass on the account, each failure pinned by its message: 1,250 tests, 42 pinned (Grammar
10 of 137, Essential 28 of 346, Relation 2 of 469, Standard 0 of 205, Unclassified 2 of 93), the census divergence 0
in every suite. Burned down in six runs from 347 failing (the first run: Essential 107, Grammar 31, Relation 112,
Standard 75, Unclassified 22); 83 -> 82 when the system database came to the server (§14; Grammar re-run on the
account, 137 green); 82 -> 42 the same day (below, "Burned down beyond the first pass").

What the 42 are: 34 are the platform's own, pinned on the DuckDB lane by the same cause (as on Snowflake); the other
8 are BigQuery's own limits, each measured: no list of lists, so removeDuplicates' reduction has no accumulator (3:
"nested arrays are not supported"); a date-time past years 1 to 9999 (2); no Jaro-Winkler function (2); and a fold
that reads its row (1: WITH RECURSIVE is top-level only, and there are no lambdas).

**Burned down beyond the first pass (82 -> 42, 2026-10-11).** Each row was a lambda-less or BigQuery-shaped gap, closed
as a SQL author would on BigQuery, each shape measured on the account first (40 rows; the last line is the second fix the
date format's row needed):

| Pins | Was | Now |
|---|---|---|
| 8 | no lateral derived table ("LATERAL join is not supported"; a correlated derived table: "Unrecognized name") | a lateral join is `[LEFT] JOIN UNNEST(ARRAY(SELECT AS STRUCT * FROM (q)))`: an UNNEST correlates, through nested derived tables too (`BigQuery.lateral`) |
| 6 | no mode | the group's (or partition's) counts per value in a wrapping select, `COUNT(v) OVER (PARTITION BY keys, v)` (a FLOAT64 key partitions by its JSON text: no PARTITION BY on FLOAT64), then `ARRAY_AGG(v ORDER BY count DESC, v LIMIT 1)` or `FIRST_VALUE` over the same order; a tie takes the least value (DuckDB's takes the first row scanned, which SQL cannot name) |
| 11 | no MAP type | a map is its entries in order, `ARRAY<STRUCT<key K, value V>>` (BigQuery's own way to load one); DuckDB's semantics measured and kept: a NULL or repeated key raises DuckDB's message, a concatenation keeps each key at its first place with the last map's value, an extraction is a list; a Variant object's keys come in BigQuery's order, sorted (its JSON keeps no document order, measured), where DuckDB keeps the document's; the executor decodes the entries to the map, the census reads ARRAY as delivering MAP |
| 6 | no lambdas and no correlated recursion to fold with | a fold that reads nothing of its row is a top-level `WITH RECURSIVE` expression, read as its last accumulator (`FoldsAsRecursiveCtes`, MIR's `SqlWith.recursive`); a fold over the NULL list is its init; list_reduce the same from its first element (removeDuplicates' three now stop at the nested-array limit; the fold that reads its row stays) |
| 2 | a filter's or map's lambda parameter left unbound (the portable carrier strategies', on Postgres, SQLite and MariaDB too) | a read qualified by the parameter (`p.first`) is a field of the substituted element (`CarrierStrategies.substParam`); the third such row, `testFilterInstance`, now fails as on DuckDB (instance identity, the platform's own) |
| 3 | an empty list of no element type | `[]` is a list of Nil's carrier, VARCHAR (the column its element fills is labelled so); a lambda body over it, which never runs, is a NULL of the body's own type |
| 1 | a statement past the maximum query length (a float's text canon, 2.9M characters) | a large repeated subexpression written once (`CommonSubexpressions`, SQLite's pass; its one-row derived table under a scalar subquery correlates here, measured): 24K |
| 1 | PERCENTILE_CONT over a window ascending only | a descending one is DuckDB's own interpolation over the ascending order of the negated values, at an exact BIGNUMERIC position (`BigQuery.descendingOver`) |
| 1 | no minimal-fraction date format | `%E3S`'s milliseconds after the second |
| 1 | a cast of a JSON lambda parameter | the parameter of a JSON array's lambda is typed JSON, so its cast reads JSON (`INT64(j)`) |
| (the same) | behind the date format, the format's time-zone shift inverted (`18:07+0500` for `08:07-0500`) | timezone() decides instant or naive by its operand's shape, as Snowflake does (`BigQuery.isInstant`): format's shift is timezone(zone, timezone('UTC', t)), whose inner call is typed naive but renders an instant |

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
| `FARM_FINGERPRINT(NULL)` is NULL (DuckDB's `hash(NULL)` is a number, and Pure's `hashCode([])` is one) | `hashCode` fingerprints the value's text as JSON, whose NULL is `'null'` |
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


## 12. SQLite, measured (2026-10-11)

The first of the open ones (§2, item 4). No account: the product's own driver, in-process and in memory.

**Result:** all five suites pass on SQLite, each failure pinned by its message: 1,249 tests, 50 pinned (Grammar 13 of
137, Essential 27 of 345, Relation 2 of 469, Standard 2 of 205, Unclassified 6 of 93), the census divergence 0 in
every suite (no ceiling raised). SQLite was a lexicon row over `AnsiSqlRenderer` until now; that row failed 985 tests
on its first lane run. The dialect class's first run failed 144 (Essential 42, Grammar 15, Relation 26, Standard 24,
Unclassified 37), and it was burned down from there to the 52 in fifteen runs; 52 -> 50 when the portable carrier
strategies read a lambda parameter's field as the folded element's (§10's burn-down; `testFilterInstance` now fails
on instance identity, as on DuckDB).

What the 50 are: 34 are the platform's own, pinned on the DuckDB lane by the same cause. The other 16 are SQLite's own
limits, each measured:

- no digest function, so no MD5, SHA-1 or SHA-256 (3);
- an integer past 64 bits (3), raised rather than delivered as a REAL;
- no hash function (2, as on Postgres);
- no session user (2);
- no Jaro-Winkler function (2, as on Postgres and the clouds);
- a date past the years 0000-9999 (2): one is raised, and the other is a five-digit year that compares as text;
- no time zone but UTC (1);
- the 1,000,000-byte statement cap (1): a mixed list's sort compares each Float by its text canon, and each capture
  group's regular-expression walk is written separately.

The driver is xerial `sqlite-jdbc` 3.47.1.0 (`@sqlite_jdbc`, already a dependency; its own build of SQLite 3.47.1, with
the math functions and the driver's statistics extension). Each executed expression gets a fresh in-memory database
(`jdbc:sqlite::memory:`), and the session runs `PRAGMA case_sensitive_like = ON`.

The work:
- `core/.../sql/dialect/SQLite.java`, a sibling of `BigQuery` and `Postgres`, with an exhaustive decision per `SqlFn`
  and `SqlAgg.Fn`;
- `SqliteRegex.java`, regular expressions as a recursive walk in SQL;
- `CommonSubexpressions.java`, a rewrite pass for the statement cap;
- SQLite rows in `TypeNames`, `Spellings` and `CarrierStrategies.Caps`;
- `Databases.dialect` constructs it;
- the wire census reads SQLite's type names (`SqlTypeCensus.sqliteOwn`, `dialectSpelling`).

What differs from DuckDB, and the dialect's answer:

| Measured | Consequence |
|---|---|
| a value has no declared type, only a storage class (INTEGER, REAL, TEXT, BLOB, NULL); a CAST to a type name casts by its affinity only (`CAST('2024-01-01' AS DATE)` is 2024); the driver names a column by its first value's class (`NUMERIC` for a NULL) | every cast is decided by the dialect: a boolean is 1 or 0, a date and a date-time are their ISO text; the census reads INTEGER as delivering Boolean and HUGEINT labels, TEXT as delivering temporal, JSON, composite and decimal ones, FLOAT as DOUBLE, and a NULL first value as claiming no type |
| no exact decimal | a decimal is a REAL; a root decimal column is its text at its scale (`printf('%.Nf')`), read back exact (`normalize`) |
| no array, struct or map type | JSON1 text (`json_array`, `json_object`); a list operation is a correlated subquery over `json_each(xs)`, and a fold is a correlated `WITH RECURSIVE` (both measured to correlate inside a scalar subquery); a nested value that leaves a JSON function through a column is put back with `json()` |
| no LATERAL, no VALUES alias list, no QUALIFY, no ORDER BY or LIMIT on a UNION branch, no quantified comparison | a lateral subquery's rows are `json_each` over those rows aggregated as JSON objects; the explosions are markers (`ExplosionMarkers`) joined to `json_each` over the longest list; VALUES columns are renamed through a subselect; QUALIFY is a wrapping subselect; a union branch is wrapped |
| no regular-expression function (REGEXP is application-defined, and none is registered: the database executes, never the host) | a literal pattern is compiled at render time to its automaton's transition table, as `VALUES` rows; a recursive query walks the table over the text (`SqliteRegex`: matches, extract, extract-all, replace); a pattern that is not a literal is a wall |
| no base64, no Levenshtein | recursive walks: base64 over the text's hex bytes three at a time (`unhex` back); Levenshtein over the edit-distance table, a row at a time as a JSON array |
| no RAISE outside a trigger | a bad JSON path's error carries its text (`json_extract('{}', <message>)`), so a message is raised as one; a quote travels as U+001D (`RaisedErrors.QUOTE_MARK`), since SQLite doubles it in the error |
| a statement is at most 1,000,000 bytes (`SQLITE_TOOBIG`) | a repeated large subexpression is written once, as a column of a one-row derived table (`CommonSubexpressions`); a repeating function's large operands are bound once; a float's shortest text reads its value once |
| integer arithmetic overflows to a REAL silently (`9223372036854775807 + 3`) | a big integer's root column raises past 64 bits |
| dates are texts of the years 0000-9999, and a date function answers NULL past them; a date with an unpadded month (`2014-2-27`) is NULL | adding an interval raises past them; a parsed or cast date's fields are padded first; a month past the month's end is clamped (`'floor'`, SQLite 3.46+) |
| LIKE is case-insensitive | `PRAGMA case_sensitive_like = ON`, the dialect's session setup |
| the statistics extension's aggregates (stdev, variance, median, mode) are not window functions | a windowed variance, deviation, covariance or correlation is computed from window sums |
| an aggregate inside a table-valued function's argument in a subquery is "misuse of aggregate function" | argMax and argMin are `json_group_array`'s own `ORDER BY` (SQLite 3.44+) |
| `acos`/`asin` outside [-1, 1] answer NULL (DuckDB raises) | raised |
| the platform's schema-qualified tables (an `ATTACH`ed database is held by its connection: "database already in use") | a schema's table is one table named `"schema.table"` |

The lanes: `//pct:pct_sqlite_<suite>` and `//pct:pct_sqlite`, run from a desk with `bazel test //pct:pct_sqlite`.
They are tagged `manual`, in no per-push lane: they sit in `//gates:heavy`, beside the three cloud lanes, which were
in no lane of `gates/BUILD.bazel` until now (CI's lane guard would have refused them). A per-push lane for SQLite is
the user's call.


## 13. MariaDB, measured (2026-10-11)

The second of the open ones (§2, item 4). No account and no Docker: a real MariaDB 11.4.13 server that Bazel unpacks
from MariaDB's own Linux tarball (`@embedded_mariadb`, `tools/mariadb/`, the server and its bootstrap scripts only),
started once per test JVM on a free loopback port with its data in the test's temporary directory
(`testing/.../EmbeddedMariaDb.java`). The driver is MariaDB Connector/J 3.5.10 (`@mariadb_jdbc`, LGPL, test-only).

**Result:** all five suites pass on MariaDB, each failure pinned by its message: 1,249 tests, 59 pinned (Essential 31
of 345, Grammar 10 of 137, Relation 13 of 469, Standard 3 of 205, Unclassified 2 of 93), the census divergence 0 in
every suite (no ceiling raised); 62 -> 61 when the system database came to the server (§14; Grammar re-run, 137
green); 61 -> 59 when the portable carrier strategies read a lambda parameter's field as the folded element's (§10's
burn-down; `testFilterInstance` now fails on instance identity, as on DuckDB).

What the 59 are: 34 are the platform's own, pinned on the DuckDB lane by the same cause (7 of them instance
identity). The other 25 are MariaDB's own limits, each measured:

- GROUP_CONCAT, JSON_ARRAYAGG and a mode are no window functions (14): a windowed string aggregate (11) or mode (3);
- a statement's memory (5): a Float's text canon written out in each of `format`'s arguments, or in each comparison
  of a mixed list's sort, passes the server's 2 GB session cap or its 16 MB statement text;
- no Jaro-Winkler function (2, as on SQLite, Postgres and the clouds);
- a date past the years 1000-9999 (2);
- no named time zone without the server's zone tables (1);
- a recursive CTE takes no outer reference (1): a fold over a row's list.

The work:
- `core/.../sql/dialect/MariaDb.java`, a sibling of `SQLite` and `BigQuery`, with an exhaustive decision per `SqlFn`
  and `SqlAgg.Fn`;
- MariaDB rows in `Lexicon`, `TypeNames`, `Spellings` and `CarrierStrategies.Caps`;
- `MariaDB` and `MySQL` in `ConnectionDefinition.DatabaseType`, accepted by the grammar as lite extensions beside
  SQLite (`docs/SEMANTICS_REGISTER.md` S43); MySQL is declared, not built (its connections and dialect refuse by name);
- `Databases.dialect` constructs it, `Sessions` opens `jdbc:mariadb://` for a static datasource;
- the raise path: `Sessions.raisedMessage` and `RaisedErrors.unwrapped(e, session)` (below);
- the wire census reads MariaDB's type names (`SqlTypeCensus.mariaDbOwn`, `dialectSpelling`);
- the lanes `//pct:pct_mariadb_<suite>` and `//pct:pct_mariadb`, tagged `manual`, in `//gates:heavy`.

What differs from DuckDB, and the dialect's answer:

| Measured | Consequence |
|---|---|
| the session decides the dialect | the dialect's session setup: `ANSI_QUOTES,PIPES_AS_CONCAT,NO_BACKSLASH_ESCAPES` and strict mode, the zone UTC, utf8mb4 with its binary collation (case- and accent-sensitive comparison and LIKE), `group_concat_max_len` at 1 GB, `max_recursive_iterations` raised, 30 decimal digits for a division, and `condition_pushdown_for_derived` off (on, a JSON filter pushed into a UNION derived table returned no rows) |
| the binary collation still pads (`' ' = ''` is true); the JSON functions answer in that collation, so a NO PAD one mixes with theirs ("Illegal mix of collations") | an empty text is tested by its length (`CHAR_LENGTH`) |
| no array, struct or map type | JSON text: a list operation is a correlated subquery over `JSON_TABLE(xs, '$[*]' ...)` (a table function's argument correlates, measured) |
| an outer reference inside a derived table or a recursive CTE fails ("Unknown column") | a LATERAL subquery's rows are inlined as `JSON_TABLE` over those rows aggregated as JSON objects; the explosions are markers joined to `JSON_TABLE` over the list; a fold, a `list_reduce` and an edit distance are a recursive CTE only over values that read no row, with a typed anchor (a CTE's column takes its first row's type, and a literal's is too narrow to grow: `''` is CHAR(0), `0` an INT) |
| no LATERAL, FULL OUTER JOIN, QUALIFY, NULLS FIRST/LAST, FILTER, VALUES alias list | FULL OUTER is emulated (`Caps.MARIADB`), QUALIFY a wrapping subselect, a sort key's NULL order an `IS NULL` key, VALUES a UNION ALL of selects; `<=>` is the null-safe comparison |
| a boolean is 1 or 0; `1.5` is a DECIMAL and `1.5E0` a DOUBLE; a JSON boolean's `JSON_VALUE` is `'1'` or `'0'` | a Float literal carries an exponent; a root Float column is cast to DOUBLE; a JSON boolean is read as 1/0 |
| a SELECT raises no error of its own text: SIGNAL runs only in a stored program, a conversion is a warning, and an XPath error is raised when the statement is PREPARED, whether or not its branch runs | a raise sets the session variable `@legend_raise` and fails at run time on a fixed error (a scalar subquery of two rows); after a failure, `Sessions.raisedMessage` reads the variable and clears it (one read, registered in the SQL-text and accessor ratchets with their reasons) |
| the driver parses a backslash before a quote as an escape, whatever the session's mode ("unknown escape sequence", or a socket error) | a string literal with a backslash before a quote spells it `CHAR(92 USING utf8mb4)` |
| a DATE or DATETIME is of the years 1000-9999 | adding an interval raises past them |
| a double's ROUND is half to even; CAST of a double to an integer rounds half to even | DuckDB's half away from zero is written out |
| a JSON_TABLE column of an empty or NULL list, and `JSON_VALUE` or `REPEAT` of a NULL, are text or binary | an element read of a list that claims no type, and a root value that claims none, are cast to their label |
| a deeply nested correlated JSON_TABLE was planned past 11 GB (the OOM killer ended the server; a common-subexpression pass made it so) | no such pass; the server caps a session at 2 GB (`--max-session-mem-used`), so a statement that big is an error; the 16 MB statement text is kept (at 1 GB a 24 MB statement's parse went past 4 GB, and a grouped `JSON_ARRAYAGG ... LIMIT` answered NULL) |
| a windowed variance or standard deviation is a running recurrence over the partition's rows in the order the window's sort leaves them, which varies (the same statement's z-scores 1.5 in one run, 1.5000000000000002 in another) | an integer's is computed from its exact DECIMAL sums over the window, the same in any order |
| a test compares the database's user with the JVM's (`currentUserId()`), and a container runs as root | the server's own account is `legend`, made by the server's init file, never `root` |

The lanes run from a desk with `bazel test //pct:pct_mariadb`. Linux x86_64 only (the tarball's platform): on another
platform the lanes are incompatible, not failing (`EMBEDDED_MARIADB_COMPATIBLE`). **MySQL** is next: its 8.4 server
tarball, a sibling dialect where the two differ (its JSON functions and regular expressions).

## 14. The system database on a server engine (2026-10-11)

`Class.all()` (Grammar's `getAll::testBasic`) reads the platform's metamodel store, which lives in the graph's SYSTEM
DATABASE (`exec/SystemDatabase.java`, the user's ruling of 2026-09-02): the metamodel rows in a database of their own,
apart from every user connection, written once per graph, read-only after, of the same engine as the runtime (so each
lane runs the metamodel queries in its own SQL). On DuckDB, H2 and SQLite it is a private in-memory instance. A server
engine has none, so the test was pinned on every server lane ("no in-memory instance of database type ...").

**The design (the user's, 2026-10-11): the same thing over a remote database.**

- **A system connection, configured apart.** The host gives the platform a SYSTEM CONNECTION per engine
  (`ExecuteOptions.withSystemConnections`, a `Sessions.Opener` per `DatabaseType`): the platform holds no server
  credential, and nothing assumes the system connection is the runtime's server. A server engine with none is refused
  by name. The opened session is checked to be the runtime's engine (`Sessions.check`), since the query is planned in
  the runtime's dialect, and takes the dialect's session setup. The PCT harness gives it the lane's own server and
  credentials, as its choice (`PctBackend.systemConnections`, `CloudLane.openSystem`): a NEW session, plus the
  `c.system.property.*` driver properties (§4).
- **Seeded once per graph, every table, as on DuckDB.** All 34 tables, on the graph's first metamodel query. A
  per-table write is about 0.4-1 s on Snowflake and 1-3 s on Databricks (measured), so a graph's seed is under a
  minute on Snowflake; only `testBasic` pays it on the cloud lanes.
- **Session-private tables.** Each table is TEMPORARY, the system session's own: no other session sees it, two graphs
  or two runs never collide, and the server drops it when the session ends, a crash included -- the private
  instance's guarantees on a shared account (the Snowflake account is a shared integration database; nothing
  permanent is created in it). A temporary table takes no schema on most servers, so each is named
  `metamodel_<table>` (`Ddl.systemTable`) and the query reads it through its table renames (`SystemDatabase.Route`,
  applied by the existing MIR rename before render).

**Measured, per engine (what each server needed):**

| Engine | Needed |
|---|---|
| all servers | no key and no length on these read-only copies (their rows are the ones the in-process engines load under both): Databricks refuses a key on a temporary table; MariaDB and MySQL refuse a key past 3,072 bytes (the store's `VARCHAR(1024)` keys in utf8mb4) and a row whose declared lengths pass 65,535 bytes; Snowflake and BigQuery enforce no key |
| MariaDB, MySQL, BigQuery | each non-text cell CAST to its column's type (`RowLoad.casts`): MariaDB and MySQL take no `'true'` into a BOOLEAN, BigQuery no string into an INT64 or a BOOL; the dialect spells its own conversion |
| Snowflake | a temporary table needs the session's current schema, and the session has none: `snowflake.system.property.schema` (a schema the role may create tables in) |
| BigQuery | a temporary table exists only in a session: `bigquery.system.property.EnableSession=1` (the driver takes it as a property); `CREATE TEMP TABLE`, unqualified |
| Databricks | a temporary TABLE is not read inside an `EXISTS` (`UC_COMMAND_NOT_SUPPORTED`, "Data source v2"; a scalar or `IN` subquery reads it): each system table is a `TEMPORARY VIEW` over its rows instead (`SqlDialect.sessionTable`, one statement, 0.2 s), each column cast to its type in the projection; Spark DDL spells an unbounded VARCHAR `STRING`, a BIT `BOOLEAN`, and a nullable column with no `NULL` |
| MySQL | a temporary table cannot be read twice in one query ("Can't reopen table"): `testBasic` reads it once; a self-joining metamodel query would fail there by that message |

**Result:** `testBasic` passes on Snowflake, Databricks, BigQuery, MariaDB and MySQL (each lane's Grammar re-run, every
one green but MySQL's open list); its pin is gone from those lanes and from Postgres. **Postgres is not verified
here**: the embedded Postgres refuses to start as root, and this session runs as root, so its lane runs only in CI.


## 15. Design (not built): a BC date-time on Snowflake and Databricks

**The one failure each cloud has beyond the platform's own** is `testAdjustByMinutesBigNumber`: a date-time in the
year -21457. The database computes it right; the JDBC driver reads it wrong (measured 2026-10-11):

| Read | Snowflake (snowflake-jdbc 4.4.0) | Databricks (databricks-jdbc 3.4.3) |
|---|---|---|
| the value as text, in SQL | `-21457-01-08 20:48:00` (`TO_VARCHAR`) | `-21457-01-08 20:48:00` (`CAST(.. AS STRING)`) |
| `getString` | `21458-06-30 17:39:38.000` | the year's sign dropped (`21458-01-08 20:48:00`) |
| `getTimestamp` | epoch -21457-01-18T17:39:38Z (ten days and three hours off) | the same text, sign dropped |
| `getObject(i, LocalDateTime.class)` | refused (a plain `SQLException`) | the `Timestamp`'s text |

So no read of a TIMESTAMP cell can recover it: the executor's BC-safe re-fetch (`Executor.fetch`, the `java.time`
carrier) has nothing faithful to re-fetch on these drivers. The value survives only as text written by the database.

**The design: on these two dialects, a result's TIMESTAMP column is delivered as its text**, which the executor
already decodes -- a temporal-labelled VARCHAR cell is the precision-faithful string convention and parses
(`Executor.unwrap`: `PureDateLiteral.parse`), the label unchanged. The text must be what the driver path would have
produced for an AD value, so nothing else moves: `PureDateLiteral.fromLocalDateTime` writes no fraction when the
nanoseconds are zero, else the fraction with its trailing zeros stripped. Measured, both warehouses write exactly that:

- Databricks: `CAST(ts AS STRING)` -- `2016-02-29 01:02:03`, `2016-02-29 01:02:03.456`, `-21457-01-08 20:48:00`;
- Snowflake: `RTRIM(RTRIM(TO_VARCHAR(ts, 'YYYY-MM-DD HH24:MI:SS.FF9'), '0'), '.')` -- the same three, and
  `0010-01-01 00:00:00` (a four-digit year kept).

**Where:** each dialect's root select, where it already rewrites a result column for the wire (Snowflake's root JSON
column is `TO_JSON(..)` under its VARCHAR label, `Snowflake.rootLabels`). Chosen by KIND (every root TIMESTAMP
column), never by value: the executor's rule (`Executor.fetch`: "one carrier, chosen by kind").

**What to check when it is built:**
1. the census: a TIMESTAMP label delivered as VARCHAR must read as the string convention, not a divergence (every
   suite's census must stay at 0);
2. the PCT wire's TDS text already writes its temporals in SQL, so only a scalar or a non-TDS read changes; a struct or
   list leaf keeps the driver's carrier (out of scope, as `Executor.unwrap` says of leaves today);
3. all five suites on both accounts, and the DuckDB, H2 and Postgres lanes untouched (no shared code changes).

**What it gains:** the one pin on Snowflake (35 -> 34, the DuckDB lane's count) and one on Databricks; and outside
PCT, every query reading a date-time before year 1 from these warehouses, which today reads wrong silently (a year
past 9999 is not measured).
