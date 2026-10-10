# The output layer: an answer is Pure's value, its text the served API's (PARK-24's design, 2026-10-10)

**Status: a design for the user's agreement; nothing is built.** Session "Plan Gen / Exec Split". The ruling it serves
(the user, 2026-10-10, "Agreed on all"): an answer is Pure's VALUE — its kind, its digits, a decimal's scale —
everywhere; its TEXT follows the API served. It replaces PARK-24's first statement (`docs/PARKED_WORK_LEDGER.md`), two of
whose four gaps were measured against the wrong Pure (§1).

Evidence, all committed under `docs/execution-plan-boundary-2026-10-05/probes/engine-reference/`: `PureEval.java` →
`pure-interpreted-results.txt` (Pure's interpreted runtime), `results.txt` (legend-engine 4.145.0's execute, compiled
Pure, and lite's execute against the same requests). The code inventory below (§2) was read, not run; a cell marked
*unverified* is measured first, by step 1 of §5.

## 1. Which Pure is the reference

Pure has two Java runtimes, and they disagree on numbers (measured 2026-10-10):

| expression | **interpreted** (legend-pure's reference; lite's PCT lane runs it) | compiled (legend-engine's server) |
|---|---|---|
| `3 * 1.1` | `3.3` | `3.3000000000000003` |
| `2.50D` | `2.50` | `2.5` |
| `2 * 2.50D` | `5.00` | `5.0` |
| `1.50D * 2.50D` | `3.7500` | `3.75` |
| `2 * 1.5` | `3.0` | `3.0` |
| `1.5e15`, `2.5e-7` | `1500000000000000.0`, `0.00000025` | the same |
| `%2024-01-02T10:30:00` | `2024-01-02T10:30:00+0000` | the same |
| `%2024-01-02T10:30:00.123456789` | `2024-01-02T10:30:00.123456789+0000` | the same |

In the interpreted runtime a Float is `BigDecimal`-backed and keeps its digits; compiled, it is a `double`. The numeric
charter (`docs/NUMERIC_CHARTER_2026_09_17.md`, Rule 2) chose the interpreted runtime as the reference on 2026-09-17, for
this reason (`abs::testBigFloatAbs` keeps `123456789123456789.99` only there). **This design keeps that choice:** the
reference for a value is interpreted Pure. So lite's Float arithmetic in decimal (Rule 1) and its decimal literals'
scale are RIGHT, and are not gaps; PARK-24's statement of them came from the compiled measurement and is corrected.

## 2. Where lite gives a value its text today (the inventory)

Every output, and the code that decides each kind's text in it:

| output | who reads it | Float | Decimal | DateTime |
|---|---|---|---|---|
| CSV wire (`Render.csvWire`, `Render.cell`) | lite's query service, exports | `LiteralSpelling.floatPrint` over `CAST(x AS VARCHAR)` | `CAST(x AS VARCHAR)`: the database's scale | `STRFTIME(CSV_DATETIME)`: space, **no fraction**, no zone |
| JSON wire, whole or one row at a time (`Render.jsonWire`, `jsonWireRows`) | lite's query service, plans' JSON | the database's own JSON number | the database's own: DuckDB **turns it into a double** (scale lost), H2 and Postgres keep it | the database's own: DuckDB a space, Postgres a `T`, no zone |
| a value-lane root (`Fold.conformValueEgress` → `wireValueEgress`) | scalar and collection answers | — | trailing zeros stripped, `D` appended, as a string (`"2.5D"`) | `ISO_NANO`: `T`, nine digits, no zone |
| `pure/v1/execution/execute` (`PureV1Api.tdsResult`) | Studio, DataCube's engine client, legend clients | the JSON wire's token, kept (`Json` keeps a number's text) | the same | the same |
| Arrow (`arrowPlan`, Python) | Python | float64 | decimal128, scale kept | timestamp |
| TDS cells, PCT, `toString` (`Render.tdsCell`, `Scalars.pureToString`) | Pure test bodies | `floatPrint(CAST(c AS DOUBLE))` | the database's scale | `dateTimeText`: `T`, three digits, `+0000` |

The same kind is formatted by several pieces of code: a Float by seven (`floatPrint`, `floatCanon`,
`CanonicalForm.renderFloat`, `plainFloat`, the databases' JSON, `Json.writeDouble`, DataCube), a Decimal by five, a
DateTime by nine. `floatPrint` re-renders only a lowercase `e`, so H2's `1.5E15` passes through it unchanged, and
Postgres's float8 text has no `.0` (`3`), which it does not add.

## 3. The gaps, against interpreted Pure

1. **A whole Float without its `.0`.** Measured: lite's `pure/v1` execute on H2, `$r.ID * 1.5`, answers `3` (Pure and
   legend-engine: `3.0`); read from the code, Postgres's CSV and JSON give `3` as well. (DuckDB writes `3.0`.)
2. **A Float at an extreme magnitude in exponent form** in lite's own outputs: `1.5E15`, `2.5E-7` (Pure:
   `1500000000000000.0`, `0.00000025`). On `pure/v1` the engine's JSON writes `1.5E15` too, so there it is the API's text
   (§4).
3. **A decimal result losing its scale.** Measured: lite's execute on H2, `$r.ID * 2.50D`, answers `2.5`, `5`, `7.5`
   (Pure: `2.50`, `5.00`, `7.50`); DuckDB's JSON turns every decimal into a double; a value-lane root strips the zeros
   (`"2.5D"`).
4. **DateTime text.** Measured: lite's `pure/v1` execute on H2 answers `2024-01-02T10:30:00`, no zone, where Pure
   writes `2024-01-02T10:30:00+0000` and legend-engine's execute `2024-01-02T10:30:00.000000000+0000`. Read from the
   code, the other outputs spell it four more ways: CSV `2024-01-02 10:30:00` (fraction dropped), DuckDB's JSON
   `2024-01-02 10:30:00.123456789`, Postgres's JSON `2024-01-02T10:30:00.123456`, value lanes
   `2024-01-02T10:30:00.000000000`; TDS cells, `2024-01-02T10:30:00.000+0000`.

## 4. The design

**One text owner per kind, per API.** Each kind's text is decided once per API, by one function per dialect, and every
output of that API uses it; the duplicates in §2 are deleted.

- **Lite's own outputs** (CSV, the JSON wire, a stream of JSON rows, value lanes): Pure's own text, interpreted. A Float
  as Pure prints it: plain digits, always a fraction (`3.0`, `1500000000000000.0`, `0.00000025`). A Decimal with its own
  scale (`5.00`). A DateTime as Pure prints it: `T`, the value's own fraction digits, `+0000`. A StrictDate
  `2024-01-02`. In JSON a number is a number token of exactly that text, a date a string of it.
- **`pure/v1` execute** (legend-engine's API): legend-engine's text for the same values — a Float as Java prints a double
  (`3.0`, `1.5E15`, `2.5E-7`), a Decimal with its scale (`5.00`), a DateTime with nine fraction digits and `+0000`. The
  VALUE is still interpreted Pure's: lite's `3 * 1.1` answers `3.3` there, where legend-engine answers
  `3.3000000000000003` — a deliberate difference, a row of `docs/SEMANTICS_REGISTER.md` (lite keeps Pure's digits; the
  engine's server loses them), as is legend-engine's 16-place decimal arithmetic (`cast(x as Decimal(32,16))`).
- **The database still computes, and builds the text** (the execution tenet: Java orchestrates, the database
  executes). The formatter is SQL per dialect, as `floatPrint` and `STRFTIME` are today; the JSON wire is assembled
  from the formatted cells (`'{"x":' || <the Float's text> || ...`, strings escaped by the database's JSON function), so
  no database's native JSON number decides a token. A Float's text in SQL: the plain digits of the double, with `.0`
  when it is whole, and no exponent (DuckDB `printf`/`format`, H2 `TO_CHAR` or `CAST(... AS DECIMAL)` text, Postgres
  `to_char`/numeric text; each measured, step 1).
- **Arrow is values, not text:** its kinds (float64, decimal128 with the value's scale, timestamp to the value's
  precision) are checked, not formatted.
- **Display is the UI's:** DataCube's `Intl` formatting is a display choice and stays; its engine client's parse
  (`parseExact`, `timestampFromText`) is adjusted only where it would misread the new text (`+0000`, a scale kept).

## 5. The work, in order

1. **The matrix, measured first.** A test that records, for each kind (Float whole, fractional, extreme; Decimal with
   trailing zeros, after arithmetic; DateTime with none, three, six and nine fraction digits; StrictDate) and each output
   (CSV, JSON wire, rows, value lane, `pure/v1`, Arrow) on DuckDB, H2 and Postgres, lite's text — beside interpreted
   Pure's (`PureEval.java`) and legend-engine's (`record_literals.py`). Every *unverified* cell of §2 becomes a measured
   one; the test is the gate of every step after it, and stays as the guard.
2. **The Float's text owner**, one per dialect (replacing `floatPrint`, `floatCanon`, `CanonicalForm.renderFloat` and
   the native JSON numbers): gaps 1 and 2.
3. **The Decimal's text owner**: the database's scale everywhere, the JSON wire's token included (DuckDB's JSON no
   longer decides), the value-lane `D` string replaced by the number of Pure's text: gap 3.
4. **The DateTime's text owner**, per API: gap 4.
5. **`pure/v1`'s text** from the same owners, in the engine's conventions; the deliberate differences recorded in
   `SEMANTICS_REGISTER.md`.

Each step: the render census (today's statements change only where the step says), the corpus passes, PCT, DataCube's
and Python's suites; one landing per step or two.

**What the shadow run adds** (`docs/execution-plan-boundary-2026-10-05/shadow-run/results-r1.txt`): every answer of
phase 1's scope across the local gate and the Postgres arm (410, the text the database builds) is the same when its lite
plan is run, so running a plan reproduces today's text, these gaps included; the fixes above change both at once.
Pure test bodies (PCT, the corpus passes) take rows of values from `Execution.execute`; running a plan for them is
phase 3 of the agreed program (`docs/EXECUTION_PLAN_BOUNDARY_2026_10_05.md` §8: the runner decodes the database's rows
by the result description the plan carries — `ExecutionPlan.TdsResult`, refused by name until then). That decoding
reads the database's values, not this text; it answers to the same rule, Pure's value, judged by PCT.

## 6. Decisions for the user

1. **The reference is interpreted Pure** (the charter's choice since 2026-09-17), not compiled — so `3 * 1.1` answers
   `3.3`, even on `pure/v1`, where legend-engine's server answers `3.3000000000000003`. Recommended.
2. **`pure/v1`'s text is legend-engine's conventions** (`1.5E15`, nine-digit DateTimes), and lite's own outputs Pure's
   text (`1500000000000000.0`, the value's own digits). Recommended, per the 2026-09-27 ruling that `pure/v1` answers as
   the engine does.
3. **The JSON wire is assembled from formatted cells**, not the database's native JSON values — the only way a database's
   JSON number stops deciding a token. Recommended.
