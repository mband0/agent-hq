import type Database from 'better-sqlite3';
import { cleanupImpossibleTaskLifecycleStates } from './taskLifecycle';
import { notifyTaskStatusChange } from './taskNotifications';

export const START_CHECKIN_GRACE_MS = 5 * 60 * 1000;
export const HEARTBEAT_STALE_MS = 10 * 60 * 1000;
export const HEARTBEAT_NOTE_MIN_MS = 15 * 60 * 1000;

export type CheckInStage = 'dispatch' | 'start' | 'heartbeat' | 'progress' | 'blocker' | 'completion';

export interface RunCheckInInput {
  instanceId: number;
  stage: CheckInStage;
  sessionKey?: string | null;
  summary?: string | null;
  commitHash?: string | null;
  branchName?: string | null;
  changedFiles?: string[] | null;
  changedFilesCount?: number | null;
  meaningfulOutput?: boolean;
  blockerReason?: string | null;
  outcome?: string | null;
  statusLabel?: string | null;
  author?: string;
  forceNote?: boolean;
  runtimeEndSuccess?: boolean | null;
  runtimeEndError?: string | null;
  runtimeEndSource?: string | null;
}

interface InstanceRow {
  id: number;
  task_id: number | null;
  agent_id: number;
  status: string;
  session_key: string | null;
  started_at?: string | null;
}

/**
 * Agent-driven check-in stages: these should be attributed to the agent, not 'Atlas HQ'.
 */
const AGENT_DRIVEN_STAGES: ReadonlySet<CheckInStage> = new Set(['dispatch', 'start', 'heartbeat', 'progress', 'blocker', 'completion']);

/**
 * Resolve the agent's display name from the agents table for a given agent_id.
 * Returns null if the agent is not found.
 */
function resolveAgentName(db: Database.Database, agentId: number): string | null {
  const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
  return row?.name ?? null;
}

function normalizeTimestamp(raw?: string | null): number | null {
  if (!raw) return null;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZ = normalized.endsWith('Z') ? normalized : `${normalized}Z`;
  const ms = new Date(withZ).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function parseChangedFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item).trim())
    .filter(Boolean)
    .slice(0, 200);
}

function logTaskStatusTransition(
  db: Database.Database,
  taskId: number,
  changedBy: string,
  oldStatus: string,
  newStatus: string,
): void {
  if (oldStatus === newStatus) return;
  db.prepare(`
    INSERT INTO task_history (task_id, changed_by, field, old_value, new_value)
    VALUES (?, ?, 'status', ?, ?)
  `).run(taskId, changedBy, oldStatus, newStatus);
}

function shouldPreserveWorkflowStatusDuringRun(status: string): boolean {
  return status === 'review' || status === 'ready_to_merge';
}

function syncTaskStatusForLifecycle(
  db: Database.Database,
  taskId: number | null,
  instanceId: number,
  stage: CheckInStage,
  source?: string,
): void {
  if (!taskId) return;

  const task = db.prepare(`
    SELECT status, active_instance_id
    FROM tasks
    WHERE id = ?
  `).get(taskId) as { status: string; active_instance_id: number | null } | undefined;
  if (!task) return;

  if (task.status === 'cancelled' || task.status === 'done') return;
  if (task.active_instance_id !== null && task.active_instance_id !== instanceId) return;
  if (shouldPreserveWorkflowStatusDuringRun(task.status)) return;

  let nextStatus: string | null = null;

  if (stage === 'dispatch') {
    if (['todo', 'ready'].includes(task.status)) {
      nextStatus = 'dispatched';
    }
  } else if (['start', 'heartbeat', 'progress', 'blocker', 'completion'].includes(stage)) {
    if (['todo', 'ready', 'dispatched'].includes(task.status)) {
      nextStatus = 'in_progress';
    }
  }

  if (!nextStatus || nextStatus === task.status) return;

  const prevStatus = task.status;

  db.prepare(`
    UPDATE tasks
    SET status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(nextStatus, taskId);

  const attributedSource = source ?? 'Atlas HQ';
  logTaskStatusTransition(db, taskId, attributedSource, prevStatus, nextStatus);
  notifyTaskStatusChange(db, {
    taskId,
    fromStatus: prevStatus,
    toStatus: nextStatus,
    source: attributedSource,
  });
}

/** @deprecated Use selectTaskForAgent instead */
export function selectTaskForJob(db: Database.Database, jobId: number): number | null {
  return selectTaskForAgent(db, jobId);
}

export function selectTaskForAgent(db: Database.Database, agentId: number): number | null {
  cleanupImpossibleTaskLifecycleStates(db);

  const row = db.prepare(`
    SELECT id
    FROM tasks
    WHERE agent_id = ?
      AND status IN ('in_progress', 'dispatched', 'ready', 'review', 'todo', 'stalled')
    ORDER BY
      CASE status
        WHEN 'in_progress' THEN 0
        WHEN 'dispatched' THEN 1
        WHEN 'ready' THEN 2
        WHEN 'review' THEN 3
        WHEN 'todo' THEN 4
        WHEN 'stalled' THEN 5
        ELSE 6
      END,
      priority DESC,
      updated_at ASC,
      created_at ASC
    LIMIT 1
  `).get(agentId) as { id: number } | undefined;

  return row?.id ?? null;
}

export function attachInstanceToTask(db: Database.Database, instanceId: number, taskId: number | null): void {
  db.prepare(`UPDATE job_instances SET task_id = ? WHERE id = ?`).run(taskId, instanceId);

  if (taskId) {
    db.prepare(`
      UPDATE tasks
      SET active_instance_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(instanceId, taskId);
  }
}

