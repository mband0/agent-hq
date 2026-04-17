import type Database from 'better-sqlite3';
import { getDb } from '../db/client';
import { notifyTelegram } from '../integrations/telegram';
import { HEARTBEAT_STALE_MS, START_CHECKIN_GRACE_MS } from '../lib/runObservability';
import { writeTaskHistory } from '../lib/taskHistory';
import { pruneOrphanedWorktrees, removeTaskWorktree, resolveWorktreeBasePath } from '../services/worktreeManager';

const DEFAULT_TIMEOUT_MINUTES = 20;
const DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MINUTES * 60_000;
const POLL_INTERVAL_MS = 60_000; // check every 60s
const WORKTREE_PRUNE_INTERVAL_MS = 30 * 60_000; // prune orphaned worktrees every 30 min

interface WatchdogRow {
  id: number;
  agent_id: number;
  status: string;
  dispatched_at: string | null;
  created_at: string;
  started_at: string | null;
  task_id: number | null;
  timeout_seconds: number | null;
  startup_grace_seconds: number | null;
  heartbeat_stale_seconds: number | null;
  worktree_path: string | null;
  repo_path: string | null;
  artifact_started_at: string | null;
  last_agent_heartbeat_at: string | null;
  last_meaningful_output_at: string | null;
  agent_name: string | null;
  job_title: string | null;
  task_title: string | null;
}

interface WatchdogDecision {
  shouldFail: boolean;
  reason: string | null;
  elapsedMs: number;
}

function normalizeTimestamp(raw?: string | null): number | null {
  if (!raw) return null;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZ = normalized.endsWith('Z') ? normalized : `${normalized}Z`;
  const ms = new Date(withZ).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function pickLatestTimestamp(...values: Array<string | null | undefined>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    const parsed = normalizeTimestamp(value);
    if (parsed !== null && (latest === null || parsed > latest)) latest = parsed;
  }
  return latest;
}

/**
 * Build a compact human-readable label for a watchdog notification.
 * Preferred shape: "Forge / Agency — Backend" (agent / job title)
 * Falls back to agent-only, job-only, or "unknown agent" when data is missing.
 * Appends task title in quotes when available and fits.
 */
export function formatActorLabel(inst: Pick<WatchdogRow, 'agent_name' | 'job_title' | 'task_title'>): string {
  const parts: string[] = [];
  if (inst.agent_name) parts.push(inst.agent_name);
  if (inst.job_title) parts.push(inst.job_title);
  let label = parts.length > 0 ? parts.join(' / ') : 'unknown agent';
  if (inst.task_title) label += ` — "${inst.task_title}"`;
  return label;
}

export function evaluateWatchdogDecision(inst: WatchdogRow, now = new Date()): WatchdogDecision {
  const timeoutMs = inst.timeout_seconds && inst.timeout_seconds > 0
    ? inst.timeout_seconds * 1000
    : DEFAULT_TIMEOUT_MS;

  // Per-agent overrides for startup grace and heartbeat stale; fall back to global defaults.
  const effectiveStartCheckinGraceMs = inst.startup_grace_seconds && inst.startup_grace_seconds > 0
    ? inst.startup_grace_seconds * 1000
    : START_CHECKIN_GRACE_MS;
  const effectiveHeartbeatStaleMs = inst.heartbeat_stale_seconds && inst.heartbeat_stale_seconds > 0
    ? inst.heartbeat_stale_seconds * 1000
    : HEARTBEAT_STALE_MS;

  const queuedAtMs = pickLatestTimestamp(inst.dispatched_at, inst.created_at);
  const startedAtMs = pickLatestTimestamp(inst.started_at, inst.artifact_started_at);
  const heartbeatAtMs = normalizeTimestamp(inst.last_agent_heartbeat_at);
  const outputAtMs = normalizeTimestamp(inst.last_meaningful_output_at);

  // Pre-start lifecycle: queued/dispatched work (or a "running" row with no actual start signal yet)
  // should be judged by startup grace from dispatch/creation, not by full execution timeout.
  if (!startedAtMs) {
    const startupElapsedMs = queuedAtMs === null ? 0 : now.getTime() - queuedAtMs;
    if (startupElapsedMs >= effectiveStartCheckinGraceMs) {
      return {
        shouldFail: true,
        reason: `startup timeout: no real start/check-in within ${Math.floor(effectiveStartCheckinGraceMs / 60000)}m`,
        elapsedMs: startupElapsedMs,
      };
    }
    return { shouldFail: false, reason: null, elapsedMs: startupElapsedMs };
  }

  const executionElapsedMs = now.getTime() - startedAtMs;
  if (executionElapsedMs >= timeoutMs) {
    return {
      shouldFail: true,
      reason: `execution timeout: exceeded ${Math.ceil(timeoutMs / 60000)}m from real start`,
      elapsedMs: executionElapsedMs,
    };
  }

  const lastLiveSignalMs = pickLatestTimestamp(
    inst.last_agent_heartbeat_at,
    inst.last_meaningful_output_at,
    inst.started_at,
    inst.artifact_started_at,
  );
  const staleElapsedMs = lastLiveSignalMs === null ? executionElapsedMs : now.getTime() - lastLiveSignalMs;
  if (staleElapsedMs >= effectiveHeartbeatStaleMs) {
    const signalLabel = outputAtMs && (!heartbeatAtMs || outputAtMs >= heartbeatAtMs)
      ? 'meaningful output'
      : heartbeatAtMs
        ? 'heartbeat'
        : 'start signal';
    return {
      shouldFail: true,
      reason: `stale run: no ${signalLabel} for ${Math.floor(staleElapsedMs / 60000)}m`,
      elapsedMs: executionElapsedMs,
    };
  }

  return { shouldFail: false, reason: null, elapsedMs: executionElapsedMs };
}

