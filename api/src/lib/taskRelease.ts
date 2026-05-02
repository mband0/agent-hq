import type Database from 'better-sqlite3';
import {
  RELEASE_TASK_STATUSES,
  type ReleaseTaskStatus,
  DIRECT_GATED_TASK_STATUSES,
  type DirectGatedTaskStatus,
} from './taskStatuses';
import { resolveSprintWorkflow } from './sprintWorkflow';
import { resolveSprintTypeForSprintId, resolveTaskWorkflowContext } from './sprintTypeConfig';
import {
  listSprintTaskTransitions,
  loadSprintTaskTransitionRequirements,
  resolveSprintTaskTransition,
} from './sprintTaskPolicy';

export type IntegrityState =
  | 'clean'
  | 'missing_review_evidence'
  | 'missing_qa_evidence'
  | 'missing_deploy_evidence'
  | 'missing_live_verification'
  | 'invalid_done_state';

export interface TaskReleaseEvidence {
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
}

export interface IntegrityEvaluation {
  integrity_state: IntegrityState;
  integrity_warnings: string[];
  release_state_badge: 'review build' | 'qa passed' | 'ready to merge' | 'live deployed' | 'live verified' | null;
  release_state_label: string | null;
  is_legacy_unverified_done: boolean;
}

export interface TaskReleaseRecord extends Partial<TaskReleaseEvidence> {
  id: number;
  status: string;
  task_type?: string | null;
  sprint_id?: number | null;
}

export function hasImplementationEvidence(task: Partial<TaskReleaseEvidence>): boolean {
  return Boolean(task.review_branch && task.review_commit);
}

export function hasQaEvidence(task: Partial<TaskReleaseEvidence>): boolean {
  return Boolean(task.qa_verified_commit && task.review_commit && task.qa_verified_commit === task.review_commit);
}

export function hasDeployEvidence(task: Partial<TaskReleaseEvidence>): boolean {
  return Boolean((task.merged_commit || task.deployed_commit) && task.deploy_target && task.deployed_at);
}

export function hasLiveVerification(task: Partial<TaskReleaseEvidence>): boolean {
  return Boolean(task.deployed_commit && task.live_verified_by && task.live_verified_at);
}

function isMainlineBranch(branch: string | null | undefined): boolean {
  const normalized = String(branch ?? '').trim().toLowerCase();
  return normalized === 'main' || normalized === 'master' || normalized === 'origin/main' || normalized === 'origin/master';
}

function isProductionLikeUrl(url: string | null | undefined): boolean {
  const value = String(url ?? '').trim().toLowerCase();
  if (!value) return false;
  return value.includes(':3500')
    || value.includes('atlas-hq-production')
    || value.includes('atlas-hq-prod')
    || value.includes('nordinitiatives.com');
}


const PLACEHOLDER_VALUES = new Set(['-', '—', 'n/a', 'na', 'none', 'null', 'undefined', 'tbd', 'todo', 'pending', 'placeholder']);

function normalizedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPlaceholderValue(value: unknown): boolean {
  const normalized = normalizedString(value)?.toLowerCase();
  return normalized ? PLACEHOLDER_VALUES.has(normalized) : false;
}

function isValidSha(value: unknown): boolean {
  const normalized = normalizedString(value);
  return normalized ? /^[0-9a-f]{7,40}$/i.test(normalized) : false;
}

function isHttpUrl(value: unknown): boolean {
  const normalized = normalizedString(value);
  return Boolean(normalized && (normalized.startsWith('http://') || normalized.startsWith('https://')));
}

type TransitionRequirementRow = {
  field_name: string;
  requirement_type: string;
  match_field: string | null;
  severity: string;
  message: string;
};

