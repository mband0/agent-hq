import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import type Database from 'better-sqlite3';
import { OPENCLAW_BIN, OPENCLAW_CONFIG_PATH, OPENCLAW_PATH } from '../config';
import { buildGatewayRunSessionKey } from './sessionKeys';
import { removeTaskWorktree } from '../services/worktreeManager';

const LIVE_TASK_STATUSES = ['dispatched', 'in_progress', 'stalled'] as const;
const LIVE_INSTANCE_STATUSES = ['queued', 'dispatched', 'running'] as const;

// ── OpenClaw env config (mirrors integrations/openclaw.ts) ───────────────────
function readGatewayTokenFromConfig(): string | null {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw) as { gateway?: { auth?: { token?: string } } };
    const token = cfg.gateway?.auth?.token;
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

function getGatewayAuthToken(): string {
  return process.env.OPENCLAW_GATEWAY_TOKEN ?? readGatewayTokenFromConfig() ?? '';
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function isQaAgent(db: Database.Database, agentId: number | null | undefined): boolean {
  if (!agentId) return false;

  const row = db.prepare(`
    SELECT name, job_title
    FROM agents
    WHERE id = ?
  `).get(agentId) as { name: string | null; job_title: string | null } | undefined;
  const haystack = ((row?.job_title ?? '') + ' ' + (row?.name ?? '')).toLowerCase();

  return /\bqa\b/.test(haystack);
}

function taskAllowsReviewExecution(db: Database.Database, task: { agent_id?: number | null; active_instance_id: number | null }): boolean {
  if (!task.active_instance_id || !task.agent_id || !isQaAgent(db, task.agent_id)) return false;

  const instance = db.prepare(`
    SELECT agent_id, status
    FROM job_instances
    WHERE id = ?
  `).get(task.active_instance_id) as { agent_id: number; status: string } | undefined;

  if (!instance) return false;
  if (instance.agent_id !== task.agent_id) return false;
  return LIVE_INSTANCE_STATUSES.includes(instance.status as typeof LIVE_INSTANCE_STATUSES[number]);
}

/**
 * Returns true when a deployment-stage instance is still live and owns
 * the task. Used by cleanupTaskExecutionLinkageForStatus to avoid prematurely
 * clearing active_instance_id when the task transitions to ready_to_merge or
 * deployed — the active instance needs to stay authoritative through both of
 * those states so it can post live_verified after deploy.
 */
function taskAllowsReleaseExecution(db: Database.Database, task: { agent_id?: number | null; active_instance_id: number | null }): boolean {
  if (!task.active_instance_id) return false;

  const instance = db.prepare(`
    SELECT agent_id, status
    FROM job_instances
    WHERE id = ?
  `).get(task.active_instance_id) as { agent_id: number; status: string } | undefined;

  if (!instance) return false;
  return LIVE_INSTANCE_STATUSES.includes(instance.status as typeof LIVE_INSTANCE_STATUSES[number]);
}

export function taskAllowsActiveExecution(status: string | null | undefined): boolean {
  return Boolean(status && LIVE_TASK_STATUSES.includes(status as typeof LIVE_TASK_STATUSES[number]));
}

export function cleanupDoneTaskWorktrees(db: Database.Database, taskId: number): number {
  const rows = db.prepare(`
    SELECT DISTINCT ji.worktree_path, a.repo_path
    FROM job_instances ji
    LEFT JOIN agents a ON a.id = ji.agent_id
    WHERE (
        ji.task_id = ?
        OR ji.worktree_path = ?
        OR ji.worktree_path LIKE ?
        OR ji.worktree_path = ?
        OR ji.worktree_path LIKE ?
      )
      AND ji.worktree_path IS NOT NULL
      AND ji.worktree_path != ''
      AND a.repo_path IS NOT NULL
      AND a.repo_path != ''
  `).all(
    taskId,
    `task-${taskId}`,
    `%/task-${taskId}`,
    `atlas-hq-task-${taskId}`,
    `%/atlas-hq-task-${taskId}`,
  ) as Array<{ worktree_path: string; repo_path: string }>;

  let removed = 0;
  for (const row of rows) {
    try {
      const result = removeTaskWorktree({
        repoPath: row.repo_path,
        worktreePath: row.worktree_path,
      });
      if (result.removed) removed++;
      else if (result.error) {
        console.warn(`[taskLifecycle] Worktree cleanup failed for done task #${taskId} at ${row.worktree_path}: ${result.error}`);
      }
    } catch (err) {
      console.warn(`[taskLifecycle] Worktree cleanup error for done task #${taskId} at ${row.worktree_path}:`, err);
    }
  }

  return removed;
}

// ── Async abort for orphaned instances ───────────────────────────────────────

// ── Watchdog: hard-kill via sessions.delete if chat.abort doesn't stick ──────

const WATCHDOG_GRACE_MS = 15_000;   // wait this long after chat.abort before checking
const WATCHDOG_POLL_INTERVAL_MS = 3_000; // how often to re-check session activity
const WATCHDOG_MAX_POLLS = 5;        // max re-checks after grace period

/**
 * Resolves the full OpenClaw session key (agent:<slug>:...) from the instance
 * payload. The DB stores the short key (hook:atlas:jobrun:<id>); the gateway
 * sessions.* methods require the agent-prefixed key.
 */
function resolveFullSessionKey(db: Database.Database, instanceId: number, shortKey: string): string | null {
  try {
    const row = db.prepare(`
      SELECT ji.payload_sent, a.session_key, a.openclaw_agent_id, a.name
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id
      WHERE ji.id = ?
    `).get(instanceId) as {
      payload_sent: string | null;
      session_key: string | null;
      openclaw_agent_id: string | null;
      name: string | null;
    } | undefined;

    const fromAgent = buildGatewayRunSessionKey(row ?? null, shortKey);
    if (fromAgent) return fromAgent;

    if (!row?.payload_sent) return null;
    const payload = JSON.parse(row.payload_sent) as { agentSlug?: string };
    if (!payload.agentSlug) return null;
    return `agent:${payload.agentSlug}:${shortKey}`;
  } catch {
    return null;
  }
}

/**
 * Polls the gateway sessions.get endpoint to see if the session's updatedAt
 * has changed since the baseline. Returns true if the session appears to still
 * be active (updatedAt advanced), false if it appears gone or quiet.
 */
function sessionStillActiveSync(fullSessionKey: string, baselineUpdatedAt: number): boolean {
  const args = [
    'gateway', 'call', 'sessions.get',
    '--json',
    '--timeout', '8000',
    '--params', JSON.stringify({ key: fullSessionKey }),
  ];

  const gatewayAuthToken = getGatewayAuthToken();
  if (gatewayAuthToken) {
    args.push('--token', gatewayAuthToken);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: OPENCLAW_PATH,
    OPENCLAW_HIDE_BANNER: '1',
    OPENCLAW_SUPPRESS_NOTES: '1',
  };

  const result = spawnSync(OPENCLAW_BIN, args, { encoding: 'utf-8', timeout: 10_000, env });
  if (result.error || result.status !== 0) return false;

  try {
    const parsed = JSON.parse(result.stdout ?? '{}') as { updatedAt?: number; messages?: unknown[] };
    // If the session has no messages at all, it's gone
    if (!parsed.messages || (parsed.messages as unknown[]).length === 0) return false;
    // If updatedAt advanced past the baseline, the session is still being written
    if (typeof parsed.updatedAt === 'number' && parsed.updatedAt > baselineUpdatedAt) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Force-kills a session by calling sessions.delete, which clears the session
 * queue and closes any active ACP runtimes — a hard kill that survives a soft
 * chat.abort being ignored by an in-flight agent.
 */
function hardKillSessionSync(fullSessionKey: string): { ok: boolean; error?: string } {
  const args = [
    'gateway', 'call', 'sessions.delete',
    '--json',
    '--timeout', '10000',
    '--params', JSON.stringify({ key: fullSessionKey }),
  ];

  const gatewayAuthToken = getGatewayAuthToken();
  if (gatewayAuthToken) {
    args.push('--token', gatewayAuthToken);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: OPENCLAW_PATH,
    OPENCLAW_HIDE_BANNER: '1',
    OPENCLAW_SUPPRESS_NOTES: '1',
  };

  const result = spawnSync(OPENCLAW_BIN, args, { encoding: 'utf-8', timeout: 12_000, env });

  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr ?? '').trim() || `sessions.delete exited with code ${result.status}` };
  }

  try {
    const parsed = JSON.parse(result.stdout ?? '{}') as { ok?: boolean };
    return { ok: parsed.ok === true };
  } catch {
    return { ok: true }; // exit 0 is good enough
  }
}

