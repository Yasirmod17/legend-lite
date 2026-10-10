// Copyright 2026 Legend Contributors
// SPDX-License-Identifier: Apache-2.0

package com.legend.cache;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * Values HELD by their users, keyed by content {@link Hash} -- Invariant 3's home for a store whose entries live exactly
 * as long as someone holds them (a compiled model while a planner over it lives: docs/DATACUBE_MODEL_DESIGN_2026_10_10.md
 * §9). Content-keyed like {@link ContentStore} and {@link HandleStore} (the caller hashes the value's DEFINITION, so an
 * edited definition is another entry and never a stale one), with what holding needs and they must not grow:
 *
 * <ul>
 *   <li><b>Counted holders</b>: {@link #hold} builds a key's value the first time and counts each holder after;
 *       {@link #release} lets one go, and the entry goes with its last -- nothing is kept that no one holds, so the
 *       store is bounded by its holders, not by a size or an age.</li>
 *   <li><b>A handle</b> names a held entry to {@link #with} without the key: a holder keeps a small number, not the
 *       content it hashed.</li>
 *   <li><b>One user at a time per entry</b>: {@link #with} runs under the entry's own lock, for values not safe to use
 *       from two threads at once (a compiled model's typing caches are plain maps).</li>
 * </ul>
 *
 * <p>GENERIC on purpose, as {@link HandleStore} is: the value's type stays with its owner, never in this package. An
 * instance is its owner's -- a host that holds models makes one; a host that holds nothing (the server) makes none.
 */
public final class HeldStore<T> {

    private final Map<String, Entry<T>> byKey = new HashMap<>();
    private final Map<Integer, Entry<T>> byHandle = new HashMap<>();
    private final AtomicInteger next = new AtomicInteger(1);

    /** A held value: its key, the value, its handle, and how many hold it. */
    private static final class Entry<T> {
        private final String key;
        private final T value;
        private final int handle;
        private final AtomicInteger holders = new AtomicInteger();

        Entry(String key, T value, int handle) {
            this.key = key;
            this.value = value;
            this.handle = handle;
        }
    }

    /**
     * Hold the value for {@code key}: built by {@code build} the first time the key is held (a build that throws holds
     * nothing), and held once more each time after. The answer names it to {@link #with} until it is released as many
     * times as it was held.
     */
    public synchronized int hold(Hash key, Supplier<T> build) {
        Entry<T> entry = byKey.get(key.hex());
        if (entry == null) {
            entry = new Entry<>(key.hex(), build.get(), next.getAndIncrement());
            byKey.put(entry.key, entry);
            byHandle.put(entry.handle, entry);
        }
        entry.holders.incrementAndGet();
        return entry.handle;
    }

    /** Let go of {@code handle} once; its value goes with its last holder. A handle not held is let go of already. */
    public synchronized void release(int handle) {
        Entry<T> entry = byHandle.get(handle);
        if (entry == null) {
            return;
        }
        if (entry.holders.decrementAndGet() == 0) {
            byHandle.remove(handle);
            byKey.remove(entry.key);
        }
    }

    /**
     * {@code use} of the value held under {@code handle}, under that entry's own lock. A handle no longer held -- let go
     * of, or never held -- is refused by name.
     */
    public <R> R with(int handle, Function<T, R> use) {
        Entry<T> entry;
        synchronized (this) {
            entry = byHandle.get(handle);
        }
        if (entry == null) {
            throw new IllegalArgumentException("nothing is held under handle " + handle + ": it was let go, or never held");
        }
        synchronized (entry) {
            return use.apply(entry.value);
        }
    }

    /** How many values are held now. */
    public synchronized int size() {
        return byHandle.size();
    }
}