function loadTransitionRequirements(
  db: Database.Database,
  outcome: string,
  sprintId?: number | null,
  taskType?: string | null,
): TransitionRequirementRow[] {
  const sprintRows = loadSprintTaskTransitionRequirements(db, sprintId ?? null, outcome, taskType);
  if (sprintRows.length > 0) {
    return sprintRows.map((row) => ({
      field_name: row.field_name,
      requirement_type: row.requirement_type,
      match_field: row.match_field,
      severity: row.severity,
      message: row.message,
    }));
  }

  if (taskType) {
    const typeReqs = db.prepare(`
      SELECT field_name, requirement_type, match_field, severity, message
      FROM transition_requirements
      WHERE task_type = ? AND outcome = ? AND enabled = 1
      ORDER BY priority DESC, id ASC
    `).all(taskType, outcome) as TransitionRequirementRow[];

    if (typeReqs.length > 0) return typeReqs;
  }

  return db.prepare(`
    SELECT field_name, requirement_type, match_field, severity, message
    FROM transition_requirements
    WHERE task_type IS NULL AND outcome = ? AND enabled = 1
    ORDER BY priority DESC, id ASC
  `).all(outcome) as TransitionRequirementRow[];
}

function statusRequiresQaEvidence(
  db: Database.Database | undefined,
  task: ({ status?: string | null; task_type?: string | null; sprint_id?: number | null } & Partial<TaskReleaseEvidence>),
): boolean {
  const status = task.status ?? null;
  if (status !== 'qa_pass' && status !== 'ready_to_merge') return false;
  if (!db) return false;

  try {
    const outcome = status === 'qa_pass' ? 'qa_pass' : 'approved_for_merge';
    const reqs = loadTransitionRequirements(db, outcome, task.sprint_id ?? null, task.task_type);
    return reqs.some(req => req.severity !== 'warn' && req.field_name === 'qa_verified_commit');
  } catch {
    return false;
  }
}

export function evaluateTaskIntegrity(
  task: { status?: string | null; task_type?: string | null } & Partial<TaskReleaseEvidence>,
  db?: Database.Database,
): IntegrityEvaluation {
  const warnings: string[] = [];
  const status = task.status ?? null;
  const reviewOk = hasImplementationEvidence(task);
  const qaOk = hasQaEvidence(task);
  const deployOk = hasDeployEvidence(task);
  const liveOk = hasLiveVerification(task);
  const requiresQaEvidence = statusRequiresQaEvidence(db, task);

  let integrityState: IntegrityState = 'clean';

  if (status === 'review' && !reviewOk) {
    integrityState = 'missing_review_evidence';
    warnings.push('Task is in review but missing review branch/commit evidence.');
  } else if (requiresQaEvidence && !qaOk) {
    integrityState = 'missing_qa_evidence';
    warnings.push(`Task is ${status} but missing QA verification evidence.`);
  } else if (status === 'deployed' && !deployOk) {
    integrityState = 'missing_deploy_evidence';
    warnings.push('Task is deployed but missing deploy commit/target/timestamp evidence.');
  } else if (status === 'deployed' && !liveOk) {
    integrityState = 'missing_live_verification';
    warnings.push('Task is deployed, awaiting live verification.');
  } else if (status === 'done' && (!deployOk || !liveOk)) {
    integrityState = 'invalid_done_state';
    if (!deployOk) warnings.push('Done task is missing deploy evidence.');
    if (!liveOk) warnings.push('Done task is missing live verification evidence.');
  }

  if (status === 'qa_pass' && !deployOk) {
    warnings.push('QA passed, but not deployed yet.');
  }
  if (status === 'ready_to_merge' && !deployOk) {
    warnings.push('Ready to merge, but deploy evidence has not been recorded yet.');
  }

  if ((status === 'review' || status === 'qa_pass' || status === 'ready_to_merge') && isMainlineBranch(task.review_branch)) {
    warnings.push('Review evidence references main/master. Atlas HQ implementation work should use a feature branch/worktree, not main.');
  }
  if ((status === 'review' || status === 'qa_pass' || status === 'ready_to_merge') && isProductionLikeUrl(task.review_url)) {
    warnings.push('Review evidence points at a production-like URL. Use Dev evidence for implementation handoff and keep production for deployed/live verification.');
  }
  if ((status === 'qa_pass' || status === 'ready_to_merge') && isProductionLikeUrl(task.qa_tested_url)) {
    warnings.push('QA evidence points at a production-like URL. For Atlas HQ internal tasks, use the Dev environment for QA proof and keep production for live verification.');
  }

  let release_state_badge: IntegrityEvaluation['release_state_badge'] = null;
  let release_state_label: string | null = null;

  if (status === 'review') {
    release_state_badge = 'review build';
    release_state_label = 'Review build only';
  } else if (status === 'qa_pass') {
    release_state_badge = 'qa passed';
    release_state_label = 'QA passed (not live)';
  } else if (status === 'ready_to_merge') {
    release_state_badge = 'ready to merge';
    release_state_label = 'Ready to merge';
  } else if (status === 'deployed') {
    release_state_badge = 'live deployed';
    release_state_label = 'Deployed to live';
  } else if (status === 'done') {
    release_state_badge = liveOk ? 'live verified' : 'live deployed';
    release_state_label = liveOk ? 'Live verified' : 'Done (legacy, unverified)';
  }

  return {
    integrity_state: integrityState,
    integrity_warnings: warnings,
    release_state_badge,
    release_state_label,
    is_legacy_unverified_done: status === 'done' && (!deployOk || !liveOk),
  };
}

