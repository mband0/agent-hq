import type Database from 'better-sqlite3';
import { cleanupTaskExecutionLinkageForStatus } from './taskLifecycle';
import { canonicalOutcomeRoute, requireReleaseGate, resolveSprintWorkflowOutcome } from './taskRelease';
import { notifyTaskStatusChange } from './taskNotifications';
import { isTerminalOutcome, closeInstance } from './instanceClose';
import {
  type FailureClass,
  isValidFailureClass,
  inferFailureClass,
  getRecoverySpec,
  inferFailureLane,
  isFailureClassAllowedForLane,
  isBlockedFailureClass,
  isFailedFailureClass,
} from './failureClasses';
import { emitIntegrityEvent, writeTaskLifecycleOutcomeHistory, writeTaskStatusChange } from './taskHistory';
import { resolveSprintTaskRoutingAssignment } from './sprintTaskPolicy';

export interface ApplyTaskOutcomeInput {
  taskId: number;
  outcome: string;
  changedBy?: string;
  summary?: string | null;
  instanceId?: number | null;
  failureClass?: string | null;
  failureDetail?: string | null;
}

export interface ApplyTaskOutcomeResult {
  ok: true;
  applied: boolean;
  ignored: boolean;
  reason?: 'task_terminal' | 'instance_not_authoritative' | 'missing_authoritative_instance';
  priorStatus: string;
  nextStatus: string;
  outcome: string;
  /** True when the instance was automatically closed as part of a terminal outcome. */
  instanceClosed?: boolean;
  /** The classified failure type (only present on failed outcomes). */
  failureClass?: FailureClass | null;
  /** Whether the system auto-recovered (routed to a non-failed state). */
  autoRecovered?: boolean;
  /** Human-readable recovery description. */
  recoveryDescription?: string;
}

export class RefusedTaskOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusedTaskOutcomeError';
  }
}

type TaskOutcomeTaskRow = {
  id: number;
  status: string;
  project_id: number | null;
  sprint_id: number | null;
  task_type: string | null;
  sprint_type: string | null;
  agent_id: number | null;
  active_instance_id: number | null;
  review_owner_agent_id: number | null;
  review_branch: string | null;
  review_commit: string | null;
  review_url: string | null;
  qa_verified_commit: string | null;
  qa_tested_url: string | null;
  merged_commit: string | null;
  deployed_commit: string | null;
  deployed_at: string | null;
  live_verified_at: string | null;
  live_verified_by: string | null;
  deploy_target: string | null;
  evidence_json: string | null;
  previous_status?: string | null;
};

type InstanceAuthorityRow = {
  id: number;
  agent_id: number;
  task_id: number | null;
  status: string;
};

type OutcomeAuthorityDecision =
  | { kind: 'allow'; mode: 'active_instance' | 'same_lane' }
  | { kind: 'ignore'; reason: ApplyTaskOutcomeResult['reason']; auditMessage: string; auditNote: string };

function logHistory(
  db: Database.Database,
  taskId: number,
  changedBy: string,
  field: string,
  oldValue: unknown,
  newValue: unknown,
): void {
  db.prepare(`
    INSERT INTO task_history (task_id, changed_by, field, old_value, new_value)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId, changedBy, field, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue));
}

function insertAuditLog(db: Database.Database, message: string): void {
  db.prepare(`
    INSERT INTO logs (agent_id, job_title, level, message)
    VALUES (NULL, 'outcome-api', 'info', ?)
  `).run(message);
}

function resolveAgentName(db: Database.Database, agentId: number | null): string | null {
  if (agentId == null) return null;
  const row = db.prepare(`SELECT name, job_title FROM agents WHERE id = ?`).get(agentId) as { name: string; job_title: string | null } | undefined;
  return row?.job_title || row?.name || String(agentId);
}

function addAuditNote(db: Database.Database, taskId: number, author: string, content: string): void {
  db.prepare(`
    INSERT INTO task_notes (task_id, author, content)
    VALUES (?, ?, ?)
  `).run(taskId, author, content);
}

export function resolveRefusedTaskOutcome(
  db: Database.Database,
  input: {
    taskId: number;
    outcome: string;
    changedBy: string;
    reason: string;
    summary?: string | null;
    instanceId?: number | null;
  },
): void {
  const task = db.prepare(`
    SELECT id
    FROM tasks
    WHERE id = ?
  `).get(input.taskId) as { id: number } | undefined;

  if (!task) return;

  insertAuditLog(db, `Refused outcome for task #${input.taskId}: outcome="${input.outcome}", actor="${input.changedBy}", reason="${input.reason}"`);
  addAuditNote(db, input.taskId, input.changedBy, `Outcome refused: ${input.outcome} — ${input.reason}`);
}

function tableHasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return cols.some(col => col.name === columnName);
  } catch {
    return false;
  }
}

