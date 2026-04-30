/**
 * contracts/workflowContract.ts — Shared workflow semantics for all agent dispatches.
 *
 * This is the SINGLE SOURCE OF TRUTH for the Agent HQ task lifecycle model.
 * It defines WHAT an agent must do (start, progress, outcome, evidence) without
 * specifying HOW (curl commands, HTTP calls, structured JSON blocks, etc.).
 *
 * Runtime-specific transport adapters (local, remote-direct, proxy-managed)
 * consume these semantics and produce the concrete instructions appropriate
 * for each agent's execution environment.
 *
 * Task #632: Split shared workflow contract from runtime-specific transport.
 */

import Database from 'better-sqlite3';
import {
  resolveSprintWorkflow,
  type ResolvedSprintWorkflow,
  type ResolvedSprintWorkflowTransition,
} from '../../lib/sprintWorkflow';

// ── PM task types ────────────────────────────────────────────────────────────

/**
 * PM-family task types that skip QA and post approved_for_merge directly
 * from in_progress (or review). Kept in sync with routing_transitions
 * and transition_requirements in schema/routing.ts.
 */
export const PM_TASK_TYPES = new Set(['pm', 'pm_analysis', 'pm_operational']);

// ── Workflow lane resolution ─────────────────────────────────────────────────

export type WorkflowLane = 'implementation' | 'review' | 'release' | 'pm';

export interface ResolvedWorkflowLane {
  lane: WorkflowLane;
  suggestedOutcome: string;
  validOutcomes: string[];
  outcomeHelp: OutcomeHelpEntry[];
  source: 'sprint_type_config' | 'compatibility';
  sprintType?: string | null;
  workflowTemplateKey?: string | null;
}

export interface OutcomeHelpEntry {
  outcome: string;
  description: string;
}

export interface WorkflowResolutionContext {
  taskStatus: string;
  taskType?: string | null;
  sprintId?: number | null;
  sprintType?: string | null;
  db?: Database.Database | null;
  resolvedWorkflow?: ResolvedSprintWorkflow | null;
  workflowTemplate?: ResolvedSprintWorkflow | null;
}

function normalizeSprintType(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized.length > 0 ? normalized : null;
}

function buildResolvedLane(
  lane: WorkflowLane,
  source: ResolvedWorkflowLane['source'],
  options: {
    sprintType?: string | null;
    workflowTemplateKey?: string | null;
    suggestedOutcome?: string;
    validOutcomes?: string[];
    outcomeHelp?: OutcomeHelpEntry[];
  } = {},
): ResolvedWorkflowLane {
  const sprintType = options.sprintType ?? null;
  const workflowTemplateKey = options.workflowTemplateKey ?? null;

  switch (lane) {
    case 'review': {
      const suggestedOutcome = options.suggestedOutcome ?? 'qa_pass';
      const validOutcomes = options.validOutcomes ?? ['qa_pass', 'qa_fail', 'blocked', 'failed'];
      return {
        lane: 'review',
        suggestedOutcome,
        validOutcomes,
        outcomeHelp: options.outcomeHelp ?? validOutcomes.map((outcome) => buildOutcomeHelp(outcome)),
        source,
        sprintType,
        workflowTemplateKey,
      };
    }
    case 'release': {
      const suggestedOutcome = options.suggestedOutcome ?? 'deployed_live';
      const validOutcomes = options.validOutcomes ?? ['deployed_live', 'blocked', 'failed'];
      return {
        lane: 'release',
        suggestedOutcome,
        validOutcomes,
        outcomeHelp: options.outcomeHelp ?? validOutcomes.map((outcome) => buildOutcomeHelp(outcome)),
        source,
        sprintType,
        workflowTemplateKey,
      };
    }
    case 'pm': {
      const suggestedOutcome = options.suggestedOutcome ?? 'approved_for_merge';
      const validOutcomes = options.validOutcomes ?? ['approved_for_merge', 'blocked', 'failed'];
      return {
        lane: 'pm',
        suggestedOutcome,
        validOutcomes,
        outcomeHelp: options.outcomeHelp ?? validOutcomes.map((outcome) => buildOutcomeHelp(outcome)),
        source,
        sprintType,
        workflowTemplateKey,
      };
    }
    default: {
      const suggestedOutcome = options.suggestedOutcome ?? 'completed_for_review';
      const validOutcomes = options.validOutcomes ?? ['completed_for_review', 'blocked', 'failed'];
      return {
        lane: 'implementation',
        suggestedOutcome,
        validOutcomes,
        outcomeHelp: options.outcomeHelp ?? validOutcomes.map((outcome) => buildOutcomeHelp(outcome)),
        source,
        sprintType,
        workflowTemplateKey,
      };
    }
  }
}