/**
 * Asynchronously aborts an orphaned job instance after task linkage has been
 * cleared. Uses spawn (not spawnSync) so it never blocks the event loop.
 *
 * Two-stage termination:
 * 1. Send chat.abort (soft signal) — this works most of the time.
 * 2. After WATCHDOG_GRACE_MS, check if the session is still active via
 *    sessions.get. If so, escalate to sessions.delete (hard kill), which
 *    clears the session queue and tears down the ACP runtime, guaranteeing
 *    the agent cannot post further check-ins.
 *
 * If the abort times out or fails, the instance is marked failed so it is not
 * left indefinitely in dispatched/running state.
 *
 * @param db          - SQLite database connection
 * @param instanceId  - The orphaned job_instance.id to abort
 * @param sessionKey  - The openclaw session key for the running instance (short form)
 * @param reason      - Human-readable reason for the abort (logged)
 */
export function abortOrphanedInstanceAsync(
  db: Database.Database,
  instanceId: number,
  sessionKey: string,
  reason: string,
): void {
  const ABORT_TIMEOUT_MS = 15_000;

  const args = [
    'gateway', 'call', 'chat.abort',
    '--json',
    '--timeout', '10000',
    '--params', JSON.stringify({ sessionKey }),
  ];

  const gatewayAuthToken = getGatewayAuthToken();
  if (gatewayAuthToken) {
    args.push('--token', gatewayAuthToken);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: OPENCLAW_PATH,
    OPENCLAW_HIDE_BANNER: '1',
    OPENCLAW_SUPPRESS_NOTES: '1',
  };

  let stdout = '';
  let stderr = '';
  let settled = false;

  const child = spawn(OPENCLAW_BIN, args, { env });

  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  const timeoutHandle = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill('SIGKILL');
    console.warn(`[taskLifecycle] abort timed out for instance #${instanceId} (${sessionKey})`);
    markInstanceFailed(db, instanceId, 'abort timed out after task cancel/stop');
  }, ABORT_TIMEOUT_MS);

  child.on('close', (code: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutHandle);

    const responseText = stdout.trim();
    const errorText = stderr.trim();

    // Treat "session not found" / "already gone" as a non-error success path
    const haystack = `${responseText} ${errorText}`.toLowerCase();
    const alreadyGone =
      (haystack.includes('session') || haystack.includes('run') || haystack.includes('target')) &&
      ['session not found', 'not found', 'no active run', 'not running', 'already_gone', 'missing']
        .some(s => haystack.includes(s));

    if (alreadyGone) {
      markInstanceCancelled(db, instanceId, 'already_gone');
      console.log(`[taskLifecycle] instance #${instanceId} already gone — ${reason}`);
      return;
    }

    if (code !== 0) {
      // Abort failed entirely — mark failed, no watchdog
      const failReason = errorText || `abort exited with code ${code}`;
      console.warn(`[taskLifecycle] abort failed for instance #${instanceId}: ${failReason}`);
      markInstanceFailed(db, instanceId, `abort failed after task cancel/stop: ${failReason}`);
      return;
    }

    // chat.abort succeeded (exit 0) — start watchdog to verify the session actually stops.
    // The soft signal may be ignored if the agent is between tool calls.
    console.log(`[taskLifecycle] chat.abort sent for instance #${instanceId} — starting watchdog (${WATCHDOG_GRACE_MS}ms grace, ${WATCHDOG_MAX_POLLS} polls)`);
    const baselineTs = Date.now();

    const watchdogTimer = setTimeout(() => {
      runAbortWatchdog(db, instanceId, sessionKey, reason, baselineTs);
    }, WATCHDOG_GRACE_MS);

    // Unref so the watchdog doesn't prevent Node from exiting if everything else is done
    watchdogTimer.unref();
  });

  child.on('error', (err: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutHandle);
    console.error(`[taskLifecycle] spawn error aborting instance #${instanceId}:`, err);
    markInstanceFailed(db, instanceId, `spawn error during abort: ${err.message}`);
  });
}

