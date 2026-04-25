/**
 * eligibility.ts — Background lifecycle repair service
 *
 * Background passes must not mutate board workflow statuses like todo/ready/review.
 * Explicit user or agent actions own task progression. This service is limited to
 * recovering execution-state drift (for example stalled or unclaimed runtime work).
 */

import Database from 'better-sqlite3';
import { notifyTelegram } from '../integrations/telegram';
import { cleanupTaskExecutionLinkageForStatus } from '../lib/taskLifecycle';
import { requireReleaseGate } from '../lib/taskRelease';
import { writeTaskStatusChange } from '../lib/taskHistory';
import { resolveSprintTaskRoutingAssignment, resolveSprintTaskTransition } from '../lib/sprintTaskPolicy';

// ── Types ────────────────────────────────────────────────────────────────────

export interface EligibilityResult {
  promoted: number;   // retained for API compatibility; background pass should keep this at 0
  blocked: number;    // retained for API compatibility; background pass should keep this at 0
  stalled: number;    // in_progress → stalled
  unclaimed: number;  // dispatched → ready (unclaim)
}

interface TaskRow {
  id: number;
  status: string;
  agent_id: number | null;
  project_id: number | null;
  sprint_id: number | null;
  claimed_at: string | null;
  dispatched_at: string | null;
  retry_count: number;
  max_retries: number;
  review_owner_agent_id: number | null;
  updated_at: string;
  task_type: string | null;
  active_instance_id?: number | null;
  review_commit?: string | null;
  qa_verified_commit?: string | null;
}