function resolveTaskRoutingAssignment(
  db: Database.Database,
  sprintId: number | null,
  projectId: number | null,
  taskType: string | null,
  status: string,
): { agent_id: number | null } {
  if (!taskType) return { agent_id: null };

  const sprintAssignment = resolveSprintTaskRoutingAssignment(db, sprintId, taskType, status);
  if (sprintAssignment.agent_id != null) return sprintAssignment;

  if (projectId == null) return { agent_id: null };

  const row = db.prepare(`
      SELECT agent_id
      FROM task_routing_rules
      WHERE project_id = ?
        AND task_type = ?
        AND status = ?
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `).get(projectId, taskType, status) as { agent_id: number | null } | undefined;

  return { agent_id: row?.agent_id ?? null };
}

function loadInstanceAuthorityRow(db: Database.Database, instanceId: number): InstanceAuthorityRow | null {
  return db.prepare(`
    SELECT id, agent_id, task_id, status
    FROM job_instances
    WHERE id = ?
  `).get(instanceId) as InstanceAuthorityRow | undefined ?? null;
}

function buildIgnoredOutcomeDecision(
  reason: ApplyTaskOutcomeResult['reason'],
  auditMessage: string,
  auditNote: string,
): OutcomeAuthorityDecision {
  return {
    kind: 'ignore',
    reason,
    auditMessage,
    auditNote,
  };
}

function resolveOutcomeAuthority(
  db: Database.Database,
  task: TaskOutcomeTaskRow,
  input: ApplyTaskOutcomeInput,
  changedBy: string,
): OutcomeAuthorityDecision {
  if (task.active_instance_id != null && input.instanceId == null) {
    return buildIgnoredOutcomeDecision(
      'missing_authoritative_instance',
      `Ignored unauthoritative outcome for task #${input.taskId}: active_instance_id=${task.active_instance_id}, callback_instance_id=missing, outcome="${input.outcome}", actor="${changedBy}"${input.summary ? `, summary: ${input.summary}` : ''}`,
      `Ignored outcome without authoritative instance: ${input.outcome}${input.summary ? ` — ${input.summary}` : ''}`,
    );
  }

  if (input.instanceId == null) {
    return { kind: 'allow', mode: 'same_lane' };
  }

  const callbackInstance = loadInstanceAuthorityRow(db, input.instanceId);
  if (!callbackInstance) {
    return buildIgnoredOutcomeDecision(
      'instance_not_authoritative',
      `Ignored stale outcome for task #${input.taskId}: callback_instance_id=${input.instanceId} not found, outcome="${input.outcome}", actor="${changedBy}"${input.summary ? `, summary: ${input.summary}` : ''}`,
      `Ignored stale outcome from instance #${input.instanceId}: ${input.outcome}${input.summary ? ` — ${input.summary}` : ''}`,
    );
  }

  if (task.active_instance_id === callbackInstance.id) {
    return { kind: 'allow', mode: 'active_instance' };
  }

  if (task.active_instance_id != null && task.active_instance_id !== callbackInstance.id) {
    return buildIgnoredOutcomeDecision(
      'instance_not_authoritative',
      `Ignored stale outcome for task #${input.taskId}: active_instance_id=${task.active_instance_id}, callback_instance_id=${callbackInstance.id}, callback_agent_id=${callbackInstance.agent_id}, outcome="${input.outcome}", actor="${changedBy}"${input.summary ? `, summary: ${input.summary}` : ''}`,
      `Ignored stale outcome from instance #${callbackInstance.id}: task is now owned by active instance #${task.active_instance_id}${input.summary ? ` — ${input.summary}` : ''}`,
    );
  }

  if (task.agent_id != null && task.agent_id === callbackInstance.agent_id) {
    return { kind: 'allow', mode: 'same_lane' };
  }

  return buildIgnoredOutcomeDecision(
    'instance_not_authoritative',
    `Ignored stale outcome for task #${input.taskId}: task_agent_id=${task.agent_id ?? 'none'}, callback_instance_id=${callbackInstance.id}, callback_agent_id=${callbackInstance.agent_id}, outcome="${input.outcome}", actor="${changedBy}"${input.summary ? `, summary: ${input.summary}` : ''}`,
    `Ignored stale outcome from instance #${callbackInstance.id}: task is no longer assigned to that instance/lane${input.summary ? ` — ${input.summary}` : ''}`,
  );
}