/**
 * Watchdog: runs after chat.abort grace period. Checks if the session is still
 * active via sessions.get polling; if still alive after all retries, escalates
 * to sessions.delete (hard kill).
 *
 * Fully non-blocking: uses recursive setTimeout so the event loop stays free.
 */
function runAbortWatchdog(
  db: Database.Database,
  instanceId: number,
  sessionKey: string,
  reason: string,
  baselineTs: number,
): void {
  // First check: is the instance already terminal?
  const inst = db.prepare(`SELECT status FROM job_instances WHERE id = ?`).get(instanceId) as { status: string } | undefined;
  if (!inst || ['done', 'failed', 'cancelled'].includes(inst.status)) {
    console.log(`[taskLifecycle:watchdog] instance #${instanceId} already terminal (${inst?.status ?? 'gone'}) — watchdog done`);
    return;
  }

  // Resolve the full OpenClaw session key (agent:<slug>:<key>)
  const maybeFullKey = resolveFullSessionKey(db, instanceId, sessionKey);
  if (!maybeFullKey) {
    // Can't resolve full key — assume soft abort was sufficient
    console.warn(`[taskLifecycle:watchdog] cannot resolve full session key for instance #${instanceId}, assuming soft abort was sufficient`);
    markInstanceCancelled(db, instanceId, 'succeeded');
    return;
  }
  const fullSessionKey: string = maybeFullKey;

  let pollCount = 0;

  function doPoll(): void {
    // Re-check instance status before each poll
    const current = db.prepare(`SELECT status FROM job_instances WHERE id = ?`).get(instanceId) as { status: string } | undefined;
    if (!current || ['done', 'failed', 'cancelled'].includes(current.status)) {
      console.log(`[taskLifecycle:watchdog] instance #${instanceId} became terminal during poll ${pollCount + 1} — watchdog done`);
      return;
    }

    pollCount++;
    const sessionActive = sessionStillActiveSync(fullSessionKey, baselineTs);

    if (!sessionActive) {
      console.log(`[taskLifecycle:watchdog] session gone for instance #${instanceId} at poll ${pollCount} — marking cancelled`);
      markInstanceCancelled(db, instanceId, 'succeeded');
      return;
    }

    console.log(`[taskLifecycle:watchdog] session still active for instance #${instanceId} at poll ${pollCount}/${WATCHDOG_MAX_POLLS}`);

    if (pollCount < WATCHDOG_MAX_POLLS) {
      // Schedule the next poll
      const t = setTimeout(doPoll, WATCHDOG_POLL_INTERVAL_MS);
      t.unref();
      return;
    }

    // All polls exhausted — escalate to hard kill
    console.warn(`[taskLifecycle:watchdog] session still active after ${WATCHDOG_MAX_POLLS} polls for instance #${instanceId} — escalating to sessions.delete`);
    const killResult = hardKillSessionSync(fullSessionKey);
    if (killResult.ok) {
      markInstanceCancelled(db, instanceId, 'hard_killed');
      console.log(`[taskLifecycle:watchdog] sessions.delete succeeded for instance #${instanceId} — marked cancelled (hard_killed)`);
    } else {
      console.error(`[taskLifecycle:watchdog] sessions.delete failed for instance #${instanceId}: ${killResult.error}`);
      markInstanceFailed(db, instanceId, `hard kill failed after soft abort was ignored: ${killResult.error}`);
    }
  }

  // Kick off the first poll immediately (we already waited WATCHDOG_GRACE_MS)
  doPoll();
}

