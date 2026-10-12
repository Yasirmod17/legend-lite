# PCT pins: what each database cannot do, and the workarounds (2026-10-12)

**The question (the user, 2026-10-12):** *drill into ClickHouse PCT to understand what pieces it could not do, and,
as for BigQuery and the others, whether there are good workarounds for them.*

**How to read a pin.** A database's PCT ledger pins a test that fails there, together with its message. Some pins are
the **platform's own**: the DuckDB reference lane pins the same test, so the failure is legend-lite's on every
database (instance identity, a model's class instances, big date arithmetic, error-message text, ...). Those are not
the database's gaps, and no dialect work removes them. A database's **own** pins are the rest.

## Own pins per database (measured at c03ac6b)

| database | pins | of which the platform's (also on DuckDB) | **own** |
|---|---:|---:|---:|
| Postgres | 109 | 34 | **75** |
| H2 (Relation suite only) | 26 | 1 | **25** |
| MySQL | 54 | 34 | **20** |
| MariaDB | 51 | 34 | **17** |
| SQLite | 49 | 34 | **15** |
| ClickHouse | 65 → **42** | 34 | 31 → **8** (burned down, below) |
| BigQuery | 42 | 34 | **8** |
| Trino | 40 | 34 | **6** |
| Databricks | 35 | 34 | **1** |
| Snowflake | 35 | 34 | **1** |

DuckDB itself pins 34. ClickHouse's row was re-measured after its burn-down, later on 2026-10-12. The counts come from the `one("<test>", "<message>")` rows in
`pct/src/test/java/org/finos/legend/lite/pct/Test_LegendLite_<Db>_<Suite>Functions_PCT.java`, where DuckDB's ledger is
`Test_LegendLite_<Suite>Functions_PCT.java`.

## ClickHouse: its 31 own pins, and a workaround for each

**Outcome (later on 2026-10-12): 23 of the 31 fixed, and 8 kept pinned.** Each fix is in `ClickHouse.java` except two
connection settings, and is recorded in `docs/CLOUD_BACKENDS_PCT_2026_10_11.md` §19.1. The table below is the plan as
probed. Where the fix took another shape than the probe, its row says so.

What ClickHouse cannot do is in `docs/CLOUD_BACKENDS_PCT_2026_10_11.md` §19, measured during the burn-down. Each
workaround below was **probed on the pinned server binary** (ClickHouse 25.8.2.29, through `clickhouse local`). A
probe proves the SQL shape works; it does not yet prove the test passes. That is the dialect's work, measured by the
lane.

| pins | what ClickHouse cannot do | the workaround, probed | effort | outcome |
|---:|---|---|---|---|
| 6 | **A Tuple field of unknown type**, from an unset property: a Tuple's fields are typed, and `Nullable(Tuple)` is refused (probed: "cannot be inside Nullable type"). Tests: `testEqVarIdentity`, `testEqualVarIdentity`, `testContainsNonPrimitive`, `testMapInstance`, `testCoalesceInPreFilter`, `testAssignNewInstance` | Type the unknown field as **`Dynamic`**. Probed: `tuple(1, CAST(NULL AS Dynamic))` is `Tuple(UInt8, Dynamic)`, its NULL field reads as NULL, and `Dynamic = Dynamic` compares. **To check:** that the JDBC driver (0.9.6) decodes a `Dynamic` field. | medium | fixed 4 without `Dynamic`: the field's DECLARED type (`StructLit.Field.declared`), an unset list as the empty list, and two instances compared as one-element arrays (a Tuple's `=` answers NULL on a NULL field). The 2 whose unset property is a class (a NULL Tuple) are refused by name and stay pinned; `testEqualNonPrimitive` now fails as on DuckDB |
| 4 | **An empty list of no type** (`Nullable(Nothing)`), which nothing can zip or project into. Tests: `testZip*ListEmpty` ×3, `testSimpleProjectWithEmpty` | An empty list is a **typed empty array**, never a NULL. Probed: `arrayZip([], [])` and `arrayZip(CAST([] AS Array(Nullable(Int64))), ...)` both answer `[]`. The NULL comes from the dialect's emulation, and the failing SQL needs a `dump-sql` look. | small | fixed: the slot's type for the empty list, at the projection's unnest and the ARRAY JOIN |
| 2 | **An as-of join with no equality**: ClickHouse needs one besides the inequality. Tests: `testSimpleAsOfJoin`, `..._MultipleExpressions` | A **constant key on both sides**: `0 AS k` in each, `ON l.k = r.k AND l.t >= r.t`. Probed: the right answer. A second alternative is the window pick Databricks uses (`AsOfAsPick`). | small | fixed, by another key: a constant is folded away and refused again, so each side's operand hashed times zero |
| 1 | **An outer join whose ON reads both sides outside an equality**: refused under `join_use_nulls`, even with `allow_experimental_join_condition` (probed). Test: `testNestedJoinArithmeticComparisonExpression` | Join **without** `join_use_nulls` (probed: the condition is accepted), plus a marker column `1 AS __m` on the optional side. A missing row reads `__m = 0`, and each of its columns becomes `if(__m = 1, col, NULL)`. Scope: per statement. | medium | kept pinned |
| 1 | **A join condition on one side alone** ("cannot determine join keys"). Test: `TestJoin_CurrentUserId` | For an inner join, a **CROSS JOIN with the condition in WHERE** (probed). For an outer join, the condition moves into that side's subquery. | small | fixed: for an outer join, the condition as a key (`if(cond, 0, 1)` against the other side's hash times zero) |
| 1 | **A correlated subquery as IN's argument**: refused even with `allow_experimental_correlated_subqueries` (probed). Test: `testIn_CorrelatedSubQuery` | Rewrite `x IN (correlated subquery)` as **`EXISTS (... AND col = x)`**. Probed: a correlated `EXISTS` runs under `allow_experimental_correlated_subqueries = 1`. Caution: experimental on 25.8. | small–medium | fixed as three-valued IN (`CASE` over three EXISTS), only where the filter is null-rejecting (the experimental feature answers false for an outer NULL, measured) |
| 4 | **No LATERAL join.** Tests: `testLateralJoin*` ×4 | BigQuery's shape: a **correlated scalar subquery collecting `groupArray(tuple(...))`, then `ARRAY JOIN`**, or `LEFT ARRAY JOIN` for an outer lateral. Probed: right rows under `allow_experimental_correlated_subqueries = 1`. Caution: experimental. | medium | fixed by decorrelation instead: a lateral subquery that only filters becomes an INNER or LEFT join with its correlated conjuncts in the ON; any other lateral is still refused |
| 4 | **A RANGE frame's offset must be a non-negative integer**; `2.1` is refused. Tests: `testRange_WithNumbers_*` ×2 in over and ×2 in reduce | **Scale the key and the offsets to integers**: order by `toInt64(x * 10^s)`, with the offset `2.1 → 21` at scale 1. Probed on a Decimal key: right sums. This is exact for a Decimal key (its scale is in its type); a TDS Float literal is already an exact Decimal on ClickHouse (§19). For a Float key it is approximate, so refuse it there. | medium | fixed without scaling: the frame computed over the partition's `groupArray(tuple(arg, key))`, filtered by the offsets and reduced by the aggregate |
| 1 | **A quantile's level must be a constant.** Test: `testPercentile` | **`arraySort(groupArray(x))` and linear interpolation** at `(n - 1) * level`. Probed: 3.25, the same as `quantileExactInclusive(0.25)`. | small | fixed as probed |
| 1 | **A statement over `max_query_size`** (256 KiB), refused before its own SETTINGS clause is read. Test: `testFormatFloat` | Set **`max_query_size` on the connection** (a JDBC/HTTP parameter), not in the statement. | small | fixed as probed, with the AST limits too |
| 1 | **No session over HTTP**, so no session-private table and nowhere for the system database. Test: getAll `testBasic` | ClickHouse's HTTP interface keeps a session by **`session_id`**, and temporary tables live in it. A session-private scratch database is the alternative. **To check:** how the 0.9.6 driver passes `session_id`. | medium | fixed: the system connection's `clickhouse_setting_session_id` (the driver passes it as an HTTP parameter), a TEMPORARY table in that session |
| 2 | **A list is never NULL** (`Nullable(Array)` is refused), so a JSON `null` read as a list becomes `[]`. Tests: `testVariantColumn_distinct_removeDuplicates`, `testVariantColumn_slice` | Carry a nullable list as **`Variant(Array(T))`**. Probed: it holds a NULL (`isNull` is 1). Every list function then needs `variantElement`, so this is a wide change for two tests. | hard | kept pinned |
| 3 | **Dates only from 1900 to 2299.** `Date32` and `DateTime64` clamp silently, so the dialect refuses rather than answer for another date. Tests: `testBetween_{Date,DateTime,StrictDate}` with the year 1032 | **None cheap.** A date would have to be carried as a number (`toDaysSinceYearZero` exists) or as text on every path. Keep them pinned: the refusal is honest. | — | kept pinned |

**Summary for ClickHouse:**

- **The plan:** 9 small and 17 medium, probed shapes that should move 26 of the 31; 5 to stay pinned.
- **The outcome:** 23 fixed. Of the 26, `testNestedJoinArithmeticComparisonExpression` stayed pinned (no per-join
  `join_use_nulls`), and 2 unset class-typed properties are refused by name instead (a Tuple is never NULL, and a
  Tuple of NULLs would be an instance that is not there).
- **One experimental setting:** `allow_experimental_correlated_subqueries = 1`, for the IN rewrite's correlated
  EXISTS, written only into the statements that hold it. It answers false for an outer row whose correlated column
  is NULL (measured), so the rewrite is limited to null-rejecting filters. `Dynamic` was not needed.
- **8 stay pinned:** the dates (3), nullable lists (2), the outer join's residual (1) and the absent instances (2).
- **None of the 34 platform pins is ClickHouse's work.**

## The other databases

Postgres has the most own pins (75), then H2 (25), MySQL (20), MariaDB (17) and SQLite (15). BigQuery (8) and Trino
(6) were burned down hardest, and Databricks and Snowflake have 1 each. The next sections, written the same way, are
to come: the pins by cause, and each cause's workaround probed on the real database. Postgres first: 75 own pins on
the most-used server database is the largest gap.
