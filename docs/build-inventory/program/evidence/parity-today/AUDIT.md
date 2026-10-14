# Audit: the spelling of now compared with `CURRENT_DATE` (branch `core/parity-today`, 2026-10-13)

The independent audit agent's report on commit a69c3dc96 over main fc4609eeb (the commit was then amended to 4a8ff29ad
with the two should-fixes taken: the snap commit cited is d19b6067c, and the IN_FLIGHT note is in the same commit).
Read-only; the auditor ran no Bazel. Quoted as delivered, the worktree path removed.

---

Audit of a69c3dc96 (core/parity-today, over origin/main fc4609eeb). No Bazel was run, as the brief asked.

**Verdict: ready after fixes.** The fix itself is correct and can land. Only the commit message needs changes.
- Blockers: 0
- Should-fix: 2, both in the commit message
- Nits: 1

## Blockers
None.

## Should-fix

**S1. The commit message names the wrong snap commit.** It says `(5ac5dddcc: s2026-10-13)`. That line was first
written by d19b6067c (2026-10-13T00:28Z, "Postgres's date and timestamp spellings").
- `git log -S's2026-10-13' -- core/src/test/resources/sql-parity/postgres-answers.jsonl` returns only d19b6067c and
  a69c3dc96.
- 5ac5dddcc did edit the answers file (9 lines), but not this line.
- Fix: amend the message to cite d19b6067c.

**S2. The commit message says the fix is "noted in IN_FLIGHT under the island line's section", but the commit does
not touch `docs/IN_FLIGHT.md`.** origin/main has no such note either. The only drift note there is the AGE one at
docs/IN_FLIGHT.md:853.
- Fix: add the note in this same commit. The natural place is next to IN_FLIGHT.md:850-854, "Found by the PR's CI on
  the way". The other option is to drop the claim.
- Do not land the note as a separate `[skip ci]` head commit: the head commit decides whether main's CI runs, and
  this is a roll-forward for a red main.

## Nits
**N1. dates.yaml:85-86: the new comment is the only comment in the file about a single case.** The file's other
comments head sections (lines 6, 13, 34, 39, 46, 53, 91). The comment is true and short (109 and 110 columns), so
this is acceptable as is.

## The six checks

**1. Postgres's answer to the new SQL is always true, and no midnight race remains.**
- Both sides read the same moment:
  - `DATE 'today'` is turned into a date when Postgres parses the statement. The date input routine handles 'today'
    from the transaction's start time, in the session's time zone.
  - `CURRENT_DATE` (Postgres 16) reads the same transaction start, in the same zone, when the statement runs.
- The test sends one statement through `Statement.executeQuery` (SqlParityPostgresTest.java:96), on a fresh,
  unprepared statement each time. Postgres parses and runs it inside one transaction, which ends at Sync.
- Equality would hold even if autocommit were off, because both sides still read the same transaction start.
- Both values are fixed when the transaction starts, so a statement that runs across midnight still gets equal dates.
- The time zone is pinned to UTC (testing/src/main/java/com/legend/testing/EmbeddedPostgres.java:118), and both
  sides use the session zone anyway.
- Plan caching cannot freeze 'today', because nothing is server-prepared.

**2. The island still refuses the spelling, so both REFUSED entries in the ledger stand.**
- The refusal path:
  - core/src/main/java/com/legend/protocol/sql/PostgresDateTime.java:93-95 lists `now`, `today` and the other
    reserved words as RESERV/OTHER_RESERVED.
  - PostgresDateTime.java:372-374 throws `Bad(false, "the word ...")` for any of them except `epoch`.
  - PostgresDateTime.java:153-156 turns that into `SqlTranslationException.unsupported`.
  - It is reached from `typedLiteral` (SqlToPure.java:5606-5612, then `dateFromString` at :5624). `typedLiteral` has
    a single call site in the expression switch (SqlToPure.java:3358).
  - core/src/main/java/com/legend/compiler/spec/SqlIslands.java:38-42 turns UNSUPPORTED into
    `NotImplementedException`.
  - SqlParity.java:920-922 records `NotImplementedException` as REFUSED when the expected answer is rows. It is rows
    (true).
- The refusal does not depend on the rest of the expression:
  - No code under protocol/sql catches `SqlTranslationException`.
  - Any translation of the literal throws, wherever it sits.
  - Even another refusal elsewhere in the query would still be REFUSED.
- Both lanes refuse at translation, before any dialect is chosen, so ledger.tsv:1753 `REFUSED REFUSED` stays correct.

**3. `"btrue"` is the right encoding.**
- `encode` writes `"b" + b` for a Boolean (SqlParity.java:853), and `decode` reads `'b'` with `Boolean.valueOf`
  (SqlParity.java:867).
- The answers file already holds 162 `"btrue"` cells.
- postgres-answers.jsonl:1682 has the same shape as its neighbours: `{"id":…,"columns":["a"],"rows":[[…]]}`.

**4. No other snapped answer reads the clock in an unstable way.**
- Snapped dates in 2026 and 2027 all come from the table data plus intervals. There is nothing dated 2026-09 or
  2026-10, which is when snaps were taken.
- Clock reads in the upstream corpus (external legend_engine_src parity-tests) and in lite/*.yaml:
  - The single-argument `AGE(tsz)` and `AGE(ts)` cases (datetime_functions.yaml:3, :17) are in the VOLATILE map
    (SqlParity.java:79-80).
  - `CURRENT_DATE - 365 days` and `NOW() - 10 years` (interval_arithmetic.yaml:124, :131) are in VOLATILE
    (SqlParity.java:75, :78).
  - Every other clock read is stable: `CLOCK_TIMESTAMP`, `NOW`, `STATEMENT_TIMESTAMP` and `TRANSACTION_TIMESTAMP`
    are compared with `'2020-01-01'` (lines 38, 255, 262, 290). The rest are `... IS NOT NULL` tests,
    `LENGTH(TIMEOFDAY()) > 0`, two-argument AGE against fixed dates, and `AGE(NULL)`.
- No lite case other than this one reads the clock.

**5. The yaml comment is true and fits.**
- Lines 85-86 are 109 and 110 columns, under 120.
- What it says is accurate: the red started at 2026-10-14 00:00 UTC, the day after the snap, and the refusal happens
  at translation.
- The style is consistent with the file apart from N1.

**6. The commit message's claims against the diff.**
- These are true:
  - UTC
  - "the same transaction's start, which is what Postgres reads 'today' as"
  - the answer is true
  - the two REFUSED stand
  - the VOLATILE map would have turned the case into a SKIP
- These are wrong: the snap commit hash (S1) and the IN_FLIGHT note (S2).
- I did not check the "both parity tests run fresh … pass after" claim, since no Bazel was run.

---

## Taken

- S1: the commit message cites d19b6067c.
- S2: the IN_FLIGHT note is in the same commit (the island line's section: the landing note and the compiler line's
  answer to the JoinChecker announcement); the runs are recorded in GATES afterwards, as every landing's are.
- N1: left as is; the comment is the case's own reason.