function buildOutcomeHelp(outcome: string, transition?: ResolvedSprintWorkflowTransition): OutcomeHelpEntry {
  const toStatus = transition?.toStatus;

  switch (outcome) {
    case 'completed_for_review':
      return { outcome, description: 'Implementation is ready for QA/review' };
    case 'qa_pass':
      return { outcome, description: 'QA passed; move the task to qa_pass' };
    case 'qa_fail':
      return { outcome, description: 'QA failed; return the task to the dev queue' };
    case 'approved_for_merge':
      return { outcome, description: 'Work is complete and can move to ready_to_merge' };
    case 'deployed_live':
      return { outcome, description: 'Merge/deploy completed and the task should move to deployed' };
    case 'live_verified':
      return { outcome, description: 'Deployed work was verified live and can move to done' };
    case 'blocked':
      return { outcome, description: 'Cannot proceed because of an external blocker' };
    case 'failed':
      return { outcome, description: 'The run itself failed' };
    case 'retry':
      return { outcome, description: 'Retry the stalled task from ready' };
    default:
      return {
        outcome,
        description: toStatus ? `Route the task to ${toStatus}` : `Apply outcome ${outcome}`,
      };
  }
}

function legacyResolveWorkflowLane(
  taskStatus: string,
  taskType?: string | null,
  sprintType?: string | null,
): ResolvedWorkflowLane {
  const normalizedSprintType = normalizeSprintType(sprintType);
  const isReviewLane = taskStatus === 'review';
  const isReleaseLane = taskStatus === 'ready_to_merge' || taskStatus === 'deployed';
  const isPmLane = !isReviewLane && !isReleaseLane && PM_TASK_TYPES.has(taskType ?? '');

  if (isReviewLane) {
    return buildResolvedLane('review', 'compatibility', { sprintType: normalizedSprintType });
  }

  if (isReleaseLane) {
    if (taskStatus === 'deployed') {
      return buildResolvedLane('release', 'compatibility', {
        sprintType: normalizedSprintType,
        suggestedOutcome: 'live_verified',
        validOutcomes: ['live_verified', 'blocked', 'failed'],
      });
    }
    return buildResolvedLane('release', 'compatibility', { sprintType: normalizedSprintType });
  }

  if (isPmLane) {
    return buildResolvedLane('pm', 'compatibility', { sprintType: normalizedSprintType });
  }

  return buildResolvedLane('implementation', 'compatibility', { sprintType: normalizedSprintType });
}

function getApplicableWorkflowTransitions(
  workflow: ResolvedSprintWorkflow,
  taskStatus: string,
  taskType?: string | null,
): ResolvedSprintWorkflowTransition[] {
  const normalizedTaskType = typeof taskType === 'string' ? taskType.trim() : '';
  const matchesStatus = workflow.transitions.filter((transition) => transition.fromStatus === taskStatus);
  if (matchesStatus.length === 0) return [];

  const byOutcome = new Map<string, ResolvedSprintWorkflowTransition[]>();
  for (const transition of matchesStatus) {
    if (transition.taskType && transition.taskType !== normalizedTaskType) continue;
    const bucket = byOutcome.get(transition.outcome) ?? [];
    bucket.push(transition);
    byOutcome.set(transition.outcome, bucket);
  }

  return [...byOutcome.entries()]
    .map(([, transitions]) => transitions.sort((a, b) => {
      const aSpecific = a.taskType ? 1 : 0;
      const bSpecific = b.taskType ? 1 : 0;
      return bSpecific - aSpecific || b.priority - a.priority || a.outcome.localeCompare(b.outcome);
    })[0])
    .sort((a, b) => {
      const aSpecific = a.taskType ? 1 : 0;
      const bSpecific = b.taskType ? 1 : 0;
      return bSpecific - aSpecific || b.priority - a.priority || a.outcome.localeCompare(b.outcome);
    });
}

