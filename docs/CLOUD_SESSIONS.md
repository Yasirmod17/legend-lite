# Running the build in a Claude Code cloud session

A cloud session runs in a container whose network goes through a proxy, as root, with a fixed disk allowance. Bazel
works there, but not out of the box. This is what a session hit and how it got through (2026-10-11 to 2026-10-14,
Bazel 9.2.0, a 4-core Linux x86 container).

## GitHub archive downloads are refused: `tools/cloud-distdir.sh`

**The symptom.** `bazel fetch`, `build` or `test` stops on

```
Error downloading [https://github.com/finos/legend-engine/archive/refs/tags/legend-engine-4.145.0.tar.gz] ...:
GET returned 403 Forbidden
```

and `curl` of the same URL answers `{"message":"GitHub access to this repository is not enabled for this session.
Use add_repo to request access. ..."}`.

**Why.** The session's proxy serves GitHub's archive downloads (`codeload.github.com/...`,
`github.com/<org>/<repo>/archive/...`) only for the repositories attached to the session, normally just this one.
What still works, measured on both dates: `git clone` of a public repository, GitHub release assets (bazelisk),
`mirror.bazel.build` and Maven Central. The build downloads GitHub archives for:

- the upstream sources the corpus, PCT and parity tests read: `legend-engine` and `legend-pure` at the release pinned
  in `release.MODULE.bazel` (with their `*_SRC_INTEGRITY`);
- the bats test helpers, through `aspect_bazel_lib`'s bats toolchain: `bats-core`, `bats-support`, `bats-assert`,
  `bats-file` (2026-10-11; a transitive module, so not named in this repository's own files).

**The fix.** From the repository root:

```
tools/cloud-distdir.sh              # or: tools/cloud-distdir.sh //core:core_tests  (default //gates:local)
```

It installs bazelisk as `bazel` if there is none, adds `common --distdir=~/.cache/legend-lite/distdir` to
`~/.bazelrc`, runs `bazel fetch --keep_going`, and gets every archive Bazel reports it could not download another
way: from Bazel's own mirror (`mirror.bazel.build/github.com/...`), else by cloning the tag with git (`--bare
--depth 1`, seconds) and packing it as GitHub does (`git archive --prefix=<repo>-<tag>/ | gzip -n`, byte-identical).
It fetches again until nothing new fails (Bazel names the next refused archive only after the previous one is
there). Bazel looks in the distdir first, by the URL's last path segment, and still checks each file against the
checksum the build pins, refusing a mismatch: nothing is trusted that the build does not already trust. Measured
2026-10-14: `legend-engine-4.145.0.tar.gz` packed to `sha256-zxwlJBBsHN4PmNp68juUPdrfV+ZjlF9us0fUaejm02E=` and
`legend-pure-5.99.0.tar.gz` to `sha256-8hb6qk1BTFWy6fuSzSX82Nk0ZWd16jDQCoZenP3yboo=`, the pins exactly; the four bats
archives came from the mirror with their pinned sha256.

The distdir and `~/.bazelrc` are the container's, so a new session runs the script again (it keeps what is already
there). `tools/cloud-distdir.sh --log <a bazel fetch log>` seeds from a log without running Bazel.

**Untested alternatives.** The 403 itself suggests attaching the repository to the session (`finos/legend-engine`,
`finos/legend-pure`), which may let the archive URLs through directly; a session's repositories are otherwise chosen
when it starts. An environment's setup script could also run `tools/cloud-distdir.sh` at every start.

## Other traps

- **The disk allowance.** The output base (about 8 GB) and the repository cache (about 20 GB) take most of it, and
  "No space left on device" then appears mid-build, often while copying inputs into a sandbox. When no build runs,
  `rm -rf "$(bazel info output_base)"/sandbox/*` and stale scratch output free a few GB. `df` reports the
  allowance, not the machine: "Avail" near zero means it is spent.
- **Root.** The container runs as root, and the embedded Postgres (`initdb`) refuses root:
  `tools/postgres/as_unprivileged.sh` runs a Postgres test as an unprivileged user (its header says how).
- **The browser tests** (`//datacube:verify_smoke_test`, `//query:verify_test`, `//site:verify_test`) time out in the
  container on main too; CI runs them.
- **`//tools/guards:classpath_test`** reaches an arm64-only target and cannot run on an x86 host.
- **WebAssembly.** The local core suite compiles no TeaVM target, so a JDK method TeaVM's class library lacks (such
  as `Character.toString(int)`) reaches CI first: after calling a JDK method new to core, build `//sdlc-server:page`
  and `//wasm:planner` locally.
- **The worker restarts.** A restarted session worker kills what it was running: run a long Bazel command in the
  background and commit a checkpoint to the branch before a long run.
