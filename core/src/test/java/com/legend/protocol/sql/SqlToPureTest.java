// Copyright 2026 Legend Contributors
// SPDX-License-Identifier: Apache-2.0

package com.legend.protocol.sql;

import com.legend.protocol.PureComposer;
import com.legend.protocol.spec.ValueSpecification;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The translator ({@link SqlToPure}) on its own: the Pure each query becomes, printed as a person would write it,
 * Postgres's name and NULL rules, and each refusal's kind. The FROM source's columns come from a stand-in for the
 * typer, so no model is compiled here; {@code SqlIslandIntegrationTest} runs the same pipeline end to end.
 */
class SqlToPureTest {

    /** A source column, as the typer reports it. */
    private record Col(String name, String type, boolean nullable) {
    }

    /** The source table: ID Integer[1], firstName String[0..1], age Integer[0..1], dept String[1]. */
    private static final List<Col> COLUMNS = List.of(
            new Col("ID", "Integer", false),
            new Col("firstName", "String", true),
            new Col("age", "Integer", true),
            new Col("dept", "String", false));

    private static String pure(String sql) {
        return pure(sql, COLUMNS);
    }

    private static String pure(String sql, List<Col> columns) {
        ValueSpecification vs = SqlToPure.translate(sql, (source, column) -> columns.forEach(
                c -> column.column(c.name(), c.type(), c.nullable())));
        return PureComposer.valueSpecification(vs, PureComposer.Style.STANDARD);
    }

    private static SqlTranslationException refusal(String sql) {
        return assertThrows(SqlTranslationException.class, () -> pure(sql));
    }

    // ------------------------------------------------------------------ shapes

    @Test
    void aPlainQueryIsFilterExtendSortSelectLimit() {
        assertEquals("#>{s::DB.T}#->filter(r|($r.dept == 'eng') && ($r.ID > 2))"
                        + "->sort([~firstName->descending(meta::pure::functions::relation::NullOrder.FIRST)])"
                        + "->select(~[firstName, ID])->drop(1)->limit(5)",
                pure("select firstName, ID from tb('s::DB.T') where dept = 'eng' and ID > 2"
                        + " order by firstName desc limit 5 offset 1"));
    }

    @Test
    void starIsEveryColumnAndASchemaQualifiedTableKeepsItsSchema() {
        assertEquals("#>{s::DB.sch.T}#->select(~[ID, firstName, age, dept])", pure("select * from tb('s::DB.sch.T')"));
    }

    @Test
    void anAliasedColumnIsRenamedOnlyWhenItsNameIsTaken() {
        assertEquals("#>{s::DB.T}#->extend(~[who:r|$r.dept])->select(~[who])",
                pure("select dept as who from tb('s::DB.T')"));
        assertEquals("#>{s::DB.T}#->extend(~[_sql_1:r|$r.dept])->select(~[_sql_1])->rename(~_sql_1, ~ID)",
                pure("select dept as \"ID\" from tb('s::DB.T')"));
    }

    @Test
    void aGroupedQueryNamesItsAggregatesByTheirOutputs() {
        assertEquals("#>{s::DB.T}#->groupBy(~[dept], ~[n:r|1:y|$y->count(), sum:r|$r.age:y|$y->sum()])"
                        + "->filter(r|$r.n > 1)->select(~[dept, n, sum])",
                pure("select dept, count(*) as n, sum(age) from tb('s::DB.T') group by dept having count(*) > 1"));
    }

    @Test
    void anAggregateWithoutGroupByAggregatesTheWholeTable() {
        assertEquals("#>{s::DB.T}#->aggregate(~[count:r|$r.age:y|$y->distinct()->count()])->select(~[count])",
                pure("select count(distinct age) from tb('s::DB.T')"));
    }

    @Test
    void groupingByAnExpressionComputesItFirst() {
        assertEquals("#>{s::DB.T}#->extend(~[_sql_1:r|$r.dept->toUpper()])"
                        + "->groupBy(~[_sql_1], ~[count:r|1:y|$y->count()])"
                        + "->extend(~[d:r|$r._sql_1])->select(~[d, count])",
                pure("select upper(dept) as d, count(*) from tb('s::DB.T') group by upper(dept)"));
    }

    // ------------------------------------------------------------------ several relations