export interface ReleaseGateResult {
  errors: string[];
  warnings: string[];
}

/**
 * Evaluate transition requirements for a given outcome.
 *
 * Resolution order for each requirement:
 *  1. transition_requirements WHERE task_type = ? (highest priority first)
 *  2. transition_requirements WHERE task_type IS NULL (defaults)
 *
 * When task-type-specific requirements exist for an outcome, they REPLACE
 * the defaults for that outcome (they are overrides, not additions).
 *
 * Returns {errors, warnings} instead of throwing, so callers can handle
 * warnings vs blocking errors.
 */
export function requireReleaseGate(
  db: Database.Database,
  task: TaskReleaseRecord,
  outcome: string,
  taskType?: string | null,
): ReleaseGateResult {
  let reqs: TransitionRequirementRow[];

  try {
    reqs = loadTransitionRequirements(db, outcome, task.sprint_id ?? null, taskType);
  } catch {
    return { errors: [], warnings: [] };
  }

  if (reqs.length === 0) {
    return { errors: [], warnings: [] };
  }

  const taskRecord = task as unknown as Record<string, unknown>;
  const result: ReleaseGateResult = { errors: [], warnings: [] };

  for (const req of reqs) {
    const fieldValue = taskRecord[req.field_name];

    let failed = false;
    if (req.requirement_type === 'required') {
      // For deployed_live: merged_commit OR deployed_commit satisfies
      if (outcome === 'deployed_live' && req.field_name === 'merged_commit') {
        failed = !taskRecord['merged_commit'] && !taskRecord['deployed_commit'];
      } else {
        failed = !fieldValue;
      }
    } else if (req.requirement_type === 'match') {
      const matchValue = req.match_field ? taskRecord[req.match_field] : null;
      failed = !fieldValue || !matchValue || fieldValue !== matchValue;
    } else if (req.requirement_type === 'from_status') {
      failed = task.status !== req.match_field;
    }

    if (failed) {
      const msg = req.message || `${outcome} requires ${req.field_name}`;
      if (req.severity === 'warn') {
        result.warnings.push(msg);
      } else {
        result.errors.push(msg);
      }
    }
  }

  if (outcome === 'completed_for_review') {
    if (isPlaceholderValue(task.review_branch)) {
      result.errors.push('completed_for_review requires review_branch, blank placeholder values are not allowed');
    } else if (isMainlineBranch(task.review_branch)) {
      result.errors.push('completed_for_review requires review_branch to be a feature branch, not main/master');
    }

    if (isPlaceholderValue(task.review_commit)) {
      result.errors.push('completed_for_review requires review_commit, blank placeholder values are not allowed');
    } else if (normalizedString(task.review_commit) && !isValidSha(task.review_commit)) {
      result.errors.push('completed_for_review requires review_commit to be a valid git SHA');
    }

    if (isPlaceholderValue(task.review_url)) {
      result.errors.push('completed_for_review requires review_url, blank placeholder values are not allowed');
    } else if (!isHttpUrl(task.review_url)) {
      result.errors.push('completed_for_review requires valid review_url');
    } else if (isProductionLikeUrl(task.review_url)) {
      result.errors.push('completed_for_review requires review_url to reference a non-production review artifact');
    }
  }

  if (outcome === 'qa_pass') {
    if (isPlaceholderValue(task.qa_verified_commit)) {
      result.errors.push('qa_pass requires qa_verified_commit, blank placeholder values are not allowed');
    } else if (normalizedString(task.qa_verified_commit) && !isValidSha(task.qa_verified_commit)) {
      result.errors.push('qa_pass requires qa_verified_commit to be a valid git SHA');
    }

    if (isPlaceholderValue(task.qa_tested_url)) {
      result.errors.push('qa_pass requires qa_tested_url, blank placeholder values are not allowed');
    } else if (!isHttpUrl(task.qa_tested_url)) {
      result.errors.push('qa_pass requires valid qa_tested_url');
    } else if (isProductionLikeUrl(task.qa_tested_url)) {
      result.errors.push('qa_pass requires qa_tested_url to reference a non-production QA artifact');
    }
  }

  return result;
}

