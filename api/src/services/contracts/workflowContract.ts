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
import { resolveSprintOutcomeMap, getLegacyOutcomeMeta } from '../../lib/sprintOutcomes';
import { loadSprintTaskTransitionRequirements } from '../../lib/sprintTaskPolicy';


// ── Workflow lane resolution ─────────────────────────────────────────────────

export type WorkflowLane = 'implementation' | 'review' | 'release' | 'pm';

export interface ResolvedWorkflowLane {
  lane: WorkflowLane;
  suggestedOutcome: string;
  validOutcomes: string[];
  outcomeHelp: OutcomeHelpEntry[];
  requiresSemanticOutcome: boolean;
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
        requiresSemanticOutcome: true,
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
        requiresSemanticOutcome: true,
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
        requiresSemanticOutcome: true,
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
        requiresSemanticOutcome: true,
        source,
        sprintType,
        workflowTemplateKey,
      };
    }
  }
}

function buildOutcomeHelp(outcome: string, transition?: ResolvedSprintWorkflowTransition, resolvedDescription?: string): OutcomeHelpEntry {
  const toStatus = transition?.toStatus;
  const fallback = getLegacyOutcomeMeta(outcome);
  return {
    outcome,
    description: resolvedDescription || fallback.description || (toStatus ? `Route the task to ${toStatus}` : `Apply outcome ${outcome}`),
  };
}

