#!/usr/bin/env bash
# rotate-gateway-logs.sh — Rotate OpenClaw gateway logs before they hit maxFileBytes
#
# The OpenClaw gateway stops spawning agents when its log file reaches 512MB
# (maxFileBytes cap). This script checks the current day's log size and rotates
# it when it exceeds a threshold, then restarts the gateway to pick up the new file.
#
# Install as a cron job (every 5 minutes):
#   crontab -e
#   */5 * * * * /Users/nordini/agent-hq/scripts/rotate-gateway-logs.sh >> /tmp/gateway-log-rotate.log 2>&1
#
# See: openclaw/openclaw#61440

set -euo pipefail

LOG_DIR="${OPENCLAW_LOG_DIR:-/tmp/openclaw}"
THRESHOLD_MB="${GATEWAY_LOG_THRESHOLD_MB:-500}"
MAX_ROTATED="${GATEWAY_LOG_MAX_ROTATED:-3}"

TODAY=$(date +%Y-%m-%d)
LOG_FILE="${LOG_DIR}/openclaw-${TODAY}.log"

if [ ! -f "$LOG_FILE" ]; then
  exit 0
fi

# Get file size in MB
SIZE_BYTES=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
SIZE_MB=$((SIZE_BYTES / 1048576))

if [ "$SIZE_MB" -lt "$THRESHOLD_MB" ]; then
  exit 0
fi

echo "[$(date -Iseconds)] Gateway log ${LOG_FILE} is ${SIZE_MB}MB (threshold: ${THRESHOLD_MB}MB) — rotating"

# Rotate: move current to .1, shift existing rotated files
for i in $(seq $((MAX_ROTATED - 1)) -1 1); do
  next=$((i + 1))
  [ -f "${LOG_FILE}.${i}" ] && mv "${LOG_FILE}.${i}" "${LOG_FILE}.${next}"
done
mv "$LOG_FILE" "${LOG_FILE}.1"

# Delete oldest rotated files beyond MAX_ROTATED
for old in "${LOG_FILE}".*; do
  num="${old##*.}"
  if [ "$num" -gt "$MAX_ROTATED" ] 2>/dev/null; then
    rm -f "$old"
    echo "[$(date -Iseconds)] Deleted old rotated log: ${old}"
  fi
done

# Restart the gateway so it picks up the new (empty) log file
GATEWAY_PID=$(pgrep -f 'openclaw-gateway' | head -1 || true)
if [ -n "$GATEWAY_PID" ]; then
  echo "[$(date -Iseconds)] Restarting gateway (pid=${GATEWAY_PID})"
  kill -TERM "$GATEWAY_PID" 2>/dev/null || true
  sleep 2
  # Start gateway in background — detach from this shell
  nohup openclaw gateway start </dev/null >/dev/null 2>&1 &
  sleep 3
  NEW_PID=$(pgrep -f 'openclaw-gateway' | head -1 || true)
  if [ -n "$NEW_PID" ]; then
    echo "[$(date -Iseconds)] Gateway restarted (new pid=${NEW_PID})"
  else
    echo "[$(date -Iseconds)] WARNING: Gateway did not restart — check manually"
  fi
else
  echo "[$(date -Iseconds)] No gateway process found — skipping restart"
fi