export function resolveTaskIdForInstance(db: Database.Database, instanceId: number): number | null {
  const instance = db.prepare(`SELECT id, task_id FROM job_instances WHERE id = ?`).get(instanceId) as {
    id: number;
    task_id: number | null;
  } | undefined;

  if (!instance) return null;
  if (instance.task_id) return instance.task_id;

  const linkedTask = db.prepare(`
    SELECT id
    FROM tasks
    WHERE active_instance_id = ?
    LIMIT 1
  `).get(instanceId) as { id: number } | undefined;

  if (!linkedTask) return null;

  attachInstanceToTask(db, instanceId, linkedTask.id);
  return linkedTask.id;
}

function buildStructuredNote(input: Required<Pick<RunCheckInInput, 'stage'>> & Omit<RunCheckInInput, 'stage'>): string {
  const lines: string[] = [];
  const label = {
    dispatch: 'Run dispatched',
    start: 'Run started',
    heartbeat: 'Heartbeat',
    progress: 'Progress update',
    blocker: 'Blocked',
    completion: 'Run completed',
  }[input.stage];

  lines.push(`Agent check-in: ${label}`);

  if (input.statusLabel) lines.push(`Status: ${input.statusLabel}`);
  if (input.summary) lines.push(`Summary: ${input.summary}`);
  if (input.blockerReason) lines.push(`Blocker: ${input.blockerReason}`);
  if (input.branchName) lines.push(`Branch: ${input.branchName}`);
  if (input.commitHash) lines.push(`Commit: ${input.commitHash}`);
  if (typeof input.changedFilesCount === 'number') lines.push(`Changed files: ${input.changedFilesCount}`);
  if (input.changedFiles && input.changedFiles.length > 0) {
    lines.push(`Files: ${input.changedFiles.slice(0, 20).join(', ')}`);
  }
  if (input.outcome) lines.push(`Outcome: ${input.outcome}`);
  if (input.sessionKey) lines.push(`Session: ${input.sessionKey}`);

  return lines.join('\n');
}

