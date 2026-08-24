#!/bin/bash
# Overnight apply campaign, sharded across N parallel workers by company hash.
# Each worker restarts itself on a crash; the whole campaign stops once D1's
# live submitted count (shared across every worker) hits the goal.
set -u
cd "$(dirname "$0")/.."

GOAL="${1:-100}"
SHARDS="${2:-4}"
mkdir -p evidence/apply

run_shard() {
  local idx="$1"
  local log="evidence/apply/overnight-shard-${idx}.log"
  local max_restarts=40
  local n=0
  echo "=== shard ${idx}/${SHARDS} started $(date -u +%FT%TZ), goal=$GOAL ===" >> "$log"
  while [ "$n" -lt "$max_restarts" ]; do
    node apply/batch.mjs --goal "$GOAL" --submit --shard "${idx}/${SHARDS}" >> "$log" 2>&1
    code=$?
    if [ "$code" -eq 0 ]; then
      echo "=== shard ${idx} exited cleanly (code 0) at $(date -u +%FT%TZ) ===" >> "$log"
      break
    fi
    n=$((n+1))
    echo "=== shard ${idx} crashed (code $code), restart $n/$max_restarts at $(date -u +%FT%TZ) ===" >> "$log"
    sleep 10
  done
  echo "=== shard ${idx} finished at $(date -u +%FT%TZ) ===" >> "$log"
}

echo "=== overnight campaign: goal=$GOAL across $SHARDS parallel shards, started $(date -u +%FT%TZ) ===" >> evidence/apply/overnight.log

for i in $(seq 0 $((SHARDS-1))); do
  run_shard "$i" &
done
wait

echo "=== all shards finished at $(date -u +%FT%TZ) ===" >> evidence/apply/overnight.log