/**
 * Legacy hardcoded release gate — fallback when transition_requirements
 * table has no matching rows for an outcome. Will be removed once all
 * requirements are confirmed migrated.
 */

/**
 * Actors considered human/user-originated. These are allowed to change task
 * status directly via the generic PUT endpoint (same as Atlas), while other
 * automated actors must route through POST /outcome.
 */
export const HUMAN_ACTORS = new Set(['User', 'user', 'Human', 'human']);

export function assertTaskStatusUpdateAllowed(
  existingTask: { status: string },
  nextStatus: string | null | undefined,
  changedBy: string,
): void {
  if (!nextStatus || nextStatus === existingTask.status) return;
  // Atlas (agent) and human users may change task status directly.
  // All other automated actors must use the /outcome endpoint.
  if (changedBy !== 'Atlas' && !HUMAN_ACTORS.has(changedBy)) {
    throw new Error('Only Atlas or a human user may change task status through the generic update endpoint');
  }
}

type SprintWorkflowRouteResolution = {
  nextStatus: string;
  allowedOutcomes: string[];
};

export function resolveSprintWorkflowOutcome(
  db: Database.Database,
  task: { status: string; task_type?: string | null; sprint_id?: number | null; sprint_type?: string | null },
  outcome: string,
): SprintWorkflowRouteResolution | null {
  const sprintType = task.sprint_type ?? resolveSprintTypeForSprintId(db, task.sprint_id ?? null);
  const workflow = resolveTaskWorkflowContext(db, { sprintType, taskType: task.task_type });

  if (workflow.taskType && workflow.allowedTaskTypes.length > 0 && !workflow.allowedTaskTypes.includes(workflow.taskType)) {
    throw new Error(`Cannot move task because task_type "${workflow.taskType}" is not allowed for sprint type "${workflow.sprintType}". Allowed task types: ${workflow.allowedTaskTypes.join(', ')}`);
  }

  const sprintTransitions = listSprintTaskTransitions(db, task.sprint_id ?? null);
  const workflowFallbackTransitions = sprintTransitions.length > 0
    ? []
    : resolveSprintWorkflow(db, task.sprint_id ?? null, workflow.sprintType).transitions;
  const matchingTransitions = [...sprintTransitions.map((transition) => ({
    fromStatus: transition.from_status,
    outcome: transition.outcome,
    toStatus: transition.to_status,
    taskType: transition.task_type,
    priority: transition.priority,
    isProtected: Boolean(transition.is_protected),
  })), ...workflowFallbackTransitions]
    .filter((transition) => transition.fromStatus === task.status)
    .filter((transition) => transition.taskType == null || transition.taskType === workflow.taskType)
    .sort((left, right) => {
      const taskTypeSpecificDelta = Number(Boolean(right.taskType)) - Number(Boolean(left.taskType));
      if (taskTypeSpecificDelta !== 0) return taskTypeSpecificDelta;
      return right.priority - left.priority;
    });

  if (matchingTransitions.length === 0) {
    return null;
  }

  const route = matchingTransitions.find((transition) => transition.outcome === outcome) ?? null;
  const allowedOutcomes = Array.from(new Set(matchingTransitions.map((transition) => transition.outcome)));

  if (!route) {
    throw new Error(
      `Cannot apply outcome "${outcome}" from "${task.status}" for sprint type "${workflow.sprintType}". Allowed outcomes: ${allowedOutcomes.length > 0 ? allowedOutcomes.join(', ') : 'none'}`,
    );
  }

  return {
    nextStatus: route.toStatus,
    allowedOutcomes,
  };
}

