// Copyright 2026 Legend Contributors
// SPDX-License-Identifier: Apache-2.0

package org.finos.legend.lite.pct.extension;

import com.legend.model.ConnectionDefinition.DatabaseType;
import com.legend.testing.EmbeddedPostgres;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;

/**
 * The database a PCT lane runs its suite on, chosen by the target ({@code LEGENDLITE_PCT_BACKEND}, an
 * environment variable: it must survive the fork into the test JVM), one connection per executed
 * expression:
 *
 * <ul>
 *   <li>unset: a fresh in-memory DuckDB;</li>
 *   <li>{@code h2}: a fresh in-memory H2, with the portability sweep's session settings;</li>
 *   <li>{@code postgres}: this JVM's embedded Postgres 16 (leg P2), a new session on its database;</li>
 *   <li>{@code sqlite}: a fresh in-memory SQLite (the driver's own build, in-process);</li>
 *   <li>{@code databricks}, {@code snowflake}, {@code bigquery}: a real account's warehouse, one session held for the
 *       suite ({@link CloudLane}: its coordinates and credentials from {@code LEGENDLITE_PCT_CLOUD_PROPERTIES}).</li>
 * </ul>
 *
 * Session settings are the dialect's, applied at the platform's connection seam
 * ({@code SqlDialect.sessionSetup}, from {@code Compiler.dialectOf}); this only opens the connection.
 */
final class PctBackend {

    private PctBackend() {
    }

    /** The lanes' databases: each one's declared type (the storeless runtime's connection) and its session. */
    private enum Lane {
        DUCKDB(DatabaseType.DuckDB) {
            @Override
            Connection open() throws SQLException {
                return DriverManager.getConnection("jdbc:duckdb:");
            }
        },
        H2(DatabaseType.H2) {
            @Override
            Connection open() throws SQLException {
                return DriverManager.getConnection("jdbc:h2:mem:" + com.legend.exec.H2Settings.SETTINGS, "sa", "");
            }
        },
        SQLITE(DatabaseType.SQLite) {
            @Override
            Connection open() throws SQLException {
                return DriverManager.getConnection("jdbc:sqlite::memory:");
            }
        },
        POSTGRES(DatabaseType.Postgres) {
            @Override
            Connection open() throws SQLException {
                return DriverManager.getConnection(EmbeddedPostgres.shared().jdbcUrl("postgres"));
            }
        },
        DATABRICKS(DatabaseType.Databricks) {
            @Override
            Connection open() throws SQLException {
                return CloudLane.connect(CloudLane.Cloud.DATABRICKS);
            }
        },
        SNOWFLAKE(DatabaseType.Snowflake) {
            @Override
            Connection open() throws SQLException {
                return CloudLane.connect(CloudLane.Cloud.SNOWFLAKE);
            }
        },
        BIGQUERY(DatabaseType.BigQuery) {
            @Override
            Connection open() throws SQLException {
                return CloudLane.connect(CloudLane.Cloud.BIGQUERY);
            }
        };

        final DatabaseType type;

        Lane(DatabaseType type) {
            this.type = type;
        }

        abstract Connection open() throws SQLException;
    }

    private static Lane lane() {
        String backend = System.getenv("LEGENDLITE_PCT_BACKEND");
        if (backend == null) {
            return Lane.DUCKDB;
        }
        return switch (backend) {
            case "h2" -> Lane.H2;
            case "postgres" -> Lane.POSTGRES;
            case "sqlite" -> Lane.SQLITE;
            case "databricks" -> Lane.DATABRICKS;
            case "snowflake" -> Lane.SNOWFLAKE;
            case "bigquery" -> Lane.BIGQUERY;
            default -> throw new IllegalStateException("LEGENDLITE_PCT_BACKEND=" + backend + ": a PCT lane runs on"
                    + " DuckDB (unset), h2, postgres, sqlite, databricks, snowflake or bigquery");
        };
    }

    /** {@code model} with this lane's storeless runtime declared beside it: the session {@link #connect} opens. */
    static String withStorelessRuntime(String model) {
        Lane lane = lane();
        return switch (lane) {
            case DUCKDB, H2, SQLITE -> com.legend.test.StorelessRuntime.with(model, lane.type);
            case POSTGRES -> com.legend.test.StorelessRuntime.onServer(model, lane.type, "127.0.0.1",
                    EmbeddedPostgres.shared().port(), "postgres");
            case DATABRICKS -> CloudLane.withStorelessRuntime(model, CloudLane.Cloud.DATABRICKS);
            case SNOWFLAKE -> CloudLane.withStorelessRuntime(model, CloudLane.Cloud.SNOWFLAKE);
            case BIGQUERY -> CloudLane.withStorelessRuntime(model, CloudLane.Cloud.BIGQUERY);
        };
    }

    /** A session on this lane's database. */
    static Connection connect() throws SQLException {
        return lane().open();
    }
}
