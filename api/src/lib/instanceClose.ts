/**
 * instanceClose.ts — shared helper for closing a job instance and terminating
 * the associated agent session.
 *
 * Extracted from PUT /instances/:id/complete so the same logic can be called
 * atomically from POST /tasks/:id/outcome when the outcome is terminal.
 */

import type Database from 'better-sqlite3';
import { abortChatRunBySessionKey } from '../runtimes/OpenClawRuntime';
import { destroyAgentContext } from '../services/browserPool';
import { recordRunCheckIn } from './runObservability';
import { removeTaskWorktree } from '../services/worktreeManager';

/**
 * Terminal outcomes that should automatically close the instance and terminate
 * the agent session when posted via POST /tasks/:id/outcome.
 *
 * Intermediate check-in outcomes (e.g. deployed_live, which is Step A of some
 * deployment-stage workflows) are intentionally NOT in this list — those
 * workflows require two sequential outcome posts and the instance must stay
 * open between them.
 */
export const TERMINAL_OUTCOMES = new Set([
  'completed_for_review',
  'qa_pass',
  'qa_fail',
  'live_verified',
  'blocked',
  'failed',
]);

export function isTerminalOutcome(outcome: string): boolean {
  return TERMINAL_OUTCOMES.has(outcome);
}

export interface CloseInstanceOptions {
  db: Database.Database;
  instanceId: number;
  /** Final status to stamp on the instance. Defaults to 'done'. */
  status?: 'done' | 'failed';
  summary?: string | null;
  outcome?: string | null;
  /** If true, skip if the instance is already in a terminal state. */
  skipIfAlreadyDone?: boolean;
}

export interface CloseInstanceResult {
  closed: boolean;
  /** 'already_done' when skipIfAlreadyDone=true and instance was already terminal. */
  reason?: 'already_done' | 'not_found';
}

/**
 * closeInstance — marks a job_instance as complete, records a completion
 * check-in, destroys the browser context, and asynchronously sends chat.abort
 * to terminate the agent session.
 *
 * This is a best-effort termination: session abort failures are logged but
 * do not cause the function to throw. The DB update is always authoritative.
 */
