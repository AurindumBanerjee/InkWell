#!/bin/bash
# Runs k6 sync-load scenarios against the 3-node Docker cluster, then tears everything down.
#
#   SCENARIOS="smoke:20:5s:15s:4 full:1000:60s:120s" bench/load.sh
#
# Each scenario is name:vus:ramp:hold[:editors-per-document], default 10 editors per document (a
# scenario with fewer than 2 editors per document would have nobody to receive anything).
# The first scenario is a smoke test: if it moves no traffic
# the rest are skipped. Run it under the shared heavy-job lock (see CLAUDE.md); it caps CPU at
# NODE_CPUS per sync node (default 0.5) and K6_CPUS for the load generator (default 4).
#
# Env: NODE_CPUS, K6_CPUS, DOCS (documents; default 100), EDIT_MS (mean ms between a user's edits;
#      default 2000), REBUILD=0 to reuse the existing inkwell-server:cluster image.
set -u
cd "$(dirname "$0")/.."

F=docker-compose.cluster.yml
SCENARIOS=${SCENARIOS:-"smoke:20:5s:15s full:1000:60s:120s"}
DOCS=${DOCS:-100}
EDIT_MS=${EDIT_MS:-2000}
K6_CPUS=${K6_CPUS:-4}
export NODE_CPUS=${NODE_CPUS:-0.5} COMPOSE_PARALLEL_LIMIT=1
RESULTS=bench/results
mkdir -p "$RESULTS" bench/.generated

sampler_pid=""
cleanup() {
  [ -n "$sampler_pid" ] && kill "$sampler_pid" 2>/dev/null
  docker compose -f "$F" down -v --remove-orphans >/dev/null 2>&1
  echo "cluster containers and volumes removed"
}
trap cleanup EXIT

if [ "${REBUILD:-1}" = "1" ]; then
  echo "== build"
  docker compose -f "$F" build server-a 2>&1 | tail -2 || exit 1
fi
echo "== up (NODE_CPUS=$NODE_CPUS per node)"
docker compose -f "$F" up -d 2>&1 | tail -3
for i in $(seq 1 60); do
  curl -fs -m 2 localhost:4000/healthz >/dev/null 2>&1 && break
  sleep 2
done
curl -fs -m 2 localhost:4000/healthz >/dev/null 2>&1 || { echo "cluster not healthy"; docker compose -f "$F" ps; exit 2; }

node bench/k6/build.mjs >/dev/null

first=1
for sc in $SCENARIOS; do
  # name:vus:ramp:hold[:editors-per-document]  (default 10 editors share each document)
  IFS=: read -r NAME VUS RAMP HOLD GROUP <<<"$sc"
  GROUP=${GROUP:-10}
  DOCS=$(( VUS / GROUP )); [ "$DOCS" -lt 1 ] && DOCS=1
  echo
  echo "== scenario $NAME: $VUS editors over $DOCS documents ($GROUP per document), ramp $RAMP, hold $HOLD"
  npx tsx bench/k6/seed.ts "$DOCS" || exit 2
  : > "$RESULTS/stats-$NAME.txt"
  ( while true; do
      docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' >> "$RESULTS/stats-$NAME.txt" 2>/dev/null
      sleep 8
    done ) &
  sampler_pid=$!

  MSYS_NO_PATHCONV=1 docker run --rm --name k6-load --cpus "$K6_CPUS" --network inkwell_default \
    -v "$(pwd -W 2>/dev/null || pwd)/bench:/bench" \
    -e VUS="$VUS" -e RAMP="$RAMP" -e HOLD="$HOLD" -e EDIT_MS="$EDIT_MS" -e NAME="$NAME" \
    -e WS_BASE=ws://nginx:80 \
    grafana/k6:latest run --quiet /bench/k6/sync-load.js 2>&1 \
    | grep -vE '^\s*$|was stopped because the VU iteration was interrupted|No script iterations fully finished' \
    | tail -40
  rc=${PIPESTATUS[0]}
  kill "$sampler_pid" 2>/dev/null; sampler_pid=""

  echo "-- peak container CPU% / memory during $NAME:"
  awk '{ gsub("%","",$2); if ($2+0 > m[$1]) { m[$1]=$2+0; mem[$1]=$3 $4 } } END { for (n in m) printf "   %-24s cpu=%6.1f%%  mem=%s\n", n, m[n], mem[n] }' "$RESULTS/stats-$NAME.txt" | sort
  echo "-- k6 exit code: $rc"

  # A saturated load generator queues work itself, which inflates every latency it measures.
  gen_peak=$(awk '$1=="k6-load" { gsub("%","",$2); if ($2+0 > m) m=$2+0 } END { printf "%d", m }' "$RESULTS/stats-$NAME.txt")
  gen_limit=$(( K6_CPUS * 80 ))
  if [ "${gen_peak:-0}" -gt "$gen_limit" ]; then
    echo "!! GENERATOR SATURATED: k6 peaked at ${gen_peak}% of its ${K6_CPUS}-CPU cap (limit ${gen_limit}%): latencies for $NAME are NOT valid"
  else
    echo "   generator ok: k6 peaked at ${gen_peak}% of its ${K6_CPUS}-CPU cap"
  fi

  if [ $first -eq 1 ]; then
    moved=$(node -e "try{const d=require('./$RESULTS/k6-$NAME.json');console.log(d.metrics.markers_received?.values.count||0)}catch{console.log(0)}")
    if [ "$moved" -le 0 ]; then
      echo "smoke scenario moved no traffic (markers_received=$moved): skipping the rest"
      docker compose -f "$F" logs --tail 15 server-a 2>&1 | tail -15
      exit 3
    fi
    first=0
  fi
done
