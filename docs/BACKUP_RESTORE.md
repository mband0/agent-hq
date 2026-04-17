# Atlas HQ — Backup & Restore Runbook

## Overview

The Atlas HQ production database (`agent-hq.db`) is backed up automatically every hour via cron. Each backup is stored in two locations:

| Location | Path | Retention |
|---|---|---|
| **Local** | `~/agent-hq/backups/` | 30 days |
| **Remote (Git host)** | `<your-private-backup-repo>` | Indefinite |

Backups use SQLite's `.backup` command for a consistent point-in-time snapshot safe to take on a live database.

---

## Backup Schedule

- **Frequency:** Every hour (cron `0 * * * *`)
- **Script:** `~/agent-hq/scripts/backup-db.sh`
- **Logs:** `~/agent-hq/logs/backup-cron.log`
- **Remote repo:** `<your-private-backup-repo>`
- **Local backup repo dir:** `~/agent-hq-backups/`

---

## Verify Backup Health

```bash
# View recent backups
ls -lht ~/agent-hq/backups/ | head -10

# View backup log
tail -40 ~/agent-hq/logs/backup-cron.log

# Run backup manually with restore verification
~/agent-hq/scripts/backup-db.sh --verify
```

---

## Restore Procedure

### Step 0 — Identify the backup to restore

**From local backups:**
```bash
ls -lht ~/agent-hq/backups/
```

Pick the most recent file before the incident (format: `atlas-hq_YYYY-MM-DD_HH-MM.db`).

**From GitHub (if local backups are gone):**
```bash
cd ~/agent-hq-backups
git pull origin main
ls -la YYYY-MM-DD/      # replace with the date you want
```

Download the `.db.gz` file you want:
```bash
# Copy to restore working area
cp YYYY-MM-DD/atlas-hq_YYYY-MM-DD_HH-MM.db.gz /tmp/
cd /tmp && gunzip atlas-hq_YYYY-MM-DD_HH-MM.db.gz
```

---

### Step 1 — Stop the API

```bash
pm2 stop agent-hq-api
```

Verify it stopped:
```bash
pm2 list | grep agent-hq-api
# Should show "stopped"
```

---

### Step 2 — Preserve the current (broken) database

```bash
# Rename the current DB so you can recover it if needed
mv ~/agent-hq/agent-hq.db ~/agent-hq/agent-hq.db.broken-$(date +%Y%m%d%H%M)
```

---

### Step 3 — Restore the backup

**From local backup:**
```bash
cp ~/agent-hq/backups/atlas-hq_YYYY-MM-DD_HH-MM.db \
   ~/agent-hq/agent-hq.db
```

**From GitHub (decompressed in Step 0):**
```bash
cp /tmp/atlas-hq_YYYY-MM-DD_HH-MM.db \
   ~/agent-hq/agent-hq.db
```

---

### Step 4 — Verify the restored database

```bash
sqlite3 ~/agent-hq/agent-hq.db "SELECT COUNT(*) FROM tasks;"
sqlite3 ~/agent-hq/agent-hq.db "SELECT COUNT(*) FROM agents;"
sqlite3 ~/agent-hq/agent-hq.db \
  "SELECT title, status FROM tasks ORDER BY created_at DESC LIMIT 10;"
```

Expected: task count should be non-zero and close to expected operational value (700+ in production as of April 2026).

---

### Step 5 — Restart the API

```bash
pm2 start agent-hq-api
```

Wait a few seconds, then check it came up healthy:
```bash
pm2 list | grep agent-hq-api
curl -s http://localhost:3501/api/v1/tasks?limit=5 | head -c 300
```

---

### Step 6 — Confirm in the UI

Open `http://localhost:3500` and verify:
- Tasks board shows expected tasks
- Projects and sprints are visible
- No database errors in PM2 logs: `pm2 logs agent-hq-api --lines 20`

---

## What Went Wrong in April 2026

On 2026-04-04, the API restarted against an empty `agent-hq.db` file after a merge operation. All 700+ task records were lost. No backup existed at the time.

**Root cause:** no backup infrastructure, and the API initializes a fresh SQLite schema on startup if it finds a valid (but empty) DB file.

**Prevention (now in place):**
- Hourly backups to `~/agent-hq/backups/` (local)
- Each backup pushed to a private off-machine repository
- 30-day local retention enforced by the backup script
- Script uses `sqlite3 .backup` for crash-safe snapshots

---

## Monitoring

Backup success/failure is written to:
- **Cron log:** `~/agent-hq/logs/backup-cron.log`
- **Script log:** `~/agent-hq/logs/backup.log`

To view recent backup status:
```bash
tail -30 ~/agent-hq/logs/backup-cron.log
```

A successful backup entry looks like:
```
[2026-04-04 19:09:24] [INFO] === Atlas HQ Backup COMPLETE ===
[2026-04-04 19:09:24] [INFO] Backup: atlas-hq_2026-04-04_19-09.db | Size: 26M | Retained locally for 30d | Off-machine: GitHub
```

If the log is stale (last entry is hours/days old), the cron may not be running. Check:
```bash
crontab -l | grep backup
```

---

## Remote Backup Access

Remote repo: `<your-private-backup-repo>`

```bash
# Clone fresh copy (if local backup repo is missing)
git clone <your-private-backup-repo> ~/agent-hq-backups

# Pull latest
cd ~/agent-hq-backups && git pull origin main

# List all available backups
find ~/agent-hq-backups -name "*.db.gz" | sort
```
