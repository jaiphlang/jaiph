#!/usr/bin/env bash

# Contract: a stdin pipeline streams stage-to-stage through a bounded buffer, so
# stages overlap and no stage's full body is slurped into memory or spooled to a
# temp file and reread.
#  - Overlap: the producer prints `start`, sleeps ~2s, then prints `end`. The
#    consumer, as each line arrives, prints `saw <line>` and (on `start`) touches
#    a marker. The producer, after its sleep, reports whether that marker exists.
#    A streaming pipeline lets the consumer see `start` DURING the sleep, so the
#    producer reports `overlap`. A runtime that slurped the producer to a string
#    and only then spawned the consumer would report `sequential` (the consumer
#    had not run yet), failing the assertion. The producer uses bash `printf`,
#    which write(2)s straight to the pipe (unbuffered), so this tests Jaiph's
#    streaming, not libc buffering.
#  - Volume: 64 MiB and 128 MiB flow producer -> sink. The sink counts exactly N
#    bytes each time, and peak RSS of the jaiph process tree does not track N:
#    doubling the payload leaves the peak essentially unchanged. A runtime that
#    concatenated the payload (`output += chunk`) would grow the peak by ~N when
#    the payload doubles. Comparing two large sizes (rather than a large vs a
#    tiny one) cancels out payload-independent JIT / baseline growth.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "stdin_pipeline_stream"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
e2e::section "Overlap: producer and consumer run concurrently"
# ---------------------------------------------------------------------------

e2e::file "overlap.jh" <<'EOF'
script producer = ```bash
printf 'start\n'
sleep 2
if [ -f "$1/consumer_saw_start" ]; then printf 'end:overlap\n'; else printf 'end:sequential\n'; fi
```

script consumer = ```bash
while IFS= read -r line; do
  printf 'saw %s\n' "$line" >> "$1/result.txt"
  [ "$line" = "start" ] && : > "$1/consumer_saw_start"
done
exit 0  # a while-read loop otherwise exits 1 on the EOF read
```

export def main(dir) {
  stdin producer(dir) -> consumer(dir)
}
EOF

e2e::run "overlap.jh" "${TEST_DIR}" >/dev/null

# The consumer saw `start` while the producer was still sleeping (so the
# producer emitted `end:overlap`), and each line was seen as it streamed in.
e2e::assert_equals "$(cat "${TEST_DIR}/result.txt")" "$(printf 'saw start\nsaw end:overlap')" \
  "consumer streamed each line live; producer observed overlap"

# ---------------------------------------------------------------------------
e2e::section "Volume: 64 MiB streams through the pipeline off the JS heap"
# ---------------------------------------------------------------------------

e2e::file "volume.jh" <<'EOF'
script gen = ```bash
head -c "$1" /dev/zero | tr '\0' a
```

script sink = ```bash
wc -c | tr -d ' \n' > "$2"
```

export def main(nbytes, out) {
  stdin gen(nbytes) -> sink(nbytes, out)
}
EOF

N1=$(( 64 * 1024 * 1024 ))
N2=$(( 128 * 1024 * 1024 ))

# Sum RSS (KB) of a pid and all of its descendants (the detached workflow runner
# and the script children it spawns are reachable by ppid while jaiph waits).
tree_rss() {
  local pid="$1" sum kid
  sum="$(ps -o rss= -p "${pid}" 2>/dev/null | tr -d ' ')"
  sum="${sum:-0}"
  for kid in $(pgrep -P "${pid}" 2>/dev/null || true); do
    sum=$(( sum + $(tree_rss "${kid}") ))
  done
  printf '%s' "${sum}"
}

# Run the volume pipeline with `payload_bytes` and return the peak tree RSS (KB).
measure_peak_rss() {
  local payload_bytes="$1" out="$2" pid peak=0 cur
  jaiph run "${TEST_DIR}/volume.jh" "${payload_bytes}" "${out}" >/dev/null 2>&1 &
  pid=$!
  while kill -0 "${pid}" 2>/dev/null; do
    cur="$(tree_rss "${pid}")"
    [ "${cur}" -gt "${peak}" ] && peak="${cur}"
    sleep 0.02
  done
  wait "${pid}" 2>/dev/null || true
  printf '%s' "${peak}"
}

out1="${TEST_DIR}/count1.txt"
out2="${TEST_DIR}/count2.txt"
peak1="$(measure_peak_rss "${N1}" "${out1}")"
peak2="$(measure_peak_rss "${N2}" "${out2}")"

# The sink counted exactly N bytes each time — the full payload streamed through.
e2e::assert_equals "$(cat "${out1}")" "${N1}" "sink counted all 64 MiB streamed through the pipeline"
e2e::assert_equals "$(cat "${out2}")" "${N2}" "sink counted all 128 MiB streamed through the pipeline"

# Doubling the payload (+64 MiB) must not grow peak RSS by anything like N. A
# concatenating runtime would hold the whole payload as a JS string, so the
# 64 MiB -> 128 MiB step would add ~64 MiB (65536 KB); streaming keeps the peak
# essentially flat. The 24 MiB bound is a wide margin over the observed few-MiB
# jitter (external process-tree poll, JIT/GC variance) while still far below the
# ~64 MiB a payload-tracking runtime would add.
delta_kb=$(( peak2 - peak1 ))
[ "${delta_kb}" -lt 0 ] && delta_kb=0
limit_kb=$(( 24 * 1024 ))
if [ "${delta_kb}" -lt "${limit_kb}" ]; then
  e2e::pass "peak RSS does not track N (64->128 MiB grew peak by ${delta_kb} KB < ${limit_kb} KB; peaks ${peak1}/${peak2} KB)"
else
  e2e::fail "peak RSS tracked the payload: doubling to 128 MiB grew peak by ${delta_kb} KB (>= ${limit_kb} KB; peaks ${peak1}/${peak2} KB)"
fi
