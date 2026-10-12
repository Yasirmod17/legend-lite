// Copyright 2026 Legend Contributors
// SPDX-License-Identifier: Apache-2.0

package com.legend.exec;

import com.legend.sql.SqlAgg;
import com.legend.sql.SqlExpr;
import com.legend.sql.SqlQuery;
import com.legend.sql.SqlSelect;
import com.legend.sql.SqlSource;
import com.legend.sql.SqlType;
import com.legend.sql.SqlUnion;
import com.legend.sql.TypeFact;

import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.LongAdder;

/**
 * THE PRIMITIVE CENSUS (docs/CLOUD_BACKENDS_PCT_2026_10_11.md §20, 2026-10-12): measurement only, under
 * {@code -Dlegend.diagnostics=primitives}. Every plan the executor sends is read for the MIR primitives a dialect must
 * spell -- each function, aggregate, window frame's shape, cast, literal kind, source and clause -- before any dialect
 * rewrites it, so the same query names the same primitives on every database; each primitive is tallied by whether its
 * statement succeeded. At the JVM's exit the tally is printed, one line a primitive:
 * {@code [primitives] ok=<n> fail=<m> <primitive>}. The coverage map joins a corpus run's tally with each database's
 * PCT run's: a primitive the corpus uses that no statement carried to success on a database is that database's gap.
 */
public final class PrimitiveCensus {

    private PrimitiveCensus() {}

    private static final boolean ON = com.legend.diagnostics.Diagnostics.on("primitives");

    private static final Map<String, LongAdder[]> TALLY = new ConcurrentHashMap<>();

    static {
        if (ON) {
            Runtime.getRuntime().addShutdownHook(new Thread(PrimitiveCensus::print, "primitive-census"));
        }
    }

    /** Tally {@code plan}'s primitives under its statement's outcome. */
    static void record(SqlQuery plan, boolean ok) {
        if (!ON) {
            return;
        }
        for (String key : primitives(plan)) {
            TALLY.computeIfAbsent(key, k -> new LongAdder[] {new LongAdder(), new LongAdder()})[ok ? 0 : 1].increment();
        }
    }

    /** The primitives {@code plan} names, each once. */
    static Set<String> primitives(SqlQuery plan) {
        Reader r = new Reader();
        r.rewrite(plan);
        return r.keys;
    }

    private static void print() {
        for (Map.Entry<String, LongAdder[]> e : new TreeMap<>(TALLY).entrySet()) {
            System.out.println("[primitives] ok=" + e.getValue()[0].sum() + " fail=" + e.getValue()[1].sum() + " "
                    + e.getKey());
        }
    }

    /** The one traversal (SqlRewriter's), every hook the identity: it reads, never rewrites. */
    private static final class Reader extends com.legend.sql.SqlRewriter {
        final Set<String> keys = new TreeSet<>();

        @Override
        protected SqlQuery select(SqlSelect s) {
            keys.add(s.projections().isEmpty() ? "select.star" : "select");
            if (s.distinct()) {
                keys.add("select.distinct");
            }
            if (s.where() != null) {
                keys.add("select.where");
            }
            if (!s.groupBy().isEmpty()) {
                keys.add("select.groupBy");
            }
            if (s.having() != null) {
                keys.add("select.having");
            }
            if (s.qualify() != null) {
                keys.add("select.qualify");
            }
            for (SqlSelect.SortKey k : s.orderBy()) {
                keys.add("select.orderBy." + (k.ascending() ? "asc" : "desc")
                        + (k.nullOrder() == null ? "" : "." + k.nullOrder()));
            }
            if (s.limit() != null) {
                keys.add("select.limit");
            }
            if (s.offset() != null) {
                keys.add("select.offset");
            }
            return s;
        }

        @Override
        protected SqlQuery union(SqlUnion u) {
            keys.add(u.all() ? "union.all" : "union");
            return u;
        }

        @Override
        protected SqlSource source(SqlSource s) {
            keys.add(s instanceof SqlSource.Join j ? "source.join." + j.kind() : "source." + s.getClass().getSimpleName());
            return s;
        }

        @Override
        protected SqlExpr expr(SqlExpr e) {
            keys.add(switch (e) {
                case SqlExpr.Call c -> "fn." + c.fn() + "(" + c.args().size() + ")";
                case SqlAgg.Reducer r -> "agg." + r.fn() + (r.distinct() ? ".distinct" : "")
                        + (r.orderBy().isEmpty() ? "" : ".ordered");
                case SqlExpr.WindowCall w -> "window." + agg(w.fn()) + frame(w.frame());
                case SqlExpr.Cast c -> "cast." + type(c.value().type()) + "->" + type(c.target());
                default -> "expr." + e.getClass().getSimpleName();
            });
            return e;
        }

        private static String agg(SqlAgg a) {
            return switch (a) {
                case SqlAgg.Reducer r -> r.fn().toString();
                case SqlAgg.RankingFn r -> r.fn().toString();
                case SqlAgg.ValueFn v -> v.fn().toString();
                default -> a.getClass().getSimpleName();
            };
        }

        private static String frame(SqlExpr.WindowCall.@com.legend.base.Nullable Frame f) {
            return f == null ? "" : "." + f.kind() + "(" + bound(f.from()) + "," + bound(f.to()) + ")";
        }

        private static String bound(SqlExpr.WindowCall.Frame.Bound b) {
            return b.getClass().getSimpleName();
        }

        private static String type(TypeFact t) {
            return t instanceof TypeFact.Typed typed ? type(typed.type()) : "?";
        }

        private static String type(SqlType t) {
            return t instanceof SqlType.Scalar s ? s.name() : t.getClass().getSimpleName();
        }
    }
}
