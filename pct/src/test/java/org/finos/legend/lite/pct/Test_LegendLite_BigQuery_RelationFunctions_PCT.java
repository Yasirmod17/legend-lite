// Copyright 2026 Legend Contributors
// SPDX-License-Identifier: Apache-2.0

package org.finos.legend.lite.pct;

import junit.framework.Test;
import org.eclipse.collections.api.factory.Lists;
import org.eclipse.collections.api.list.MutableList;
import org.finos.legend.pure.code.core.RelationCodeRepositoryProvider;
import org.finos.legend.pure.m3.pct.reports.config.PCTReportConfiguration;
import org.finos.legend.pure.m3.pct.reports.config.exclusion.ExclusionSpecification;
import org.finos.legend.pure.m3.pct.reports.model.Adapter;
import org.finos.legend.pure.m3.pct.shared.model.ReportScope;
import org.finos.legend.pure.runtime.java.interpreted.testHelper.PureTestBuilderInterpreted;
import static org.finos.legend.engine.test.shared.framework.PureTestHelperFramework.wrapSuite;

/**
 * The relation PCT suite on BigQuery (docs/CLOUD_BACKENDS_PCT_2026_10_11.md): the SAME tests as
 * {@link Test_LegendLite_RelationFunctions_PCT}, through the same adapter, on a real account
 * ({@code LEGENDLITE_PCT_BACKEND=bigquery}, pct/BUILD.bazel; its coordinates and credentials from
 * {@code LEGENDLITE_PCT_CLOUD_PROPERTIES}), with BigQuery's OWN expected failures -- legend-engine's shape, as
 * {@link Test_LegendLite_Postgres_RelationFunctions_PCT}: every expected failure named and pinned by the text it
 * fails with, and a pinned test that starts passing fails the run, so a fix is recorded by deleting its row.
 */
public class Test_LegendLite_BigQuery_RelationFunctions_PCT extends PCTReportConfiguration {

    private static final ReportScope reportScope = RelationCodeRepositoryProvider.relationFunctions;
    private static final Adapter adapter = LegendLitePCTReportProvider.LegendLiteAdapter;
    private static final String platform = "interpreted";

    // Pinned by a STABLE part of the message (the runner matches by containment): no per-run id.
    // First measured 2026-10-11 on the account (BigQuery, 469 tests); burned down the same day: every
    // row is the platform's own (pinned on the DuckDB lane too) or a measured limit of BigQuery.
    private static final MutableList<ExclusionSpecification> expectedFailures = Lists.mutable.with(
            // THE PLATFORM'S OWN (each pinned on the DuckDB lane too, by the same cause): name resolution, lowering
            // and harness limits, the 0-based indexOf, error positions and messages
            one("meta::pure::functions::relation::tests::composition::testVariantArrayColumn_joinStrings_Function_1__Boolean_1_", "\"\nexpected: '#TDS\n   id,payload,joined\n   1,\\'[1,2,3]\\',1,2,3\n   2,\\'[4,5,6]\\',4,5,6\n   3,\\'[7,8,9]\\',7,8,9\n   4,\\'null\\',\n#'\nactual:   '#TDS\n   id,payload,joined\n   1,\\'[1,2,3]\\',1,2,3\n   2,\\'[4,5,6]\\',4,5,6\n   3,\\'[7,8,9]\\',7,8,9\n   4,\\'null\\',null\n#'\""),
            // BIGQUERY'S OWN LIMIT: no MAP type (a map has no representation here)
            one("meta::pure::functions::relation::tests::composition::testVariantMapColumn_keys_LateralFlatten_Function_1__Boolean_1_", "\"MAP_KEYS reached BigQuery: BigQuery has no MAP type\""),
            one("meta::pure::functions::relation::tests::composition::testVariantMapColumn_values_LateralFlatten_Function_1__Boolean_1_", "\"MAP_VALUES reached BigQuery: BigQuery has no MAP type\""),
            // BIGQUERY'S OWN LIMIT: no lambdas, and no correlated recursion to fold with (WITH RECURSIVE is top-level
            // only, measured)
            one("meta::pure::functions::relation::tests::extend::testVariantColumn_fold_Function_1__Boolean_1_", "\"a fold reached BigQuery, which has no lambdas and no correlated recursion (WITH RECURSIVE is top-level only, measured)\""),
            // BIGQUERY'S OWN LIMIT: a correlated derived table (LATERAL) is refused; only an UNNEST correlates
            // ("Unrecognized name", measured)
            one("meta::pure::functions::relation::tests::composition::testFilterPostProject_Function_1__Boolean_1_", "\"a lateral join reached BigQuery, which correlates no derived table\""),
            one("meta::pure::functions::relation::tests::lateral::testLateralJoinAreInnerJoins_Function_1__Boolean_1_", "\"a lateral join reached BigQuery, which correlates no derived table\""),
            one("meta::pure::functions::relation::tests::lateral::testLateralJoin_Chained_Function_1__Boolean_1_", "\"a lateral join reached BigQuery, which correlates no derived table\""),
            one("meta::pure::functions::relation::tests::lateral::testLateralJoin_CorrelatedColumnNameAlsoOnInner_Function_1__Boolean_1_", "\"a lateral join reached BigQuery, which correlates no derived table\""),
            one("meta::pure::functions::relation::tests::lateral::testLateralJoin_Function_1__Boolean_1_", "\"a lateral join reached BigQuery, which correlates no derived table\""),
            one("meta::pure::functions::relation::tests::project::testSimpleProjectList_Function_1__Boolean_1_", "\"a lateral join reached BigQuery, which correlates no derived table\""),
            one("meta::pure::functions::relation::tests::project::testSimpleProjectWithEmpty_Function_1__Boolean_1_", "\"a lateral join reached BigQuery, which correlates no derived table\""),
            one("meta::pure::functions::relation::tests::project::testSimpleProject_Function_1__Boolean_1_", "\"a lateral join reached BigQuery, which correlates no derived table\""),
            // THE DIALECT'S OWN GAP (named, not yet closed): a lambda parameter over a JSON array carries no type, so
            // its cast is a scalar CAST, which GoogleSQL refuses on JSON
            one("meta::pure::functions::relation::variant::tests::flatten::testFlatten_LateralJoin_Nested_Extend_Function_1__Boolean_1_", "\"BigQueryException during runQuery\nInvalid cast from JSON to INT64")
    );

    public static Test suite() {
        return PctCensusGate.wrap("Relation", wrapSuite(
                () -> true,
                () -> PureTestBuilderInterpreted.buildPCTTestSuite(reportScope, expectedFailures, adapter),
                () -> false,
                Lists.mutable.empty()));
    }

    @Override
    public MutableList<ExclusionSpecification> expectedFailures() {
        return expectedFailures;
    }

    @Override
    public ReportScope getReportScope() {
        return reportScope;
    }

    @Override
    public Adapter getAdapter() {
        return adapter;
    }

    @Override
    public String getPlatform() {
        return platform;
    }
}
