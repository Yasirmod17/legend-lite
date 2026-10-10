#!/bin/zsh
# THE SHADOW RUN: every lane of //gates:local (and the Postgres arm) with the probe applied, each text answer compared
# with its lite plan's (probe.py, PlanShadow.java.txt); the records collected per test target into <outdir>.
#
#   docs/execution-plan-boundary-2026-10-05/shadow-run/run.sh <outdir>
#
# Run from the repository root. The probe is removed again at the end, whatever happens.
set -u
OUT=$1
HERE=${0:a:h}
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT")" ]; then
  echo "run.sh: $OUT is not empty"; exit 2
fi
mkdir -p "$OUT"
[ -e core/src/main/java/com/legend/PlanShadow.java ] || python3 -I "$HERE/probe.py" apply || { echo "the probe does not apply"; exit 2; }
trap 'python3 -I "$HERE/probe.py" remove' EXIT
LANES=(//gates:local //core:postgres_arm_test)
echo "== $LANES $(date +%H:%M:%S)"
bazel test --keep_going --cache_test_results=no --local_test_jobs=4 $LANES > "$OUT/lanes.log" 2>&1
echo "exit=$? $(grep -E 'Executed' "$OUT/lanes.log" | tail -1)"
for t in $(bazel query "tests(//gates:local) + //core:postgres_arm_test" 2>/dev/null); do
  d="bazel-testlogs/${${t#//}/://}/test.outputs"
  records=("$d"/shadow-*.tsv(N))
  if (( ${#records} )); then
    mkdir -p "$OUT/${${t#//}//[\/:]/_}"
    cp "${records[@]}" "$OUT/${${t#//}//[\/:]/_}/"
  fi
done
echo "== done $(date +%H:%M:%S)"
