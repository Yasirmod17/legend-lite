package com.legend.queries.page;

import com.legend.json.Json;
import com.legend.queries.MemoryRecords;
import com.legend.queries.SavedQueries;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * THE SAVED QUERIES IN THE PAGE (docs/ONE_PLATFORM_PROGRAM_2026_10_12.md B5): {@link SavedQueries}' rules compiled to
 * WebAssembly, the same rules legend-lite's server and Python's native library answer with. Each call is handed the
 * records the page keeps (its IndexedDB's) and answers what the rules answered with every query it wrote, which the
 * page's adapter ({@code query-store/src/wasm-server.ts}) writes back: the module keeps nothing between calls, so two
 * tabs over the one IndexedDB see each other's queries at their next call.
 */
public final class QueriesPage {
    private QueriesPage() {}

    /**
     * One {@code /api/pure/v1/query...} call ({@code rest}: the path after {@code /api/pure/v1/query}) over
     * {@code records} ({@code {"id": [versions...]}}), as {@code user}: {@code {"status", "body", "changed"}}, JSON.
     */
    @org.teavm.jso.JSExport
    public static String answer(String method, String rest, String rawQuery, String body, String user, String records) {
        MemoryRecords held = MemoryRecords.of(records);
        SavedQueries.Answer a = SavedQueries.answer(new SavedQueries(held, System::currentTimeMillis), method, rest,
                rawQuery.isEmpty() ? null : rawQuery, body, user);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", a.status());
        out.put("body", a.json());
        out.put("changed", held.changed());
        return Json.toCompact(out);
    }

    public static void main(String[] args) {
        // TeaVM's entry point: the export above is the module's surface
    }
}