interface RoutingConfigRow {
  stall_threshold_min: number;
  max_retries: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getRoutingConfig(db: Database.Database, agentId: number | null): RoutingConfigRow {
  // Task #596: routing_config_legacy has been removed. Read config from agents table.
  if (agentId == null) return { stall_threshold_min: 30, max_retries: 3 };
  try {
    const agentRow = db.prepare(
      `SELECT stall_threshold_min, max_retries FROM agents WHERE id = ?`
    ).get(agentId) as RoutingConfigRow | undefined;
    return agentRow ?? { stall_threshold_min: 30, max_retries: 3 };
  } catch {
    return { stall_threshold_min: 30, max_retries: 3 };
  }
}

/**
 * getSystemPolicyThreshold — reads threshold_seconds from the system_policies table.
 * Falls back to defaultSeconds if the policy row is missing or has a null threshold.
 * Allows admin-tunable thresholds without source code edits.
 */
function getSystemPolicyThreshold(db: Database.Database, policyKey: string, defaultSeconds: number): number {
  try {
    const row = db.prepare(
      `SELECT threshold_seconds FROM system_policies WHERE policy_key = ? AND enabled = 1`
    ).get(policyKey) as { threshold_seconds: number | null } | undefined;
    return row?.threshold_seconds ?? defaultSeconds;
  } catch {
    return defaultSeconds;
  }
}

function minutesSince(isoStr: string | null): number {
  if (!isoStr) return Infinity;
  const past = new Date(isoStr + (isoStr.endsWith('Z') ? '' : 'Z')).getTime();
  return (Date.now() - past) / 60000;
}

function resolveTaskRoutingTarget(
  db: Database.Database,
  sprintId: number | null,
  _projectId: number | null,
  taskType: string | null,
  status: string,
): { agent_id: number | null } {
  if (!taskType) return { agent_id: null };

  try {
    return resolveSprintTaskRoutingAssignment(db, sprintId, taskType, status);
  } catch {
    return { agent_id: null };
  }
}

function autoPromoteQaPassTasks(db: Database.Database, projectId: number | undefined, result: EligibilityResult): void {
  const projectFilter = projectId != null ? `AND t.project_id = ${projectId}` : '';
  const qaPassTasks = db.prepare(`
    SELECT t.*
    FROM tasks t
    WHERE t.status = 'qa_pass'
    ${projectFilter}
      AND t.active_instance_id IS NULL
  `).all() as TaskRow[];

  for (const task of qaPassTasks) {
    const transition = resolveSprintTaskTransition(
      db,
      task.sprint_id ?? null,
      'qa_pass',
      'approved_for_merge',
      task.task_type ?? null,
    );
    if (!transition || transition.enabled !== 1 || transition.lane !== 'auto') {
      continue;
    }

    try {
      requireReleaseGate(db, task as never, 'approved_for_merge');
    } catch {
      continue;
    }

    const routingTarget = resolveTaskRoutingTarget(
      db,
      task.sprint_id ?? null,
      task.project_id ?? null,
      task.task_type ?? null,
      'ready_to_merge',
    );
    const nextAgentId = routingTarget.agent_id ?? task.agent_id;

    db.prepare(`
      UPDATE tasks
      SET status = 'ready_to_merge',
          agent_id = ?,
          updated_at = datetime('now')
      WHERE id = ?
        AND status = 'qa_pass'
        AND active_instance_id IS NULL
    `).run(nextAgentId, task.id);

    cleanupTaskExecutionLinkageForStatus(db, task.id, 'ready_to_merge');
    writeTaskStatusChange(db, task.id, 'eligibility', 'qa_pass', 'ready_to_merge');

    if (nextAgentId !== task.agent_id) {
      try {
        db.prepare(`
          INSERT INTO task_history (task_id, changed_by, field, old_value, new_value)
          VALUES (?, 'eligibility', 'agent_id', ?, ?)
        `).run(task.id, task.agent_id == null ? null : String(task.agent_id), nextAgentId == null ? null : String(nextAgentId));
      } catch {
        // lightweight test DBs may omit task_history; promotion still stands
      }
    }

    result.promoted++;
  }
}

// ── Main pass ────────────────────────────────────────────────────────────────

export function runEligibilityPass(db: Database.Database, projectId?: number): EligibilityResult {
  const result: EligibilityResult = { promoted: 0, blocked: 0, stalled: 0, unclaimed: 0 };

  const projectFilter = projectId != null ? `AND t.project_id = ${projectId}` : '';

  // ── 1. Background eligibility never changes queue/review workflow status ──
  // No todo → ready or ready → todo style workflow mutation.
  // The one allowed exception is an explicit transition-table driven release
  // handoff when a global transition is marked lane='auto' and the release gate
  // requirements are already satisfied.
  autoPromoteQaPassTasks(db, projectId, result);

  // ── 2. in_progress → stalled (Phase 6: real instance health checks) ───────
  const inProgressTasks = db.prepare(`
    SELECT t.*
    FROM tasks t
    WHERE t.status = 'in_progress'
      AND t.paused_at IS NULL
    ${projectFilter}
  `).all() as TaskRow[];

  for (const task of inProgressTasks) {
    const config = getRoutingConfig(db, task.agent_id);
    const thresholdMin = config.stall_threshold_min;

    // Phase 6: Check linked instance health instead of just elapsed time
    const activeInstanceId = (task as any).active_instance_id as number | null;
    
    if (activeInstanceId) {
      // There's a linked instance — check its health
      const instance = db.prepare(
        `SELECT id, status, runtime_ended_at FROM job_instances WHERE id = ?`
      ).get(activeInstanceId) as { id: number; status: string; runtime_ended_at: string | null } | undefined;

      if (instance && (instance.status === 'running' || instance.status === 'dispatched') && !instance.runtime_ended_at) {
        // Instance is healthy — don't stall, even if elapsed time exceeds threshold.
        // The watchdog handles instance-level timeouts.
        continue;
      }

      // Instance is done/failed/missing — this task has no healthy instance
      // Fall through to stall it
    } else {
      // No linked instance — check if there's any running instance for this job+task combo
      const anyInstance = db.prepare(`
        SELECT id, status FROM job_instances
        WHERE task_id = ? AND status IN ('running', 'dispatched')
        LIMIT 1
      `).get(task.id) as { id: number; status: string } | undefined;

      if (anyInstance) {
        // Found a healthy instance — link it and skip
        db.prepare(`UPDATE tasks SET active_instance_id = ? WHERE id = ?`).run(anyInstance.id, task.id);
        continue;
      }
    }

    // No healthy instance — use elapsed time as secondary check
    const refTime = task.claimed_at ?? task.updated_at;
    if (minutesSince(refTime) >= thresholdMin) {
      db.prepare(`
        UPDATE tasks SET status = 'stalled', active_instance_id = NULL, updated_at = datetime('now') WHERE id = ?
      `).run(task.id);
      writeTaskStatusChange(db, task.id, 'eligibility', task.status, 'stalled');
      result.stalled++;

      // Telegram notification for stalled task
      const taskInfo = db.prepare(`
        SELECT t.title, a.job_title as job_title
        FROM tasks t
        LEFT JOIN agents a ON a.id = t.agent_id
        WHERE t.id = ?
      `).get(task.id) as { title: string; job_title: string | null } | undefined;
      if (taskInfo) {
        notifyTelegram(`⚠️ Stalled: Task #${task.id} · ${taskInfo.title} (${taskInfo.job_title ?? 'unassigned'}) — no healthy instance`);
      }
    }
  }

  // ── 5. dispatched → ready (unclaim: no agent claimed within threshold) ─────
  // Phase 1: Tasks now go directly to in_progress, so 'dispatched' should be rare.
  // This handles legacy/edge cases only.
  //
  // System policy: dispatched_unclaim
  // Threshold is read from system_policies.threshold_seconds (default 300s = 5m).
  // Admins can tune this via PUT /api/v1/routing/system-policies/dispatched_unclaim.
  const unclaimThresholdSeconds = getSystemPolicyThreshold(db, 'dispatched_unclaim', 300);
  const unclaimThresholdMin = unclaimThresholdSeconds / 60;

  const dispatchedTasks = db.prepare(`
    SELECT t.*
    FROM tasks t
    WHERE t.status = 'dispatched'
      AND t.paused_at IS NULL
    ${projectFilter}
  `).all() as TaskRow[];

  for (const task of dispatchedTasks) {
    // Check for a live instance before considering an unclaim revert.
    // claimed_at is rarely set during normal dispatch flow, so the old guard was
    // effectively a no-op and caused every dispatched task to revert after 5 min.
    // Instead, mirror the in_progress stall check: if a healthy instance (running
    // or dispatched) exists, the agent is active — leave the task alone.
    const activeInstanceId = (task as any).active_instance_id as number | null;

    if (activeInstanceId) {
      const instance = db.prepare(
        `SELECT id, status FROM job_instances WHERE id = ?`
      ).get(activeInstanceId) as { id: number; status: string } | undefined;

      if (instance && (instance.status === 'running' || instance.status === 'dispatched')) {
        // Healthy linked instance — agent is running, don't revert.
        continue;
      }
    } else {
      // No linked instance — look for any running/dispatched instance for this task
      const anyInstance = db.prepare(`
        SELECT id, status FROM job_instances
        WHERE task_id = ? AND status IN ('running', 'dispatched')
        LIMIT 1
      `).get(task.id) as { id: number; status: string } | undefined;

      if (anyInstance) {
        // Found a healthy instance — link it and skip revert
        db.prepare(`UPDATE tasks SET active_instance_id = ? WHERE id = ?`).run(anyInstance.id, task.id);
        continue;
      }
    }

    // No healthy instance and threshold exceeded → revert to ready
    if (minutesSince(task.dispatched_at) >= unclaimThresholdMin) {
      db.prepare(`
        UPDATE tasks
        SET status = 'ready', dispatched_at = NULL, active_instance_id = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(task.id);
      writeTaskStatusChange(db, task.id, 'eligibility', task.status, 'ready');
      result.unclaimed++;
    }
  }

  // ── 5b. stalled ───────────────────────────────────────────────────────────
  // Stalled tasks are intentionally left untouched by automatic eligibility
  // or reconciler recovery. They remain stalled until a human explicitly
  // moves them.

  // ── 6. review → ready (QA fail path) — handled by QA agent via PUT /tasks/:id ──
  // The QA agent sets status='todo' and resets agent_id to review_owner_agent_id.
  // This service handles the retry_count increment + failed promotion.
  const reviewTasks = db.prepare(`
    SELECT t.*
    FROM tasks t
    WHERE t.status = 'review'
    ${projectFilter}
  `).all() as TaskRow[];

  for (const task of reviewTasks) {
    // Only act if review_owner_agent_id is set AND the task has exceeded max_retries
    // Normal QA fail flow is initiated by the QA agent — we only sweep for stuck review tasks
    // that have been rejected but not re-routed.
    // (Standard path: QA agent does PUT {status:'todo', agent_id: review_owner_agent_id} — not here)
    // This block is intentionally left as documentation for the dispatcher to handle via QA agent.
    void task; // suppress unused warning
  }

  return result;
}

/**
 * resetFromQAFail — called by QA agent (or review endpoint) to demote a reviewed task back.
 * Increments retry_count. If retry_count >= max_retries: sets failed. Otherwise: resets to ready.
 * Returns the new status.
 */
export function resetFromQAFail(db: Database.Database, taskId: number): 'ready' | 'failed' {
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as TaskRow | undefined;
  if (!task) throw new Error(`Task ${taskId} not found`);

  const config = getRoutingConfig(db, task.agent_id);
  const newRetryCount = task.retry_count + 1;
  const maxRetries = config.max_retries ?? task.max_retries ?? 3;

  if (newRetryCount >= maxRetries) {
    db.prepare(`
      UPDATE tasks SET status = 'failed', retry_count = ?, updated_at = datetime('now') WHERE id = ?
    `).run(newRetryCount, taskId);
    writeTaskStatusChange(db, taskId, 'eligibility', task.status, 'failed');
    return 'failed';
  } else {
    const targetAgentId = task.review_owner_agent_id ?? task.agent_id;
    db.prepare(`
      UPDATE tasks
      SET status = 'ready', retry_count = ?, agent_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(newRetryCount, targetAgentId, taskId);
    writeTaskStatusChange(db, taskId, 'eligibility', task.status, 'ready');
    return 'ready';
  }
}
