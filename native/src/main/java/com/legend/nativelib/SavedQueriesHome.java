package com.legend.nativelib;

import com.legend.queries.FileRecords;
import com.legend.queries.SavedQueries;

import org.graalvm.nativeimage.IsolateThread;
import org.graalvm.nativeimage.c.function.CEntryPoint;
import org.graalvm.nativeimage.c.type.CCharPointer;
import planner.Folded;

import java.nio.file.Path;

/**
 * PYTHON'S SAVED QUERIES (docs/ONE_PLATFORM_PROGRAM_2026_10_12.md B5): legend-engine's query store as legend-lite's
 * rules answer it ({@link SavedQueries}, the very rules its server runs on the JVM and the page runs compiled to
 * WebAssembly), over a folder in this user's legend-lite folder, one JSON file per query ({@link FileRecords}, the
 * server's layout). Each call is one request -- {@code rest} the path after {@code /api/pure/v1/query}, {@code query}
 * its raw query string (empty for none) -- as {@code user}, answered {@code "OK\n<status>\n<body>"} as
 * {@link ModelHome}'s are. The caller serializes the calls on a folder, across processes too (Python holds a lock around
 * each); nothing is kept in memory between calls.
 */
final class SavedQueriesHome {
    private SavedQueriesHome() {
    }

    @CEntryPoint(name = "lite_saved_queries")
    static CCharPointer savedQueries(IsolateThread thread, CCharPointer folder, CCharPointer method, CCharPointer rest,
            CCharPointer query, CCharPointer body, CCharPointer user) {
        String a;
        try {
            String f = Compiler.text(folder), m = Compiler.text(method), r = Compiler.text(rest), q = Compiler.text(query),
                    b = Compiler.text(body), u = Compiler.text(user);
            a = Folded.of(() -> {
                SavedQueries.Answer answer = SavedQueries.answer(new SavedQueries(new FileRecords(Path.of(f)),
                        System::currentTimeMillis), m, r, q.isEmpty() ? null : q, b, u);
                return answer.status() + "\n" + answer.json();
            });
        } catch (Throwable failure) {
            a = Folded.failure(failure);
        }
        return Compiler.answer(a);
    }
}
