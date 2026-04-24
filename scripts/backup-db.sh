#!/usr/bin/env bash
# =============================================================================
# Agent HQ Database Backup Script
# =============================================================================
# Backs up the Agent HQ production SQLite database to:
#   1. Local backup directory (with 30-day retention)
#   2. Private Git repo (if configured) for off-machine storage
#
# Usage:
#   ./scripts/backup-db.sh              # normal backup
#   ./scripts/backup-db.sh --verify     # backup + verify restore to temp DB
#
# Logs: /Users/nordini/agent-hq/logs/backup.log
# Note: launchd/cron must point at this script's real path.
# =============================================================================

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
REPO_DIR="/Users/nordini/agent-hq"
DB_PATH="${AGENT_HQ_DB_PATH:-$REPO_DIR/agent-hq.db}"
BACKUP_DIR="$REPO_DIR/backups"
LOG_DIR="$REPO_DIR/logs"
LOG_FILE="$LOG_DIR/backup.log"
BACKUP_REPO_DIR="${BACKUP_REPO_DIR:-/Users/nordini/agent-hq-backups}"
RETAIN_DAYS=30
VERIFY="${1:-}"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M)
DATE=$(date +%Y-%m-%d)
BACKUP_FILENAME="agent-hq_${TIMESTAMP}.db"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_FILENAME"

# ── Helpers ──────────────────────────────────────────────────────────────────
log() {
  local level="$1"; shift
  local msg="$*"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $msg" | tee -a "$LOG_FILE"
}

die() {
  log ERROR "$*"
  exit 1
}

# ── Pre-flight ───────────────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR" "$LOG_DIR"

[[ -f "$DB_PATH" ]] || die "Source database not found: $DB_PATH"

REMOTE_ENABLED=true
if [[ ! -d "$BACKUP_REPO_DIR" ]]; then
  REMOTE_ENABLED=false
fi

log INFO "=== Agent HQ Backup START ==="
log INFO "Source DB: $DB_PATH ($(du -sh "$DB_PATH" | cut -f1))"
log INFO "Backup target: $BACKUP_PATH"

# ── 1. Create local backup using SQLite's online backup ──────────────────────
# Use sqlite3 .backup command for a consistent snapshot (safe on live DB)
if command -v sqlite3 &>/dev/null; then
  sqlite3 "$DB_PATH" ".backup '$BACKUP_PATH'" \
    || die "sqlite3 .backup failed"
else
  # Fallback: cp (less safe if WAL mode is active, but usually fine)
  cp "$DB_PATH" "$BACKUP_PATH" \
    || die "cp backup failed"
fi

BACKUP_SIZE=$(du -sh "$BACKUP_PATH" | cut -f1)
log INFO "Local backup created: $BACKUP_PATH ($BACKUP_SIZE)"

# ── 2. Compress for remote push ───────────────────────────────────────────────
COMPRESSED_PATH="${BACKUP_PATH}.gz"
gzip -k "$BACKUP_PATH" -c > "$COMPRESSED_PATH" \
  || die "Compression failed"
COMPRESSED_SIZE=$(du -sh "$COMPRESSED_PATH" | cut -f1)
log INFO "Compressed: $COMPRESSED_PATH ($COMPRESSED_SIZE)"

# ── 3. Push to GitHub backup repo ────────────────────────────────────────────
REMOTE_STATUS="not configured"
if [[ "$REMOTE_ENABLED" == true ]]; then
  REMOTE_FILENAME="${DATE}/agent-hq_${TIMESTAMP}.db.gz"
  REMOTE_DIR="$BACKUP_REPO_DIR/$DATE"

  mkdir -p "$REMOTE_DIR"
  cp "$COMPRESSED_PATH" "$BACKUP_REPO_DIR/$REMOTE_FILENAME"

  cd "$BACKUP_REPO_DIR"
  git add "$REMOTE_FILENAME"
  git commit -m "backup: agent-hq_${TIMESTAMP} (${BACKUP_SIZE} raw, ${COMPRESSED_SIZE} gz)" \
    || { log WARN "git commit failed — nothing to commit or git error"; }
  git push origin main 2>&1 | tee -a "$LOG_FILE" \
    || die "git push to backup repo failed"

  log INFO "Remote backup pushed: $BACKUP_REPO_DIR/$REMOTE_FILENAME"
  REMOTE_STATUS="configured"
else
  log WARN "Remote backup repo not found: $BACKUP_REPO_DIR (skipping off-machine push)"
fi

# Clean compressed file from backup dir (keep only uncompressed locally)
rm -f "$COMPRESSED_PATH"

# ── 4. Local retention: prune files older than RETAIN_DAYS days ──────────────
PRUNED=0
while IFS= read -r -d '' old_file; do
  rm -f "$old_file"
  log INFO "Pruned old backup: $old_file"
  PRUNED=$((PRUNED + 1))
done < <(find "$BACKUP_DIR" -name "*.db" -mtime "+${RETAIN_DAYS}" -print0)

log INFO "Retention: pruned $PRUNED file(s) older than ${RETAIN_DAYS} days"

# ── 5. Optional: verify restore ──────────────────────────────────────────────
if [[ "$VERIFY" == "--verify" ]]; then
  log INFO "Running restore verification..."
  TEMP_DB=$(mktemp /tmp/agent-hq-verify-XXXXXX.db)
  cp "$BACKUP_PATH" "$TEMP_DB"

  TASK_COUNT=$(sqlite3 "$TEMP_DB" "SELECT COUNT(*) FROM tasks;" 2>/dev/null || echo "error")
  rm -f "$TEMP_DB"

  if [[ "$TASK_COUNT" =~ ^[0-9]+$ ]]; then
    log INFO "Restore verification PASSED — task count in backup: $TASK_COUNT"
  else
    die "Restore verification FAILED — could not read task count from backup DB"
  fi
fi

# ── 6. Summary ────────────────────────────────────────────────────────────────
log INFO "=== Agent HQ Backup COMPLETE ==="
log INFO "Backup: $BACKUP_FILENAME | Size: $BACKUP_SIZE | Retained locally for ${RETAIN_DAYS}d | Off-machine: $REMOTE_STATUS"