function markInstanceCancelled(db: Database.Database, instanceId: number, abortStatus: string): void {
  try {
    db.prepare(`
      UPDATE job_instances
      SET status = 'cancelled',
          abort_attempted_at = COALESCE(abort_attempted_at, datetime('now')),
          abort_status = ?,
          abort_error = NULL,
          completed_at = datetime('now')
      WHERE id = ?
        AND status NOT IN ('done', 'failed', 'cancelled')
    `).run(abortStatus, instanceId);
  } catch (err) {
    console.error(`[taskLifecycle] failed to mark instance #${instanceId} as cancelled:`, err);
  }
}

function markInstanceFailed(db: Database.Database, instanceId: number, reason: string): void {
  try {
    db.prepare(`
      UPDATE job_instances
      SET status = 'failed',
          abort_attempted_at = COALESCE(abort_attempted_at, datetime('now')),
          abort_status = 'failed',
          abort_error = ?,
          error = ?,
          completed_at = datetime('now')
      WHERE id = ?
        AND status NOT IN ('done', 'failed', 'cancelled')
    `).run(reason, reason, instanceId);
  } catch (err) {
    console.error(`[taskLifecycle] failed to mark instance #${instanceId} as failed:`, err);
  }
}

// ── Exported lifecycle functions ─────────────────────────────────────────────