    @Test
    void aJoinRenamesTheRightSidesTakenNamesAndReadsEachSideByItsQualifier() {
        // both sides have every name: the right side's become b_<name>, and an output named like a taken column is
        // computed under a fresh name and renamed last
        assertEquals("#>{s::DB.T}#->join(#>{s::DB.T}#->rename(~ID, ~b_ID)->rename(~firstName, ~b_firstName)->rename(~age, ~b_age)->rename(~dept, ~b_dept), meta::pure::functions::relation::JoinKind.INNER,"
                        + " {a, b|$b.b_age->isNotEmpty() && ($a.ID == $b.b_age->toOne())})"
                        + "->extend(~[_sql_1:r|$r.b_dept])->select(~[ID, _sql_1])->rename(~_sql_1, ~dept)",
                pure("select a.ID, b.dept from tb('s::DB.T') a join tb('s::DB.T') b on a.ID = b.age"));
    }

    @Test
    void usingMergesTheSharedColumnAndAFullJoinCoalescesIt() {
        // the merged ID is whichever side has a row: COALESCE(a.ID, b.ID)
        assertEquals("#>{s::DB.T}#->join(#>{s::DB.T}#->rename(~ID, ~b_ID)->rename(~firstName, ~b_firstName)->rename(~age, ~b_age)->rename(~dept, ~b_dept), meta::pure::functions::relation::JoinKind.FULL,"
                        + " {a, b|$a.ID == $b.b_ID})->extend(~[_sql_1:r|$r.ID->coalesce($r.b_ID)])"
                        + "->extend(~[_sql_2:r|$r._sql_1])->select(~[_sql_2, dept])->rename(~_sql_2, ~ID)",
                pure("select ID, a.dept from tb('s::DB.T') a full join tb('s::DB.T') b using (ID)"));
    }

    @Test
    void unionIsConcatenateThenDistinctAndUnionAllKeepsDuplicates() {
        // the right side's columns take the left side's names, by position
        assertEquals("#>{s::DB.T}#->select(~[dept])->concatenate(#>{s::DB.T}#->select(~[firstName])"
                        + "->rename(~firstName, ~dept))->distinct()",
                pure("select dept from tb('s::DB.T') union select firstName from tb('s::DB.T')"));
        assertEquals("#>{s::DB.T}#->select(~[ID])->concatenate(#>{s::DB.T}#->select(~[age])->rename(~age, ~ID))"
                        + "->sort([~ID->ascending(meta::pure::functions::relation::NullOrder.LAST)])",
                pure("select ID from tb('s::DB.T') union all select age from tb('s::DB.T') order by 1"));
    }

    @Test
    void aCteIsItsQueryWhereverItIsNamed() {
        assertEquals("#>{s::DB.T}#->select(~[ID])->rename(~ID, ~n)->filter(r|$r.n > 1)->select(~[n])",
                pure("with x (n) as (select ID from tb('s::DB.T')) select n from x where n > 1"));
    }

    @Test
    void setOperationsCheckTheirColumnsAsPostgresDoes() {
        assertEquals("UNION types integer and string cannot be matched",
                refusal("select ID from tb('s::DB.T') union select dept from tb('s::DB.T')").getMessage());
        assertEquals("each UNION query must have the same number of columns",
                refusal("select ID from tb('s::DB.T') union select ID, dept from tb('s::DB.T')")
                .getMessage());
        assertEquals("INTERSECT ALL is not supported yet",
                refusal("select ID from tb('s::DB.T') intersect all select ID from tb('s::DB.T')")
                .getMessage());
    }

    @Test
    void intersectKeepsTheLeftRowsSomeRightRowEqualsOnce() {
        assertEquals("#>{s::DB.T}#->select(~[age])->filter(r|#>{s::DB.T}#->select(~[ID])->exists(s|$r.age == $s.ID))"
                + "->distinct()", pure("select age from tb('s::DB.T') intersect select ID from tb('s::DB.T')"));
        assertEquals("#>{s::DB.T}#->select(~[age])->filter(r|!#>{s::DB.T}#->select(~[ID])->exists(s|$r.age == $s.ID))"
                + "->distinct()", pure("select age from tb('s::DB.T') except select ID from tb('s::DB.T')"));
    }

    // ------------------------------------------------------------------ subqueries in expressions

    @Test
    void existsIsARowOrNoneAndReadsTheEnclosingRow() {
        // the subquery is one level down: its own row is r1, the enclosing query's r
        assertEquals("#>{s::DB.T}#->filter(r|#>{s::DB.T}#->filter(r1|$r1.age->isNotEmpty() && ($r1.age->toOne() =="
                        + " $r.ID))->extend(~['?column?':r1|1])->select(~['?column?'])->exists(s|true))->select(~[ID])",
                pure("select ID from tb('s::DB.T') t where exists (select 1 from tb('s::DB.T') u where u.age = t.ID)"));
    }