export function runWatchdogPass(db: Database.Database, now = new Date()): void {
  const stuck = db.prepare(`
    SELECT ji.id, ji.agent_id, ji.status, ji.dispatched_at, ji.created_at,
           ji.started_at, ji.task_id, ji.worktree_path, a.timeout_seconds, a.repo_path,
           a.startup_grace_seconds, a.heartbeat_stale_seconds,
           ia.started_at AS artifact_started_at,
           ia.last_agent_heartbeat_at,
           ia.last_meaningful_output_at,
           a.name AS agent_name,
           a.job_title AS job_title,
           t.title AS task_title
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id
      LEFT JOIN instance_artifacts ia ON ia.instance_id = ji.id
      LEFT JOIN tasks t ON t.id = ji.task_id
      WHERE ji.status IN ('running', 'dispatched', 'queued')
  `).all() as WatchdogRow[];

  for (const inst of stuck) {
    const decision = evaluateWatchdogDecision(inst, now);
    if (!decision.shouldFail || !decision.reason) continue;

    const elapsedMin = Math.floor(decision.elapsedMs / 60000);
    const completedAt = now.toISOString();
    db.prepare(`
      UPDATE job_instances
      SET status = 'failed',
          error  = ?,
          completed_at = ?,
          runtime_ended_at = COALESCE(runtime_ended_at, ?),
          runtime_end_success = COALESCE(runtime_end_success, 0),
          runtime_end_error = COALESCE(runtime_end_error, ?),
          runtime_end_source = COALESCE(runtime_end_source, 'watchdog')
      WHERE id = ? AND status IN ('running', 'dispatched', 'queued')
    `).run(
      `Watchdog: ${decision.reason}`,
      completedAt,
      completedAt,
      `Watchdog: ${decision.reason}`,
      inst.id
    );

    if (inst.task_id) {
      const cleared = db.prepare(`
        UPDATE tasks SET active_instance_id = NULL, updated_at = datetime('now')
        WHERE id = ? AND active_instance_id = ?
      `).run(inst.task_id, inst.id);
      if (cleared.changes > 0) {
        writeTaskHistory(db, inst.task_id, 'watchdog', 'active_instance_id', String(inst.id), null);
      }
    }

    db.prepare(`
      INSERT INTO logs (instance_id, agent_id, level, message)
      VALUES (?, ?, 'warn', ?)
    `).run(
      inst.id,
      inst.agent_id,
      `Watchdog: instance #${inst.id} was auto-failed from "${inst.status}" after ${elapsedMin}m — ${decision.reason} (task_id=${inst.task_id ?? 'none'})`
    );

    if (inst.worktree_path && inst.repo_path) {
      try {
        removeTaskWorktree({ repoPath: inst.repo_path, worktreePath: inst.worktree_path });
      } catch (wtErr) {
        console.warn(`[watchdog] Worktree cleanup failed for instance #${inst.id}:`, wtErr);
      }
    }

    const actorLabel = formatActorLabel(inst);
    console.log(`[watchdog] Auto-failed instance #${inst.id} (${elapsedMin}m elapsed, task=${inst.task_id ?? 'none'}) — ${decision.reason}`);
    notifyTelegram(`⏰ Watchdog: ${actorLabel} auto-failed after ${elapsedMin}m (instance #${inst.id}${inst.task_id ? `, task #${inst.task_id}` : ''}) — ${decision.reason}`);
  }
}

export function startWatchdog(): void {
  console.log(`[watchdog] Starting — will auto-fail instances based on per-job timeout_seconds (default ${DEFAULT_TIMEOUT_MINUTES}m)`);

  setInterval(() => {
    const db = getDb();
    runWatchdogPass(db, new Date());
  }, POLL_INTERVAL_MS);

  // ── Orphaned worktree pruning (task #365) ────────────────────────────────
  // Every 30 minutes, scan agent workspace directories for stale task worktrees.
  // A worktree is orphaned if it's >24h old and has no live instance.
  setInterval(() => {
    try {
      const db = getDb();

      // Find all agents with a repo_path (worktree-enabled)
      const agents = db.prepare(`
        SELECT id, name, workspace_path, repo_path, os_user
        FROM agents
        WHERE repo_path IS NOT NULL AND repo_path != ''
          AND workspace_path IS NOT NULL AND workspace_path != ''
      `).all() as Array<{ id: number; name: string; workspace_path: string; repo_path: string; os_user: string | null }>;

      for (const agent of agents) {
        const basePath = resolveWorktreeBasePath({
          osUser: agent.os_user,
          workspacePath: agent.workspace_path,
        });
        const result = pruneOrphanedWorktrees({
          repoPath: agent.repo_path,
          basePath,
          maxAgeHours: 24,
          isActiveCheck: (taskId: number) => {
            const row = db.prepare(`
              SELECT COUNT(*) as n
              FROM job_instances
              WHERE task_id = ?
                AND status IN ('queued', 'dispatched', 'running')
            `).get(taskId) as { n: number };
            return row.n > 0;
          },
        });

        if (result.pruned.length > 0) {
          const agentLabel = agent.name || `agent #${agent.id}`;
          console.log(`[watchdog] Pruned ${result.pruned.length} orphaned worktree(s) for ${agentLabel}`);
          notifyTelegram(`🧹 Watchdog: pruned ${result.pruned.length} orphaned worktree(s) for ${agentLabel}`);
        }
      }
    } catch (err) {
      console.error('[watchdog] Worktree prune error:', err);
    }
  }, WORKTREE_PRUNE_INTERVAL_MS);
}