export async function closeInstance(opts: CloseInstanceOptions): Promise<CloseInstanceResult> {
  const { db, instanceId, status = 'done', summary, outcome, skipIfAlreadyDone = false } = opts;

  // Use a simple SELECT on job_instances only first — avoids SQLITE_ERROR if
  // schema is minimal (e.g. in tests). Richer fields are fetched below only
  // if we actually proceed with closing.
  const basicInstance = db.prepare(`SELECT id, status FROM job_instances WHERE id = ?`).get(instanceId) as { id: number; status: string } | undefined;
  if (!basicInstance) {
    return { closed: false, reason: 'not_found' };
  }

  if (skipIfAlreadyDone && (basicInstance.status === 'done' || basicInstance.status === 'failed')) {
    return { closed: false, reason: 'already_done' };
  }

  // Fetch full instance row with agent details (best-effort; may fail if schema is minimal)
  let instance: Record<string, unknown> | undefined;
  try {
    instance = db.prepare(`
      SELECT ji.*, a.session_key AS agent_session_key, a.repo_path AS agent_repo_path
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id
      WHERE ji.id = ?
    `).get(instanceId) as Record<string, unknown> | undefined;
  } catch {
    instance = basicInstance as Record<string, unknown>;
  }
  if (!instance) instance = basicInstance as Record<string, unknown>;

  const finalStatus: 'done' | 'failed' = ['done', 'failed'].includes(status) ? status : 'done';

  // ── 1. Mark instance complete ─────────────────────────────────────────────
  // Use a graceful UPDATE: try with completed_at first; fall back to status-only
  // if the column doesn't exist (e.g. minimal test schemas).
  try {
    db.prepare(`
      UPDATE job_instances
      SET status = ?,
          completed_at = datetime('now'),
          runtime_ended_at = COALESCE(runtime_ended_at, datetime('now')),
          runtime_end_success = COALESCE(runtime_end_success, ?),
          runtime_end_error = COALESCE(runtime_end_error, ?),
          runtime_end_source = COALESCE(runtime_end_source, 'task_outcome_auto_close')
      WHERE id = ?
    `).run(finalStatus, finalStatus === 'done' ? 1 : 0, finalStatus === 'failed' ? (summary ?? `Terminal outcome: ${outcome ?? finalStatus}`) : null, instanceId);
  } catch {
    try {
      db.prepare(`UPDATE job_instances SET status = ? WHERE id = ?`).run(finalStatus, instanceId);
    } catch (e2) {
      console.warn(`[instanceClose] Could not update instance ${instanceId} status (non-fatal):`, e2 instanceof Error ? e2.message : e2);
    }
  }

  // ── 2. Record completion check-in (best-effort — may fail in minimal schemas) ─
  try {
    recordRunCheckIn(db, {
      instanceId,
      stage: 'completion',
      summary: summary ?? null,
      outcome: outcome ?? finalStatus,
      meaningfulOutput: true,
      statusLabel: finalStatus,
      forceNote: true,
      runtimeEndSuccess: finalStatus === 'done',
      runtimeEndError: finalStatus === 'failed' ? (summary ?? `Terminal outcome: ${outcome ?? finalStatus}`) : null,
      runtimeEndSource: 'task_outcome_auto_close',
    });
  } catch {
    // Non-fatal in minimal-schema environments (e.g. tests without instance_artifacts)
  }

  try {
    // Resolve agent name for log entries
    const agentNameRow = instance.agent_id
      ? db.prepare(`SELECT name, job_title FROM agents WHERE id = ?`).get(instance.agent_id) as { name: string; job_title: string | null } | undefined
      : undefined;
    const logJobTitle = agentNameRow?.job_title || agentNameRow?.name || String(instance.agent_id ?? 'unknown');

    if (summary) {
      db.prepare(`
        INSERT INTO logs (instance_id, agent_id, job_title, level, message)
        VALUES (?, ?, ?, 'info', ?)
      `).run(instanceId, instance.agent_id, logJobTitle, `Agent completion report (auto-close): ${summary}`);
    }

    db.prepare(`
      INSERT INTO logs (instance_id, agent_id, job_title, level, message)
      VALUES (?, ?, ?, 'info', ?)
    `).run(instanceId, instance.agent_id, logJobTitle, `Job instance ${instanceId} auto-closed by terminal outcome (${outcome ?? finalStatus})`);
  } catch {
    // Non-fatal in minimal-schema environments
  }

  // ── 3. Destroy browser context ────────────────────────────────────────────
  const agentSessionKey = instance.agent_session_key as string | null;
  const slugMatch = agentSessionKey?.match(/^agent:([^:]+):/);
  const agentSlug = slugMatch ? slugMatch[1] : null;
  if (agentSlug) {
    destroyAgentContext(agentSlug, instanceId).catch((err: unknown) => {
      console.warn(`[instanceClose] Browser context cleanup failed for instance ${instanceId} (non-fatal):`, err instanceof Error ? err.message : err);
    });
  }

  // ── 4. Terminate agent session (async, fire-and-forget) ───────────────────
  const instanceSessionKey = instance.session_key as string | null;
  if (instanceSessionKey) {
    setImmediate(() => {
      try {
        const result = abortChatRunBySessionKey(instanceSessionKey, `terminal outcome: ${outcome ?? finalStatus}`);
        if (!result.ok && result.status !== 'already_gone') {
          console.warn(`[instanceClose] Session abort non-fatal for instance ${instanceId} (status=${result.status}): ${result.error ?? 'unknown'}`);
        } else {
          console.log(`[instanceClose] Session abort for instance ${instanceId}: ${result.status}`);
        }
      } catch (err) {
        console.warn(`[instanceClose] Session abort threw for instance ${instanceId} (non-fatal):`, err instanceof Error ? err.message : err);
      }
    });
  }

  // ── 5. Worktree cleanup (non-blocking) ────────────────────────────────────
  const worktreePath = instance.worktree_path as string | null;
  const agentRepoPath = instance.agent_repo_path as string | null;
  if (worktreePath && agentRepoPath) {
    setImmediate(() => {
      try {
        const result = removeTaskWorktree({ repoPath: agentRepoPath, worktreePath });
        if (result.removed) {
          console.log(`[instanceClose] Cleaned up worktree: ${worktreePath}`);
        } else if (result.error) {
          console.warn(`[instanceClose] Failed to clean up worktree ${worktreePath}: ${result.error}`);
        }
      } catch (wtErr) {
        console.warn(`[instanceClose] Worktree cleanup error for instance ${instanceId}:`, wtErr);
      }
    });
  }

  console.log(`[instanceClose] Instance ${instanceId} auto-closed (${finalStatus}) via terminal outcome: ${outcome ?? finalStatus}`);
  return { closed: true };
}
