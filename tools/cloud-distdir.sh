#!/bin/bash
# Bazel in a cloud session whose network refuses GitHub's ARCHIVE downloads (codeload.github.com and
# github.com/<org>/<repo>/archive/...: "GitHub access to this repository is not enabled for this session", 403), while
# `git clone` of a public repository, GitHub release assets, mirror.bazel.build and Maven Central still work.
# docs/CLOUD_SESSIONS.md says why, and what to try first.
#
#   tools/cloud-distdir.sh [target ...]       (default //gates:local)
#   tools/cloud-distdir.sh --log <fetch log>  (seed only what one `bazel fetch` log names; runs no Bazel)
#
# 1. installs bazelisk as `bazel` when none is on PATH (it then runs the version in .bazelversion);
# 2. adds `common --distdir=<dir>` to ~/.bazelrc ($LEGEND_DISTDIR, default ~/.cache/legend-lite/distdir): Bazel then
#    looks there first for a file named as the download URL's last segment;
# 3. runs `bazel fetch --keep_going` and reads which archives Bazel could not download ("Error downloading [<url>]");
# 4. gets each one another way: Bazel's own mirror (mirror.bazel.build/<host>/<path>), else the tree at that ref
#    cloned with git and packed as GitHub packs it (`git archive --prefix=<repo>-<ref>/ | gzip -n`: byte-identical);
# 5. fetches again, and again while each pass names archives not yet seeded (Bazel stops a module extension at its
#    first failed download, so the next ones show only on the next pass).
# Bazel still checks every seeded file against the checksum the build pins and refuses a mismatch, so nothing is
# trusted that the build does not already trust. The distdir and ~/.bazelrc live in the container: a new session
# runs this again (files already seeded are kept).
set -euo pipefail

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
dist=${LEGEND_DISTDIR:-$HOME/.cache/legend-lite/distdir}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$dist"

log=""
if [ "${1:-}" = "--log" ]; then
  log=$2
  shift 2
fi
targets=("$@")
[ ${#targets[@]} -gt 0 ] || targets=(//gates:local)
line="common --distdir=$dist"
grep -qxF "$line" "$HOME/.bazelrc" 2>/dev/null || echo "$line" >> "$HOME/.bazelrc"

# the archives a fetch log says Bazel could not download, one URL per line
failed_urls() {
  sed -E 's/\x1b\[[0-9;]*m//g' "$1" | grep -oE 'Error downloading \[https://[^]]+\]' \
      | sed -E 's/^Error downloading \[//; s/\]$//' | sort -u || true
}

# seeds one archive into the distdir; prints how, or MISSING
seed() {
  local url=$1 name=${1##*/}
  if curl -fsSL --max-time 300 -o "$work/$name" "https://mirror.bazel.build/${url#https://}" 2>/dev/null; then
    mv "$work/$name" "$dist/$name"
    echo "mirror  $name  (mirror.bazel.build)"
    return 0
  fi
  # github.com/<org>/<repo>/archive/[refs/tags/]<ref>.tar.gz or codeload.github.com/<org>/<repo>/tar.gz/[refs/tags/]
  # <ref>; GitHub's top directory is <repo>-<ref>, with a leading "v" before a digit dropped
  if [[ $url =~ ^https://github\.com/([^/]+)/([^/]+)/archive/(refs/tags/)?(.+)\.tar\.gz$ ]] \
      || [[ $url =~ ^https://codeload\.github\.com/([^/]+)/([^/]+)/tar\.gz/(refs/tags/)?(.+)$ ]]; then
    local org=${BASH_REMATCH[1]} r=${BASH_REMATCH[2]} ref=${BASH_REMATCH[4]}
    local top=$r-$ref clone=$work/$r.git
    [[ $ref =~ ^v[0-9] ]] && top=$r-${ref#v}
    rm -rf "$clone"
    # a tag or branch clones by name; a commit is fetched by its id
    if git clone -q --bare --depth 1 --branch "$ref" "https://github.com/$org/$r.git" "$clone" 2>/dev/null \
        || { rm -rf "$clone" && git init -q --bare "$clone" \
            && git -C "$clone" fetch -q --depth 1 "https://github.com/$org/$r.git" "$ref" 2>/dev/null \
            && git -C "$clone" tag seeded FETCH_HEAD && ref=seeded; }; then
      git -C "$clone" archive --format=tar --prefix="$top/" "$ref" | gzip -n > "$work/$name"
      mv "$work/$name" "$dist/$name"
      rm -rf "$clone"
      echo "git     $name  (git clone of $org/$r, packed as GitHub packs it)"
      return 0
    fi
  fi
  echo "MISSING $name  ($url: neither the mirror nor git could get it)"
  return 1
}

# seeds what a log names and the distdir lacks; prints the number seeded
seed_from() {
  local n=0 url
  for url in $(failed_urls "$1"); do
    [ -s "$dist/${url##*/}" ] && continue
    seed "$url" >&2 && n=$((n + 1))
  done
  echo "$n"
}

if [ -n "$log" ]; then
  echo "seeded $(seed_from "$log") into $dist"
  exit 0
fi

if ! command -v bazel >/dev/null 2>&1; then
  mkdir -p "$HOME/.local/bin"
  echo "installing bazelisk as $HOME/.local/bin/bazel (add it to PATH)"
  curl -fsSL -o "$HOME/.local/bin/bazel" \
      https://github.com/bazelbuild/bazelisk/releases/download/v1.26.0/bazelisk-linux-amd64
  chmod +x "$HOME/.local/bin/bazel"
  export PATH="$HOME/.local/bin:$PATH"
fi

for pass in 1 2 3 4 5 6 7 8; do
  echo "pass $pass: bazel fetch --keep_going ${targets[*]}"
  if (cd "$repo" && bazel fetch --keep_going "${targets[@]}" > "$work/fetch.log" 2>&1); then
    echo "fetch complete: Bazel runs from here ($dist, $(find "$dist" -maxdepth 1 -type f | wc -l) files)"
    exit 0
  fi
  if [ "$(seed_from "$work/fetch.log")" = 0 ]; then
    # nothing new to seed: what is left is not a refused archive (or a seeded file Bazel rejected)
    echo "fetch still fails, and nothing more to seed:"
    sed -E 's/\x1b\[[0-9;]*m//g' "$work/fetch.log" | grep -E "Error downloading|Checksum was|^ERROR" | sort -u | head -20
    exit 1
  fi
done
echo "still failing after 8 passes"
exit 1