function legacyResolveWorkflowLane(
  taskStatus: string,
  _taskType?: string | null,
  sprintType?: string | null,
): ResolvedWorkflowLane {
  const normalizedSprintType = normalizeSprintType(sprintType);
  const isReviewLane = taskStatus === 'review' || taskStatus === 'qa_pass';
  const isReleaseLane = taskStatus === 'ready_to_merge' || taskStatus === 'deployed';

  if (isReviewLane) {
    return buildResolvedLane('review', 'compatibility', {
      sprintType: normalizedSprintType,
      suggestedOutcome: taskStatus === 'qa_pass' ? 'approved_for_merge' : 'qa_pass',
      validOutcomes: taskStatus === 'qa_pass' ? ['approved_for_merge', 'qa_fail', 'blocked', 'failed'] : ['qa_pass', 'qa_fail', 'blocked', 'failed'],
    });
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

  const preferred = preferredByStatus[taskStatus] ?? ['completed_for_review', 'approved_for_merge', 'blocked', 'failed'];

  for (const outcome of preferred) {
    if (validOutcomes.includes(outcome)) return outcome;
  }

  return validOutcomes[0] ?? null;
}

function inferWorkflowLane(
  taskStatus: string,
  _taskType: string | null | undefined,
  suggestedOutcome: string,
): WorkflowLane {
  if (taskStatus === 'review' || taskStatus === 'qa_pass') return 'review';
  if (taskStatus === 'ready_to_merge' || taskStatus === 'deployed') return 'release';
  if (suggestedOutcome === 'deployed_live' || suggestedOutcome === 'live_verified' || suggestedOutcome === 'approved_for_merge') return 'release';
  return 'implementation';
}

function resolveWorkflowLaneFromResolvedWorkflow(
  db: Database.Database | null | undefined,
  taskStatus: string,
  taskType: string | null | undefined,
  workflow: ResolvedSprintWorkflow,
): ResolvedWorkflowLane | null {
  const transitions = getApplicableWorkflowTransitions(workflow, taskStatus, taskType);
  if (transitions.length === 0) return null;

  const validOutcomes = transitions.map((transition) => transition.outcome);
  const suggestedOutcome = getSuggestedOutcome(taskStatus, taskType, validOutcomes);
  if (!suggestedOutcome) return null;

  const outcomeMeta = db
    ? resolveSprintOutcomeMap(db, { sprintType: workflow.sprintType, taskType, fallbackOutcomes: validOutcomes })
    : new Map<string, { description: string }>();

  const lane = inferWorkflowLane(taskStatus, taskType, suggestedOutcome);
  return buildResolvedLane(lane, 'sprint_type_config', {
    sprintType: workflow.sprintType,
    workflowTemplateKey: workflow.workflowTemplateKey,
    suggestedOutcome,
    validOutcomes,
    outcomeHelp: transitions.map((transition) => buildOutcomeHelp(transition.outcome, transition, outcomeMeta.get(transition.outcome)?.description)),
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
    const workflowResolvedLane = resolveWorkflowLaneFromResolvedWorkflow(ctx.db ?? null, ctx.taskStatus, ctx.taskType, resolvedWorkflow);
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
 * Some software-delivery workflows require multiple sequential release outcomes.
 * The concrete outcomes and evidence requirements come from workflow config.
 */
export const RELEASE_LANE_NOTES = [
  `DEPLOYMENT-STAGE WORKFLOW ONLY: release work can have multiple configured handoff steps. Use the currently valid outcomes and configured gate rows; do not infer the next step from habit.`,
  `Post only an outcome that is valid from the task's current status. After any successful release outcome, re-check the task status before posting another outcome.`,
  `Required evidence for each release outcome comes from configured gate requirements. Do not treat a field as required just because it appears in an example.`,
  `If deployment succeeds but the configured live-verification step is not yet complete, do NOT treat the task as finished.`,
  `Truthful fallback: leave the task in the configured post-deploy state for follow-up verification when live verification cannot be completed in this run.`,
  `If live verification cannot be completed truthfully, post blocked or failed with the exact reason.`,
].join('\n');

// ── Evidence requirements (shared semantics) ─────────────────────────────────

export interface EvidenceRequirements {
  /** Configured evidence field expressions that should be recorded. */
  fields: string[];
  /** Individual field names from configured expressions. Useful for structured examples. */
  fieldNames: string[];
  /** Human-readable description of the configured evidence gates. */
  description: string;
}

/**
 * getEvidenceRequirements is kept for older imports. New dispatch contracts
 * should call resolveEvidenceRequirements so gate rows, not lane names, decide
 * which fields are presented as required.
 */
export function getEvidenceRequirements(_lane: WorkflowLane): EvidenceRequirements {
  return {
    fields: [],
    fieldNames: [],
    description: 'No lane-specific evidence defaults are inferred. Evidence requirements come from configured gate rows for the active workflow outcomes.',
  };
}

type ContractGateRequirement = {
  outcome: string;
  field_name: string;
  requirement_type: string;
  match_field: string | null;
  severity: string;
  message: string;
};

const NON_EVIDENCE_FIELDS = new Set(['status']);
const NON_ADVANCEMENT_OUTCOMES = new Set(['blocked', 'failed', 'qa_fail', 'retry']);

function isAdvancementOutcome(outcome: string): boolean {
  return !NON_ADVANCEMENT_OUTCOMES.has(outcome) && !outcome.startsWith('failed:');
}

function parseFieldExpression(fieldName: string): string[] {
  return fieldName
    .split('|')
    .map((field) => field.trim())
    .filter(Boolean);
}

function formatFieldExpression(fieldName: string): string {
  return parseFieldExpression(fieldName).join(' or ') || fieldName;
}

function loadConfiguredGateRequirements(
  db: Database.Database,
  outcome: string,
  sprintId?: number | null,
  taskType?: string | null,
): ContractGateRequirement[] {
  const sprintRows = loadSprintTaskTransitionRequirements(db, sprintId ?? null, outcome, taskType);
  if (sprintRows.length > 0) {
    return sprintRows.map((row) => ({
      outcome,
      field_name: row.field_name,
      requirement_type: row.requirement_type,
      match_field: row.match_field,
      severity: row.severity,
      message: row.message,
    }));
  }

  try {
    if (taskType) {
      const typeRows = db.prepare(`
        SELECT field_name, requirement_type, match_field, severity, message
        FROM transition_requirements
        WHERE task_type = ? AND outcome = ? AND enabled = 1
        ORDER BY priority DESC, id ASC
      `).all(taskType, outcome) as Array<Omit<ContractGateRequirement, 'outcome'>>;
      if (typeRows.length > 0) return typeRows.map((row) => ({ ...row, outcome }));
    }

    const rows = db.prepare(`
      SELECT field_name, requirement_type, match_field, severity, message
      FROM transition_requirements
      WHERE task_type IS NULL AND outcome = ? AND enabled = 1
      ORDER BY priority DESC, id ASC
    `).all(outcome) as Array<Omit<ContractGateRequirement, 'outcome'>>;
    return rows.map((row) => ({ ...row, outcome }));
  } catch {
    return [];
  }
}

export function resolveEvidenceRequirements(options: {
  db?: Database.Database | null;
  lane: WorkflowLane;
  taskType?: string | null;
  sprintId?: number | null;
  outcomes?: string[];
  suggestedOutcome?: string | null;
}): EvidenceRequirements {
  const outcomes = Array.from(new Set([
    ...(options.outcomes ?? []),
    options.suggestedOutcome ?? '',
  ].filter((outcome): outcome is string => Boolean(outcome) && isAdvancementOutcome(outcome))));

  if (!options.db || outcomes.length === 0) {
    return {
      fields: [],
      fieldNames: [],
      description: 'No configured gate rows were available in this dispatch context. Do not infer required evidence from the lane name; follow the workflow API response if an outcome is refused.',
    };
  }

  const requirements = outcomes.flatMap((outcome) => loadConfiguredGateRequirements(
    options.db as Database.Database,
    outcome,
    options.sprintId ?? null,
    options.taskType ?? null,
  ));

  const blockingRequirements = requirements.filter((requirement) => requirement.severity !== 'warn');
  const fieldExpressions = new Set<string>();
  const fieldNames = new Set<string>();

  for (const requirement of blockingRequirements) {
    if (requirement.requirement_type === 'from_status') continue;
    if (requirement.requirement_type !== 'required' && requirement.requirement_type !== 'match') continue;

    const fields = parseFieldExpression(requirement.field_name).filter((field) => !NON_EVIDENCE_FIELDS.has(field));
    if (fields.length === 0) continue;

    fieldExpressions.add(formatFieldExpression(requirement.field_name));
    for (const field of fields) fieldNames.add(field);
  }

  const outcomeLabel = outcomes.join(', ');
  if (blockingRequirements.length === 0) {
    return {
      fields: [],
      fieldNames: [],
      description: `No blocking evidence gate rows are configured for ${outcomeLabel}. Do not infer additional required fields from the lane name.`,
    };
  }

  if (fieldExpressions.size === 0) {
    return {
      fields: [],
      fieldNames: [],
      description: `Configured gate rows for ${outcomeLabel} do not require additional evidence fields beyond workflow/status checks.`,
    };
  }

  return {
    fields: Array.from(fieldExpressions),
    fieldNames: Array.from(fieldNames),
    description: `Configured gate fields for ${outcomeLabel}: ${Array.from(fieldExpressions).join(', ')}. These come from workflow gate requirement rows; no lane-specific defaults are inferred.`,
  };
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