export function assertAtlasDirectStatusGate(
  db: Database.Database,
  task: TaskReleaseRecord & { task_type?: string | null; sprint_id?: number | null },
  nextStatus: string | null | undefined,
): void {
  if (!nextStatus || nextStatus === task.status) return;

  const statusToOutcome: Record<string, string> = {
    review: 'completed_for_review',
    qa_pass: 'qa_pass',
    ready_to_merge: 'approved_for_merge',
    deployed: 'deployed_live',
    done: 'live_verified',
  };

  const outcome = statusToOutcome[nextStatus];
  if (!outcome) return;

  const sprintType = resolveSprintTypeForSprintId(db, task.sprint_id ?? null);
  const workflow = resolveTaskWorkflowContext(db, { sprintType, taskType: task.task_type });

  if (workflow.taskType && workflow.allowedTaskTypes.length > 0 && !workflow.allowedTaskTypes.includes(workflow.taskType)) {
    throw new Error(`Cannot move task to "${nextStatus}" because task_type "${workflow.taskType}" is not allowed for sprint type "${workflow.sprintType}". Allowed task types: ${workflow.allowedTaskTypes.join(', ')}`);
  }

  const allowedDirectStatuses = new Set<ReleaseTaskStatus>(['review', 'qa_pass', 'ready_to_merge', 'deployed', 'done']);
  const allowedTransitions = Array.from(allowedDirectStatuses).filter(candidate => {
    const candidateOutcome = statusToOutcome[candidate];
    if (!candidateOutcome) return false;
    const sprintRoute = resolveSprintWorkflowOutcome(db, {
      status: task.status,
      task_type: workflow.taskType,
      sprint_id: task.sprint_id ?? null,
      sprint_type: workflow.sprintType,
    }, candidateOutcome);
    return (sprintRoute?.nextStatus ?? canonicalOutcomeRoute(db, task.status, candidateOutcome, workflow.taskType, task.sprint_id ?? null, workflow.sprintType)) === candidate;
  });

  if (!allowedTransitions.includes(nextStatus as ReleaseTaskStatus)) {
    const allowedLabel = allowedTransitions.length > 0 ? allowedTransitions.join(', ') : 'none';
    throw new Error(`Cannot move task from "${task.status}" to "${nextStatus}" for sprint type "${workflow.sprintType}". Allowed next statuses: ${allowedLabel}`);
  }

  if (nextStatus === 'done' && task.status !== 'deployed') {
    throw new Error('done requires task status deployed');
  }

  const gate = requireReleaseGate(db, task, outcome, task.task_type);
  if (gate.errors.length > 0) {
    throw new Error(gate.errors[0]);
  }
}

/**
 * Legacy hardcoded route map — used as final fallback when lifecycle_rules
 * table has no matching row. Will be removed once all transitions are
 * confirmed migrated.
 */