export async function applyTaskOutcome(db: Database.Database, input: ApplyTaskOutcomeInput): Promise<ApplyTaskOutcomeResult> {
  const changedBy = input.changedBy ?? 'system';
  const existing = db.prepare(`
    SELECT
      id,
      status,
      project_id,
      sprint_id,
      task_type,
      (SELECT sprint_type FROM sprints WHERE id = tasks.sprint_id) as sprint_type,
      agent_id,
      active_instance_id,
      review_owner_agent_id,
      review_branch,
      review_commit,
      review_url,
      qa_verified_commit,
      qa_tested_url,
      merged_commit,
      deployed_commit,
      deployed_at,
      live_verified_at,
      live_verified_by,
      deploy_target,
      evidence_json,
      previous_status
    FROM tasks
    WHERE id = ?
  `).get(input.taskId) as TaskOutcomeTaskRow | undefined;

  if (!existing) {
    throw new Error('Task not found');
  }

  const priorStatus = existing.status;
  const routingBaseStatus = priorStatus === 'needs_attention' && existing.previous_status
    ? existing.previous_status
    : priorStatus;

  if (priorStatus === 'cancelled' || priorStatus === 'done') {
    const message = `Ignored stale outcome for task #${input.taskId}: task is ${priorStatus}, outcome="${input.outcome}", actor="${changedBy}"${input.instanceId != null ? `, instance_id=${input.instanceId}` : ''}${input.summary ? `, summary: ${input.summary}` : ''}`;
    insertAuditLog(db, message);
    if (input.summary) {
      addAuditNote(db, input.taskId, changedBy, `Ignored stale outcome: ${input.outcome} — ${input.summary}`);
    }

    return {
      ok: true,
      applied: false,
      ignored: true,
      reason: 'task_terminal',
      priorStatus,
      nextStatus: priorStatus,
      outcome: input.outcome,
    };
  }

  const authorityDecision = resolveOutcomeAuthority(db, existing, input, changedBy);
  if (authorityDecision.kind === 'ignore') {
    insertAuditLog(db, authorityDecision.auditMessage);
    if (input.summary) {
      addAuditNote(db, input.taskId, changedBy, authorityDecision.auditNote);
    }

    // Emit stale_outcome_write integrity event for instance_not_authoritative cases
    if (authorityDecision.reason === 'instance_not_authoritative') {
      emitIntegrityEvent(db, {
        taskId: input.taskId,
        anomalyType: 'stale_outcome_write',
        detail: `${authorityDecision.auditNote}${input.instanceId != null ? ` (instance #${input.instanceId})` : ''}`,
        instanceId: input.instanceId ?? null,
        projectId: existing.project_id,
        agentId: existing.agent_id,
      });
    }

    return {
      ok: true,
      applied: false,
      ignored: true,
      reason: authorityDecision.reason,
      priorStatus,
      nextStatus: priorStatus,
      outcome: input.outcome,
    };
  }

  const projectId = existing.project_id;

  // ── Failure classification ────────────────────────────────────────────────
  // Unsuccessful exits must preserve lane-of-failure even when the task auto-
  // recovers back to ready/reviewable work. Task #95 standardizes that model.
  let resolvedFailureClass: FailureClass | null = null;
  let autoRecovered = false;
  let recoveryDescription: string | undefined;
  let effectiveOutcome = input.outcome;
  const failureLane = inferFailureLane(routingBaseStatus);
  const isUnsuccessfulOutcome = input.outcome === 'failed' || input.outcome === 'blocked' || input.outcome === 'qa_fail';

  const hasConfiguredOutcomeRoute = (candidateOutcome: string): boolean => {
    if (canonicalOutcomeRoute(db, routingBaseStatus, candidateOutcome, existing.task_type, existing.sprint_id, existing.sprint_type)) {
      return true;
    }

    const configuredRoute = db.prepare(`
      SELECT 1
      FROM routing_config
      WHERE from_status = ? AND outcome = ? AND enabled = 1
        AND (project_id = ? OR project_id IS NULL)
      ORDER BY CASE WHEN project_id = ? THEN 0 ELSE 1 END, id ASC
      LIMIT 1
    `).get(routingBaseStatus, candidateOutcome, projectId, projectId) as { 1: number } | undefined;

    return Boolean(configuredRoute);
  };

  if (isUnsuccessfulOutcome) {
    if (input.failureClass && isValidFailureClass(input.failureClass)) {
      resolvedFailureClass = input.failureClass;
    } else {
      resolvedFailureClass = inferFailureClass({
        outcome: input.outcome,
        summary: input.summary,
        fromStatus: routingBaseStatus,
        error: input.failureDetail,
      });
    }

    if (!isFailureClassAllowedForLane(resolvedFailureClass, failureLane)) {
      throw new Error(`failure_class "${resolvedFailureClass}" is not allowed from ${routingBaseStatus} (${failureLane} lane)`);
    }

    const shouldBeBlocked = isBlockedFailureClass(resolvedFailureClass);
    if (input.outcome === 'blocked' && !shouldBeBlocked) {
      throw new Error(`blocked outcome requires a blocked failure_class, got "${resolvedFailureClass}"`);
    }
    if (input.outcome === 'failed' && !isFailedFailureClass(resolvedFailureClass)) {
      throw new Error(`failed outcome requires a failed failure_class, got "${resolvedFailureClass}"`);
    }

    if (input.outcome === 'failed') {
      const classSpecificOutcome = `failed:${resolvedFailureClass}`;
      const legacyFailureOutcomeAliases: Partial<Record<FailureClass, string>> = {
        qa_failure: 'failed:evidence_failure',
        release_failure: 'failed:release_conflict',
        infra_failure: 'failed:runtime_contract_failure',
        runtime_failure: 'failed:runtime_contract_failure',
      };
      const classSpecificRoute = hasConfiguredOutcomeRoute(classSpecificOutcome);
      const aliasedOutcome = legacyFailureOutcomeAliases[resolvedFailureClass] ?? null;
      const aliasedRoute = aliasedOutcome ? hasConfiguredOutcomeRoute(aliasedOutcome) : false;
      if (classSpecificRoute) {
        effectiveOutcome = classSpecificOutcome;
      } else if (aliasedRoute && aliasedOutcome) {
        effectiveOutcome = aliasedOutcome;
      }
    }

    const spec = getRecoverySpec(resolvedFailureClass);
    autoRecovered = spec.autoRecoverable;
    recoveryDescription = spec.recoveryDescription;
  }

  let sprintWorkflowRoute: ReturnType<typeof resolveSprintWorkflowOutcome> = null;
  try {
    sprintWorkflowRoute = resolveSprintWorkflowOutcome(db, {
      status: routingBaseStatus,
      task_type: existing.task_type,
      sprint_id: existing.sprint_id,
      sprint_type: existing.sprint_type,
    }, effectiveOutcome);
  } catch (error) {
    if (!(effectiveOutcome !== input.outcome && effectiveOutcome.startsWith('failed:'))) throw error;
    const fallbackValidation = resolveSprintWorkflowOutcome(db, {
      status: routingBaseStatus,
      task_type: existing.task_type,
      sprint_id: existing.sprint_id,
      sprint_type: existing.sprint_type,
    }, input.outcome);
    if (!fallbackValidation) throw error;
  }

  const gateResult = requireReleaseGate(db, { ...existing, status: routingBaseStatus }, input.outcome, existing.task_type);
  if (gateResult.errors.length > 0) {
    const refusal = gateResult.errors[0];
    resolveRefusedTaskOutcome(db, {
      taskId: input.taskId,
      outcome: input.outcome,
      changedBy,
      reason: refusal,
      summary: input.summary ?? null,
      instanceId: input.instanceId ?? existing.active_instance_id,
    });
    throw new RefusedTaskOutcomeError(refusal);
  }

  const canonicalNextStatus = sprintWorkflowRoute?.nextStatus
    ?? canonicalOutcomeRoute(db, routingBaseStatus, effectiveOutcome, existing.task_type, existing.sprint_id, existing.sprint_type);

  let route: { to_status: string; lane: string } | undefined;
  if (!canonicalNextStatus) {
    route = db.prepare(`
      SELECT to_status, lane
      FROM routing_config
      WHERE from_status = ? AND outcome = ? AND enabled = 1
        AND project_id = ?
      LIMIT 1
    `).get(routingBaseStatus, effectiveOutcome, projectId) as { to_status: string; lane: string } | undefined;

    if (!route) {
      route = db.prepare(`
        SELECT to_status, lane
        FROM routing_config
        WHERE from_status = ? AND outcome = ? AND enabled = 1
          AND project_id IS NULL
        LIMIT 1
      `).get(routingBaseStatus, effectiveOutcome) as { to_status: string; lane: string } | undefined;
    }

    // Fall back to base 'failed' routing if class-specific routing found nothing
    if (!route && effectiveOutcome !== input.outcome) {
      route = db.prepare(`
        SELECT to_status, lane
        FROM routing_config
        WHERE from_status = ? AND outcome = ? AND enabled = 1
          AND project_id = ?
        LIMIT 1
      `).get(routingBaseStatus, input.outcome, projectId) as { to_status: string; lane: string } | undefined;

      if (!route) {
        route = db.prepare(`
          SELECT to_status, lane
          FROM routing_config
          WHERE from_status = ? AND outcome = ? AND enabled = 1
            AND project_id IS NULL
          LIMIT 1
        `).get(routingBaseStatus, input.outcome) as { to_status: string; lane: string } | undefined;
      }
      // Reset recovery state since we fell back to base routing
      if (route) {
        autoRecovered = false;
        recoveryDescription = undefined;
      }
    }
  }

  if (!canonicalNextStatus && !route) {
    throw new Error(`No routing config found for from_status="${priorStatus}" outcome="${input.outcome}"`);
  }

  const nextStatus = canonicalNextStatus ?? route!.to_status;
  const reviewOwnerAgentId = existing.review_owner_agent_id ?? existing.agent_id ?? null;
  const routedAssignment = resolveTaskRoutingAssignment(db, existing.sprint_id, existing.project_id, existing.task_type, nextStatus);
  const nextAgentId = input.outcome === 'qa_fail'
    ? (reviewOwnerAgentId ?? existing.agent_id ?? null)
    : (routedAssignment.agent_id ?? existing.agent_id);
  const nextReviewOwnerAgentId = input.outcome === 'qa_fail'
    ? reviewOwnerAgentId
    : (input.outcome === 'completed_for_review' ? reviewOwnerAgentId : existing.review_owner_agent_id ?? null);

  // Store failure classification on the task when failing.
  // Also capture previous_status so retry/reopen can restore workflow position
  // instead of always resetting to 'ready' (task #30).
  const preserveFailureMetadata = isUnsuccessfulOutcome || nextStatus === 'failed' || nextStatus === 'stalled';
  if (resolvedFailureClass) {
    db.prepare(`
      UPDATE tasks
      SET status = ?,
          agent_id = ?,
          review_owner_agent_id = ?,
          failure_class = ?,
          failure_detail = ?,
          previous_status = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(nextStatus, nextAgentId, nextReviewOwnerAgentId, resolvedFailureClass, input.failureDetail ?? input.summary ?? null,
           preserveFailureMetadata ? priorStatus : null,
           input.taskId);
  } else {
    db.prepare(`
      UPDATE tasks
      SET status = ?,
          agent_id = ?,
          review_owner_agent_id = ?,
          failure_class = NULL,
          failure_detail = NULL,
          previous_status = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(nextStatus, nextAgentId, nextReviewOwnerAgentId,
           input.taskId);
  }

  // Record the task outcome on the authoritative instance so the Jobs UI can
  // distinguish execution status (done/failed) from task workflow outcome.
  const lifecyclePostedAt = new Date().toISOString();
  let runtimeEndedBeforeOutcome = false;
  if (input.instanceId != null) {
    const runtimeState = db.prepare(`SELECT runtime_ended_at FROM job_instances WHERE id = ?`).get(input.instanceId) as { runtime_ended_at: string | null } | undefined;
    runtimeEndedBeforeOutcome = Boolean(runtimeState?.runtime_ended_at);
    db.prepare(`
      UPDATE job_instances
      SET task_outcome = ?,
          failure_class = ?,
          lifecycle_outcome_posted_at = COALESCE(lifecycle_outcome_posted_at, datetime('now'))
      WHERE id = ?
    `).run(input.outcome, resolvedFailureClass, input.instanceId);
  } else if (existing.active_instance_id != null) {
    const runtimeState = db.prepare(`SELECT runtime_ended_at FROM job_instances WHERE id = ?`).get(existing.active_instance_id) as { runtime_ended_at: string | null } | undefined;
    runtimeEndedBeforeOutcome = Boolean(runtimeState?.runtime_ended_at);
    db.prepare(`
      UPDATE job_instances
      SET task_outcome = ?,
          failure_class = ?,
          lifecycle_outcome_posted_at = COALESCE(lifecycle_outcome_posted_at, datetime('now'))
      WHERE id = ?
    `).run(input.outcome, resolvedFailureClass, existing.active_instance_id);
  }

  cleanupTaskExecutionLinkageForStatus(db, input.taskId, nextStatus);
  writeTaskLifecycleOutcomeHistory(db, input.taskId, changedBy, {
    outcome: input.outcome,
    postedAt: lifecyclePostedAt,
    postedAfterRuntimeEnd: runtimeEndedBeforeOutcome,
  });
  if (nextAgentId !== existing.agent_id) {
    logHistory(
      db,
      input.taskId,
      changedBy,
      'agent_id',
      resolveAgentName(db, existing.agent_id),
      resolveAgentName(db, nextAgentId),
    );
  }

  // ── Emit task_event for this outcome-driven status transition (#586) ─────
  writeTaskStatusChange(db, input.taskId, changedBy, priorStatus, nextStatus, {
    instanceId: input.instanceId ?? existing.active_instance_id,
    reason: input.summary ?? null,
    projectId: existing.project_id,
    agentId: existing.agent_id,
  });

  // ── Record failure_stage on instance (#586) ──────────────────────────────
  if (isUnsuccessfulOutcome || input.outcome.startsWith('failed:')) {
    const failInstanceId = input.instanceId ?? existing.active_instance_id;
    if (failInstanceId != null) {
      try {
        db.prepare(`UPDATE job_instances SET failure_stage = ? WHERE id = ?`)
          .run(priorStatus, failInstanceId);
      } catch { /* non-fatal */ }
    }
  }

  // ── Integrity anomaly detection (#586) ───────────────────────────────────
  const iProjectId = existing.project_id;
  const iInstanceId = input.instanceId ?? existing.active_instance_id;
  const iAgentId = existing.agent_id;

  if (nextStatus === 'review' && !existing.review_branch && !existing.review_commit) {
    emitIntegrityEvent(db, {
      taskId: input.taskId, anomalyType: 'missing_review_evidence',
      detail: `Task moved to review (outcome: ${input.outcome}) with no review_branch or review_commit`,
      instanceId: iInstanceId, projectId: iProjectId, agentId: iAgentId,
    });
  }

  if (nextStatus === 'qa_pass' && !existing.qa_verified_commit) {
    emitIntegrityEvent(db, {
      taskId: input.taskId, anomalyType: 'missing_qa_evidence',
      detail: `Task moved to qa_pass (outcome: ${input.outcome}) with no qa_verified_commit`,
      instanceId: iInstanceId, projectId: iProjectId, agentId: iAgentId,
    });
  }

  if (nextStatus === 'qa_pass' && existing.review_commit && existing.qa_verified_commit
    && existing.review_commit !== existing.qa_verified_commit) {
    emitIntegrityEvent(db, {
      taskId: input.taskId, anomalyType: 'commit_mismatch',
      detail: `review_commit=${existing.review_commit} ≠ qa_verified_commit=${existing.qa_verified_commit}`,
      instanceId: iInstanceId, projectId: iProjectId, agentId: iAgentId,
    });
  }

  if (nextStatus === 'done' && existing.deployed_at && !existing.live_verified_at) {
    emitIntegrityEvent(db, {
      taskId: input.taskId, anomalyType: 'deployed_not_verified',
      detail: `Task reached done without live_verified_at being set`,
      instanceId: iInstanceId, projectId: iProjectId, agentId: iAgentId,
    });
  }

  const failureInfo = resolvedFailureClass ? `, failure_class="${resolvedFailureClass}"${autoRecovered ? ' (auto-recovered)' : ''}` : '';
  const message = `Outcome transition: task #${input.taskId} (${priorStatus} → ${nextStatus}), outcome="${input.outcome}"${failureInfo}, actor="${changedBy}"${existing.agent_id ? `, agent_id=${existing.agent_id}` : ''}${input.instanceId != null ? `, instance_id=${input.instanceId}` : ''}${input.summary ? `, summary: ${input.summary}` : ''}`;
  insertAuditLog(db, message);

  if (input.summary) {
    addAuditNote(db, input.taskId, changedBy, `Outcome: ${input.outcome} — ${input.summary}`);
  }

  notifyTaskStatusChange(db, {
    taskId: input.taskId,
    fromStatus: priorStatus,
    toStatus: nextStatus,
    source: changedBy,
  });

  // ── Auto-close instance on terminal outcomes ──────────────────────────────
  // When the outcome is terminal (e.g. completed_for_review, qa_pass, blocked,
  // failed, live_verified), automatically mark the instance done and terminate
  // the agent session. This makes POST /tasks/:id/outcome the single exit step.
  // The separate PUT /instances/:id/complete remains for backward compat but is
  // no longer required.
  //
  // deployed_live is intentionally excluded: it is Step A of some
  // deployment-stage workflows and the instance must stay open until
  // live_verified (Step B) is posted.
  let instanceClosed = false;
  const authoritativeInstanceId = input.instanceId ?? existing.active_instance_id;
  if (authoritativeInstanceId != null && isTerminalOutcome(input.outcome)) {
    const instanceStatus = input.outcome === 'failed' ? 'failed' : 'done';
    try {
      const closeResult = await closeInstance({
        db,
        instanceId: authoritativeInstanceId,
        status: instanceStatus,
        summary: input.summary ?? null,
        outcome: input.outcome,
        skipIfAlreadyDone: true,
      });
      instanceClosed = closeResult.closed;
    } catch (closeErr) {
      // Non-fatal: log and continue. Task status was already updated.
      console.warn(`[taskOutcome] Auto-close failed for instance ${authoritativeInstanceId} (non-fatal):`, closeErr instanceof Error ? closeErr.message : closeErr);
    }
  }

  return {
    ok: true,
    applied: true,
    ignored: false,
    priorStatus,
    nextStatus,
    outcome: input.outcome,
    instanceClosed,
    failureClass: resolvedFailureClass,
    autoRecovered,
    recoveryDescription,
  };
}