    @Test
    void inIsAnyAndKeepsPostgresNullsInBothCases() {
        // TRUE when some row equals; FALSE when every row is known and unequal; else NULL
        assertEquals("#>{s::DB.T}#->extend(~[v:r|if(#>{s::DB.T}#->select(~[age])->exists(s|$s.age->isNotEmpty()"
                        + " && ($r.ID == $s.age->toOne())), |true, |if(!#>{s::DB.T}#->select(~[age])->exists("
                        + "s|!($s.age->isNotEmpty() && ($r.ID != $s.age->toOne()))), |false, |[]))])->select(~[v])",
                pure("select ID in (select age from tb('s::DB.T')) as v from tb('s::DB.T')"));
        // NOT IN holds only when every row is known and unequal: one NULL row makes it NULL, never TRUE
        assertEquals("#>{s::DB.T}#->filter(r|!#>{s::DB.T}#->select(~[age])->exists(s|!($s.age->isNotEmpty()"
                        + " && ($r.ID != $s.age->toOne()))))->select(~[ID])",
                pure("select ID from tb('s::DB.T') where ID not in (select age from tb('s::DB.T'))"));
    }

    @Test
    void allIsTrueOverNoRowsAndFalseWhenSomeRowIsFalse() {
        assertEquals("#>{s::DB.T}#->filter(r|!#>{s::DB.T}#->select(~[age])->exists(s|!($s.age->isNotEmpty()"
                        + " && ($r.ID > $s.age->toOne()))))->select(~[ID])",
                pure("select ID from tb('s::DB.T') where ID > all (select age from tb('s::DB.T'))"));
    }

    @Test
    void aScalarSubqueryIsItsOneValueAndMayBeNull() {
        assertEquals("#>{s::DB.T}#->extend(~[m:r|#>{s::DB.T}#->filter(r1|$r1.dept == $r.dept)"
                        + "->aggregate(~[max:r1|$r1.age:y1|$y1->max()])->select(~[max])->map(s|$s.max)->toOne()])"
                        + "->select(~[m])",
                pure("select (select max(age) from tb('s::DB.T') u where u.dept = t.dept) as m from tb('s::DB.T') t"));
        assertEquals("subquery must return only one column",
                refusal("select (select ID, age from tb('s::DB.T')) from tb('s::DB.T')").getMessage());
        assertEquals("subquery has too many columns",
                refusal("select ID from tb('s::DB.T') where ID in (select ID, age from tb('s::DB.T'))").getMessage());
    }

    @Test
    void anAggregateOfOnlyTheEnclosingQuerysColumnsIsRefused() {
        assertEquals("an aggregate of only an enclosing query's columns is not supported yet",
                refusal("select (select max(t.age) from tb('s::DB.T') u) from tb('s::DB.T') t").getMessage());
    }

    // ------------------------------------------------------------------ windows

    @Test
    void aWindowCallIsAColumnExtendedOverItsWindowBeforeTheSelectList() {
        assertEquals("#>{s::DB.T}#->extend(over(~[dept], [~age->descending(meta::pure::functions::relation::NullOrder"
                        + ".FIRST)]), ~rn:{p, w, r|$p->rowNumber($r)})->select(~[ID, rn])",
                pure("select ID, row_number() over (partition by dept order by age desc) as rn from tb('s::DB.T')"));
    }

    @Test
    void aWindowAggregateMapsEachRowAndReducesTheFrame() {
        // rows(-1, 0): one preceding row to the current row
        assertEquals("#>{s::DB.T}#->extend(over([], [~ID->ascending(meta::pure::functions::relation::NullOrder.LAST)],"
                        + " -1->rows(0)), ~s:{p, w, r|$r.age}:y|$y->sum())->select(~[s])",
                pure("select sum(age) over (order by ID rows between 1 preceding and current row) as s"
                        + " from tb('s::DB.T')"));
    }

    @Test
    void overNothingIsOnePartitionOfEveryRow() {
        assertEquals("#>{s::DB.T}#->extend(over([]), ~n:{p, w, r|1}:y|$y->count())->select(~[n])",
                pure("select count(*) over () as n from tb('s::DB.T')"));
    }

    @Test
    void lagReadsTheOtherRowsColumnAndAnExpressionIsComputedFirst() {
        assertEquals("#>{s::DB.T}#->extend(~[_sql_1:r|if($r.age->isEmpty(), |[], |$r.age->toOne() * 2)])"
                        + "->extend(over([~ID->ascending(meta::pure::functions::relation::NullOrder.LAST)]),"
                        + " ~prev:{p, w, r|$p->lag($r, 2)._sql_1})->select(~[prev])",
                pure("select lag(age * 2, 2) over (order by ID) as prev from tb('s::DB.T')"));
    }

