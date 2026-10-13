package com.legend.queries;

import com.legend.json.Json;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Map;
import java.util.TreeMap;

/**
 * DataCube's saved pages in a directory, one {@code <id>.json} file each, the row as the page keeps it (its content the
 * exact JSON text): Python's {@code ll.home()/pages} through the native library -- the layout its pages were kept in
 * before these rules were Java, so they open as they were -- and legend-lite's server's {@code --query-store DIR/dataCube}.
 * A write goes to a file beside it, then replaces it. A file that is not a row (written by something else, cut short)
 * is left out of the list, never a failure of every other page; asked for by its id, it is the 500 of a page that cannot
 * be read. The ids are a page's own spelling ({@link SavedCubes}' rules refuse any other first; refused here again, as
 * the file's name), so a name never reaches outside the directory (no separator, no Windows device name).
 */
public final class FileCubeRecords implements SavedCubes.Records {

    private final Path directory;

    public FileCubeRecords(Path directory) {
        this.directory = directory;
    }

    @Override
    public Map<String, Json.Obj> all() {
        Map<String, Json.Obj> out = new TreeMap<>();
        if (!Files.isDirectory(directory)) {
            return out;
        }
        try (var files = Files.list(directory)) {
            for (Path p : files.filter(f -> f.getFileName().toString().endsWith(".json")).toList()) {
                try {
                    Json.Obj row = Json.parseObject(Files.readString(p));
                    if (SavedCubes.isRow(row)) {
                        out.put(((Json.Str) row.get("id")).value(), row);
                    }
                } catch (IllegalArgumentException | IOException unread) {
                    // not a row: left out, the others still open
                }
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return out;
    }

    @Override
    public Json.@com.legend.base.Nullable Obj find(String id) {
        Path p = file(id);
        try {
            if (!Files.isRegularFile(p)) {
                return null;
            }
            Json.Obj row = Json.parseObject(Files.readString(p));
            if (!SavedCubes.isRow(row)) {
                throw new IllegalArgumentException("the saved page '" + id + "' (" + p.getFileName() + ") is not one");
            }
            return row;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @Override
    public void put(Json.Obj row) {
        Path target = file(((Json.Str) row.get("id")).value());
        try {
            Files.createDirectories(directory);
            Path tmp = target.resolveSibling(target.getFileName() + ".part");
            Files.writeString(tmp, Json.toCompact(row));
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @Override
    public void remove(String id) {
        try {
            Files.deleteIfExists(file(id));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private Path file(String id) {
        SavedCubes.pageId(id);
        return directory.resolve(id + ".json");
    }
}