export function cleanupTaskExecutionLinkageForStatus(
  db: Database.Database,
  taskId: number,
  nextStatus?: string | null,
): boolean {
  const task = db.prepare(`
    SELECT id, status, agent_id, active_instance_id
    FROM tasks
    WHERE id = ?
  `).get(taskId) as { id: number; status: string; agent_id: number | null; active_instance_id: number | null } | undefined;

  if (!task) return false;

  const effectiveStatus = nextStatus ?? task.status;
  if (effectiveStatus === 'done') {
    cleanupDoneTaskWorktrees(db, taskId);
  }

  if (!task.active_instance_id) return false;

  if (taskAllowsActiveExecution(effectiveStatus)) return false;
  if (effectiveStatus === 'review' && taskAllowsReviewExecution(db, task)) return false;
  // Deployment-stage exception: the active instance must remain authoritative
  // through ready_to_merge and deployed so it can post live_verified after deploy.
  // Clearing active_instance_id here would cause the live_verified callback
  // to be rejected as instance_not_authoritative (observed on task #571).
  if ((effectiveStatus === 'ready_to_merge' || effectiveStatus === 'deployed') && taskAllowsReleaseExecution(db, task)) return false;

  // Capture orphaned instance info before clearing linkage
  const orphanedInstanceId = task.active_instance_id;
  const orphanedInstance = db.prepare(`
    SELECT id, session_key, status
    FROM job_instances
    WHERE id = ?
  `).get(orphanedInstanceId) as { id: number; session_key: string | null; status: string } | undefined;

  const result = db.prepare(`
    UPDATE tasks
    SET active_instance_id = NULL,
        updated_at = datetime('now')
    WHERE id = ?
      AND active_instance_id IS NOT NULL
  `).run(taskId);

  if (result.changes > 0 && orphanedInstance) {
    const { session_key: sessionKey, status: instanceStatus } = orphanedInstance;

    // Only abort instances that are still live (dispatched/running).
    // Queued instances have no active session to abort — just mark failed.
    const isLive = instanceStatus === 'dispatched' || instanceStatus === 'running';

    if (sessionKey && isLive) {
      // Fire-and-forget async abort — never blocks the event loop
      abortOrphanedInstanceAsync(
        db,
        orphanedInstanceId,
        sessionKey,
        `task #${taskId} cancelled/stopped (status → ${effectiveStatus})`,
      );
    } else if (instanceStatus === 'queued' || (isLive && !sessionKey)) {
      // Queued or live-but-sessionless: no session to abort, mark failed immediately
      markInstanceFailed(
        db,
        orphanedInstanceId,
        `orphaned by task #${taskId} cancel/stop (status → ${effectiveStatus}); no session key to abort`,
      );
    }
    // Already-terminal instances (done/failed) are left untouched
  }

  return result.changes > 0;
}

export function cleanupImpossibleTaskLifecycleStates(db: Database.Database): number {
  // Single-query batch cleanup: clears active_instance_id for any task that
  // does not have BOTH a live instance AND a valid-execution task status.
  // Replaces the previous N+1 per-task loop with a single UPDATE statement.
  //
  // A task is "validly executing" iff:
  //   - its task status is one of the live-execution statuses (dispatched, in_progress, stalled), AND
  //   - its active_instance_id points to a job_instance that is still live (queued, dispatched, running)
  //
  // OR:
  //   - its task status is one of the deployment-stage statuses (review, ready_to_merge, deployed), AND
  //   - its active_instance_id points to a live instance (queued, dispatched, running)
  //
  // The release-lane exception is critical: QA dispatch creates an instance and links
  // it via active_instance_id while the task remains in 'review'. Deployment-stage dispatch
  // creates an instance while the task is in 'ready_to_merge' or 'deployed'. Without these
  // exceptions, the next reconciler tick would clear active_instance_id, breaking
  // the authority chain and causing outcome posts to be rejected as
  // 'instance_not_authoritative'.
  //
  // Anything that does not satisfy either condition gets its active_instance_id cleared.
  const result = db.prepare(`
    UPDATE tasks
    SET active_instance_id = NULL,
        updated_at = datetime('now')
    WHERE active_instance_id IS NOT NULL
      AND NOT (
        status IN ('dispatched', 'in_progress', 'stalled', 'review', 'ready_to_merge', 'deployed')
        AND active_instance_id IN (
          SELECT id FROM job_instances
          WHERE status IN ('queued', 'dispatched', 'running')
        )
      )
  `).run();

  return result.changes;
}
