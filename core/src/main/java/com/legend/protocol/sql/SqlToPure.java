// Copyright 2026 Legend Contributors
// SPDX-License-Identifier: Apache-2.0

package com.legend.protocol.sql;

import com.legend.protocol.spec.AppliedFunction;
import com.legend.protocol.spec.AppliedProperty;
import com.legend.protocol.spec.CBoolean;
import com.legend.protocol.spec.CDate;
import com.legend.protocol.spec.CDecimal;
import com.legend.protocol.spec.CInteger;
import com.legend.protocol.spec.CString;
import com.legend.protocol.spec.ColSpec;
import com.legend.protocol.spec.ColSpecArray;
import com.legend.protocol.spec.EnumValue;
import com.legend.protocol.spec.LambdaFunction;
import com.legend.protocol.spec.PureCollection;
import com.legend.protocol.spec.ValueSpecification;
import com.legend.protocol.spec.Variable;
import com.legend.values.PureDateLiteral;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * A Postgres query ({@link SqlParser}'s tree) to a Pure Relation expression: the {@code #SQL{...}#} island's meaning
 * (docs/LEGEND_SQL_STUDY_2026_10_11.md §3). It builds the protocol tree a person would write in Pure, before name
 * resolution, as the parser does; the compiler resolves and types it like any query. It never types anything itself:
 * what a FROM source's columns are, it asks the caller ({@link Sources}), and the compiler types the whole result once.
 *
 * <p>Postgres is the spec. Where a Postgres construct has a Pure spelling with the same meaning, it is translated;
 * where it has none yet, it is refused by name and position, never approximated (AGENTS.md invariant 4). The refusals
 * that are Postgres's own ("column must appear in the GROUP BY clause") carry Postgres's wording.
 *
 * <p><b>Names</b> (the study's D1, 2026-10-11): a quoted identifier matches exactly; an unquoted one matches the name
 * equal to its Postgres folding (lowercase) when there is one, else the one name equal to it ignoring case; two such
 * names are an ambiguity to quote. Every query Postgres accepts resolves as Postgres resolves it; a camelCase model
 * name resolves unquoted too. Output names keep the case they are written in.
 *
 * <p>Step 1 of the study's phase 1: one FROM source, {@code tb('pkg::Database.schema.table')}.
 */
public final class SqlToPure {

    /** What a FROM source's columns are: the caller types the source; the translator never types. */
    public interface Sources {
        /** Reports the columns of {@code source}, an unresolved relation expression, to {@code column}, in order. */
        void columns(ValueSpecification source, Column column);
    }

    /** One source column: its name as the model spells it, its Pure type's name ({@code Integer},
     *  {@code Decimal(10,2)}, {@code String}, {@code StrictDate}, an enumeration's path, ...), and whether it may hold
     *  no value (SQL's NULL; Pure's {@code [0..1]}). */
    @FunctionalInterface
    public interface Column {
        void column(String name, String type, boolean nullable);
    }

    /** The one table function this step reads: {@code tb('pkg::Database.schema.table')}, upstream's dynamic source. */
    private static final String TABLE_FUNCTION = "tb";

    private static final String ROW = "r";
    private static final String GROUP = "y";
    private static final String NULL_ORDER = "meta::pure::functions::relation::NullOrder";
    private static final String SYNTHETIC = "_sql_";

    private final Sources sources;
    private int fresh;

    private SqlToPure(Sources sources) {
        this.sources = sources;
    }

    /** The Pure relation expression {@code sql} means; {@link SqlTranslationException} when it has none (its kind
     *  says whether the text is not SQL, the translation is not built yet, or Postgres rejects the query too). */
    public static ValueSpecification translate(String sql, Sources sources) {
        SqlAst.Statement statement;
        try {
            statement = SqlParser.parse(sql);
        } catch (SqlSyntaxException e) {
            throw new SqlTranslationException(e.unsupported() ? SqlTranslationException.Kind.UNSUPPORTED
                    : SqlTranslationException.Kind.SYNTAX, e.reason(), e.line(), e.column());
        }
        return switch (statement) {
            case SqlAst.Select s -> new SqlToPure(sources).select(s);
        };
    }

    // ------------------------------------------------------------------ kinds

    /** What the translator knows of a value's type: enough to choose a Postgres meaning, nothing more. */
    enum Kind { INTEGER, FLOAT, DECIMAL, NUMBER, STRING, BOOLEAN, DATE, DATETIME, NULL, OTHER;

        boolean numeric() {
            return this == INTEGER || this == FLOAT || this == DECIMAL || this == NUMBER;
        }
    }

    private static Kind kindOf(String pureType) {
        int paren = pureType.indexOf('(');
        String base = paren < 0 ? pureType : pureType.substring(0, paren);
        return switch (base) {
            case "Integer" -> Kind.INTEGER;
            case "Float" -> Kind.FLOAT;
            case "Decimal" -> Kind.DECIMAL;
            case "Number" -> Kind.NUMBER;
            case "String" -> Kind.STRING;
            case "Boolean" -> Kind.BOOLEAN;
            case "StrictDate" -> Kind.DATE;
            case "DateTime" -> Kind.DATETIME;
            default -> Kind.OTHER;
        };
    }

    /** Postgres's numeric promotion for {@code + - *}: integer with integer stays integer; a float wins; else exact. */
    private static Kind arithmetic(Kind a, Kind b) {
        if (a == Kind.INTEGER && b == Kind.INTEGER) {
            return Kind.INTEGER;
        }
        if (a == Kind.FLOAT || b == Kind.FLOAT) {
            return Kind.FLOAT;
        }
        if (a == Kind.NUMBER || b == Kind.NUMBER) {
            return Kind.NUMBER;
        }
        return Kind.DECIMAL;
    }

    /**
     * A translated expression: its Pure spelling, what is known of its type, and whether it may be NULL. A BOOLEAN is
     * a CONDITION in Postgres's three-valued logic: {@code vs} holds exactly when it is TRUE and {@code whenFalse}
     * exactly when it is FALSE; when it is NULL, neither holds. Both are two-valued Pure ({@code Boolean[1]}), so
     * {@code NOT}, {@code AND} and {@code OR} keep Postgres's meaning (NOT NULL is NULL, not TRUE).
     */
    record Tx(ValueSpecification vs, Kind kind, boolean nullable,
            @com.legend.base.Nullable ValueSpecification whenFalse) {

        /** A value that is not a condition. */
        static Tx value(ValueSpecification vs, Kind kind, boolean nullable) {
            return new Tx(vs, kind, nullable, null);
        }

        /** A condition: when it is TRUE, when it is FALSE. */
        static Tx condition(ValueSpecification whenTrue, ValueSpecification whenFalse, boolean nullable) {
            return new Tx(whenTrue, Kind.BOOLEAN, nullable, whenFalse);
        }

        ValueSpecification falseWhen() {
            return java.util.Objects.requireNonNull(whenFalse, "a condition has its FALSE case");
        }
    }

    /** A column of the relation in hand. */
    private record Col(String name, Kind kind, boolean nullable) {
    }

    // ------------------------------------------------------------------ names

    /** Postgres's folding of an unquoted identifier: ASCII letters to lower case, nothing else. */
    private static String fold(String text) {
        char[] chars = text.toCharArray();
        for (int i = 0; i < chars.length; i++) {
            if (chars[i] >= 'A' && chars[i] <= 'Z') {
                chars[i] = (char) (chars[i] + ('a' - 'A'));
            }
        }
        return new String(chars);
    }

    /** THE identifier rule (class comment): the name of {@code names} that {@code id} means, or null for none. */
    private static @com.legend.base.Nullable String resolve(SqlAst.Ident id, Iterable<String> names, String what) {
        if (id.quoted()) {
            for (String n : names) {
                if (n.equals(id.text())) {
                    return n;
                }
            }
            return null;
        }
        String folded = fold(id.text());
        List<String> loose = new ArrayList<>();
        for (String n : names) {
            if (n.equals(folded)) {
                return n;
            }
            if (fold(n).equals(folded) && !loose.contains(n)) {
                loose.add(n);
            }
        }
        if (loose.size() > 1) {
            throw SqlTranslationException.invalid(what + " reference \"" + id.text() + "\" is ambiguous: it matches "
                    + String.join(", ", loose.stream().map(n -> "\"" + n + "\"").toList())
                    + "; quote the name to choose one", id.pos());
        }
        return loose.isEmpty() ? null : loose.get(0);
    }

    /** Postgres's hint for a quoted name that differs only in case from a real one. */
    private static String hint(SqlAst.Ident name, List<String> names) {
        if (name.quoted()) {
            for (String n : names) {
                if (fold(n).equals(fold(name.text()))) {
                    return "; perhaps you meant \"" + n + "\"";
                }
            }
        }
        return "";
    }

    // ------------------------------------------------------------------ scopes

    /** Where a column reference finds its column. */
    private interface Scope {
        Col column(SqlAst.ColumnRef ref);

        /** The column an expression IS in a grouped scope (a group key or an aggregate); null otherwise. */
        @com.legend.base.Nullable Col grouped(SqlAst.Expr e);

        /** The clause an aggregate would be refused in, or null where aggregates have been collected. */
        @com.legend.base.Nullable String noAggregatesIn();
    }

    /** The FROM source's columns, before any grouping. */
    private final class Input implements Scope {
        private final SqlAst.Ident qualifier;
        private final List<Col> columns;
        private final String clause;

        Input(SqlAst.Ident qualifier, List<Col> columns, String clause) {
            this.qualifier = qualifier;
            this.columns = columns;
            this.clause = clause;
        }

        Input in(String otherClause) {
            return new Input(qualifier, columns, otherClause);
        }

        List<String> names() {
            return columns.stream().map(Col::name).toList();
        }

        @Override
        public Col column(SqlAst.ColumnRef ref) {
            List<SqlAst.Ident> parts = ref.parts();
            if (parts.size() > 2) {
                throw SqlTranslationException.unsupported("schema-qualified column references are not supported yet",
                        ref.pos());
            }
            if (parts.size() == 2) {
                SqlAst.Ident q = parts.get(0);
                if (resolve(q, List.of(qualifier.text()), "table") == null) {
                    throw SqlTranslationException.invalid("missing FROM-clause entry for table \"" + q.text() + "\"",
                            q.pos());
                }
            }
            SqlAst.Ident name = parts.get(parts.size() - 1);
            String found = resolve(name, names(), "column");
            if (found == null && parts.size() == 1 && resolve(name, List.of(qualifier.text()), "table") != null) {
                // Postgres reads a FROM item's name as its whole row (row_to_json(persons))
                throw SqlTranslationException.unsupported("whole-row references (\"" + name.text() + "\" as a value)"
                        + " are not supported yet", name.pos());
            }
            if (found == null) {
                throw SqlTranslationException.invalid("column \"" + name.text() + "\" does not exist"
                        + hint(name, names()), name.pos());
            }
            for (Col c : columns) {
                if (c.name().equals(found)) {
                    return c;
                }
            }
            throw new IllegalStateException("resolved to a column not in the scope: " + found);
        }

        @Override
        public @com.legend.base.Nullable Col grouped(SqlAst.Expr e) {
            return null;
        }

        @Override
        public @com.legend.base.Nullable String noAggregatesIn() {
            return clause;
        }
    }

    /** The grouped relation's columns: the group keys and the aggregates, by the canonical form of what they are. */
    private final class Grouped implements Scope {
        private final Input input;
        private final Map<String, Col> byCanon;
        private final Map<String, Col> keyBySource;

        Grouped(Input input, Map<String, Col> byCanon, Map<String, Col> keyBySource) {
            this.input = input;
            this.byCanon = byCanon;
            this.keyBySource = keyBySource;
        }

        @Override
        public Col column(SqlAst.ColumnRef ref) {
            Col source = input.column(ref);
            Col key = keyBySource.get(source.name());
            if (key == null) {
                throw SqlTranslationException.invalid("column \"" + text(ref) + "\" must appear in the GROUP BY"
                        + " clause or be used in an aggregate function", ref.pos());
            }
            return key;
        }

        @Override
        public @com.legend.base.Nullable Col grouped(SqlAst.Expr e) {
            if (e instanceof SqlAst.ColumnRef) {
                return null;
            }
            return byCanon.get(canon(e, input));
        }

        @Override
        public @com.legend.base.Nullable String noAggregatesIn() {
            return null;
        }
    }

    private static String text(SqlAst.ColumnRef ref) {
        return String.join(".", ref.parts().stream().map(SqlAst.Ident::text).toList());
    }

    // ------------------------------------------------------------------ the query

    private ValueSpecification select(SqlAst.Select s) {
        SqlAst.FromItem from = s.from();
        if (from == null) {
            throw SqlTranslationException.unsupported("a query without FROM is not supported yet", s.pos());
        }
        if (s.items().isEmpty()) {
            throw SqlTranslationException.unsupported("a select list with no columns is not supported yet", s.pos());
        }
        ValueSpecification relation = source(from);
        List<Col> columns = new ArrayList<>();
        sources.columns(relation, (name, type, nullable) -> columns.add(new Col(name, kindOf(type), nullable)));
        SqlAst.Ident alias = from.alias();
        SqlAst.Ident qualifier = alias != null ? alias : last(from);
        Input input = new Input(qualifier, columns, "WHERE");

        SqlAst.Expr where = s.where();
        if (where != null) {
            relation = call("filter", relation, lambda(ROW, condition(where, input, "WHERE")));
        }
        boolean aggregate = !s.groupBy().isEmpty() || hasAggregate(s);
        return aggregate ? grouped(s, input.in("GROUP BY"), relation) : plain(s, input.in("the select list"), relation);
    }

    private static SqlAst.Ident last(SqlAst.FromItem from) {
        List<SqlAst.Ident> name = switch (from) {
            case SqlAst.TableName t -> t.name();
            case SqlAst.TableFunction f -> f.name();
        };
        return name.get(name.size() - 1);
    }

    /** {@code tb('pkg::Database.schema.table')}: the table as {@code #>{pkg::Database.schema.table}#}. */
    private ValueSpecification source(SqlAst.FromItem from) {
        return switch (from) {
            case SqlAst.TableName t -> throw SqlTranslationException.unsupported("a table name needs a source"
                    + " function for now: write " + TABLE_FUNCTION + "('pkg::Database.schema.table')", t.pos());
            case SqlAst.TableFunction f -> {
                if (f.name().size() != 1 || !TABLE_FUNCTION.equals(functionName(f.name().get(0)))) {
                    throw SqlTranslationException.unsupported("function \"" + f.name().get(f.name().size() - 1).text()
                            + "\" in FROM is not supported yet; the source function is " + TABLE_FUNCTION + "(...)",
                            f.pos());
                }
                if (f.args().size() != 1 || f.args().get(0).name() != null
                        || !(f.args().get(0).value() instanceof SqlAst.StringLit path)) {
                    throw SqlTranslationException.invalid(TABLE_FUNCTION + "(...) takes one string:"
                            + " " + TABLE_FUNCTION + "('pkg::Database.schema.table')", f.pos());
                }
                // the database's path holds no '.', so the first one ends it
                String p = path.value();
                int dot = p.indexOf('.');
                if (dot <= 0 || dot == p.length() - 1) {
                    throw SqlTranslationException.invalid("a table is named 'pkg::Database.schema.table' or"
                            + " 'pkg::Database.table', not '" + p + "'", path.pos());
                }
                yield AppliedFunction.tableReference(p.substring(0, dot), p.substring(dot + 1), null);
            }
        };
    }

    /** A query with no grouping: filter, computed columns, sort, the select list, then the slice. */
    private ValueSpecification plain(SqlAst.Select s, Input in, ValueSpecification relation) {
        SqlAst.Expr having = s.having();
        if (having != null) {
            throw SqlTranslationException.unsupported("HAVING without GROUP BY or an aggregate is not supported yet",
                    having.pos());
        }
        Set<String> present = new HashSet<>(in.names());
        List<Output> outputs = new ArrayList<>();
        Set<String> passed = new HashSet<>();
        for (SqlAst.SelectItem item : s.items()) {
            switch (item) {
                case SqlAst.AllColumns all -> {
                    SqlAst.Ident q = all.qualifier();
                    if (q != null && resolve(q, List.of(in.qualifier.text()), "table") == null) {
                        throw SqlTranslationException.invalid("missing FROM-clause entry for table \"" + q.text()
                                + "\"", q.pos());
                    }
                    for (Col c : in.columns) {
                        outputs.add(passthrough(c, c.name(), passed, present, in));
                    }
                }
                case SqlAst.SelectExpr x -> outputs.add(output(x, in, passed, present));
            }
        }
        return assemble(s, in, relation, present, outputs);
    }

    /** A query with GROUP BY or aggregates: keys and aggregates by groupBy (or aggregate), then HAVING, then as
     *  plain. */
    private ValueSpecification grouped(SqlAst.Select s, Input in, ValueSpecification relation) {
        // the group keys: a column is a key as itself; any other expression is computed first
        Map<String, Col> byCanon = new LinkedHashMap<>();
        Map<String, Col> keyBySource = new HashMap<>();
        List<ColSpec> keys = new ArrayList<>();
        List<ColSpec> computedKeys = new ArrayList<>();
        Set<String> names = new HashSet<>(in.names());
        for (SqlAst.Expr g : s.groupBy()) {
            SqlAst.Expr key = groupKey(g, s, in);
            noAggregate(key, "GROUP BY");
            String canon = canon(key, in);
            if (byCanon.containsKey(canon)) {
                continue;
            }
            Col col;
            if (key instanceof SqlAst.ColumnRef ref) {
                Col source = in.column(ref);
                col = source;
                keyBySource.put(source.name(), source);
            } else {
                Tx t = tx(key, in, ROW);
                col = new Col(fresh(names), t.kind(), t.nullable());
                computedKeys.add(new ColSpec(col.name(), lambda(ROW, valueOf(t)), null, null));
            }
            byCanon.put(canon, col);
            keys.add(new ColSpec(col.name(), null, null, null));
        }
        // the aggregates, wherever they are written
        List<ColSpec> aggregates = new ArrayList<>();
        List<SqlAst.Expr> scanned = new ArrayList<>();
        for (SqlAst.SelectItem item : s.items()) {
            if (item instanceof SqlAst.SelectExpr x) {
                scanned.add(x.expr());
            } else {
                throw SqlTranslationException.unsupported("\"*\" in a grouped query is not supported yet", item.pos());
            }
        }
        SqlAst.Expr having = s.having();
        if (having != null) {
            scanned.add(having);
        }
        for (SqlAst.SortItem o : s.orderBy()) {
            scanned.add(o.expr());
        }
        // an aggregate that IS a select item is computed under that item's name, so it needs no copy
        Map<String, String> preferred = new HashMap<>();
        for (SqlAst.SelectItem item : s.items()) {
            if (item instanceof SqlAst.SelectExpr x && x.expr() instanceof SqlAst.FunctionCall f && isAggregate(f)) {
                SqlAst.Ident alias = x.alias();
                preferred.putIfAbsent(canon(f, in), alias != null ? alias.text() : defaultName(f));
            }
        }
        for (SqlAst.Expr e : scanned) {
            collectAggregates(e, in, byCanon, aggregates, names, preferred);
        }
        if (!computedKeys.isEmpty()) {
            relation = call("extend", relation, new ColSpecArray(computedKeys));
        }
        if (keys.isEmpty()) {
            relation = call("aggregate", relation, new ColSpecArray(aggregates));
        } else if (aggregates.isEmpty()) {
            relation = call("distinct", call("select", relation, new ColSpecArray(keys)));
        } else {
            relation = call("groupBy", relation, new ColSpecArray(keys), new ColSpecArray(aggregates));
        }
        Grouped g = new Grouped(in, byCanon, keyBySource);
        if (having != null) {
            relation = call("filter", relation, lambda(ROW, condition(having, g, "HAVING")));
        }
        Set<String> present = new HashSet<>();
        for (Col c : byCanon.values()) {
            present.add(c.name());
        }
        List<Output> outputs = new ArrayList<>();
        Set<String> passed = new HashSet<>();
        for (SqlAst.SelectItem item : s.items()) {
            outputs.add(output((SqlAst.SelectExpr) item, g, passed, present));
        }
        return assemble(s, g, relation, present, outputs);
    }

    /** A GROUP BY item's expression: an ordinal names a select item; a bare name is an input column first, then an
     *  output name (Postgres's order). */
    private SqlAst.Expr groupKey(SqlAst.Expr g, SqlAst.Select s, Input in) {
        if (g instanceof SqlAst.IntegerLit n) {
            return selectExpr(s, n, "GROUP BY");
        }
        if (g instanceof SqlAst.ColumnRef ref && ref.parts().size() == 1
                && resolve(ref.parts().get(0), in.names(), "column") == null) {
            List<String> outputNames = new ArrayList<>();
            for (SqlAst.SelectItem item : s.items()) {
                if (item instanceof SqlAst.SelectExpr x && x.alias() != null) {
                    outputNames.add(java.util.Objects.requireNonNull(x.alias()).text());
                }
            }
            String found = resolve(ref.parts().get(0), outputNames, "column");
            if (found != null) {
                for (SqlAst.SelectItem item : s.items()) {
                    if (item instanceof SqlAst.SelectExpr x && x.alias() != null
                            && java.util.Objects.requireNonNull(x.alias()).text().equals(found)) {
                        return x.expr();
                    }
                }
            }
        }
        return g;
    }

    private static SqlAst.Expr selectExpr(SqlAst.Select s, SqlAst.IntegerLit n, String clause) {
        int i = n.value().intValue();
        if (n.value().signum() <= 0 || n.value().compareTo(java.math.BigInteger.valueOf(s.items().size())) > 0) {
            throw SqlTranslationException.invalid(clause + " position " + n.value() + " is not in select list",
                    n.pos());
        }
        SqlAst.SelectItem item = s.items().get(i - 1);
        if (item instanceof SqlAst.SelectExpr x) {
            return x.expr();
        }
        throw SqlTranslationException.unsupported(clause + " position " + i + " is \"*\", which is not supported"
                + " here yet", n.pos());
    }

    // ------------------------------------------------------------------ outputs and the tail

    /** An output column: the name the query shows, the column that holds it, and its value when it is computed. */
    private record Output(String name, String internal, @com.legend.base.Nullable ValueSpecification value,
            SqlAst.@com.legend.base.Nullable Expr expr) {
    }

    private Output output(SqlAst.SelectExpr x, Scope scope, Set<String> passed, Set<String> present) {
        SqlAst.Ident alias = x.alias();
        Col g = scope.grouped(x.expr());
        Col col = g != null ? g : x.expr() instanceof SqlAst.ColumnRef ref ? scope.column(ref) : null;
        if (col != null) {
            String name = alias != null ? alias.text()
                    : x.expr() instanceof SqlAst.ColumnRef ? col.name() : defaultName(x.expr());
            Output o = passthrough(col, name, passed, present, scope);
            return new Output(o.name(), o.internal(), o.value(), x.expr());
        }
        Tx t = tx(x.expr(), scope, ROW);
        String name = alias != null ? alias.text() : defaultName(x.expr());
        return new Output(name, internalFor(name, present), valueOf(t), x.expr());
    }

    /** A column shown as itself once; shown again, or under another name, it is a computed copy. */
    private Output passthrough(Col c, String name, Set<String> passed, Set<String> present, Scope scope) {
        if (name.equals(c.name()) && passed.add(c.name())) {
            return new Output(name, c.name(), null, null);
        }
        return new Output(name, internalFor(name, present), property(ROW, c.name()), null);
    }

    /** The column a computed output is built in: its own name when that is free, else a fresh one (renamed last). */
    private String internalFor(String name, Set<String> present) {
        if (!present.contains(name) && !name.startsWith(SYNTHETIC)) {
            present.add(name);
            return name;
        }
        return fresh(present);
    }

    private String fresh(Set<String> taken) {
        String name;
        do {
            name = SYNTHETIC + (++fresh);
        } while (taken.contains(name));
        taken.add(name);
        return name;
    }

    /** Postgres's name for an unnamed select item (its FigureColname): a column's name, a function's name,
     *  {@code case} for CASE, else {@code ?column?}. */
    private static String defaultName(SqlAst.Expr e) {
        return switch (e) {
            case SqlAst.ColumnRef ref -> ref.parts().get(ref.parts().size() - 1).text();
            case SqlAst.FunctionCall f -> functionName(f.name().get(f.name().size() - 1));
            case SqlAst.Case c -> "case";
            case SqlAst.Cast c -> defaultName(c.operand()).equals("?column?") ? c.type().name()
                    : defaultName(c.operand());
            default -> "?column?";
        };
    }

    /** The computed outputs, the sort, the select list, the renames and the slice, in Postgres's order. */
    private ValueSpecification assemble(SqlAst.Select s, Scope scope, ValueSpecification relation, Set<String> present,
            List<Output> outputs) {
        Set<String> shown = new HashSet<>();
        for (Output o : outputs) {
            if (!shown.add(o.name())) {
                throw SqlTranslationException.unsupported("the output column name \"" + o.name() + "\" appears twice;"
                        + " Pure relations need distinct column names, so give one an alias", s.pos());
            }
        }
        List<ColSpec> computed = new ArrayList<>();
        for (Output o : outputs) {
            ValueSpecification v = o.value();
            if (v != null) {
                computed.add(new ColSpec(o.internal(), lambda(ROW, v), null, null));
            }
        }
        // the sort keys: an ordinal or an output name means that output; anything else is computed for the sort
        List<ValueSpecification> sortInfos = new ArrayList<>();
        for (SqlAst.SortItem item : s.orderBy()) {
            String key = sortKey(item, s, scope, outputs, computed, present);
            boolean nullsFirst = item.nullsFirst() != null ? java.util.Objects.requireNonNull(item.nullsFirst())
                    : item.descending();
            sortInfos.add(call(item.descending() ? "descending" : "ascending", colSpec(key),
                    new EnumValue(NULL_ORDER, nullsFirst ? "FIRST" : "LAST")));
        }
        if (!computed.isEmpty()) {
            relation = call("extend", relation, new ColSpecArray(computed));
        }
        List<ColSpec> selection = new ArrayList<>();
        for (Output o : outputs) {
            selection.add(colSpec(o.internal()));
        }
        if (s.distinct()) {
            relation = call("distinct", call("select", relation, new ColSpecArray(selection)));
            if (!sortInfos.isEmpty()) {
                relation = call("sort", relation, new PureCollection(sortInfos));
            }
        } else {
            if (!sortInfos.isEmpty()) {
                relation = call("sort", relation, new PureCollection(sortInfos));
            }
            relation = call("select", relation, new ColSpecArray(selection));
        }
        for (Output o : outputs) {
            if (!o.internal().equals(o.name())) {
                relation = call("rename", relation, colSpec(o.internal()), colSpec(o.name()));
            }
        }
        SqlAst.Expr offset = s.offset();
        if (offset != null) {
            relation = call("drop", relation, count(offset, "OFFSET"));
        }
        SqlAst.Expr limit = s.limit();
        if (limit != null) {
            relation = call("limit", relation, count(limit, "LIMIT"));
        }
        return relation;
    }

    private String sortKey(SqlAst.SortItem item, SqlAst.Select s, Scope scope, List<Output> outputs,
            List<ColSpec> computed, Set<String> present) {
        SqlAst.Expr e = item.expr();
        if (e instanceof SqlAst.IntegerLit n) {
            selectExpr(s, n, "ORDER BY");
            return outputs.get(n.value().intValue() - 1).internal();
        }
        if (e instanceof SqlAst.ColumnRef ref && ref.parts().size() == 1) {
            String found = resolve(ref.parts().get(0), outputs.stream().map(Output::name).toList(), "column");
            if (found != null) {
                for (Output o : outputs) {
                    if (o.name().equals(found)) {
                        return o.internal();
                    }
                }
            }
        }
        if (s.distinct()) {
            Scope inputs = scope instanceof Grouped g ? g.input : scope;
            String canon = canon(e, inputScope(inputs));
            for (Output o : outputs) {
                SqlAst.Expr oe = o.expr();
                if (oe != null && canon(oe, inputScope(inputs)).equals(canon)) {
                    return o.internal();
                }
            }
            throw SqlTranslationException.invalid("for SELECT DISTINCT, ORDER BY expressions must appear in select"
                    + " list", e.pos());
        }
        Col g = scope.grouped(e);
        if (g != null) {
            return g.name();
        }
        if (e instanceof SqlAst.ColumnRef ref) {
            return scope.column(ref).name();
        }
        Tx t = tx(e, scope, ROW);
        String name = fresh(present);
        computed.add(new ColSpec(name, lambda(ROW, valueOf(t)), null, null));
        return name;
    }

    private static Input inputScope(Scope scope) {
        if (scope instanceof Input i) {
            return i;
        }
        throw new IllegalStateException("not an input scope");
    }

    /** An integer constant as the Pure parser spells one: a long when it fits, else the big integer. */
    private static CInteger integer(java.math.BigInteger value) {
        return value.bitLength() < Long.SIZE ? new CInteger(value.longValue()) : new CInteger(value);
    }

    private static CInteger count(SqlAst.Expr e, String clause) {
        if (e instanceof SqlAst.IntegerLit n && n.value().signum() >= 0) {
            return integer(n.value());
        }
        throw SqlTranslationException.unsupported(clause + " takes a non-negative integer constant here", e.pos());
    }

    // ------------------------------------------------------------------ aggregates

    private static final Set<String> AGGREGATES = Set.of("count", "sum", "avg", "min", "max");

    private static boolean isAggregate(SqlAst.FunctionCall f) {
        return f.name().size() == 1 && AGGREGATES.contains(functionName(f.name().get(0)));
    }

    private static boolean hasAggregate(SqlAst.Select s) {
        for (SqlAst.SelectItem item : s.items()) {
            if (item instanceof SqlAst.SelectExpr x && containsAggregate(x.expr())) {
                return true;
            }
        }
        SqlAst.Expr having = s.having();
        if (having != null && containsAggregate(having)) {
            return true;
        }
        for (SqlAst.SortItem o : s.orderBy()) {
            if (containsAggregate(o.expr())) {
                return true;
            }
        }
        return false;
    }

    private static boolean containsAggregate(SqlAst.Expr e) {
        if (e instanceof SqlAst.FunctionCall f && isAggregate(f)) {
            return true;
        }
        for (SqlAst.Expr child : children(e)) {
            if (containsAggregate(child)) {
                return true;
            }
        }
        return false;
    }

    private static void noAggregate(SqlAst.Expr e, String clause) {
        if (e instanceof SqlAst.FunctionCall f && isAggregate(f)) {
            throw SqlTranslationException.invalid("aggregate functions are not allowed in " + clause, e.pos());
        }
        for (SqlAst.Expr child : children(e)) {
            noAggregate(child, clause);
        }
    }

    /** Every aggregate call of {@code e}, once each: a column of the grouped relation with its map and reduce. */
    private void collectAggregates(SqlAst.Expr e, Input in, Map<String, Col> byCanon, List<ColSpec> aggregates,
            Set<String> names, Map<String, String> preferred) {
        if (e instanceof SqlAst.FunctionCall f && isAggregate(f)) {
            for (SqlAst.Expr arg : f.args()) {
                if (containsAggregate(arg)) {
                    throw SqlTranslationException.invalid("aggregate function calls cannot be nested", arg.pos());
                }
            }
            String canon = canon(f, in);
            if (byCanon.containsKey(canon)) {
                return;
            }
            String fn = functionName(f.name().get(0));
            Tx arg;
            if (f.star()) {
                if (!fn.equals("count")) {
                    throw SqlTranslationException.invalid(fn + "(*) is not a function; only count(*) is", f.pos());
                }
                arg = Tx.value(new CInteger(1L), Kind.INTEGER, false);
            } else {
                if (f.args().size() != 1) {
                    throw SqlTranslationException.invalid(fn + " takes one argument here", f.pos());
                }
                arg = tx(f.args().get(0), in, ROW);
            }
            if (f.distinct() && !fn.equals("count")) {
                throw SqlTranslationException.unsupported(fn + "(DISTINCT ...) is not supported yet", f.pos());
            }
            ValueSpecification group = new Variable(GROUP);
            if (f.distinct()) {
                group = call("distinct", group);
            }
            Kind kind;
            ValueSpecification reduce;
            switch (fn) {
                case "count" -> {
                    kind = Kind.INTEGER;
                    reduce = call("count", group);
                }
                case "sum" -> {
                    requireNumeric(arg, f);
                    kind = arg.kind() == Kind.DECIMAL ? Kind.NUMBER : arg.kind();
                    reduce = call("sum", group);
                }
                case "avg" -> {
                    requireNumeric(arg, f);
                    kind = Kind.FLOAT;
                    reduce = call("average", group);
                }
                case "min" -> {
                    kind = arg.kind();
                    reduce = call("min", group);
                }
                case "max" -> {
                    kind = arg.kind();
                    reduce = call("max", group);
                }
                default -> throw new IllegalStateException("not an aggregate: " + fn);
            }
            // count is never NULL; every other aggregate is NULL over no values (Postgres)
            String want = preferred.get(canon);
            String name = want != null && !names.contains(want) && !want.startsWith(SYNTHETIC) ? want : fresh(names);
            names.add(name);
            Col col = new Col(name, kind, !fn.equals("count"));
            byCanon.put(canon, col);
            aggregates.add(new ColSpec(col.name(), lambda(ROW, valueOf(arg)), lambda(GROUP, reduce), null));
            return;
        }
        for (SqlAst.Expr child : children(e)) {
            collectAggregates(child, in, byCanon, aggregates, names, preferred);
        }
    }

    private static void requireNumeric(Tx arg, SqlAst.FunctionCall f) {
        if (!arg.kind().numeric()) {
            throw SqlTranslationException.invalid("function " + functionName(f.name().get(0)) + "(" + arg.kind()
                    .name().toLowerCase(Locale.ROOT) + ") does not exist", f.pos());
        }
    }

    // ------------------------------------------------------------------ expressions

    /** A WHERE, HAVING or WHEN condition: the rows where it is TRUE (NULL and FALSE alike are not TRUE). */
    private ValueSpecification condition(SqlAst.Expr e, Scope scope, String clause) {
        return truth(tx(e, scope, ROW), clause, e.pos()).vs();
    }

    /** A boolean operand ({@code clause}'s). A NULL constant is Postgres's unknown truth value: neither true nor
     *  false. */
    private static Tx truth(Tx t, String clause, SqlAst.Pos pos) {
        if (t.kind() == Kind.NULL) {
            return Tx.condition(new CBoolean(false), new CBoolean(false), true);
        }
        if (t.kind() != Kind.BOOLEAN) {
            throw SqlTranslationException.invalid("argument of " + clause + " must be type boolean", pos);
        }
        return t;
    }

    /** A column's value; a boolean column is a condition (TRUE when it holds true, FALSE when it holds false). */
    private static Tx columnValue(String row, Col c) {
        ValueSpecification v = property(row, c.name());
        return c.kind() == Kind.BOOLEAN ? booleanValue(v, c.nullable()) : Tx.value(v, c.kind(), c.nullable());
    }

    /** A boolean VALUE (a column, a CASE, a coalesce) as a condition. A nullable one's tests say "known and true",
     *  "known and false" outright: {@code $v == true} would be compared in SQL, NULL for a NULL, where the test must
     *  be false (Postgres: NULL IS TRUE is false). */
    private static Tx booleanValue(ValueSpecification v, boolean nullable) {
        if (!nullable) {
            return Tx.condition(v, call("not", v), false);
        }
        ValueSpecification known = call("isNotEmpty", v);
        return Tx.condition(call("and", known, call("toOne", v)), call("and", known, call("not", call("toOne", v))),
                true);
    }

    /** An expression's Pure value: a condition becomes true, false, or (when neither holds) no value. */
    private static ValueSpecification valueOf(Tx t) {
        if (t.kind() != Kind.BOOLEAN || !t.nullable()) {
            return t.vs();
        }
        return call("if", t.vs(), thunk(new CBoolean(true)),
                thunk(call("if", t.falseWhen(), thunk(new CBoolean(false)), thunk(empty()))));
    }

    /** Postgres's strict functions and operators: NULL when any argument is NULL, else {@code build} of the values. */
    private static Tx strict(Kind kind, List<Tx> args, java.util.function.Function<List<ValueSpecification>,
            ValueSpecification> build) {
        List<ValueSpecification> values = new ArrayList<>();
        ValueSpecification anyNull = null;
        for (Tx a : args) {
            ValueSpecification v = valueOf(a);
            if (a.nullable()) {
                anyNull = anyNull == null ? call("isEmpty", v) : call("or", anyNull, call("isEmpty", v));
                values.add(call("toOne", v));
            } else {
                values.add(v);
            }
        }
        ValueSpecification result = build.apply(values);
        if (anyNull == null) {
            return Tx.value(result, kind, false);
        }
        return Tx.value(call("if", anyNull, thunk(empty()), thunk(result)), kind, true);
    }

    /** A strict predicate (a comparison, IN, BETWEEN, LIKE): NULL when an operand is NULL, else {@code test}. */
    private static Tx strictTest(List<Tx> operands, java.util.function.Function<List<ValueSpecification>,
            ValueSpecification> test) {
        List<ValueSpecification> values = new ArrayList<>();
        ValueSpecification known = null;
        for (Tx a : operands) {
            ValueSpecification v = valueOf(a);
            if (a.nullable()) {
                known = known == null ? call("isNotEmpty", v) : call("and", known, call("isNotEmpty", v));
                values.add(call("toOne", v));
            } else {
                values.add(v);
            }
        }
        ValueSpecification t = test.apply(values);
        if (known == null) {
            return Tx.condition(t, call("not", t), false);
        }
        return Tx.condition(call("and", known, t), call("and", known, call("not", t)), true);
    }

    private static Tx not(Tx t) {
        return Tx.condition(t.falseWhen(), t.vs(), t.nullable());
    }

    private Tx tx(SqlAst.Expr e, Scope scope, String row) {
        Col g = scope.grouped(e);
        if (g != null) {
            return columnValue(row, g);
        }
        return switch (e) {
            case SqlAst.ColumnRef ref -> columnValue(row, scope.column(ref));
            case SqlAst.IntegerLit n -> Tx.value(integer(n.value()), Kind.INTEGER, false);
            case SqlAst.NumericLit n -> Tx.value(new CDecimal(n.value()), Kind.DECIMAL, false);
            case SqlAst.StringLit str -> Tx.value(new CString(str.value()), Kind.STRING, false);
            case SqlAst.BooleanLit b -> booleanValue(new CBoolean(b.value()), false);
            case SqlAst.NullLit n -> Tx.value(empty(), Kind.NULL, true);
            case SqlAst.TypedLit lit -> typedLiteral(lit);
            case SqlAst.Param p -> throw SqlTranslationException.unsupported("parameters ($" + p.index() + ") are not"
                    + " supported yet", p.pos());
            case SqlAst.Unary u -> unary(u, scope, row);
            case SqlAst.Binary b -> binary(b, scope, row);
            case SqlAst.Operator o -> throw SqlTranslationException.unsupported((REGEX_OPERATORS.contains(o.operator())
                    ? "regular expression operators (~, ~*, !~, !~*) are" : "the operator " + o.operator() + " is")
                    + " not supported yet", o.pos());
            case SqlAst.IsNull n -> {
                ValueSpecification v = valueOf(tx(n.operand(), scope, row));
                Tx isNull = Tx.condition(call("isEmpty", v), call("isNotEmpty", v), false);
                yield n.negated() ? not(isNull) : isNull;
            }
            case SqlAst.IsTruth t -> isTruth(t, scope, row);
            case SqlAst.IsDistinct d -> isDistinct(d, scope, row);
            case SqlAst.InList in -> inList(in, scope, row);
            case SqlAst.Between b -> between(b, scope, row);
            case SqlAst.Like l -> like(l, scope, row);
            case SqlAst.Case c -> caseExpr(c, scope, row);
            case SqlAst.FunctionCall f -> function(f, scope, row);
            case SqlAst.Cast c -> throw SqlTranslationException.unsupported("casts are not supported yet", c.pos());
        };
    }

    private Tx unary(SqlAst.Unary u, Scope scope, String row) {
        Tx operand = tx(u.operand(), scope, row);
        return switch (u.op()) {
            case NOT -> not(truth(operand, "NOT", u.pos()));
            case MINUS -> {
                numericOperand(operand, u.operand());
                yield strict(operand.kind(), List.of(operand), v -> call("minus", v.get(0)));
            }
            case PLUS -> {
                numericOperand(operand, u.operand());
                yield operand;
            }
        };
    }

    private Tx binary(SqlAst.Binary b, Scope scope, String row) {
        switch (b.op()) {
            case AND, OR -> {
                Tx l = truth(tx(b.left(), scope, row), b.op().name(), b.pos());
                Tx r = truth(tx(b.right(), scope, row), b.op().name(), b.pos());
                boolean nullable = l.nullable() || r.nullable();
                // Kleene: AND is TRUE when both are, FALSE when either is; OR the other way round
                return b.op() == SqlAst.BinaryOp.AND
                        ? Tx.condition(call("and", l.vs(), r.vs()), call("or", l.falseWhen(), r.falseWhen()), nullable)
                        : Tx.condition(call("or", l.vs(), r.vs()), call("and", l.falseWhen(), r.falseWhen()), nullable);
            }
            case EQ, NE, LT, LE, GT, GE -> {
                List<Tx> sides = comparable(b.left(), b.right(), scope, row, b.pos());
                String fn = switch (b.op()) {
                    case EQ, NE -> "equal";
                    case LT -> "lessThan";
                    case LE -> "lessThanEqual";
                    case GT -> "greaterThan";
                    default -> "greaterThanEqual";
                };
                Tx test = strictTest(sides, v -> call(fn, v.get(0), v.get(1)));
                return b.op() == SqlAst.BinaryOp.NE ? not(test) : test;
            }
            case PLUS, MINUS, TIMES -> {
                Tx l = tx(b.left(), scope, row);
                Tx r = tx(b.right(), scope, row);
                numericOperand(l, b.left());
                numericOperand(r, b.right());
                String fn = b.op() == SqlAst.BinaryOp.PLUS ? "plus" : b.op() == SqlAst.BinaryOp.MINUS ? "minus"
                        : "times";
                return strict(arithmetic(l.kind(), r.kind()), List.of(l, r),
                        v -> AppliedFunction.infixRun(fn, List.of(v.get(0), v.get(1))));
            }
            case DIVIDE -> {
                Tx l = tx(b.left(), scope, row);
                Tx r = tx(b.right(), scope, row);
                numericOperand(l, b.left());
                numericOperand(r, b.right());
                if (l.kind() == Kind.INTEGER && r.kind() == Kind.INTEGER) {
                    throw SqlTranslationException.unsupported("integer division (which truncates in Postgres) is not"
                            + " supported yet; divide by a numeric (2.0) for an exact quotient", b.pos());
                }
                return strict(Kind.FLOAT, List.of(l, r), v -> call("divide", v.get(0), v.get(1)));
            }
            case POWER -> {
                Tx l = tx(b.left(), scope, row);
                Tx r = tx(b.right(), scope, row);
                numericOperand(l, b.left());
                numericOperand(r, b.right());
                // Postgres computes ^ in double precision but for a numeric operand, where it is exact; pow is a Float
                if (exactNumeric(l.kind()) || exactNumeric(r.kind())) {
                    throw SqlTranslationException.unsupported("^ on numeric values (exact in Postgres) is not supported"
                            + " yet", b.pos());
                }
                return strict(Kind.FLOAT, List.of(l, r), v -> call("pow", v.get(0), v.get(1)));
            }
            case MODULO -> {
                Tx l = tx(b.left(), scope, row);
                Tx r = tx(b.right(), scope, row);
                if (l.kind() != Kind.INTEGER || r.kind() != Kind.INTEGER) {
                    throw SqlTranslationException.unsupported("% is supported for integers only, so far", b.pos());
                }
                return strict(Kind.INTEGER, List.of(l, r), v -> call("rem", v.get(0), v.get(1)));
            }
            case CONCAT -> {
                // a || b || c is one strict concatenation of all its operands: NULL when any is
                List<Tx> operands = new ArrayList<>();
                for (SqlAst.Expr operand : concatenated(b)) {
                    Tx t = tx(operand, scope, row);
                    if (t.kind() != Kind.STRING) {
                        throw SqlTranslationException.unsupported("|| is supported for text values only, so far",
                                operand.pos());
                    }
                    operands.add(t);
                }
                return strict(Kind.STRING, operands, v -> AppliedFunction.infixRun("plus", v));
            }
        }
        throw new IllegalStateException("unreachable: " + b.op());
    }

    private static boolean exactNumeric(Kind kind) {
        return kind == Kind.DECIMAL || kind == Kind.NUMBER;
    }

    /** The operands of a run of {@code ||}, left to right. */
    private static List<SqlAst.Expr> concatenated(SqlAst.Expr e) {
        if (e instanceof SqlAst.Binary b && b.op() == SqlAst.BinaryOp.CONCAT) {
            List<SqlAst.Expr> all = new ArrayList<>(concatenated(b.left()));
            all.addAll(concatenated(b.right()));
            return all;
        }
        return List.of(e);
    }

    private static void numericOperand(Tx t, SqlAst.Expr e) {
        if (t.kind() == Kind.NULL) {
            throw SqlTranslationException.unsupported("arithmetic with a NULL constant is always NULL in Postgres; it"
                    + " is not supported here", e.pos());
        }
        // Postgres has these operators (an untyped constant takes the other operand's type; date - date, jsonb - key)
        if (e instanceof SqlAst.StringLit) {
            throw SqlTranslationException.unsupported("an untyped string constant in arithmetic is not supported yet",
                    e.pos());
        }
        if (isDate(t.kind())) {
            throw SqlTranslationException.unsupported("date and timestamp arithmetic is not supported yet", e.pos());
        }
        if (t.kind() == Kind.OTHER) {
            throw SqlTranslationException.unsupported("arithmetic on values of this type is not supported yet",
                    e.pos());
        }
        if (!t.kind().numeric()) {
            throw SqlTranslationException.invalid("arithmetic needs numbers; this operand is not numeric", e.pos());
        }
    }

    /** The two sides of a comparison: a string constant compared with a date takes the date's type (Postgres reads
     *  an untyped constant by its context), in ISO 8601 spelling. */
    private List<Tx> comparable(SqlAst.Expr left, SqlAst.Expr right, Scope scope, String row, SqlAst.Pos pos) {
        if (left instanceof SqlAst.NullLit || right instanceof SqlAst.NullLit) {
            throw SqlTranslationException.unsupported("a comparison with a NULL constant is NULL in Postgres, never"
                    + " true; write IS NULL or IS NOT NULL", pos);
        }
        return comparableValues(left, right, scope, row, pos);
    }

    private List<Tx> comparableValues(SqlAst.Expr left, SqlAst.Expr right, Scope scope, String row, SqlAst.Pos pos) {
        Tx l = tx(left, scope, row);
        Tx r = tx(right, scope, row);
        if (left instanceof SqlAst.StringLit s && readsStrings(r.kind())) {
            l = fromString(s, r.kind());
        } else if (right instanceof SqlAst.StringLit s && readsStrings(l.kind())) {
            r = fromString(s, l.kind());
        }
        boolean ok = l.kind() == r.kind() || l.kind().numeric() && r.kind().numeric()
                || isDate(l.kind()) && isDate(r.kind()) || l.kind() == Kind.OTHER || r.kind() == Kind.OTHER;
        if (!ok) {
            throw SqlTranslationException.invalid("cannot compare " + l.kind().name().toLowerCase(Locale.ROOT)
                    + " with " + r.kind().name().toLowerCase(Locale.ROOT), pos);
        }
        return List.of(l, r);
    }

    private static boolean isDate(Kind k) {
        return k == Kind.DATE || k == Kind.DATETIME;
    }

    /** The kinds an untyped string constant compared with them is read as (Postgres: an "unknown" constant takes the
     *  other operand's type, read by that type's input rules). */
    private static boolean readsStrings(Kind k) {
        return isDate(k) || k == Kind.INTEGER || k == Kind.DECIMAL || k == Kind.FLOAT || k == Kind.BOOLEAN;
    }

    private static final Set<String> REGEX_OPERATORS = Set.of("~", "~*", "!~", "!~*");

    /** A string constant read as {@code kind}, by Postgres's input rules: dates and timestamps in ISO 8601, integers
     *  and decimals in their plain spellings (others, which Postgres may read too, are refused), booleans as
     *  Postgres's boolin reads them (any unambiguous prefix of true/false/yes/no, on/off, 1/0; nothing else). */
    private static Tx fromString(SqlAst.StringLit s, Kind kind) {
        String v = s.value();
        switch (kind) {
            case DATE, DATETIME -> {
                return dateFromString(s, kind);
            }
            case INTEGER -> {
                String n = plainNumber(v.strip(), false);
                if (n != null && new java.math.BigInteger(n).bitLength() < 64) {
                    return Tx.value(integer(new java.math.BigInteger(n)), Kind.INTEGER, false);
                }
            }
            case DECIMAL, FLOAT -> {
                String n = plainNumber(v.strip(), true);
                if (n != null) {
                    return Tx.value(new CDecimal(new BigDecimal(n)), Kind.DECIMAL, false);
                }
            }
            case BOOLEAN -> {
                Boolean b = postgresBoolean(v.strip().toLowerCase(Locale.ROOT));
                if (b == null) {
                    throw SqlTranslationException.invalid("invalid input syntax for type boolean: \"" + v + "\"",
                            s.pos());
                }
                return booleanValue(new CBoolean(b), false);
            }
            default -> {
            }
        }
        throw SqlTranslationException.unsupported("the string '" + v + "' read as " + kind.name()
                .toLowerCase(Locale.ROOT) + " is not supported yet", s.pos());
    }

    /** {@code v} when it is a plain number: an optional sign and digits, and (when {@code decimal}) an optional point
     *  with digits on at least one side and an optional exponent; without its {@code +}. Null otherwise. */
    private static @com.legend.base.Nullable String plainNumber(String v, boolean decimal) {
        int i = v.startsWith("+") || v.startsWith("-") ? 1 : 0;
        int digits = 0;
        while (i < v.length() && Character.isDigit(v.charAt(i)) && v.charAt(i) < 0x80) {
            i++;
            digits++;
        }
        if (decimal && i < v.length() && v.charAt(i) == '.') {
            i++;
            while (i < v.length() && Character.isDigit(v.charAt(i)) && v.charAt(i) < 0x80) {
                i++;
                digits++;
            }
        }
        if (digits == 0) {
            return null;
        }
        if (decimal && i < v.length() && (v.charAt(i) == 'e' || v.charAt(i) == 'E')) {
            int e = i + 1 < v.length() && (v.charAt(i + 1) == '+' || v.charAt(i + 1) == '-') ? i + 2 : i + 1;
            int start = e;
            while (e < v.length() && Character.isDigit(v.charAt(e)) && v.charAt(e) < 0x80) {
                e++;
            }
            if (e == start) {
                return null;
            }
            i = e;
        }
        if (i != v.length()) {
            return null;
        }
        return v.startsWith("+") ? v.substring(1) : v;
    }

    /** Postgres's parse_bool_with_len: true, false, or null for a spelling it refuses. */
    private static @com.legend.base.Nullable Boolean postgresBoolean(String v) {
        if (v.isEmpty()) {
            return null;
        }
        if ("true".startsWith(v) || "yes".startsWith(v) || v.equals("on") || v.equals("1")) {
            return Boolean.TRUE;
        }
        if ("false".startsWith(v) || "no".startsWith(v) || v.length() >= 2 && "off".startsWith(v)
                || v.equals("0")) {
            return Boolean.FALSE;
        }
        return null;
    }

    /** {@code x IS [NOT] TRUE | FALSE | UNKNOWN}: never NULL; UNKNOWN is a NULL condition (neither case holds). */
    private Tx isTruth(SqlAst.IsTruth t, Scope scope, String row) {
        Tx operand = truth(tx(t.operand(), scope, row), "IS " + t.truth(), t.pos());
        ValueSpecification holds = switch (t.truth()) {
            case TRUE -> operand.vs();
            case FALSE -> operand.falseWhen();
            case UNKNOWN -> call("and", call("not", operand.vs()), call("not", operand.falseWhen()));
        };
        Tx test = Tx.condition(holds, call("not", holds), false);
        return t.negated() ? not(test) : test;
    }

    /** {@code x IS [NOT] DISTINCT FROM y}: equality in which two NULLs are equal (Pure's {@code ==}); never NULL. */
    private Tx isDistinct(SqlAst.IsDistinct d, Scope scope, String row) {
        ValueSpecification same;
        if (d.left() instanceof SqlAst.NullLit || d.right() instanceof SqlAst.NullLit) {
            SqlAst.Expr other = d.left() instanceof SqlAst.NullLit ? d.right() : d.left();
            same = call("isEmpty", valueOf(tx(other, scope, row)));
        } else {
            List<Tx> sides = comparableValues(d.left(), d.right(), scope, row, d.pos());
            same = call("equal", valueOf(sides.get(0)), valueOf(sides.get(1)));
        }
        Tx notDistinct = Tx.condition(same, call("not", same), false);
        return d.negated() ? notDistinct : not(notDistinct);
    }

    private Tx inList(SqlAst.InList in, Scope scope, String row) {
        List<Tx> operands = new ArrayList<>();
        operands.add(tx(in.operand(), scope, row));
        for (SqlAst.Expr v : in.values()) {
            if (v instanceof SqlAst.NullLit) {
                throw SqlTranslationException.unsupported("NULL in an IN list is not supported yet (Postgres makes"
                        + " the result NULL rather than false)", v.pos());
            }
            operands.add(comparable(in.operand(), v, scope, row, v.pos()).get(1));
        }
        Tx test = strictTest(operands, v -> call("in", v.get(0), new PureCollection(v.subList(1, v.size()))));
        return in.negated() ? not(test) : test;
    }

    private Tx between(SqlAst.Between b, Scope scope, String row) {
        List<Tx> low = comparable(b.operand(), b.low(), scope, row, b.pos());
        List<Tx> high = comparable(b.operand(), b.high(), scope, row, b.pos());
        Tx test = strictTest(List.of(low.get(0), low.get(1), high.get(1)),
                v -> call("and", call("greaterThanEqual", v.get(0), v.get(1)),
                        call("lessThanEqual", v.get(0), v.get(2))));
        return b.negated() ? not(test) : test;
    }

    /** {@code LIKE} by the shape of its constant pattern: no wildcard is equality; a trailing, leading or enclosing
     *  {@code %} alone is startsWith, endsWith or contains; anything else is the equivalent regular expression. */
    private Tx like(SqlAst.Like l, Scope scope, String row) {
        Tx operand = tx(l.operand(), scope, row);
        if (operand.kind() != Kind.STRING) {
            throw SqlTranslationException.invalid("LIKE needs a text value", l.operand().pos());
        }
        if (!(l.pattern() instanceof SqlAst.StringLit pattern)) {
            throw SqlTranslationException.unsupported("LIKE with a pattern that is not a constant is not supported"
                    + " yet", l.pattern().pos());
        }
        char escape = '\\';
        SqlAst.Expr esc = l.escape();
        if (esc != null) {
            if (!(esc instanceof SqlAst.StringLit e) || e.value().length() > 1) {
                throw SqlTranslationException.invalid("invalid escape string: it must be empty or one character",
                        esc.pos());
            }
            escape = e.value().isEmpty() ? 0 : e.value().charAt(0);
        }
        // the pattern as literal runs between wildcards: run, wildcard, run, ..., run
        List<String> parts = new ArrayList<>();
        StringBuilder run = new StringBuilder();
        String p = pattern.value();
        for (int i = 0; i < p.length(); i++) {
            char c = p.charAt(i);
            if (escape != 0 && c == escape) {
                if (i + 1 >= p.length()) {
                    throw SqlTranslationException.invalid("LIKE pattern must not end with escape character",
                            pattern.pos());
                }
                run.append(p.charAt(++i));
            } else if (c == '%' || c == '_') {
                parts.add(run.toString());
                parts.add(String.valueOf(c));
                run.setLength(0);
            } else {
                run.append(c);
            }
        }
        parts.add(run.toString());
        List<String> wild = new ArrayList<>();
        for (int i = 1; i < parts.size(); i += 2) {
            wild.add(parts.get(i));
        }
        boolean ci = l.caseInsensitive();
        boolean onlyPercent = !wild.contains("_");
        java.util.function.Function<List<ValueSpecification>, ValueSpecification> test;
        if (wild.isEmpty()) {
            test = v -> textTest("equal", v.get(0), parts.get(0), ci);
        } else if (onlyPercent && wild.size() == 1 && parts.get(2).isEmpty() && !parts.get(0).isEmpty()) {
            test = v -> textTest("startsWith", v.get(0), parts.get(0), ci);
        } else if (onlyPercent && wild.size() == 1 && parts.get(0).isEmpty() && !parts.get(2).isEmpty()) {
            test = v -> textTest("endsWith", v.get(0), parts.get(2), ci);
        } else if (onlyPercent && wild.size() == 2 && parts.get(0).isEmpty() && parts.get(4).isEmpty()
                && !parts.get(2).isEmpty()) {
            test = v -> textTest("contains", v.get(0), parts.get(2), ci);
        } else {
            StringBuilder regex = new StringBuilder(ci ? "(?i)^" : "^");
            for (int i = 0; i < parts.size(); i++) {
                String part = parts.get(i);
                if (i % 2 == 1) {
                    regex.append(part.equals("%") ? ".*" : ".");
                } else {
                    for (int k = 0; k < part.length(); k++) {
                        char c = part.charAt(k);
                        if ("\\.[]{}()*+?^$|".indexOf(c) >= 0) {
                            regex.append('\\');
                        }
                        regex.append(c);
                    }
                }
            }
            regex.append('$');
            String re = regex.toString();
            test = v -> call("matches", v.get(0), new CString(re));
        }
        Tx result = strictTest(List.of(operand), test);
        return l.negated() ? not(result) : result;
    }

    private static ValueSpecification textTest(String fn, ValueSpecification value, String text,
            boolean caseInsensitive) {
        return caseInsensitive ? call(fn, call("toLower", value), call("toLower", new CString(text)))
                : call(fn, value, new CString(text));
    }

    /** {@code CASE}: the first WHEN that is TRUE gives the result (a NULL WHEN is not TRUE); no ELSE is NULL. */
    private Tx caseExpr(SqlAst.Case c, Scope scope, String row) {
        SqlAst.Expr otherwise = c.otherwise();
        Tx last = otherwise == null ? Tx.value(empty(), Kind.NULL, true) : tx(otherwise, scope, row);
        Kind kind = last.kind();
        boolean nullable = last.nullable();
        ValueSpecification vs = valueOf(last);
        List<SqlAst.When> whens = c.whens();
        for (int i = whens.size() - 1; i >= 0; i--) {
            SqlAst.When w = whens.get(i);
            ValueSpecification test;
            SqlAst.Expr operand = c.operand();
            if (operand != null) {
                List<Tx> sides = comparable(operand, w.condition(), scope, row, w.condition().pos());
                test = strictTest(sides, v -> call("equal", v.get(0), v.get(1))).vs();
            } else {
                test = condition(w.condition(), scope, "CASE/WHEN");
            }
            Tx then = tx(w.result(), scope, row);
            kind = kind == Kind.NULL ? then.kind() : kind;
            nullable |= then.nullable();
            vs = call("if", test, thunk(valueOf(then)), thunk(vs));
        }
        return kind == Kind.BOOLEAN ? booleanValue(vs, nullable) : Tx.value(vs, kind, nullable);
    }

    private Tx function(SqlAst.FunctionCall f, Scope scope, String row) {
        if (isAggregate(f)) {
            String clause = scope.noAggregatesIn();
            throw SqlTranslationException.invalid(clause != null ? "aggregate functions are not allowed in " + clause
                    : "aggregate function calls cannot be nested", f.pos());
        }
        if (f.name().size() != 1) {
            throw SqlTranslationException.unsupported("schema-qualified function names are not supported yet",
                    f.pos());
        }
        String fn = functionName(f.name().get(0));
        if (f.distinct() || f.star()) {
            throw SqlTranslationException.invalid(fn + " is not an aggregate", f.pos());
        }
        List<Tx> args = new ArrayList<>();
        for (SqlAst.Expr a : f.args()) {
            args.add(tx(a, scope, row));
        }
        return switch (fn) {
            case "upper" -> text1(f, args, "toUpper", Kind.STRING);
            case "lower" -> text1(f, args, "toLower", Kind.STRING);
            case "length", "char_length", "character_length" -> text1(f, args, "length", Kind.INTEGER);
            case "trim", "btrim" -> {
                if (args.size() == 2) {
                    throw SqlTranslationException.unsupported(fn + " with the characters to trim is not supported yet",
                            f.pos());
                }
                yield text1(f, args, "trim", Kind.STRING);
            }
            case "abs" -> numeric1(f, args, "abs");
            case "ceil", "ceiling" -> numeric1(f, args, "ceiling");
            case "floor" -> numeric1(f, args, "floor");
            case "coalesce" -> coalesce(f, args);
            case "current_date" -> nullary(f, args, "today", Kind.DATE);
            case "current_timestamp", "now", "localtimestamp" -> nullary(f, args, "now", Kind.DATETIME);
            default -> throw SqlTranslationException.unsupported("function " + fn + "(...) is not supported yet",
                    f.pos());
        };
    }

    private static Tx text1(SqlAst.FunctionCall f, List<Tx> args, String pure, Kind result) {
        arity(f, args, 1);
        if (args.get(0).kind() == Kind.NULL) {
            throw SqlTranslationException.unsupported("a NULL constant argument makes " + functionName(f.name()
                    .get(0)) + "(...) NULL in Postgres; it is not supported here", f.pos());
        }
        if (args.get(0).kind() != Kind.STRING) {
            throw SqlTranslationException.invalid("function " + functionName(f.name().get(0)) + " needs a text"
                    + " value", f.pos());
        }
        return strict(result, args, v -> call(pure, v.get(0)));
    }

    private static Tx numeric1(SqlAst.FunctionCall f, List<Tx> args, String pure) {
        arity(f, args, 1);
        numericOperand(args.get(0), f.args().get(0));
        Kind result = pure.equals("abs") ? args.get(0).kind() : Kind.INTEGER;
        return strict(result, args, v -> call(pure, v.get(0)));
    }

    private static Tx nullary(SqlAst.FunctionCall f, List<Tx> args, String pure, Kind result) {
        arity(f, args, 0);
        return Tx.value(call(pure), result, false);
    }

    /** {@code coalesce(a, b, ...)}: the first value that is not NULL. Pure's takes two to four values, so a longer
     *  list nests from the right. */
    private static Tx coalesce(SqlAst.FunctionCall f, List<Tx> args) {
        if (args.size() < 2) {
            throw SqlTranslationException.unsupported("coalesce takes two or more arguments here", f.pos());
        }
        Kind kind = Kind.NULL;
        boolean nullable = true;
        for (Tx a : args) {
            if (kind == Kind.NULL) {
                kind = a.kind();
            }
            nullable &= a.nullable();
        }
        ValueSpecification tail = valueOf(args.get(args.size() - 1));
        int i = args.size() - 1;
        while (i > 0) {
            int take = Math.min(3, i);
            List<ValueSpecification> group = new ArrayList<>();
            for (int k = i - take; k < i; k++) {
                group.add(valueOf(args.get(k)));
            }
            group.add(tail);
            tail = call("coalesce", group);
            i -= take;
        }
        return kind == Kind.BOOLEAN ? booleanValue(tail, nullable) : Tx.value(tail, kind, nullable);
    }

    /** Refuses another number of arguments as not supported: Postgres may have that overload (btrim(x, chars)). */
    private static void arity(SqlAst.FunctionCall f, List<Tx> args, int n) {
        if (args.size() != n) {
            throw SqlTranslationException.unsupported("function " + functionName(f.name().get(0)) + " with "
                    + args.size() + " argument" + (args.size() == 1 ? "" : "s") + " is not supported yet; it takes "
                    + n + " here", f.pos());
        }
    }

    /** {@code DATE '...'} and {@code TIMESTAMP '...'} in ISO 8601 spelling: Pure date constants. */
    private static Tx typedLiteral(SqlAst.TypedLit lit) {
        return switch (lit.type().name()) {
            case "date" -> dateFromString(new SqlAst.StringLit(lit.value(), lit.pos()), Kind.DATE);
            case "timestamp", "timestamp without time zone" ->
                    dateFromString(new SqlAst.StringLit(lit.value(), lit.pos()), Kind.DATETIME);
            default -> throw SqlTranslationException.unsupported("constants of type " + lit.type().name() + " are not"
                    + " supported yet", lit.pos());
        };
    }

    /** A string constant read as a date ({@code yyyy-mm-dd}) or a timestamp ({@code yyyy-mm-dd hh:mm:ss[.f]}): the
     *  ISO 8601 spellings every database reads alike; Postgres's other date spellings are refused. */
    private static Tx dateFromString(SqlAst.StringLit s, Kind target) {
        String v = s.value();
        boolean date = v.length() == 10 && isoDate(v);
        boolean timestamp = v.length() >= 19 && isoDate(v.substring(0, 10)) && (v.charAt(10) == ' '
                || v.charAt(10) == 'T') && isoTime(v.substring(11));
        if (target == Kind.DATE && date) {
            validDate(v, s.pos());
            return Tx.value(new CDate(PureDateLiteral.parse(v), v, null), Kind.DATE, false);
        }
        if (target == Kind.DATETIME && (timestamp || date)) {
            // the Pure spelling of the same instant: yyyy-mm-ddThh:mm:ss[.f]
            String body = date ? v + "T00:00:00" : timestampBody(v, s.pos());
            return Tx.value(new CDate(PureDateLiteral.parse(body), body, null), Kind.DATETIME, false);
        }
        throw SqlTranslationException.unsupported("'" + v + "' is not an ISO 8601 " + (target == Kind.DATE ? "date"
                + " (yyyy-mm-dd)" : "timestamp (yyyy-mm-dd hh:mm:ss)") + "; other spellings are not supported",
                s.pos());
    }

    /** Refuses a date no calendar has, as Postgres does ({@code 2023-02-30}). */
    private static java.time.LocalDate validDate(String v, SqlAst.Pos pos) {
        try {
            return java.time.LocalDate.of(Integer.parseInt(v.substring(0, 4)), Integer.parseInt(v.substring(5, 7)),
                    Integer.parseInt(v.substring(8, 10)));
        } catch (java.time.DateTimeException e) {
            throw SqlTranslationException.invalid("date/time field value out of range: \"" + v + "\"", pos);
        }
    }

    /** An ISO timestamp's Pure spelling, read by Postgres's rules: {@code 24:00:00} is the next day's midnight, and
     *  a fraction finer than a microsecond is rounded to one (half to even, Postgres's rint), carrying as far as it
     *  must. */
    private static String timestampBody(String v, SqlAst.Pos pos) {
        java.time.LocalDate day = validDate(v.substring(0, 10), pos);
        int hour = Integer.parseInt(v.substring(11, 13));
        int minute = Integer.parseInt(v.substring(14, 16));
        int second = Integer.parseInt(v.substring(17, 19));
        String fraction = v.length() > 20 ? v.substring(20) : "";
        boolean zeroFraction = fraction.chars().allMatch(c -> c == '0');
        if (hour == 24 && minute == 0 && second == 0 && zeroFraction) {
            return day.plusDays(1) + "T00:00:00";
        }
        if (hour > 23 || minute > 59 || second > 59) {
            throw SqlTranslationException.invalid("date/time field value out of range: \"" + v + "\"", pos);
        }
        if (fraction.length() <= 6) {
            return v.substring(0, 10) + "T" + v.substring(11);
        }
        BigDecimal micros = new BigDecimal("0." + fraction).movePointRight(6).setScale(0,
                java.math.RoundingMode.HALF_EVEN);
        java.time.LocalDateTime t = day.atTime(hour, minute, second).plusNanos(micros.longValueExact() * 1000);
        String body = String.format(Locale.ROOT, "%sT%02d:%02d:%02d", t.toLocalDate(), t.getHour(), t.getMinute(),
                t.getSecond());
        return t.getNano() == 0 ? body : body + "." + String.format(Locale.ROOT, "%06d", t.getNano() / 1000);
    }

    private static boolean isoDate(String v) {
        return v.length() == 10 && digits(v, 0, 4) && v.charAt(4) == '-' && digits(v, 5, 7) && v.charAt(7) == '-'
                && digits(v, 8, 10);
    }

    private static boolean isoTime(String v) {
        if (v.length() < 8 || !digits(v, 0, 2) || v.charAt(2) != ':' || !digits(v, 3, 5) || v.charAt(5) != ':'
                || !digits(v, 6, 8)) {
            return false;
        }
        return v.length() == 8 || v.charAt(8) == '.' && v.length() > 9 && digits(v, 9, v.length());
    }

    private static boolean digits(String v, int from, int to) {
        for (int i = from; i < to; i++) {
            if (v.charAt(i) < '0' || v.charAt(i) > '9') {
                return false;
            }
        }
        return true;
    }

    // ------------------------------------------------------------------ canonical form

    /** An expression's structure, its column references resolved: two spellings of one expression ({@code name},
     *  {@code t.NAME}) have one canonical form. Postgres matches GROUP BY and select-list expressions this way. */
    private static String canon(SqlAst.Expr e, Input in) {
        return switch (e) {
            case SqlAst.ColumnRef ref -> "col(" + in.column(ref).name() + ")";
            case SqlAst.IntegerLit n -> "int(" + n.value() + ")";
            case SqlAst.NumericLit n -> "num(" + n.value().toPlainString() + ")";
            case SqlAst.StringLit s -> "str(" + s.value().length() + ":" + s.value() + ")";
            case SqlAst.BooleanLit b -> "bool(" + b.value() + ")";
            case SqlAst.NullLit n -> "null";
            case SqlAst.TypedLit t -> "typed(" + t.type().name() + ":" + t.value() + ")";
            case SqlAst.Param p -> "param(" + p.index() + ")";
            case SqlAst.Unary u -> u.op() + "(" + canon(u.operand(), in) + ")";
            case SqlAst.Binary b -> b.op() + "(" + canon(b.left(), in) + "," + canon(b.right(), in) + ")";
            case SqlAst.Operator o -> {
                SqlAst.Expr left = o.left();
                yield "op(" + o.operator() + "," + (left == null ? "" : canon(left, in)) + "," + canon(o.right(), in)
                        + ")";
            }
            case SqlAst.IsNull n -> "isnull" + n.negated() + "(" + canon(n.operand(), in) + ")";
            case SqlAst.IsTruth t -> "is" + t.negated() + t.truth() + "(" + canon(t.operand(), in) + ")";
            case SqlAst.IsDistinct d -> "distinct" + d.negated() + "(" + canon(d.left(), in) + ","
                    + canon(d.right(), in) + ")";
            case SqlAst.InList l -> "in" + l.negated() + "(" + canon(l.operand(), in) + list(l.values(), in) + ")";
            case SqlAst.Between b -> "between" + b.negated() + "(" + canon(b.operand(), in) + ","
                    + canon(b.low(), in) + "," + canon(b.high(), in) + ")";
            case SqlAst.Like l -> "like" + l.negated() + l.caseInsensitive() + "(" + canon(l.operand(), in) + ","
                    + canon(l.pattern(), in) + "," + (l.escape() == null ? "" : canon(
                            java.util.Objects.requireNonNull(l.escape()), in)) + ")";
            case SqlAst.Case c -> {
                StringBuilder b = new StringBuilder("case(");
                SqlAst.Expr operand = c.operand();
                b.append(operand == null ? "" : canon(operand, in));
                for (SqlAst.When w : c.whens()) {
                    b.append(",when(").append(canon(w.condition(), in)).append(",").append(canon(w.result(), in))
                            .append(")");
                }
                SqlAst.Expr otherwise = c.otherwise();
                b.append(",else(").append(otherwise == null ? "" : canon(otherwise, in)).append("))");
                yield b.toString();
            }
            case SqlAst.FunctionCall f -> "fn(" + String.join(".", f.name().stream()
                    .map(SqlToPure::functionName).toList()) + "," + f.distinct() + "," + f.star()
                    + list(f.args(), in) + ")";
            case SqlAst.Cast c -> "cast(" + c.type().name() + c.type().modifiers() + "," + canon(c.operand(), in)
                    + ")";
        };
    }

    private static String list(List<SqlAst.Expr> values, Input in) {
        StringBuilder b = new StringBuilder();
        for (SqlAst.Expr v : values) {
            b.append(',').append(canon(v, in));
        }
        return b.toString();
    }

    private static List<SqlAst.Expr> children(SqlAst.Expr e) {
        return switch (e) {
            case SqlAst.ColumnRef r -> List.of();
            case SqlAst.IntegerLit n -> List.of();
            case SqlAst.NumericLit n -> List.of();
            case SqlAst.StringLit s -> List.of();
            case SqlAst.BooleanLit b -> List.of();
            case SqlAst.NullLit n -> List.of();
            case SqlAst.TypedLit t -> List.of();
            case SqlAst.Param p -> List.of();
            case SqlAst.Unary u -> List.of(u.operand());
            case SqlAst.Binary b -> List.of(b.left(), b.right());
            case SqlAst.Operator o -> {
                SqlAst.Expr left = o.left();
                yield left == null ? List.of(o.right()) : List.of(left, o.right());
            }
            case SqlAst.IsNull n -> List.of(n.operand());
            case SqlAst.IsTruth t -> List.of(t.operand());
            case SqlAst.IsDistinct d -> List.of(d.left(), d.right());
            case SqlAst.InList l -> {
                List<SqlAst.Expr> all = new ArrayList<>();
                all.add(l.operand());
                all.addAll(l.values());
                yield all;
            }
            case SqlAst.Between b -> List.of(b.operand(), b.low(), b.high());
            case SqlAst.Like l -> {
                List<SqlAst.Expr> all = new ArrayList<>(List.of(l.operand(), l.pattern()));
                SqlAst.Expr esc = l.escape();
                if (esc != null) {
                    all.add(esc);
                }
                yield all;
            }
            case SqlAst.Case c -> {
                List<SqlAst.Expr> all = new ArrayList<>();
                SqlAst.Expr operand = c.operand();
                if (operand != null) {
                    all.add(operand);
                }
                for (SqlAst.When w : c.whens()) {
                    all.add(w.condition());
                    all.add(w.result());
                }
                SqlAst.Expr otherwise = c.otherwise();
                if (otherwise != null) {
                    all.add(otherwise);
                }
                yield all;
            }
            case SqlAst.FunctionCall f -> f.args();
            case SqlAst.Cast c -> List.of(c.operand());
        };
    }

    // ------------------------------------------------------------------ building Pure

    /** A function name as Postgres reads it: folded when unquoted, exact when quoted. */
    private static String functionName(SqlAst.Ident id) {
        return id.quoted() ? id.text() : fold(id.text());
    }

    private static AppliedFunction call(String fn, ValueSpecification... args) {
        return call(fn, List.of(args));
    }

    private static AppliedFunction call(String fn, List<ValueSpecification> args) {
        return new AppliedFunction(fn, args);
    }

    private static ValueSpecification property(String row, String column) {
        return new AppliedProperty(new Variable(row), column);
    }

    private static LambdaFunction lambda(String parameter, ValueSpecification body) {
        return new LambdaFunction(List.of(new Variable(parameter)), List.of(body));
    }

    private static LambdaFunction thunk(ValueSpecification body) {
        return new LambdaFunction(List.of(), List.of(body));
    }

    /** No value: Pure's {@code []}, SQL's NULL. */
    private static ValueSpecification empty() {
        return new PureCollection(List.of());
    }

    private static ColSpec colSpec(String name) {
        return new ColSpec(name, null, null, null);
    }
}