function getSuggestedOutcome(
  taskStatus: string,
  taskType: string | null | undefined,
  validOutcomes: string[],
): string | null {
  const preferredByStatus: Record<string, string[]> = {
    review: ['qa_pass', 'approved_for_merge', 'qa_fail', 'blocked', 'failed'],
    qa_pass: ['approved_for_merge', 'qa_fail', 'failed'],
    ready_to_merge: ['deployed_live', 'qa_fail', 'failed'],
    deployed: ['live_verified', 'qa_fail', 'failed'],
    stalled: ['retry'],
  };

  const defaultPreferred = PM_TASK_TYPES.has(taskType ?? '')
    ? ['approved_for_merge', 'completed_for_review', 'blocked', 'failed']
    : ['completed_for_review', 'approved_for_merge', 'blocked', 'failed'];
  const preferred = preferredByStatus[taskStatus] ?? defaultPreferred;

  for (const outcome of preferred) {
    if (validOutcomes.includes(outcome)) return outcome;
  }

  return validOutcomes[0] ?? null;
}

function inferWorkflowLane(
  taskStatus: string,
  taskType: string | null | undefined,
  suggestedOutcome: string,
): WorkflowLane {
  if (taskStatus === 'review' || taskStatus === 'qa_pass') return 'review';
  if (taskStatus === 'ready_to_merge' || taskStatus === 'deployed') return 'release';
  if (suggestedOutcome === 'deployed_live' || suggestedOutcome === 'live_verified') return 'release';
  if (suggestedOutcome === 'approved_for_merge' && PM_TASK_TYPES.has(taskType ?? '')) return 'pm';
  return 'implementation';
}

function resolveWorkflowLaneFromResolvedWorkflow(
  taskStatus: string,
  taskType: string | null | undefined,
  workflow: ResolvedSprintWorkflow,
): ResolvedWorkflowLane | null {
  const transitions = getApplicableWorkflowTransitions(workflow, taskStatus, taskType);
  if (transitions.length === 0) return null;

  const validOutcomes = transitions.map((transition) => transition.outcome);
  const suggestedOutcome = getSuggestedOutcome(taskStatus, taskType, validOutcomes);
  if (!suggestedOutcome) return null;

  const lane = inferWorkflowLane(taskStatus, taskType, suggestedOutcome);
  return buildResolvedLane(lane, 'sprint_type_config', {
    sprintType: workflow.sprintType,
    workflowTemplateKey: workflow.workflowTemplateKey,
    suggestedOutcome,
    validOutcomes,
    outcomeHelp: transitions.map((transition) => buildOutcomeHelp(transition.outcome, transition)),
  });
}

/**
 * resolveWorkflowLane — determine the workflow lane and valid outcomes
 * from the task's current status and type.
 *
 * This is the semantic model shared by ALL runtimes. The lane determines:
 * - Which outcome the agent should report (suggestedOutcome)
 * - Which outcomes are valid for this dispatch
 * - What each outcome means (outcomeHelp)
 *
 * The result contains NO transport details — no URLs, no curl, no JSON blocks.
 */
export function resolveWorkflowLane(
  taskStatusOrContext: string | WorkflowResolutionContext,
  taskType?: string | null,
): ResolvedWorkflowLane {
  const ctx: WorkflowResolutionContext = typeof taskStatusOrContext === 'string'
    ? { taskStatus: taskStatusOrContext, taskType }
    : taskStatusOrContext;

  const normalizedSprintType = normalizeSprintType(ctx.sprintType);
  const resolvedWorkflow = ctx.resolvedWorkflow
    ?? ctx.workflowTemplate
    ?? (ctx.db ? resolveSprintWorkflow(ctx.db, ctx.sprintId ?? null, normalizedSprintType) : null);

  if (resolvedWorkflow) {
    const workflowResolvedLane = resolveWorkflowLaneFromResolvedWorkflow(ctx.taskStatus, ctx.taskType, resolvedWorkflow);
    if (workflowResolvedLane) return workflowResolvedLane;
  }

  return legacyResolveWorkflowLane(ctx.taskStatus, ctx.taskType, normalizedSprintType);
}

// ── Pipeline reference ───────────────────────────────────────────────────────

/**
 * The canonical Agent HQ task pipeline stages.
 * Shared by all runtimes as reference documentation.
 */