    @Test
    void windowsArePostgresErrorsOutsideTheSelectListAndOrderBy() {
        assertEquals("window functions are not allowed in WHERE",
                refusal("select ID from tb('s::DB.T') where rank() over (order by ID) > 1").getMessage());
        assertEquals("window function calls cannot be nested",
                refusal("select sum(rank() over (order by ID)) over () from tb('s::DB.T')").getMessage());
        assertEquals("window function rank requires an OVER clause",
                refusal("select rank() from tb('s::DB.T')").getMessage());
        assertEquals("EXCLUDE CURRENT ROW is not supported yet", refusal("select sum(age) over (order by ID rows"
                + " between unbounded preceding and unbounded following exclude current row) from tb('s::DB.T')")
                .getMessage());
    }

    // ------------------------------------------------------------------ Postgres's NULL rules

    @Test
    void arithmeticOnANullableColumnIsNullWhenTheColumnIs() {
        assertEquals("#>{s::DB.T}#->extend(~[next:r|if($r.age->isEmpty(), |[], |$r.age->toOne() + 1)])"
                + "->select(~[next])", pure("select age + 1 as next from tb('s::DB.T')"));
        assertEquals("#>{s::DB.T}#->extend(~[next:r|$r.ID + 1])->select(~[next])",
                pure("select ID + 1 as next from tb('s::DB.T')"));
    }

    @Test
    void notOfANullComparisonIsNotTrue() {
        // NOT (age > 1) holds only where age is known and not greater than 1 (Postgres: NOT NULL is NULL)
        assertEquals("#>{s::DB.T}#->filter(r|$r.age->isNotEmpty() && !($r.age->toOne() > 1))->select(~[ID])",
                pure("select ID from tb('s::DB.T') where not (age > 1)"));
        assertEquals("#>{s::DB.T}#->filter(r|!($r.ID > 1))->select(~[ID])",
                pure("select ID from tb('s::DB.T') where not (ID > 1)"));
    }

    @Test
    void aNullableConditionAsAValueIsTrueFalseOrNull() {
        assertEquals("#>{s::DB.T}#->extend(~[old:r|if($r.age->isNotEmpty() && ($r.age->toOne() > 30), |true,"
                        + " |if($r.age->isNotEmpty() && !($r.age->toOne() > 30), |false, |[]))])->select(~[old])",
                pure("select age > 30 as old from tb('s::DB.T')"));
    }

    @Test
    void powerIsPowOverIntegersAndFloats() {
        assertEquals("#>{s::DB.T}#->extend(~[p:r|$r.ID->pow(2)])->select(~[p])",
                pure("select ID ^ 2 as p from tb('s::DB.T')"));
        assertEquals("#>{s::DB.T}#->extend(~[p:r|if($r.age->isEmpty(), |[], |$r.age->toOne()->pow(2))])"
                + "->select(~[p])", pure("select age ^ 2 as p from tb('s::DB.T')"));
        // Postgres computes numeric ^ exactly; pow is a Float
        assertEquals("^ on numeric values (exact in Postgres) is not supported yet",
                refusal("select 2.5 ^ ID from tb('s::DB.T')").getMessage());
    }

    @Test
    void otherOperatorsAreRefusedByName() {
        SqlTranslationException regex = refusal("select ID from tb('s::DB.T') where dept ~ 'e'");
        assertEquals(SqlTranslationException.Kind.UNSUPPORTED, regex.kind());
        assertEquals("regular expression operators (~, ~*, !~, !~*) are not supported yet", regex.getMessage());
        assertEquals("the operator ->> is not supported yet",
                refusal("select dept ->> 'k' from tb('s::DB.T')").getMessage());
        assertEquals("a select list with no columns is not supported yet",
                refusal("select from tb('s::DB.T')").getMessage());
    }

    @Test
    void isDistinctFromIsPureEquality() {
        assertEquals("#>{s::DB.T}#->filter(r|$r.firstName != $r.dept)->select(~[ID])",
                pure("select ID from tb('s::DB.T') where firstName is distinct from dept"));
    }