/**
 * Resolve the next status for a given (from_status, outcome) pair.
 *
 * Single canonical workflow model (task #614): routing_transitions is the
 * authoritative table for all outcome→status routing. lifecycle_rules is
 * kept as a read-only legacy fallback during the transition period.
 *
 * Resolution order:
 *  1. routing_transitions WHERE task_type = ? AND project_id IS NULL AND enabled = 1
 *     (task-type-specific override; highest priority wins)
 *  2. routing_transitions WHERE task_type IS NULL AND project_id IS NULL AND enabled = 1
 *     (global default transition)
 *  3. lifecycle_rules WHERE task_type = ? AND enabled = 1  (legacy compat)
 *  4. lifecycle_rules WHERE task_type IS NULL AND enabled = 1  (legacy compat)
 */
export function canonicalOutcomeRoute(
  db: Database.Database,
  priorStatus: string,
  outcome: string,
  taskType?: string | null,
  sprintId?: number | null,
  sprintType?: string | null,
): string | null {
  const workflow = resolveTaskWorkflowContext(db, { sprintType: sprintType ?? null, taskType });
  const taskTypeAllowed = !workflow.taskType
    || workflow.allowedTaskTypes.length === 0
    || workflow.allowedTaskTypes.includes(workflow.taskType);

  try {
    const sprintTransition = resolveSprintTaskTransition(db, sprintId ?? null, priorStatus, outcome, workflow.taskType);
    if (sprintTransition) return sprintTransition.to_status;

    if (workflow.sprintType && taskTypeAllowed) {
      const sprintRule = db.prepare(`
        SELECT swt.to_status_key as to_status
        FROM sprint_workflow_templates sw
        INNER JOIN sprint_workflow_transitions swt ON swt.template_id = sw.id
        WHERE sw.sprint_type_key = ?
          AND sw.is_default = 1
          AND swt.from_status_key = ?
          AND swt.outcome = ?
        ORDER BY swt.stage_order ASC, swt.id ASC
        LIMIT 1
      `).get(workflow.sprintType, priorStatus, outcome) as { to_status: string } | undefined;
      if (sprintRule) return sprintRule.to_status;
    }

    // 1. routing_transitions: task-type-specific, but only when allowed by sprint-type config
    if (workflow.taskType && taskTypeAllowed) {
      const typeRule = db.prepare(`
        SELECT to_status FROM routing_transitions
        WHERE task_type = ? AND from_status = ? AND outcome = ? AND enabled = 1 AND project_id IS NULL
        ORDER BY priority DESC, id ASC
        LIMIT 1
      `).get(workflow.taskType, priorStatus, outcome) as { to_status: string } | undefined;
      if (typeRule) return typeRule.to_status;
    }

    // 2. routing_transitions: global default (task_type IS NULL)
    const defaultRule = db.prepare(`
      SELECT to_status FROM routing_transitions
      WHERE task_type IS NULL AND from_status = ? AND outcome = ? AND enabled = 1 AND project_id IS NULL
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `).get(priorStatus, outcome) as { to_status: string } | undefined;
    if (defaultRule) return defaultRule.to_status;
  } catch {
    // routing_transitions columns may not exist yet (old DB) — fall through
  }

  // 3–4. lifecycle_rules legacy compat (read-only fallback)
  try {
    if (workflow.taskType && taskTypeAllowed) {
      const typeRule = db.prepare(`
        SELECT to_status FROM lifecycle_rules
        WHERE task_type = ? AND from_status = ? AND outcome = ? AND enabled = 1
        ORDER BY priority DESC, id ASC
        LIMIT 1
      `).get(workflow.taskType, priorStatus, outcome) as { to_status: string } | undefined;
      if (typeRule) return typeRule.to_status;
    }

    const defaultLegacyRule = db.prepare(`
      SELECT to_status FROM lifecycle_rules
      WHERE task_type IS NULL AND from_status = ? AND outcome = ? AND enabled = 1
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `).get(priorStatus, outcome) as { to_status: string } | undefined;
    if (defaultLegacyRule) return defaultLegacyRule.to_status;
  } catch {
    // lifecycle_rules table may not exist yet (test DBs) — fall through
  }

  return null;
}
