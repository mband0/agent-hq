import type Database from 'better-sqlite3';
import { getDb } from '../db/client';
import { attachInstanceToTask } from '../lib/runObservability';
import { cleanupImpossibleTaskLifecycleStates, cleanupTaskExecutionLinkageForStatus } from '../lib/taskLifecycle';
import { runEligibilityPass, type EligibilityResult } from '../services/eligibility';
import {
  runDispatcher, type DispatchResult,
  buildDispatchMessage, buildDispatchTaskNotesSection,
  dispatchInstance, getDispatchTaskNotesContext, type DispatchInstanceParams,
} from '../services/dispatcher';
import { buildContractInstructions, resolveTransportMode } from '../services/contracts';
import { backfillInstanceTokensAsync } from '../lib/tokenBackfill';
import { writeTaskStatusChange } from '../lib/taskHistory';
import { markTaskNeedsAttentionForMissingSemanticHandoff, taskRequiresSemanticOutcome } from '../lib/lifecycleHandoff';
import { getNeedsAttentionEligibleStatuses } from '../lib/reconcilerConfig';
import { buildHookSessionKey, resolveRuntimeAgentSlug } from '../lib/sessionKeys';

const POLL_INTERVAL_MS = 12_000; // ~12 seconds

/**
 * Grace period before an orphan in_progress task (active_instance_id is NULL
 * or points to a terminal instance) is transitioned to stalled.
 * Configurable via ORPHAN_STALL_GRACE_MS env var; defaults to 5 minutes.
 * A short window prevents false positives during the brief moment between
 * dispatch clearing active_instance_id and the new instance being attached.
 */
