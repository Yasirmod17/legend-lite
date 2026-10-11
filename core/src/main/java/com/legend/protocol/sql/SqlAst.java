// Copyright 2026 Legend Contributors
// SPDX-License-Identifier: Apache-2.0

package com.legend.protocol.sql;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.List;
import java.util.Objects;

/**
 * The syntax tree of a Postgres SQL statement: what was written, with where it was written. It is pure data and
 * decides no meaning: an identifier keeps the case it was written in and says whether it was quoted, so the reader
 * that resolves names (the translator to Pure, later the wire server) applies the folding rule, once.
 *
 * <p>Grammar-first: each node is shaped as Postgres's grammar has it, not as one consumer needs it. The tree grows
 * with the statements the parser accepts; a construct the parser does not accept is refused there, by name.
 */
public final class SqlAst {

    private SqlAst() {
    }

    /** A place in the SQL text: 1-based line and column. */
    public record Pos(int line, int column) {
    }

    /** An identifier as written: its text (an unquoted one keeps its written case) and whether it was double-quoted. */
    public record Ident(String text, boolean quoted, Pos pos) {
        public Ident {
            Objects.requireNonNull(text, "text");
            Objects.requireNonNull(pos, "pos");
        }
    }

    // ------------------------------------------------------------------ statements

    /** A statement. */
    public sealed interface Statement permits Select {
        Pos pos();
    }

    /** {@code SELECT [DISTINCT] items [FROM from] [WHERE] [GROUP BY] [HAVING] [ORDER BY] [LIMIT] [OFFSET]}. */
    public record Select(boolean distinct, List<SelectItem> items, @com.legend.base.Nullable FromItem from,
            @com.legend.base.Nullable Expr where, List<Expr> groupBy, @com.legend.base.Nullable Expr having,
            List<SortItem> orderBy, @com.legend.base.Nullable Expr limit, @com.legend.base.Nullable Expr offset,
            Pos pos) implements Statement {
        public Select {
            items = List.copyOf(items);
            groupBy = List.copyOf(groupBy);
            orderBy = List.copyOf(orderBy);
        }
    }

    /** One entry of a select list. */
    public sealed interface SelectItem permits AllColumns, SelectExpr {
        Pos pos();
    }

    /** {@code *} or {@code qualifier.*}. */
    public record AllColumns(@com.legend.base.Nullable Ident qualifier, Pos pos) implements SelectItem {
    }

    /** {@code expr [[AS] alias]}. */
    public record SelectExpr(Expr expr, @com.legend.base.Nullable Ident alias, Pos pos) implements SelectItem {
    }

    /** {@code expr [ASC | DESC] [NULLS FIRST | NULLS LAST]}; {@code nullsFirst} is null when not written. */
    public record SortItem(Expr expr, boolean descending, @com.legend.base.Nullable Boolean nullsFirst, Pos pos) {
    }

    // ------------------------------------------------------------------ FROM

    /** One item of a FROM clause. */
    public sealed interface FromItem permits TableName, TableFunction {
        Pos pos();

        @com.legend.base.Nullable Ident alias();
    }

    /** A table by (possibly qualified) name: {@code schema.table}. */
    public record TableName(List<Ident> name, @com.legend.base.Nullable Ident alias, Pos pos) implements FromItem {
        public TableName {
            name = List.copyOf(name);
        }
    }

    /** A function in FROM: {@code name(args) [[AS] alias]}. */
    public record TableFunction(List<Ident> name, List<Arg> args, @com.legend.base.Nullable Ident alias, Pos pos)
            implements FromItem {
        public TableFunction {
            name = List.copyOf(name);
            args = List.copyOf(args);
        }
    }

    /** A function argument, positional or named ({@code name => value}). */
    public record Arg(@com.legend.base.Nullable Ident name, Expr value) {
    }

    // ------------------------------------------------------------------ expressions

    /** A value expression. */
    public sealed interface Expr permits ColumnRef, IntegerLit, NumericLit, StringLit, BooleanLit, NullLit, TypedLit,
            Param, Unary, Binary, IsNull, IsTruth, IsDistinct, InList, Between, Like, Case, FunctionCall, Cast {
        Pos pos();
    }