export const PIPELINE_STAGES = [
  'todo', 'ready', 'dispatched', 'in_progress', 'review',
  'qa_pass', 'ready_to_merge', 'deployed', 'done',
] as const;

export const NEEDS_ATTENTION_REFERENCE = 'Needs Attention is a sticky operator recovery lane for runs that ended without a valid semantic handoff. It is not a synonym for blocked, failed, or QA fail. Tasks should remain in Needs Attention until an explicit operator decision or follow-up automation moves them to the next status.';

export const PIPELINE_REFERENCE = `Pipeline reference: ${PIPELINE_STAGES.join(' → ')}. ${NEEDS_ATTENTION_REFERENCE}`;

// ── Deployment-stage notes ───────────────────────────────────────────────────

/**
 * Some software-delivery workflows require TWO sequential outcomes
 * (deployed_live then live_verified). This is a workflow-level concern that
 * applies regardless of transport, but it is not universal across all Agent HQ
 * setups.
 */
export const RELEASE_LANE_NOTES = [
  `⚠️ DEPLOYMENT-STAGE WORKFLOW ONLY: This task requires TWO distinct handoff steps. Do not stop after deployment alone.`,
  `  Step A — merge and deploy:`,
  `    Post outcome deployed_live → task moves to "deployed"`,
  `    deployed_live is NOT terminal and does NOT mean the task is done.`,
  `  Step B — live verification against the real deployed target:`,
  `    Post outcome live_verified → task moves to "done"`,
  `    live_verified is the terminal completion step for deployment-stage work.`,
  `If deployment succeeds but live verification is not yet complete, do NOT treat the task as finished.`,
  `If live verification cannot be completed truthfully, post blocked or failed with the exact reason.`,
].join('\n');

// ── Evidence requirements (shared semantics) ─────────────────────────────────

export interface EvidenceRequirements {
  /** Lane-specific evidence fields that should be recorded. */
  fields: string[];
  /** Human-readable description of what evidence is needed. */
  description: string;
}

/**
 * getEvidenceRequirements — returns the evidence fields needed for a given lane.
 * Transport adapters use this to format the correct evidence instructions.
 */
export function getEvidenceRequirements(lane: WorkflowLane): EvidenceRequirements {
  switch (lane) {
    case 'implementation':
      return {
        fields: ['branch', 'commit', 'review_url', 'notes'],
        description: 'Record review evidence: feature branch name, commit SHA, and non-production review URL',
      };
    case 'review':
      return {
        fields: ['qa_url', 'verified_commit', 'notes'],
        description: 'Record QA evidence: tested URL and verified commit SHA',
      };
    case 'release':
      return {
        fields: ['merged_commit', 'deployed_commit', 'deploy_target', 'deployed_at'],
        description: 'Record deploy evidence: merged/deployed commits, deploy target, timestamp',
      };
    case 'pm':
      return {
        fields: [],
        description: 'No evidence recording required for PM tasks',
      };
  }
}

export function getAllowedTaskTypesForSprintType(
  db: Database.Database,
  sprintType: string | null | undefined,
): string[] {
  const normalizedSprintType = normalizeSprintType(sprintType);
  if (!normalizedSprintType) return [];

  try {
    const rows = db.prepare(`
      SELECT task_type
      FROM sprint_type_task_types
      WHERE sprint_type_key = ?
      ORDER BY task_type ASC
    `).all(normalizedSprintType) as Array<{ task_type: string | null }>;

    return rows
      .map(row => typeof row.task_type === 'string' ? row.task_type.trim() : '')
      .filter((taskType): taskType is string => taskType.length > 0);
  } catch {
    return [];
  }
}

export function isTaskTypeAllowedForSprintType(
  db: Database.Database,
  sprintType: string | null | undefined,
  taskType: string | null | undefined,
): boolean {
  const normalizedSprintType = normalizeSprintType(sprintType);
  const normalizedTaskType = typeof taskType === 'string' ? taskType.trim() : '';

  if (!normalizedSprintType || !normalizedTaskType) return true;

  const allowedTaskTypes = getAllowedTaskTypesForSprintType(db, normalizedSprintType);
  if (allowedTaskTypes.length === 0) return true;

  return allowedTaskTypes.includes(normalizedTaskType);
}
