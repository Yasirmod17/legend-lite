// Copyright 2026 Legend Contributors
// SPDX-License-Identifier: Apache-2.0

package org.finos.legend.lite.pct;

import junit.framework.Test;
import org.eclipse.collections.api.factory.Lists;
import org.eclipse.collections.api.list.MutableList;
import org.finos.legend.pure.m3.PlatformCodeRepositoryProvider;
import org.finos.legend.pure.m3.pct.reports.config.PCTReportConfiguration;
import org.finos.legend.pure.m3.pct.reports.config.exclusion.ExclusionSpecification;
import org.finos.legend.pure.m3.pct.reports.model.Adapter;
import org.finos.legend.pure.m3.pct.shared.model.ReportScope;
import org.finos.legend.pure.runtime.java.interpreted.testHelper.PureTestBuilderInterpreted;
import static org.finos.legend.engine.test.shared.framework.PureTestHelperFramework.wrapSuite;

/**
 * The essential PCT suite on BigQuery (docs/CLOUD_BACKENDS_PCT_2026_10_11.md): the SAME tests as
 * {@link Test_LegendLite_EssentialFunctions_PCT}, through the same adapter, on a real account
 * ({@code LEGENDLITE_PCT_BACKEND=bigquery}, pct/BUILD.bazel; its coordinates and credentials from
 * {@code LEGENDLITE_PCT_CLOUD_PROPERTIES}), with BigQuery's OWN expected failures -- legend-engine's shape, as
 * {@link Test_LegendLite_Postgres_EssentialFunctions_PCT}: every expected failure named and pinned by the text it
 * fails with, and a pinned test that starts passing fails the run, so a fix is recorded by deleting its row.
 */
public class Test_LegendLite_BigQuery_EssentialFunctions_PCT extends PCTReportConfiguration {

    private static final ReportScope reportScope = PlatformCodeRepositoryProvider.essentialFunctions;
    private static final Adapter adapter = LegendLitePCTReportProvider.LegendLiteAdapter;
    private static final String platform = "interpreted";

    // Pinned by a STABLE part of the message (the runner matches by containment): no per-run id.
    private static final MutableList<ExclusionSpecification> expectedFailures = Lists.mutable.with(
            // first measured on the account: every row is pinned from the first run's report
    );

    public static Test suite() {
        return PctCensusGate.wrap("Essential", wrapSuite(
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
