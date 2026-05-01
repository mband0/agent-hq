import type Database from 'better-sqlite3';
import { resolveWorkflowLane } from '../services/contracts/workflowContract';
import { isNeedsAttentionEligibleStatus } from './reconcilerConfig';
import { emitIntegrityEvent, writeTaskRuntimeEndHistory, writeTaskStatusChange } from './taskHistory';
import { notifyTaskStatusChange } from './taskNotifications';

export type LifecycleHandoffStatus = 'posted' | 'missing' | 'reconciled';
export type HandoffEvidencePresence = 'yes' | 'no';

interface TaskLifecycleContractRow {
  status: string;
  task_type: string | null;
  sprint_id: number | null;
  sprint_type: string | null;
}

interface MissingHandoffRuntimeMeta {
  source?: string | null;
  success?: boolean | null;
  endedAt?: string | null;
  error?: string | null;
}

interface MarkMissingHandoffParams {
  taskId: number | null | undefined;
  instanceId: number;
  changedBy: string;
  lane: string | null;
  priorTaskStatus: string | null;
  sessionKey?: string | null;
  reviewQaDeployEvidenceRecorded?: HandoffEvidencePresence;
  runtimeEnd?: MissingHandoffRuntimeMeta;
}

export function taskRequiresSemanticOutcome(db: Database.Database, taskId: number | null | undefined): boolean {
  if (!taskId) return false;
  const task = db.prepare(`
    SELECT t.status, t.task_type, t.sprint_id, s.sprint_type
    FROM tasks t
    LEFT JOIN sprints s ON s.id = t.sprint_id
    WHERE t.id = ?
    LIMIT 1
  `).get(taskId) as TaskLifecycleContractRow | undefined;
  if (!task?.status) return false;

  const workflow = resolveWorkflowLane({
    taskStatus: task.status,
    taskType: task.task_type,
    sprintId: task.sprint_id,
    sprintType: task.sprint_type,
    db,
  });
  return workflow.requiresSemanticOutcome;
}

export function markTaskNeedsAttentionForMissingSemanticHandoff(
  db: Database.Database,
  params: MarkMissingHandoffParams,
): boolean {
  db.prepare(`
    UPDATE job_instances
    SET lifecycle_handoff_status = 'missing',
        semantic_outcome_missing = 1,
        runtime_completed_at = COALESCE(runtime_completed_at, runtime_ended_at, ?)
    WHERE id = ?
      AND COALESCE(task_outcome, '') = ''
      AND lifecycle_outcome_posted_at IS NULL
  `).run(params.runtimeEnd?.endedAt ?? new Date().toISOString(), params.instanceId);

  if (!params.taskId) return false;

  const task = db.prepare(`SELECT id, title, status FROM tasks WHERE id = ?`).get(params.taskId) as
    | { id: number; title: string; status: string }
    | undefined;
  if (!task) return false;
  if (['done', 'cancelled', 'failed', 'needs_attention'].includes(task.status)) return false;
  if (!isNeedsAttentionEligibleStatus(db, task.status)) return false;

  db.prepare(`
    UPDATE tasks
    SET status = 'needs_attention',
        previous_status = COALESCE(previous_status, status),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(params.taskId);
  writeTaskStatusChange(db, params.taskId, params.changedBy, task.status, 'needs_attention');
  notifyTaskStatusChange(db, { taskId: params.taskId, fromStatus: task.status, toStatus: 'needs_attention', source: params.changedBy });

  writeTaskRuntimeEndHistory(db, params.taskId, params.changedBy, {
    endedAt: params.runtimeEnd?.endedAt,
    success: params.runtimeEnd?.success ?? null,
    source: params.runtimeEnd?.source ?? null,
    error: params.runtimeEnd?.error ?? null,
    lifecycleHandoff: 'missing_after_runtime_end',
  });

  const runtimeEndedSuccessfully = params.runtimeEnd?.success ? 'yes' : 'no';
  const evidenceRecorded = params.reviewQaDeployEvidenceRecorded ?? 'unknown';
  const runtimeEndedAt = params.runtimeEnd?.endedAt ?? 'unknown';
  const runtimeEndedState = params.runtimeEnd?.success ? 'successfully' : 'unsuccessfully';
  const noteLines = [
    'Summary: run ended without required lifecycle outcome',
    'Work completed: runtime session reached a terminal state, but no valid semantic lifecycle outcome was posted for this lane',
    'Tests run: runtime completion reconciliation and lifecycle handoff enforcement',
    'Result: needs_attention',
    `Failure or issue observed: runtime ended ${runtimeEndedState} at the session level without the required lifecycle handoff`,
    'Root cause assessment: control-plane/lifecycle contract failure or missing outcome write',
    `Evidence: instance_id=${params.instanceId}; session_key=${params.sessionKey ?? 'unknown'}; lane=${params.lane ?? 'unknown'}; prior_status=${params.priorTaskStatus ?? task.status}; runtime_success=${runtimeEndedSuccessfully}; review_qa_deploy_evidence_recorded=${evidenceRecorded}; runtime_end_source=${params.runtimeEnd?.source ?? 'unknown'}; runtime_ended_at=${runtimeEndedAt}`,
    'Next action: operator review before any redispatch or lane re-entry',
    'Next owner: PM/operator',
    `Instance ID: ${params.instanceId}`,
    `Session key: ${params.sessionKey ?? 'unknown'}`,
    `Lane: ${params.lane ?? 'unknown'}`,
    `Prior task status: ${params.priorTaskStatus ?? task.status}`,
    `Runtime ended successfully: ${runtimeEndedSuccessfully}`,
    `Review/QA/deploy evidence recorded: ${evidenceRecorded}`,
    'Recommended next action: operator review before any redispatch or lane re-entry',
  ];
  if (params.runtimeEnd?.source) noteLines.push(`Runtime end source: ${params.runtimeEnd.source}`);
  if (params.runtimeEnd?.endedAt) noteLines.push(`Runtime ended at: ${params.runtimeEnd.endedAt}`);
  if (params.runtimeEnd?.error) noteLines.push(`Runtime end error: ${params.runtimeEnd.error}`);

  db.prepare(`INSERT INTO task_notes (task_id, author, content) VALUES (?, ?, ?)`).run(params.taskId, params.changedBy, noteLines.join('\n'));

  emitIntegrityEvent(db, {
    taskId: params.taskId,
    anomalyType: 'missing_lifecycle_handoff',
    detail: `Runtime ended on instance #${params.instanceId} without required lifecycle outcome`,
    instanceId: params.instanceId,
  });
  return true;
}
