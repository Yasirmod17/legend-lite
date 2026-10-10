// Copyright 2026 Legend Contributors
// SPDX-License-Identifier: Apache-2.0

package com.legend.cache;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** HeldStore: a value built once per content key, held while it has holders, used one thread at a time. */
@DisplayName("HeldStore -- values held by their users, keyed by content")
class HeldStoreTest {

    @Test
    @DisplayName("one build per key while held; built again once its last holder lets it go")
    void builtOncePerKeyWhileHeld() {
        HeldStore<String> store = new HeldStore<>();
        AtomicInteger builds = new AtomicInteger();
        Hash key = Hash.ofUtf8("a definition");
        int a = store.hold(key, () -> "value " + builds.incrementAndGet());
        int b = store.hold(key, () -> "value " + builds.incrementAndGet());
        assertEquals(a, b);
        assertEquals(1, builds.get(), "built once while held");
        assertNotEquals(a, store.hold(Hash.ofUtf8("another"), () -> "other"), "another key, another entry");
        store.release(a);
        store.release(b);
        int c = store.hold(key, () -> "value " + builds.incrementAndGet());
        assertEquals("value 2", store.with(c, v -> v), "gone with its last holder, built again");
    }

    @Test
    @DisplayName("a build that throws holds nothing")
    void aFailedBuildHoldsNothing() {
        HeldStore<String> store = new HeldStore<>();
        assertThrows(IllegalStateException.class, () -> store.hold(Hash.ofUtf8("bad"), () -> {
            throw new IllegalStateException("no");
        }));
        assertEquals(0, store.size());
    }

    @Test
    @DisplayName("a handle let go of is refused by name; letting it go again does nothing")
    void aHandleLetGoIsRefused() {
        HeldStore<String> store = new HeldStore<>();
        int h = store.hold(Hash.ofUtf8("x"), () -> "x");
        store.release(h);
        store.release(h);
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> store.with(h, v -> v));
        assertEquals("nothing is held under handle " + h + ": it was let go, or never held", e.getMessage());
    }
}