export function recordRunCheckIn(db: Database.Database, input: RunCheckInInput): { taskId: number | null; noteCreated: boolean } {
  const nowIso = new Date().toISOString();
  const changedFiles = parseChangedFiles(input.changedFiles);
  const changedFilesCount = input.changedFilesCount ?? (changedFiles.length > 0 ? changedFiles.length : null);
  const taskId = resolveTaskIdForInstance(db, input.instanceId);

  const instance = db.prepare(`
    SELECT id, task_id, agent_id, status, session_key, started_at
    FROM job_instances
    WHERE id = ?
  `).get(input.instanceId) as InstanceRow | undefined;

  if (!instance) {
    throw new Error(`Instance ${input.instanceId} not found`);
  }

  const trustedStartSignal = ['start', 'heartbeat', 'progress', 'blocker', 'completion'].includes(input.stage);

  db.prepare(`
    INSERT INTO instance_artifacts (
      instance_id,
      task_id,
      current_stage,
      summary,
      latest_commit_hash,
      branch_name,
      changed_files_json,
      changed_files_count,
      blocker_reason,
      outcome,
      last_agent_heartbeat_at,
      last_meaningful_output_at,
      started_at,
      completed_at,
      stale,
      stale_at,
      session_key,
      updated_at,
      last_note_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, NULL)
    ON CONFLICT(instance_id) DO UPDATE SET
      task_id = excluded.task_id,
      current_stage = excluded.current_stage,
      summary = COALESCE(excluded.summary, instance_artifacts.summary),
      latest_commit_hash = COALESCE(excluded.latest_commit_hash, instance_artifacts.latest_commit_hash),
      branch_name = COALESCE(excluded.branch_name, instance_artifacts.branch_name),
      changed_files_json = CASE WHEN excluded.changed_files_json IS NOT NULL AND excluded.changed_files_json != '[]' THEN excluded.changed_files_json ELSE instance_artifacts.changed_files_json END,
      changed_files_count = COALESCE(excluded.changed_files_count, instance_artifacts.changed_files_count),
      blocker_reason = CASE WHEN excluded.blocker_reason IS NOT NULL THEN excluded.blocker_reason ELSE instance_artifacts.blocker_reason END,
      outcome = CASE WHEN excluded.outcome IS NOT NULL THEN excluded.outcome ELSE instance_artifacts.outcome END,
      last_agent_heartbeat_at = COALESCE(excluded.last_agent_heartbeat_at, instance_artifacts.last_agent_heartbeat_at),
      last_meaningful_output_at = COALESCE(excluded.last_meaningful_output_at, instance_artifacts.last_meaningful_output_at),
      started_at = COALESCE(instance_artifacts.started_at, excluded.started_at),
      completed_at = COALESCE(excluded.completed_at, instance_artifacts.completed_at),
      stale = 0,
      stale_at = NULL,
      session_key = COALESCE(excluded.session_key, instance_artifacts.session_key),
      updated_at = excluded.updated_at
  `).run(
    input.instanceId,
    taskId,
    input.stage,
    input.summary ?? null,
    input.commitHash ?? null,
    input.branchName ?? null,
    JSON.stringify(changedFiles),
    changedFilesCount,
    input.blockerReason ?? null,
    input.outcome ?? null,
    trustedStartSignal ? nowIso : null,
    input.meaningfulOutput || ['progress', 'blocker', 'completion'].includes(input.stage) ? nowIso : null,
    trustedStartSignal ? nowIso : null,
    input.stage === 'completion' ? nowIso : null,
    input.sessionKey ?? instance.session_key ?? null,
    nowIso,
  );

  const artifact = db.prepare(`
    SELECT summary, current_stage, last_note_at, changed_files_json, latest_commit_hash, branch_name, blocker_reason, outcome
    FROM instance_artifacts
    WHERE instance_id = ?
  `).get(input.instanceId) as {
    summary: string | null;
    current_stage: string | null;
    last_note_at: string | null;
    changed_files_json: string | null;
    latest_commit_hash: string | null;
    branch_name: string | null;
    blocker_reason: string | null;
    outcome: string | null;
  };

  const previousNoteMs = normalizeTimestamp(artifact.last_note_at);
  const shouldNoteBecauseTime = previousNoteMs === null || (Date.now() - previousNoteMs) >= HEARTBEAT_NOTE_MIN_MS;
  const shouldCreateNote = Boolean(
    input.forceNote
    || input.stage === 'dispatch'
    || input.stage === 'start'
    || input.stage === 'blocker'
    || input.stage === 'completion'
    || input.meaningfulOutput
    || (input.stage === 'heartbeat' && shouldNoteBecauseTime && input.summary)
    || (input.stage === 'progress' && (input.summary || changedFilesCount || input.commitHash || input.branchName))
  );

  let noteCreated = false;
  if (taskId && shouldCreateNote) {
    const note = buildStructuredNote({
      ...input,
      stage: input.stage,
      changedFiles,
      changedFilesCount: changedFilesCount ?? undefined,
    });

    // For agent-driven stages, attribute the note to the agent name rather than 'Atlas HQ'.
    // If an explicit author was passed in, honour it; otherwise resolve from the agents table.
    let noteAuthor: string;
    if (input.author !== undefined) {
      noteAuthor = input.author;
    } else if (AGENT_DRIVEN_STAGES.has(input.stage)) {
      noteAuthor = resolveAgentName(db, instance.agent_id) ?? 'Atlas HQ';
    } else {
      noteAuthor = 'Atlas HQ';
    }

    db.prepare(`
      INSERT INTO task_notes (task_id, author, content)
      VALUES (?, ?, ?)
    `).run(taskId, noteAuthor, note);

    db.prepare(`
      UPDATE instance_artifacts
      SET last_note_at = ?
      WHERE instance_id = ?
    `).run(nowIso, input.instanceId);

    noteCreated = true;
  }

  // Attribute status transitions to the agent for agent-driven stages
  const statusSource = AGENT_DRIVEN_STAGES.has(input.stage)
    ? (resolveAgentName(db, instance.agent_id) ?? 'Atlas HQ')
    : 'Atlas HQ';
  syncTaskStatusForLifecycle(db, taskId, input.instanceId, input.stage, statusSource);

  if (trustedStartSignal) {
    // Preserve a 'claude-code:' session_key that was set by ClaudeCodeRuntime from the
    // SDK init message — do not overwrite it with the 'hook:atlas:jobrun:' key from the
    // agent's start callback, which is sent before the SDK updates the key.
    db.prepare(`
      UPDATE job_instances
      SET session_key = CASE
            WHEN session_key LIKE 'claude-code:%' THEN session_key
            ELSE COALESCE(?, session_key)
          END,
          status = CASE WHEN status IN ('queued', 'dispatched') THEN 'running' ELSE status END,
          started_at = COALESCE(started_at, ?)
      WHERE id = ?
    `).run(input.sessionKey ?? null, nowIso, input.instanceId);
  }

  if (input.stage === 'completion') {
    const runtimeEndSuccess = input.runtimeEndSuccess ?? (input.statusLabel ? input.statusLabel !== 'failed' : input.outcome !== 'failed');
    const runtimeEndError = input.runtimeEndError ?? (runtimeEndSuccess ? null : (input.summary ?? input.blockerReason ?? null));
    db.prepare(`
      UPDATE job_instances
      SET started_at = COALESCE(started_at, ?),
          completed_at = COALESCE(completed_at, ?),
          runtime_ended_at = COALESCE(runtime_ended_at, ?),
          runtime_end_success = COALESCE(runtime_end_success, ?),
          runtime_end_error = COALESCE(?, runtime_end_error),
          runtime_end_source = COALESCE(?, runtime_end_source)
      WHERE id = ?
    `).run(
      nowIso,
      nowIso,
      nowIso,
      runtimeEndSuccess ? 1 : 0,
      runtimeEndError,
      input.runtimeEndSource ?? 'instance_complete',
      input.instanceId,
    );
  }

  return { taskId, noteCreated };
}

export function markInstanceStale(db: Database.Database, instanceId: number, reason: string): { taskId: number | null; changed: boolean } {
  const taskId = resolveTaskIdForInstance(db, instanceId);
  const existing = db.prepare(`SELECT stale FROM instance_artifacts WHERE instance_id = ?`).get(instanceId) as { stale: number } | undefined;
  if (existing?.stale) {
    return { taskId, changed: false };
  }

  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO instance_artifacts (instance_id, task_id, current_stage, stale, stale_at, updated_at)
    VALUES (?, ?, 'heartbeat', 1, ?, ?)
    ON CONFLICT(instance_id) DO UPDATE SET
      task_id = excluded.task_id,
      stale = 1,
      stale_at = excluded.stale_at,
      updated_at = excluded.updated_at
  `).run(instanceId, taskId, nowIso, nowIso);

  if (taskId) {
    db.prepare(`
      INSERT INTO task_notes (task_id, author, content)
      VALUES (?, 'Atlas HQ', ?)
    `).run(taskId, `Agent run appears stale\nReason: ${reason}`);
  }

  return { taskId, changed: true };
}