const ORPHAN_STALL_GRACE_MS: number = (() => {
  const v = parseInt(process.env.ORPHAN_STALL_GRACE_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 5 * 60_000;
})();

/**
 * Grace period before treating a runtime-ended task with no persisted semantic
 * lifecycle outcome as a true hand-off failure.
 *
 * This covers the gap where observability/runtime-end metadata can land before
 * transcript parsing or lifecycle persistence finishes. After the grace window,
 * we still escalate to needs_attention so genuine lost hand-offs remain visible.
 */
const MISSING_LIFECYCLE_OUTCOME_GRACE_MS: number = (() => {
  const v = parseInt(process.env.MISSING_LIFECYCLE_OUTCOME_GRACE_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 2 * 60_000;
})();

interface TaskRow {
  id: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  agent_id: number | null;
  project_id: number | null;
  sprint_id: number | null;
  task_type: string | null;
  review_owner_agent_id: number | null;
  active_instance_id: number | null;
  updated_at: string;
  story_points: number | null;
  /** The status the task was in before it became stalled/failed. Preserved for human-directed recovery context. */
  previous_status: string | null;
}

interface AgentRow {
  id: number;
  name: string;
  session_key: string;
  openclaw_agent_id: string | null;
  model: string | null;
  /** Container hooks URL — when set, dispatch routes to this container instead of the host gateway. */
  hooks_url: string | null;
  /** Per-agent Authorization header for hooks_url dispatch (task #431). */
  hooks_auth_header: string | null;
  /** Agent runtime type (openclaw, veri, claude-code, etc.). */
  runtime_type: string | null;
  /** Agent runtime config JSON. */
  runtime_config: unknown;
  /* ── Merged job-template fields (task #459) ── */
  job_title: string;
  pre_instructions: string;
  skill_name: string | null;
  timeout_seconds: number;
  sprint_id: number | null;
  enabled: number;
}

interface SprintRow {
  id: number;
  name: string;
  goal: string;
  status: string;
  sprint_type: string | null;
}

interface RoutingRuleRow {
  id: number;
  project_id: number;
  task_type: string;
  status: string;
  agent_id: number | null;
  priority: number;
}

interface DispatchDeps {
  dispatchInstance: (params: DispatchInstanceParams) => Promise<void>;
}

export interface ReconcilerDeps extends DispatchDeps {
  runEligibilityPass: (db: Database.Database, projectId?: number) => EligibilityResult;
  runDispatcher: (db: Database.Database, projectId?: number) => DispatchResult;
}

export interface ReconcilerTickSummary {
  projectsChecked: number;
  projectIds: number[];
  promoted: number;
  blocked: number;
  stalled: number;
  unclaimed: number;
  dispatched: number;
  skipped: number;
  errors: string[];
}

const DEFAULT_RECONCILER_DEPS: ReconcilerDeps = {
  dispatchInstance,
  runEligibilityPass,
  runDispatcher,
};

function createEmptySummary(projectIds: number[] = []): ReconcilerTickSummary {
  return {
    projectsChecked: projectIds.length,
    projectIds,
    promoted: 0,
    blocked: 0,
    stalled: 0,
    unclaimed: 0,
    dispatched: 0,
    skipped: 0,
    errors: [],
  };
}

function log(db: Database.Database, message: string, _taskId?: number, agentId?: number): void {
  db.prepare(`
    INSERT INTO logs (agent_id, job_title, level, message)
    VALUES (?, 'reconciler', 'info', ?)
  `).run(agentId ?? null, message);
  console.log(`[reconciler] ${message}`);
}

function logHistory(
  db: Database.Database,
  taskId: number,
  changedBy: string,
  field: string,
  oldValue: string | null,
  newValue: string | null,
): void {
  db.prepare(`
    INSERT INTO task_history (task_id, changed_by, field, old_value, new_value)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId, changedBy, field, oldValue, newValue);
}

function resolveAgentName(db: Database.Database, agentId: number | null): string | null {
  if (agentId == null) return null;
  const row = db.prepare(`SELECT name FROM agents WHERE id = ?`).get(agentId) as { name: string } | undefined;
  return row?.name ?? String(agentId);
}

function isAgentBusy(db: Database.Database, agentId: number): boolean {
  const running = db.prepare(`
    SELECT id FROM job_instances
    WHERE agent_id = ? AND status IN ('queued', 'dispatched', 'running')
    LIMIT 1
  `).get(agentId);
  return !!running;
}

function hasTaskLiveInstance(db: Database.Database, taskId: number): boolean {
  const row = db.prepare(`
    SELECT ji.id
    FROM job_instances ji
    WHERE ji.task_id = ?
      AND ji.status IN ('queued', 'dispatched', 'running')
    LIMIT 1
  `).get(taskId);
  return Boolean(row);
}

function buildQaTaskContext(task: TaskRow): string {
  return [
    `## Review Task #${task.id}: ${task.title}`,
    '',
    task.description || '(no description provided)',
    '',
    `This task is already in the Agent HQ review lane. Do not move it to in_progress or done via the generic task update endpoint.`,
    `Keep the task in review while you test it.`,
    `Use the Agent HQ Task Contract Base URL for lifecycle writes such as task notes, QA evidence, check-ins, and outcomes.`,
    `Do not send lifecycle writes to the dev API under test unless the contract Base URL explicitly points there.`,
    '',
    `PASS workflow:`,
    `1. Record QA evidence with PUT /api/v1/tasks/${task.id}/qa-evidence`,
    `2. Then POST /api/v1/tasks/${task.id}/outcome with {"outcome":"qa_pass","changed_by":"agency-qa","instance_id":<instance id>}`,
    '',
    `FAIL workflow:`,
    `1. Post a clear task note with repro + expected vs actual`,
    `2. Then POST /api/v1/tasks/${task.id}/outcome with {"outcome":"qa_fail","changed_by":"agency-qa","instance_id":<instance id>}`,
    '',
    `Never use {"status":"done"} or {"status":"in_progress"} for QA pass/fail. The outcome endpoint owns release-pipeline transitions.`,
  ].join('\n');
}

function resolveReviewRoutingRules(db: Database.Database, task: TaskRow): RoutingRuleRow[] {
  if (!task.task_type || !task.sprint_id) return [];
  try {
    return db.prepare(`
      SELECT *
      FROM sprint_task_routing_rules
      WHERE sprint_id = ?
        AND task_type = ?
        AND status = 'review'
      ORDER BY priority DESC, id ASC
    `).all(task.sprint_id, task.task_type) as RoutingRuleRow[];
  } catch {
    return [];
  }
}

function reassignReviewTaskIfNeeded(db: Database.Database, task: TaskRow, rule: RoutingRuleRow): TaskRow {
  const ruleAgentId: number | null = (rule as any).agent_id ?? null;
  if (task.agent_id === ruleAgentId && task.review_owner_agent_id != null) {
    return task;
  }

  const nextReviewOwnerAgentId = task.review_owner_agent_id ?? (task.agent_id !== ruleAgentId ? task.agent_id : null);
  if (task.agent_id === ruleAgentId && nextReviewOwnerAgentId === task.review_owner_agent_id) {
    return task;
  }

  db.prepare(`
    UPDATE tasks
    SET agent_id = ?,
        review_owner_agent_id = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(ruleAgentId, nextReviewOwnerAgentId, task.id);

  if (task.agent_id !== ruleAgentId) {
    const oldName = task.agent_id ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(task.agent_id) as { name: string } | undefined)?.name : null;
    const newName = ruleAgentId ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(ruleAgentId) as { name: string } | undefined)?.name : null;
    logHistory(db, task.id, 'reconciler', 'agent_id', oldName ?? 'unassigned', newName ?? String(ruleAgentId));
    log(db,
      `Review routing: task #${task.id} "${task.title}" reassigned ${oldName ?? 'unassigned'} → ${newName ?? String(ruleAgentId)}`,
      task.id,
      ruleAgentId ?? undefined,
    );
  }

  return {
    ...task,
    agent_id: ruleAgentId,
    review_owner_agent_id: nextReviewOwnerAgentId,
  };
}

function getReconcilerProjectIds(db: Database.Database): number[] {
  const rows = db.prepare(`
    SELECT DISTINCT project_id
    FROM (
      SELECT id AS project_id FROM projects
      UNION ALL
      SELECT project_id FROM agents WHERE project_id IS NOT NULL
      UNION ALL
      SELECT project_id FROM tasks WHERE project_id IS NOT NULL
      UNION ALL
      SELECT project_id FROM routing_config WHERE project_id IS NOT NULL
    )
    WHERE project_id IS NOT NULL
    ORDER BY project_id ASC
  `).all() as Array<{ project_id: number }>;

  return rows.map(row => row.project_id);
}

export async function reconcileReviewQaRouting(
  deps: DispatchDeps = { dispatchInstance },
  db: Database.Database = getDb(),
): Promise<void> {
  const reviewTasks = db.prepare(`
    SELECT t.*
    FROM tasks t
    WHERE t.status = 'review'
      AND t.paused_at IS NULL
      AND (t.sprint_id IS NULL OR EXISTS (
        SELECT 1 FROM sprints sp WHERE sp.id = t.sprint_id AND sp.status != 'closed'
      ))
    ORDER BY t.updated_at ASC
  `).all() as TaskRow[];

  for (const originalTask of reviewTasks) {
    const rules = resolveReviewRoutingRules(db, originalTask);
    if (rules.length === 0) continue;

    // Skip entire task if it already has a live instance (no point trying any rule)
    if (hasTaskLiveInstance(db, originalTask.id)) continue;

    for (const rule of rules) {
      // Re-check live instance on each iteration in case a concurrent tick claimed it
      if (hasTaskLiveInstance(db, originalTask.id)) break;

      // Task #596: resolve agent via rule's agent_id directly, fall back to job_templates FK
      const ruleAgentId = (rule as any).agent_id;
      let agent: AgentRow | undefined;
      if (ruleAgentId) {
        agent = db.prepare(`SELECT * FROM agents WHERE id = ? AND enabled = 1`).get(ruleAgentId) as AgentRow | undefined;
      }
      if (!agent) continue;

      // Agent busy? Try next rule instead of skipping the whole task
      if (isAgentBusy(db, agent.id)) continue;

      // Agent is available — now safe to write task reassignment to DB
      const task = reassignReviewTaskIfNeeded(db, originalTask, rule);
      if (!task.agent_id) continue;

      const sprint = task.sprint_id
        ? db.prepare('SELECT * FROM sprints WHERE id = ?').get(task.sprint_id) as SprintRow | undefined
        : undefined;

      const preInstructions = agent.pre_instructions
        ? `${buildQaTaskContext(task)}\n\n---\n\n${agent.pre_instructions}`
        : buildQaTaskContext(task);

      const instanceResult = db.prepare(`
        INSERT INTO job_instances (agent_id, status)
        VALUES (?, 'queued')
      `).run(agent.id);
      const instanceId = instanceResult.lastInsertRowid as number;
      attachInstanceToTask(db, instanceId, task.id);

      try {
        const taskNotesSection = buildDispatchTaskNotesSection(getDispatchTaskNotesContext(db, {
          taskId: task.id,
          agentId: agent.id,
          currentInstanceId: instanceId,
        }));

        // Build message via shared helper + append lifecycle contract
        let message = buildDispatchMessage({
          preInstructions,
          skillName: agent.skill_name,
          sprintGoal: sprint?.goal || null,
          taskNotesSection,
        });

        // Append task lifecycle contract
        const agentSlug = resolveRuntimeAgentSlug(agent)
          ?? agent.session_key.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
        const runSessionKey = buildHookSessionKey(instanceId);
        const contract = buildContractInstructions({
          instanceId,
          taskId: task.id,
          taskStatus: task.status,
          taskType: task.task_type ?? null,
          sprintId: task.sprint_id ?? null,
          sprintType: sprint?.sprint_type ?? null,
          agentSlug,
          sessionKey: runSessionKey,
          transportMode: resolveTransportMode({
            runtimeType: agent.runtime_type,
            runtimeConfig: agent.runtime_config,
            hooksUrl: agent.hooks_url,
          }),
          db,
        });
        message += `\n\n${contract}`;

        const effectiveModel = agent.model ?? null;

        await deps.dispatchInstance({
          instanceId,
          agentId: agent.id,
          jobTitle: agent.job_title,
          sessionKey: agent.session_key,
          message,
          model: effectiveModel,
          timeoutSeconds: agent.timeout_seconds,
          hooksUrl: agent.hooks_url,
          hooksAuthHeader: agent.hooks_auth_header,
          runtimeType: agent.runtime_type,
          runtimeConfig: agent.runtime_config,
          storyPoints: task.story_points ?? null,
        });

        log(db,
          `QA auto-dispatch: task #${task.id} "${task.title}" kept in review and queued job "${agent.job_title}" for agent "${agent.name}" (model=${effectiveModel ?? 'gateway-default'})`,
          task.id,
          agent.id,
        );
      } catch (err) {
        console.error(`[reconciler] QA dispatch failed for task #${task.id}:`, err);
        // Mark the newly created instance as failed — do NOT call
        // cleanupTaskExecutionLinkageForStatus here, because the task may
        // still have a legitimately running instance from a prior dispatch.
        // Clearing active_instance_id on a transient dispatch error causes
        // running QA/DevOps instances to lose authoritative linkage.
        db.prepare(`
          UPDATE job_instances
          SET status = 'failed',
              error = ?,
              completed_at = datetime('now')
          WHERE id = ?
            AND status NOT IN ('done', 'failed', 'cancelled')
        `).run(
          err instanceof Error ? err.message : String(err),
          instanceId
        );
        // Restore previous active_instance_id if this failed instance was set as active
        const currentTask = db.prepare('SELECT active_instance_id FROM tasks WHERE id = ?').get(task.id) as { active_instance_id: number | null } | undefined;
        if (currentTask?.active_instance_id === instanceId) {
          db.prepare(`
            UPDATE tasks SET active_instance_id = NULL, updated_at = datetime('now') WHERE id = ?
          `).run(task.id);
        }
      }

      // Successfully dispatched (or attempted) — stop trying further rules for this task
      break;
    }
  }
}

function reconcileInProgressRecovery(db: Database.Database): void {
  const inProgressTasks = db.prepare(`
    SELECT t.* FROM tasks t
    WHERE t.status = 'in_progress'
      AND t.agent_id IS NOT NULL
      AND t.paused_at IS NULL
  `).all() as TaskRow[];

  const now = Date.now();

  for (const task of inProgressTasks) {
    const agent = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(task.agent_id!) as AgentRow | undefined;
    if (!agent) continue;

    const liveInstance = db.prepare(`
      SELECT id FROM job_instances
      WHERE agent_id = ? AND status IN ('queued', 'dispatched', 'running')
      LIMIT 1
    `).get(agent.id);

    if (liveInstance) continue;

    const raw = task.updated_at;
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const withZ = normalized.endsWith('Z') ? normalized : normalized + 'Z';
    const updatedMs = new Date(withZ).getTime();
    const elapsedMs = now - updatedMs;
    const timeoutMs = (agent.timeout_seconds || 900) * 1000;

    if (elapsedMs >= timeoutMs) {
      const priorStatus = task.status;
      // Store previous_status so human operators can see the prior workflow position.
      db.prepare(`
        UPDATE tasks SET status = 'stalled', previous_status = ?, updated_at = datetime('now') WHERE id = ?
      `).run(priorStatus, task.id);
      logHistory(db, task.id, 'reconciler', 'status', priorStatus, 'stalled');

      const elapsedMin = Math.floor(elapsedMs / 60000);
      log(db,
        `In-progress recovery: task #${task.id} "${task.title}" (${priorStatus} → stalled) — no live instance for agent "${agent.name}", stalled after ${elapsedMin}m`,
        task.id, agent.id
      );
    }
  }
}

/**
 * reconcileOrphanInProgressTasks — detect and stall in_progress tasks that
 * have no live instance attached.
 *
 * An "orphan" is any in_progress task where:
 *   (a) active_instance_id IS NULL, or
 *   (b) active_instance_id points to an instance with a terminal status
 *       (done, failed, cancelled).
 *
 * These tasks are invisible to the watchdog (which only monitors live
 * job_instances) and to cleanupImpossibleTaskLifecycleStates (which clears
 * the stale linkage but does not change task status). Without this pass they
 * remain stuck in_progress indefinitely.
 *
 * A configurable grace period (ORPHAN_STALL_GRACE_MS, default 5 min) measured
 * from updated_at prevents false positives during the brief window between one
 * instance completing and the next being attached at re-dispatch.
 *
 * All detected orphans are logged immediately (even before the grace period
 * expires) so they are visible in observability tooling.
 */
export function reconcileOrphanInProgressTasks(db: Database.Database): void {
  const orphans = db.prepare(`
    SELECT t.id, t.title, t.agent_id, t.active_instance_id, t.updated_at, t.paused_at,
           ji.status AS instance_status
    FROM tasks t
    LEFT JOIN job_instances ji ON ji.id = t.active_instance_id
    WHERE t.status = 'in_progress'
      AND t.paused_at IS NULL
      AND (
        t.active_instance_id IS NULL
        OR ji.status IN ('done', 'failed', 'cancelled')
      )
  `).all() as Array<{
    id: number;
    title: string;
    agent_id: number | null;
    active_instance_id: number | null;
    updated_at: string;
    paused_at: string | null;
    instance_status: string | null;
  }>;

  if (orphans.length === 0) return;

  const now = Date.now();

  for (const orphan of orphans) {
    const raw = orphan.updated_at;
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const withZ = normalized.endsWith('Z') ? normalized : normalized + 'Z';
    const updatedMs = new Date(withZ).getTime();
    const elapsedMs = now - updatedMs;
    const elapsedMin = Math.floor(elapsedMs / 60000);

    const instanceDesc = orphan.active_instance_id === null
      ? 'no active_instance_id'
      : `active_instance_id=${orphan.active_instance_id} (${orphan.instance_status})`;

    const agentName = resolveAgentName(db, orphan.agent_id);

    // Always log orphan detection for observability (rate-limited to once per 10 min per task).
    const recentOrphanLog = db.prepare(`
      SELECT id FROM logs
      WHERE message LIKE ? AND created_at > datetime('now', '-10 minutes')
      LIMIT 1
    `).get(`%Orphan in_progress: task #${orphan.id}%`) as { id: number } | undefined;

    if (!recentOrphanLog) {
      const detectMsg = `Orphan in_progress: task #${orphan.id} "${orphan.title}" — ${instanceDesc}, elapsed=${elapsedMin}m, agent=${agentName ?? 'none'}`;
      console.warn(`[reconciler] ${detectMsg}`);
      log(db, detectMsg, orphan.id, orphan.agent_id ?? undefined);
    }

    // Transition to stalled only after grace period has elapsed.
    if (elapsedMs < ORPHAN_STALL_GRACE_MS) continue;

    db.prepare(`
      UPDATE tasks SET status = 'stalled', updated_at = datetime('now') WHERE id = ? AND status = 'in_progress'
    `).run(orphan.id);

    logHistory(db, orphan.id, 'reconciler', 'status', 'in_progress', 'stalled');

    log(db,
      `Orphan stall: task #${orphan.id} "${orphan.title}" (in_progress → stalled) — ${instanceDesc} for ${elapsedMin}m (grace=${Math.floor(ORPHAN_STALL_GRACE_MS / 60000)}m), agent=${agentName ?? 'none'}`,
      orphan.id, orphan.agent_id ?? undefined,
    );

    console.log(
      `[reconciler] Orphan stall: task #${orphan.id} "${orphan.title}" → stalled (${instanceDesc}, elapsed=${elapsedMin}m)`
    );
  }
}

function reconcileMissingLifecycleOutcomeAfterRuntimeEnd(db: Database.Database): void {
  const now = Date.now();
  const eligibleStatuses = getNeedsAttentionEligibleStatuses(db);
  if (eligibleStatuses.length === 0) return;
  const placeholders = eligibleStatuses.map(() => '?').join(', ');

  const candidates = db.prepare(`
    SELECT
      t.id,
      t.title,
      t.status,
      t.previous_status,
      t.project_id,
      t.agent_id,
      t.active_instance_id,
      ji.status AS instance_status,
      ji.runtime_ended_at,
      ji.runtime_end_error,
      ji.runtime_end_source,
      ji.task_outcome,
      ji.lifecycle_outcome_posted_at
    FROM tasks t
    JOIN job_instances ji ON ji.id = t.active_instance_id
    WHERE t.paused_at IS NULL
      AND t.status IN (${placeholders})
      AND ji.runtime_ended_at IS NOT NULL
      AND ji.lifecycle_outcome_posted_at IS NULL
      AND COALESCE(ji.task_outcome, '') = ''
  `).all(...eligibleStatuses) as Array<{
    id: number;
    title: string;
    status: string;
    previous_status: string | null;
    project_id: number | null;
    agent_id: number | null;
    active_instance_id: number;
    instance_status: string | null;
    runtime_ended_at: string;
    runtime_end_error: string | null;
    runtime_end_source: string | null;
    task_outcome: string | null;
    lifecycle_outcome_posted_at: string | null;
  }>;

  for (const task of candidates) {
    if (!taskRequiresSemanticOutcome(db, task.id)) continue;

    const normalized = task.runtime_ended_at.includes('T')
      ? task.runtime_ended_at
      : task.runtime_ended_at.replace(' ', 'T');
    const withZ = normalized.endsWith('Z') ? normalized : `${normalized}Z`;
    const runtimeEndedMs = new Date(withZ).getTime();
    const elapsedMs = now - runtimeEndedMs;
    const elapsedMin = Math.floor(elapsedMs / 60000);

    if (!Number.isFinite(runtimeEndedMs) || elapsedMs < MISSING_LIFECYCLE_OUTCOME_GRACE_MS) {
      continue;
    }

    markTaskNeedsAttentionForMissingSemanticHandoff(db, {
      taskId: task.id,
      instanceId: task.active_instance_id,
      changedBy: 'reconciler',
      lane: task.status,
      priorTaskStatus: task.status,
      runtimeEnd: {
        source: task.runtime_end_source,
        success: task.instance_status === 'done' ? true : task.runtime_end_error ? false : null,
        endedAt: withZ,
        error: task.runtime_end_error,
      },
    });

    log(db,
      `Lifecycle recovery: task #${task.id} "${task.title}" (${task.status} → needs_attention) — runtime ended on instance #${task.active_instance_id} without lifecycle outcome after ${elapsedMin}m (grace=${Math.floor(MISSING_LIFECYCLE_OUTCOME_GRACE_MS / 60000)}m)`,
      task.id,
      task.agent_id ?? undefined,
    );
  }
}

/**
 * logStuckReviewTasks — emit a warning log for tasks that have been in 'review'
 * status with no active_instance_id for longer than 5 minutes. This surfaces
 * QA dispatch failures that would otherwise silently block the pipeline.
 */
function logStuckReviewTasks(db: Database.Database): void {
  const stuckTasks = db.prepare(`
    SELECT t.id, t.title, t.agent_id, t.updated_at
    FROM tasks t
    WHERE t.status = 'review'
      AND t.paused_at IS NULL
      AND t.active_instance_id IS NULL
      AND t.updated_at < datetime('now', '-5 minutes')
      AND (t.sprint_id IS NULL OR EXISTS (
        SELECT 1 FROM sprints sp WHERE sp.id = t.sprint_id AND sp.status != 'closed'
      ))
  `).all() as Array<{ id: number; title: string; agent_id: number | null; updated_at: string }>;

  for (const task of stuckTasks) {
    const agentName = resolveAgentName(db, task.agent_id);
    const msg = `⚠ Stuck review: task #${task.id} "${task.title}" has been in review with no active instance for >5 min (agent=${agentName ?? 'none'}, updated_at=${task.updated_at})`;
    console.warn(`[reconciler] ${msg}`);
    // Log to DB but only once per 30 minutes per task to avoid spam
    const recentLog = db.prepare(`
      SELECT id FROM logs
      WHERE message LIKE ? AND created_at > datetime('now', '-30 minutes')
      LIMIT 1
    `).get(`%Stuck review: task #${task.id}%`) as { id: number } | undefined;
    if (!recentLog) {
      log(db, msg, task.id, task.agent_id ?? undefined);
    }
  }
}

export async function runReconcilerTick(
  deps: ReconcilerDeps = DEFAULT_RECONCILER_DEPS,
  db: Database.Database = getDb(),
): Promise<ReconcilerTickSummary> {
  reconcileMissingLifecycleOutcomeAfterRuntimeEnd(db);
  cleanupImpossibleTaskLifecycleStates(db);

  const projectIds = getReconcilerProjectIds(db);
  const summary = createEmptySummary(projectIds);

  for (const projectId of projectIds) {
    try {
      const eligibility = deps.runEligibilityPass(db, projectId);
      const dispatch = deps.runDispatcher(db, projectId);

      summary.promoted += eligibility.promoted;
      summary.blocked += eligibility.blocked;
      summary.stalled += eligibility.stalled;
      summary.unclaimed += eligibility.unclaimed;
      summary.dispatched += dispatch.dispatched;
      summary.skipped += dispatch.skipped;
      summary.errors.push(...dispatch.errors.map(error => `[project ${projectId}] ${error}`));

      if (eligibility.promoted > 0 || eligibility.blocked > 0 || eligibility.stalled > 0 || eligibility.unclaimed > 0 || dispatch.dispatched > 0 || dispatch.errors.length > 0) {
        console.log(
          `[reconciler] project=${projectId} promoted=${eligibility.promoted} blocked=${eligibility.blocked} stalled=${eligibility.stalled} unclaimed=${eligibility.unclaimed} dispatched=${dispatch.dispatched} skipped=${dispatch.skipped} errors=${dispatch.errors.length}`
        );
      }
    } catch (err) {
      const message = `[project ${projectId}] ${String(err)}`;
      summary.errors.push(message);
      console.error('[reconciler] Project automation error:', message);
    }
  }

  await reconcileReviewQaRouting({ dispatchInstance: deps.dispatchInstance }, db);
  reconcileOrphanInProgressTasks(db);
  reconcileInProgressRecovery(db);
  logStuckReviewTasks(db);

  // Backfill token usage from OpenClaw session data for recently completed instances.
  // Uses the async token-backfill path so reconciler ticks do not block the Node.js event loop.
  try {
    await backfillInstanceTokensAsync(db);
  } catch (err) {
    console.warn('[reconciler] Token backfill error:', err);
  }

  if (summary.dispatched > 0 || summary.promoted > 0 || summary.blocked > 0 || summary.stalled > 0 || summary.unclaimed > 0 || summary.errors.length > 0) {
    console.log(
      `[reconciler] tick summary projects=${summary.projectsChecked} dispatched=${summary.dispatched} promoted=${summary.promoted} blocked=${summary.blocked} stalled=${summary.stalled} unclaimed=${summary.unclaimed} errors=${summary.errors.length}`
    );
  }

  return summary;
}

async function tick(): Promise<void> {
  try {
    await runReconcilerTick();
  } catch (err) {
    console.error('[reconciler] Tick error:', err);
  }
}

export function startReconciler(): void {
  console.log(`[reconciler] Starting — polling every ${POLL_INTERVAL_MS / 1000}s`);
  setInterval(() => {
    tick().catch(err => console.error('[reconciler] Tick error:', err));
  }, POLL_INTERVAL_MS);
  console.log('[reconciler] Running');
}