    /** A column reference, possibly qualified: {@code col}, {@code t.col}. */
    public record ColumnRef(List<Ident> parts, Pos pos) implements Expr {
        public ColumnRef {
            parts = List.copyOf(parts);
        }
    }

    /** An integer constant: digits, no point, no exponent. */
    public record IntegerLit(BigInteger value, Pos pos) implements Expr {
    }

    /** A numeric constant: a point or an exponent ({@code numeric} in Postgres; exact). */
    public record NumericLit(BigDecimal value, Pos pos) implements Expr {
    }

    /** A string constant. */
    public record StringLit(String value, Pos pos) implements Expr {
    }

    /** {@code TRUE} or {@code FALSE}. */
    public record BooleanLit(boolean value, Pos pos) implements Expr {
    }

    /** {@code NULL}. */
    public record NullLit(Pos pos) implements Expr {
    }

    /** A constant of a named type: {@code type 'string'} ({@code DATE '2024-01-31'}). The type name is as written. */
    public record TypedLit(TypeName type, String value, Pos pos) implements Expr {
    }

    /** A positional parameter: {@code $1}. */
    public record Param(int index, Pos pos) implements Expr {
    }

    /** A prefix operator. */
    public enum UnaryOp { MINUS, PLUS, NOT }

    /** {@code -x}, {@code +x}, {@code NOT x}. */
    public record Unary(UnaryOp op, Expr operand, Pos pos) implements Expr {
    }

    /** A binary operator. */
    public enum BinaryOp { OR, AND, EQ, NE, LT, LE, GT, GE, PLUS, MINUS, TIMES, DIVIDE, MODULO, CONCAT }

    /** {@code left op right}. */
    public record Binary(BinaryOp op, Expr left, Expr right, Pos pos) implements Expr {
    }

    /** {@code x IS [NOT] NULL}. */
    public record IsNull(Expr operand, boolean negated, Pos pos) implements Expr {
    }

    /** A truth value {@code IS} tests for. */
    public enum Truth { TRUE, FALSE, UNKNOWN }

    /** {@code x IS [NOT] TRUE | FALSE | UNKNOWN}. */
    public record IsTruth(Expr operand, Truth truth, boolean negated, Pos pos) implements Expr {
    }

    /** {@code x IS [NOT] DISTINCT FROM y}. */
    public record IsDistinct(Expr left, Expr right, boolean negated, Pos pos) implements Expr {
    }

    /** {@code x [NOT] IN (v, ...)}. */
    public record InList(Expr operand, List<Expr> values, boolean negated, Pos pos) implements Expr {
        public InList {
            values = List.copyOf(values);
        }
    }

    /** {@code x [NOT] BETWEEN low AND high}. */
    public record Between(Expr operand, Expr low, Expr high, boolean negated, Pos pos) implements Expr {
    }

    /** {@code x [NOT] LIKE | ILIKE pattern [ESCAPE e]}. */
    public record Like(Expr operand, Expr pattern, @com.legend.base.Nullable Expr escape, boolean negated,
            boolean caseInsensitive, Pos pos) implements Expr {
    }

    /** {@code CASE [operand] WHEN ... THEN ... [ELSE ...] END}; a simple CASE has an operand. */
    public record Case(@com.legend.base.Nullable Expr operand, List<When> whens,
            @com.legend.base.Nullable Expr otherwise, Pos pos) implements Expr {
        public Case {
            whens = List.copyOf(whens);
        }
    }

    /** {@code WHEN condition THEN result}. */
    public record When(Expr condition, Expr result) {
    }

    /** {@code name([DISTINCT] args)} or {@code name(*)}. */
    public record FunctionCall(List<Ident> name, List<Expr> args, boolean distinct, boolean star, Pos pos)
            implements Expr {
        public FunctionCall {
            name = List.copyOf(name);
            args = List.copyOf(args);
        }
    }

    /** {@code CAST(x AS type)} or {@code x::type}. */
    public record Cast(Expr operand, TypeName type, Pos pos) implements Expr {
    }

    /** A type name as written, its words joined by single spaces ({@code double precision}), with its modifiers
     *  ({@code numeric(10,2)}). */
    public record TypeName(String name, List<Integer> modifiers, Pos pos) {
        public TypeName {
            modifiers = List.copyOf(modifiers);
        }
    }
}