    @Test
    void likeByThePatternsShape() {
        assertEquals("#>{s::DB.T}#->filter(r|$r.dept->startsWith('en'))->select(~[ID])",
                pure("select ID from tb('s::DB.T') where dept like 'en%'"));
        assertEquals("#>{s::DB.T}#->filter(r|$r.dept->contains('n_g'))->select(~[ID])",
                pure("select ID from tb('s::DB.T') where dept like '%n\\_g%'"));
        assertEquals("#>{s::DB.T}#->filter(r|$r.dept->matches('(?i)^e.g\\\\.$'))->select(~[ID])",
                pure("select ID from tb('s::DB.T') where dept ilike 'e_g.'"));
    }

    @Test
    void aStringComparedWithADateIsADate() {
        List<Col> dated = List.of(new Col("d", "StrictDate", false));
        assertEquals("#>{s::DB.T}#->filter(r|$r.d >= %2024-01-31)->select(~[d])",
                pure("select d from tb('s::DB.T') where d >= '2024-01-31'", dated));
        assertEquals(SqlTranslationException.Kind.UNSUPPORTED, assertThrows(SqlTranslationException.class,
                () -> pure("select d from tb('s::DB.T') where d >= 'January 8, 1999'", dated)).kind());
    }

    @Test
    void nullsSortLastAscendingAndFirstDescendingUnlessWritten() {
        String sorted = pure("select ID from tb('s::DB.T') order by age, dept desc, ID nulls first");
        assertTrue(sorted.contains("[~age->ascending(meta::pure::functions::relation::NullOrder.LAST),"
                + " ~dept->descending(meta::pure::functions::relation::NullOrder.FIRST),"
                + " ~ID->ascending(meta::pure::functions::relation::NullOrder.FIRST)]"), sorted);
    }

    // ------------------------------------------------------------------ names

    @Test
    void anUnquotedNameMatchesItsFoldingFirstThenIgnoringCase() {
        assertEquals("#>{s::DB.T}#->select(~[firstName])", pure("select FIRSTNAME from tb('s::DB.T')"));
        List<Col> both = List.of(new Col("name", "String", false),
                new Col("Name", "String", false), new Col("NAME", "String", false));
        // Postgres's own rule decides first: NAME folds to name, which exists
        assertEquals("#>{s::DB.T}#->select(~[name])", pure("select NAME from tb('s::DB.T')", both));
        // a quoted name matches exactly
        assertEquals("#>{s::DB.T}#->select(~[Name])", pure("select \"Name\" from tb('s::DB.T')", both));
    }

    @Test
    void severalNamesThatDifferOnlyInCaseAreAmbiguous() {
        List<Col> two = List.of(new Col("Name", "String", false),
                new Col("NAME", "String", false));
        SqlTranslationException e = assertThrows(SqlTranslationException.class,
                () -> pure("select name from tb('s::DB.T')", two));
        assertEquals(SqlTranslationException.Kind.INVALID, e.kind());
        assertEquals("column reference \"name\" is ambiguous: it matches \"Name\", \"NAME\"; quote the name to choose"
                + " one", e.getMessage());
    }

    @Test
    void aQuotedNameInTheWrongCaseGetsAHint() {
        assertEquals("column \"firstname\" does not exist; perhaps you meant \"firstName\"",
                refusal("select \"firstname\" from tb('s::DB.T')").getMessage());
    }

    // ------------------------------------------------------------------ refusals

    @Test
    void refusalsSayTheirKindAndWhere() {
        SqlTranslationException syntax = refusal("select ID from tb('s::DB.T') where");
        assertEquals(SqlTranslationException.Kind.SYNTAX, syntax.kind());
        assertEquals(1, syntax.line());
        assertEquals(35, syntax.column());
        assertEquals(SqlTranslationException.Kind.UNSUPPORTED,
                refusal("select ID from tb('s::DB.T') a, lateral (select 1) b").kind());
        assertEquals(SqlTranslationException.Kind.UNSUPPORTED, refusal("select age / 2 from tb('s::DB.T')").kind());
        SqlTranslationException grouped = refusal("select dept, age from tb('s::DB.T') group by dept");
        assertEquals(SqlTranslationException.Kind.INVALID, grouped.kind());
        assertEquals("column \"age\" must appear in the GROUP BY clause or be used in an aggregate function",
                grouped.getMessage());
        assertEquals("aggregate functions are not allowed in WHERE",
                refusal("select ID from tb('s::DB.T') where count(*) > 1").getMessage());
        assertEquals("column \"nope\" does not exist", refusal("select nope from tb('s::DB.T')").getMessage());
        assertEquals(SqlTranslationException.Kind.UNSUPPORTED,
                refusal("select ID from tb('s::DB.T') where age = null").kind());
    }
}
