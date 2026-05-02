import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { cleanupTaskExecutionLinkageForStatus } from '../lib/taskLifecycle';
import { applyTaskOutcome, RefusedTaskOutcomeError, resolveRefusedTaskOutcome } from '../lib/taskOutcome';
import { assertAtlasDirectStatusGate, assertTaskStatusUpdateAllowed, evaluateTaskIntegrity } from '../lib/taskRelease';
import {
  extractInlineEvidence,
  hasAnyEvidence,
  validateInlineEvidenceForOutcome,
  validateReviewEvidence,
  validateQaEvidence,
  validateDeployEvidence,
  type GateRequirement,
} from '../lib/evidenceValidation';
import { triggerDispatch } from '../services/dispatchTrigger';
import { notifyTaskStatusChange } from '../lib/taskNotifications';
import { VALID_TASK_TYPES, isValidTaskType } from '../lib/taskTypes';
import { getAllowedTaskTypesForSprintType, isTaskTypeAllowedForSprintType, resolveSprintTypeForSprintId } from '../lib/sprintTypeConfig';
import { VALID_DEFECT_TYPES, isValidDefectType } from '../lib/defectTypes';
import { type FailureClass, isValidFailureClass, getFailureClassDisplay, getRecoverySpec, getAllFailureClasses } from '../lib/failureClasses';
import { emitTaskEvent } from '../lib/taskHistory';
import { RELEASE_TASK_STATUSES, isTaskStatus } from '../lib/taskStatuses';
import { resolveDefaultProjectSprintId } from '../lib/starterSetup';
import { stopTaskAndPause } from '../lib/taskStop';
import { loadSprintTaskTransitionRequirements } from '../lib/sprintTaskPolicy';

const UPLOADS_BASE = path.resolve(__dirname, '../../uploads/tasks');

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const taskDir = path.join(UPLOADS_BASE, String(req.params.id));
    fs.mkdirSync(taskDir, { recursive: true });
    cb(null, taskDir);
  },
  filename: (_req, file, cb) => {
    // Prefix with timestamp to avoid collisions
    const prefix = Date.now();
    cb(null, `${prefix}-${file.originalname}`);
  },
});

const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max

const router = Router();
const VALID_STORY_POINTS = [1, 2, 3, 5, 8, 13, 21] as const;

function normalizeStoryPoints(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) throw new Error('story_points must be an integer');
  if (!VALID_STORY_POINTS.includes(parsed as typeof VALID_STORY_POINTS[number])) {
    throw new Error(`Invalid story_points "${value}". Valid: ${VALID_STORY_POINTS.join(', ')}`);
  }
  return parsed;
}

// ── Helper: enrich a raw task row with blockers + blocking ───────────────────

type CustomFieldDefinition = {
  key: string;
  label?: string;
  type?: string;
  required?: boolean;
  options?: string[];
  help_text?: string;
};

function parseCustomFields(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw === 'string') {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('custom_fields must be an object');
    }
    return parsed as Record<string, unknown>;
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  throw new Error('custom_fields must be an object');
}

function resolveSprintTypeForTask(sprintId: unknown): string {
  const db = getDb();
  return resolveSprintTypeForSprintId(db, sprintId);
}

function resolveTaskFieldSchema(sprintId: unknown, taskType: unknown): { sprint_type: string; schema: { fields: CustomFieldDefinition[] }; allowed_task_types: string[] } {
  const db = getDb();
  const sprintType = resolveSprintTypeForSprintId(db, sprintId);
  const normalizedTaskType = typeof taskType === 'string' && taskType.trim().length > 0 ? taskType.trim() : null;
  const allowedTaskTypes = getAllowedTaskTypesForSprintType(db, sprintType);

  for (const candidate of [
    { sprintType, taskType: normalizedTaskType },
    { sprintType, taskType: null },
    { sprintType: 'generic', taskType: normalizedTaskType },
    { sprintType: 'generic', taskType: null },
  ]) {
    const row = db.prepare(`
      SELECT schema_json
      FROM task_field_schemas
      WHERE sprint_type_key = ? AND task_type IS ?
      ORDER BY COALESCE(updated_at, created_at, datetime('now')) DESC, id DESC
      LIMIT 1
    `).get(candidate.sprintType, candidate.taskType) as { schema_json: string } | undefined;
    if (!row) continue;
    try {
      const parsed = JSON.parse(row.schema_json || '{}') as { fields?: CustomFieldDefinition[] };
      return { sprint_type: sprintType, schema: { fields: Array.isArray(parsed.fields) ? parsed.fields : [] }, allowed_task_types: allowedTaskTypes };
    } catch {
      return { sprint_type: sprintType, schema: { fields: [] }, allowed_task_types: allowedTaskTypes };
    }
  }

  return { sprint_type: sprintType, schema: { fields: [] }, allowed_task_types: allowedTaskTypes };
}


function validateTaskCustomFields(customFields: Record<string, unknown>, schema: { fields: CustomFieldDefinition[] }): void {
  const fields = Array.isArray(schema.fields) ? schema.fields : [];
  const knownKeys = new Set(fields.map((field) => field.key));

  for (const key of Object.keys(customFields)) {
    if (!knownKeys.has(key)) throw new Error(`Unknown custom field "${key}"`);
  }

  for (const field of fields) {
    const value = customFields[field.key];
    const isEmpty = value === null || value === undefined || value === '';
    if (field.required && isEmpty) throw new Error(`custom field "${field.key}" is required`);
    if (isEmpty) continue;

    switch (field.type) {
      case 'textarea':
      case 'text':
      case 'url':
        if (typeof value !== 'string') throw new Error(`custom field "${field.key}" must be a string`);
        if (field.type === 'url' && value.trim().length > 0) {
          try {
            new URL(value);
          } catch {
            throw new Error(`custom field "${field.key}" must be a valid URL`);
          }
        }
        break;
      case 'select':
        if (typeof value !== 'string') throw new Error(`custom field "${field.key}" must be a string`);
        if (Array.isArray(field.options) && field.options.length > 0 && !field.options.includes(value)) {
          throw new Error(`custom field "${field.key}" must be one of: ${field.options.join(', ')}`);
        }
        break;
      case 'number':
        if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`custom field "${field.key}" must be a number`);
        break;
      case 'checkbox':
        if (typeof value !== 'boolean') throw new Error(`custom field "${field.key}" must be a boolean`);
        break;
      default:
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          throw new Error(`custom field "${field.key}" has an unsupported value`);
        }
        break;
    }
  }
}

function enrichTask(task: Record<string, unknown>): Record<string, unknown> {
  const db = getDb();
  const id = task.id as number;
  const changedFiles = (() => {
    try {
      const raw = task.changed_files_json;
      return typeof raw === 'string' ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  })();
  const customFields = (() => {
    try {
      return parseCustomFields(task.custom_fields_json);
    } catch {
      return {};
    }
  })();
  const resolvedFieldSchema = resolveTaskFieldSchema(task.sprint_id, task.task_type);

  const blockers = db.prepare(`
    SELECT t.*, a.name as agent_name, s.name as sprint_name
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.agent_id
    LEFT JOIN sprints s ON s.id = t.sprint_id
    WHERE t.id IN (SELECT blocker_id FROM task_dependencies WHERE blocked_id = ?)
  `).all(id) as Record<string, unknown>[];

  const blocking = db.prepare(`
    SELECT t.*, a.name as agent_name, s.name as sprint_name
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.agent_id
    LEFT JOIN sprints s ON s.id = t.sprint_id
    WHERE t.id IN (SELECT blocked_id FROM task_dependencies WHERE blocker_id = ?)
  `).all(id) as Record<string, unknown>[];

  // Enrich failure class with display info
  const failureClass = task.failure_class as FailureClass | null;
  const failureInfo = failureClass && isValidFailureClass(failureClass)
    ? {
        failure_display: getFailureClassDisplay(failureClass),
        failure_recovery: getRecoverySpec(failureClass),
      }
    : {};

  return {
    ...task,
    ...evaluateTaskIntegrity(task as { status?: string | null; task_type?: string | null }, db),
    ...failureInfo,
    changed_files: changedFiles,
    custom_fields: customFields,
    resolved_sprint_type: resolvedFieldSchema.sprint_type,
    resolved_custom_field_schema: resolvedFieldSchema.schema,
    blockers,
    blocking,
  };
}

function enrichTasks(tasks: Record<string, unknown>[]): Record<string, unknown>[] {
  return tasks.map(enrichTask);
}

function maybeTriggerDispatch(projectId: unknown): void {
  if (typeof projectId === 'number' && Number.isFinite(projectId)) {
    triggerDispatch(projectId);
  }
}

// ── Helper: log a history entry ──────────────────────────────────────────────

function logHistory(
  taskId: number,
  changedBy: string,
  field: string,
  oldValue: unknown,
  newValue: unknown
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO task_history (task_id, changed_by, field, old_value, new_value)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId, changedBy, field, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue));
}

function addTaskNote(taskId: number, author: string, content: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO task_notes (task_id, author, content)
    VALUES (?, ?, ?)
  `).run(taskId, author, content);
}

function updateTaskEvidence(
  taskId: number,
  changedBy: string,
  updates: Record<string, unknown>,
  options?: { explicitClears?: Set<string> },
): void {
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown> | undefined;
  if (!existing) throw new Error('Task not found');

  // Filter to keys that were explicitly provided (not undefined)
  const requestedKeys = Object.keys(updates).filter(key => updates[key] !== undefined);
  if (requestedKeys.length === 0) return;

  // Protect existing non-null evidence from being overwritten with null/empty values.
  // A blank write from a stale or duplicate run must not clear evidence that has
  // already been set (e.g. qa_verified_commit, qa_tested_url, review_commit, etc.).
  // A write is only applied if the incoming value is non-empty, OR the existing
  // value is already null/empty (i.e. it is a first-write, not a regression).
  //
  // Exception: fields listed in options.explicitClears bypass this protection —
  // these represent intentional, user-authorised reset actions (not stale writes).
  const explicitClears = options?.explicitClears ?? new Set<string>();
  const activeKeys = requestedKeys.filter(key => {
    const incoming = updates[key];
    const current = existing[key];
    const incomingIsEmpty = incoming === null || incoming === undefined || incoming === '';
    const currentIsSet = current !== null && current !== undefined && current !== '';
    // Allow explicit clear — bypass blank-write protection for intentional resets
    if (incomingIsEmpty && currentIsSet && explicitClears.has(key)) return true;
    // Skip: incoming is blank and a valid value already exists → protect evidence
    if (incomingIsEmpty && currentIsSet) return false;
    return true;
  });

  if (activeKeys.length === 0) return;

  for (const key of activeKeys) {
    const oldValue = existing[key];
    const newValue = updates[key];
    if (String(oldValue ?? '') !== String(newValue ?? '')) {
      logHistory(taskId, changedBy, key, oldValue, newValue);
    }
  }

  const assignments = activeKeys.map(key => `${key} = ?`).join(', ');
  db.prepare(`
    UPDATE tasks
    SET ${assignments}, updated_at = datetime('now')
    WHERE id = ?
  `).run(...activeKeys.map(key => updates[key]), taskId);
}

// ── TASK SELECT helper (shared query) ────────────────────────────────────────

// ── Agent resolution note ─────────────────────────────────────────────────────
// t.agent_id is a snapshot set at dispatch time. It can drift if a task is
// rerouted (job_id changes) by the reconciler or eligibility engine without a
// new dispatch. jt.agent_id (derived from the current job_id → job_templates)
// is the canonical source of truth. We prefer jt.agent_id over t.agent_id so
// that displayed assignment always reflects the current routing state.
const TASK_SELECT = `
  SELECT
    t.*,
    a.name as agent_name,
    s.name as sprint_name,
    ji.id as active_instance_id,
    ji.status as active_instance_status,
    ji.session_key as active_instance_session_key,
    ji.created_at as active_instance_created_at,
    ji.dispatched_at as active_instance_dispatched_at,
    ji.started_at as active_instance_started_at,
    ji.completed_at as active_instance_completed_at,
    ji.runtime_ended_at as active_instance_runtime_ended_at,
    ji.runtime_completed_at as active_instance_runtime_completed_at,
    ji.runtime_end_success as active_instance_runtime_end_success,
    ji.runtime_end_error as active_instance_runtime_end_error,
    ji.runtime_end_source as active_instance_runtime_end_source,
    ji.lifecycle_handoff_status as active_instance_lifecycle_handoff_status,
    ji.semantic_outcome_missing as active_instance_semantic_outcome_missing,
    ji.lifecycle_outcome_posted_at as active_instance_lifecycle_outcome_posted_at,
    ia.current_stage as latest_run_stage,
    ia.last_agent_heartbeat_at,
    ia.last_meaningful_output_at,
    ia.latest_commit_hash,
    ia.branch_name,
    ia.changed_files_json,
    ia.changed_files_count,
    ia.summary as latest_artifact_summary,
    ia.blocker_reason,
    ia.outcome as latest_run_outcome,
    ia.stale as run_is_stale,
    ia.stale_at as run_stale_at,
    ia.updated_at as artifact_updated_at,
    ji.task_outcome as active_instance_task_outcome,
    origin_t.title as origin_task_title,
    COALESCE(tom.spawned_defects, 0) as spawned_defects
  FROM tasks t
  LEFT JOIN agents a ON a.id = t.agent_id
  LEFT JOIN sprints s ON s.id = t.sprint_id
  LEFT JOIN job_instances ji ON ji.id = t.active_instance_id
  LEFT JOIN instance_artifacts ia ON ia.instance_id = ji.id
  LEFT JOIN tasks origin_t ON origin_t.id = t.origin_task_id
  LEFT JOIN task_outcome_metrics tom ON tom.task_id = t.id
`;

// ── GET /api/v1/tasks/completed-recent?hours=N ──────────────────────────────
// Returns tasks that reached 'done' status within the last N hours (default 24).
// Includes task title, agent name, completion time (live_verified_at or updated_at),
// and the terminal outcome (live_verified, qa_pass, etc.).
// Ordered by most recent completion first.

// ── GET /api/v1/tasks/failure-classes ────────────────────────────────────────
// Reference endpoint: returns all failure classes with display info and recovery specs.
router.get('/failure-classes', (_req: Request, res: Response) => {
  res.json(getAllFailureClasses());
});

// ── GET /api/v1/tasks/search?q=&exclude_id=&limit= ──────────────────────────
// Lightweight task search for use in pickers (e.g. blocker picker).
// Searches by numeric id prefix (if q starts with #) or by title substring.
// Returns id, title, status — enough to display in a dropdown.
router.get('/search', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const q = String(req.query.q ?? '').trim();
    const excludeId = req.query.exclude_id ? Number(req.query.exclude_id) : null;
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 20), 50);

    if (!q) return res.json([]);

    const params: unknown[] = [];
    let condition = '';

    // If query starts with # or is purely numeric, search by id
    const idQuery = q.replace(/^#/, '');
    if (/^\d+$/.test(idQuery)) {
      condition = "CAST(t.id AS TEXT) LIKE ?";
      params.push(`${idQuery}%`);
    } else {
      condition = "LOWER(t.title) LIKE ?";
      params.push(`%${q.toLowerCase()}%`);
    }

    let excludeCondition = '';
    if (excludeId !== null) {
      excludeCondition = ' AND t.id != ?';
      params.push(excludeId);
    }

    params.push(limit);

    const rows = db.prepare(`
      SELECT t.id, t.title, t.status
      FROM tasks t
      WHERE ${condition}${excludeCondition}
      ORDER BY t.id DESC
      LIMIT ?
    `).all(...params) as { id: number; title: string; status: string }[];

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/completed-recent', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const hours = Math.max(1, Math.min(168, Number(req.query.hours) || 24));

    const rows = db.prepare(`
      SELECT
        t.id,
        t.title,
        t.status,
        t.priority,
        t.project_id,
        t.live_verified_at,
        t.live_verified_by,
        t.updated_at,
        t.agent_id,
        a.name  AS agent_name,
        a.job_title AS job_title,
        p.name  AS project_name,
        s.name  AS sprint_name,
        (
          SELECT th.new_value
          FROM task_history th
          WHERE th.task_id = t.id
            AND th.field = 'status'
            AND th.new_value = 'done'
          ORDER BY th.created_at DESC
          LIMIT 1
        ) AS completion_status,
        (
          SELECT th.created_at
          FROM task_history th
          WHERE th.task_id = t.id
            AND th.field = 'status'
            AND th.new_value = 'done'
          ORDER BY th.created_at DESC
          LIMIT 1
        ) AS completed_at,
        (
          SELECT ji2.task_outcome
          FROM job_instances ji2
          WHERE ji2.task_id = t.id
            AND ji2.task_outcome IS NOT NULL
            AND ji2.task_outcome != ''
          ORDER BY ji2.completed_at DESC
          LIMIT 1
        ) AS outcome
      FROM tasks t
      LEFT JOIN agents a ON a.id = t.agent_id
      LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN sprints s ON s.id = t.sprint_id
      WHERE t.status = 'done'
        AND t.updated_at >= datetime('now', '-' || ? || ' hours')
      ORDER BY t.updated_at DESC
    `).all(hours) as Record<string, unknown>[];

    res.json({ hours, count: rows.length, tasks: rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/tasks?project_id=X ──────────────────────────────────────────
// Supports optional pagination via limit/offset query params.
// When limit is provided, returns { tasks, total, hasMore, limit, offset }.
// Without limit, returns Task[] for backwards compatibility.
// Optional exclude_done=true hides tasks with status='done'.

router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { project_id, sprint_id, job_id, limit, offset, exclude_done, include_closed, origin_task_id, defect_type, status } = req.query;

    let query = TASK_SELECT;
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (project_id) {
      conditions.push('t.project_id = ?');
      params.push(Number(project_id));
    }
    if (sprint_id) {
      conditions.push('t.sprint_id = ?');
      params.push(Number(sprint_id));
    }
    if (job_id) {
      // Deprecated: job_id filter now interpreted as agent_id
      conditions.push('(t.agent_id = ? OR t.agent_id IS NULL)');
      params.push(Number(job_id));
    }
    if (origin_task_id) {
      conditions.push('t.origin_task_id = ?');
      params.push(Number(origin_task_id));
    }
    if (defect_type) {
      conditions.push('t.defect_type = ?');
      params.push(String(defect_type));
    }
    if (status) {
      // Support comma-separated list e.g. ?status=in_progress,stalled,blocked
      const statuses = String(status).split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        conditions.push('t.status = ?');
        params.push(statuses[0]);
      } else if (statuses.length > 1) {
        conditions.push(`t.status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }
    }
    if (exclude_done === 'true' || exclude_done === '1') {
      conditions.push("t.status != 'done'");
    }
    // By default, exclude tasks belonging to closed sprints. Pass ?include_closed=true to see them.
    if (!include_closed || include_closed === 'false') {
      conditions.push(`(t.sprint_id IS NULL OR EXISTS (
        SELECT 1 FROM sprints sp WHERE sp.id = t.sprint_id AND sp.status != 'closed'
      ))`);
    }
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ` ORDER BY t.created_at DESC`;

    // Paginated response when limit param is provided
    if (limit !== undefined) {
      const lim = Math.min(Math.max(1, Number(limit) || 50), 500);
      const off = Math.max(0, Number(offset) || 0);

      // Count total matching tasks (simple count without heavy JOINs)
      let countQuery = `SELECT COUNT(*) as total FROM tasks t`;
      if (conditions.length > 0) {
        countQuery += ` WHERE ${conditions.join(' AND ')}`;
      }
      const countResult = db.prepare(countQuery).get(...params) as { total: number };
      const total = countResult.total;

      query += ` LIMIT ? OFFSET ?`;
      const tasks = db.prepare(query).all(...params, lim, off) as Record<string, unknown>[];

      return res.json({
        tasks: enrichTasks(tasks),
        total,
        hasMore: off + lim < total,
        limit: lim,
        offset: off,
      });
    }

    // Legacy: return plain array when no pagination params (backwards compat)
    const tasks = db.prepare(query).all(...params) as Record<string, unknown>[];
    res.json(enrichTasks(tasks));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/tasks/field-schema/resolve ───────────────────────────────────

router.get('/field-schema/resolve', (req: Request, res: Response) => {
  try {
    const resolved = resolveTaskFieldSchema(req.query.sprint_id ?? null, req.query.task_type ?? null);
    res.json(resolved);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/tasks/:id ────────────────────────────────────────────────────

router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(Number(req.params.id)) as Record<string, unknown> | undefined;

    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(enrichTask(task));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/tasks ───────────────────────────────────────────────────────

router.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { title, description = '', status = 'todo', priority = 'medium', job_id, agent_id, project_id, sprint_id, recurring = 0, task_type, story_points, origin_task_id, defect_type, blockers, custom_fields } = req.body as {
      title: string;
      description?: string;
      status?: string;
      priority?: string;
      job_id?: number | null;
      agent_id?: number | null;
      project_id?: number | null;
      sprint_id?: number | null;
      recurring?: number | boolean;
      task_type?: string | null;
      story_points?: number | string | null;
      changed_by?: string;
      origin_task_id?: number | null;
      defect_type?: string | null;
      review_branch?: string | null;
      review_commit?: string | null;
      review_url?: string | null;
      blockers?: number[];
      custom_fields?: Record<string, unknown> | string | null;
    };

    const normalizedStoryPoints = normalizeStoryPoints(story_points);
    const normalizedCustomFields = parseCustomFields(custom_fields);
    const resolvedProjectId = project_id ?? null;
    let resolvedSprintId = sprint_id ?? null;
    const resolvedAgentId = agent_id ?? job_id ?? null;

    if (!title) return res.status(400).json({ error: 'title is required' });
    if (task_type !== undefined && task_type !== null && !isValidTaskType(task_type)) {
      return res.status(400).json({ error: `Invalid task_type "${task_type}". Valid: ${VALID_TASK_TYPES.join(', ')}` });
    }
    if (defect_type !== undefined && defect_type !== null && !isValidDefectType(defect_type)) {
      return res.status(400).json({ error: `Invalid defect_type "${defect_type}". Valid: ${VALID_DEFECT_TYPES.join(', ')}` });
    }
    if (status !== undefined && status !== null && !isTaskStatus(status)) {
      return res.status(400).json({ error: `"${status}" is not a valid task status. Valid values: ${RELEASE_TASK_STATUSES.join(', ')}` });
    }
    if (origin_task_id != null) {
      const originExists = db.prepare(`SELECT id FROM tasks WHERE id = ?`).get(origin_task_id);
      if (!originExists) return res.status(400).json({ error: `origin_task_id ${origin_task_id} does not exist` });
    }
    if (resolvedProjectId != null) {
      const projectExists = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(resolvedProjectId);
      if (!projectExists) return res.status(400).json({ error: `project_id ${resolvedProjectId} does not exist` });
      if (resolvedSprintId == null) {
        resolvedSprintId = resolveDefaultProjectSprintId(db, resolvedProjectId);
      }
    }
    if (resolvedSprintId != null) {
      const sprintExists = db.prepare(`SELECT id FROM sprints WHERE id = ?`).get(resolvedSprintId);
      if (!sprintExists) return res.status(400).json({ error: `sprint_id ${resolvedSprintId} does not exist` });
    }
    if (resolvedAgentId != null) {
      const agentExists = db.prepare(`SELECT id FROM agents WHERE id = ?`).get(resolvedAgentId);
      if (!agentExists) return res.status(400).json({ error: `agent_id ${resolvedAgentId} does not exist` });
    }

    const resolvedFieldSchema = resolveTaskFieldSchema(resolvedSprintId, task_type ?? null);
    if (typeof task_type === 'string' && !isTaskTypeAllowedForSprintType(db, resolvedFieldSchema.sprint_type, task_type)) {
      return res.status(400).json({ error: `task_type "${task_type}" is not allowed for sprint type "${resolvedFieldSchema.sprint_type}"` });
    }
    validateTaskCustomFields(normalizedCustomFields, resolvedFieldSchema.schema);

    // Validate blockers before insert (fail fast on invalid IDs)
    const validBlockerIds: number[] = [];
    const invalidBlockerIds: number[] = [];
    if (Array.isArray(blockers) && blockers.length > 0) {
      for (const bid of blockers) {
        const exists = db.prepare('SELECT id FROM tasks WHERE id = ?').get(bid);
        if (exists) {
          validBlockerIds.push(bid);
        } else {
          invalidBlockerIds.push(bid);
        }
      }
    }

    const insertTask = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO tasks (title, description, status, priority, project_id, agent_id, sprint_id, recurring, task_type, story_points, origin_task_id, defect_type, custom_fields_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(title, description, status, priority, resolvedProjectId, resolvedAgentId, resolvedSprintId, recurring ? 1 : 0, task_type ?? null, normalizedStoryPoints ?? null, origin_task_id ?? null, defect_type ?? null, JSON.stringify(normalizedCustomFields));

      const taskId = result.lastInsertRowid as number;

      // Wire blockers within the same transaction
      if (validBlockerIds.length > 0) {
        const insertDep = db.prepare(`INSERT OR IGNORE INTO task_dependencies (blocker_id, blocked_id) VALUES (?, ?)`);
        for (const bid of validBlockerIds) {
          insertDep.run(bid, taskId);
        }
      }

      return taskId;
    });

    const taskId = insertTask();

    // If this task has an origin_task_id, increment spawned_defects on the origin's outcome metrics
    if (origin_task_id != null) {
      const existingMetrics = db.prepare(`SELECT id FROM task_outcome_metrics WHERE task_id = ?`).get(origin_task_id) as { id: number } | undefined;
      if (existingMetrics) {
        db.prepare(`UPDATE task_outcome_metrics SET spawned_defects = spawned_defects + 1, updated_at = datetime('now') WHERE task_id = ?`).run(origin_task_id);
      } else {
        // Insert a minimal metrics row — use NULL for FKs that may not resolve
        db.prepare(`
          INSERT INTO task_outcome_metrics (task_id, spawned_defects)
          VALUES (?, 1)
        `).run(origin_task_id);
      }
    }
    const createdBy = req.body.changed_by ?? 'system';

    db.prepare(`
      INSERT INTO task_history (task_id, field, old_value, new_value, changed_by)
      VALUES (?, 'created', NULL, ?, ?)
    `).run(taskId, title, createdBy);

    const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(taskId) as Record<string, unknown>;
    if (status === 'ready') {
      maybeTriggerDispatch(project_id ?? task.project_id);
    }
    const enriched = enrichTask(task);
    if (invalidBlockerIds.length > 0) {
      (enriched as Record<string, unknown>).skipped_blocker_ids = invalidBlockerIds;
    }
    res.status(201).json(enriched);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('story_points') || message.includes('custom field') || message.includes('custom_fields')) return res.status(400).json({ error: message });
    if (message.includes('CHECK constraint failed')) {
      return res.status(400).json({ error: `Invalid field value: ${message.replace(/^.*CHECK constraint failed:\s*/i, '')}` });
    }
    res.status(500).json({ error: message });
  }
});

// ── PUT /api/v1/tasks/:id ────────────────────────────────────────────────────

router.put('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    const {
      title, description, status, priority, job_id, agent_id, project_id, sprint_id, recurring, branch_url, task_type, story_points,
      origin_task_id, defect_type, review_branch, review_commit, review_url, blockers, custom_fields,
      changed_by = 'system',
    } = req.body as {
      title?: string;
      description?: string;
      status?: string;
      priority?: string;
      job_id?: number | null;
      agent_id?: number | null;
      project_id?: number | null;
      sprint_id?: number | null;
      recurring?: number | boolean;
      branch_url?: string | null;
      task_type?: string | null;
      story_points?: number | string | null;
      origin_task_id?: number | null;
      defect_type?: string | null;
      review_branch?: string | null;
      review_commit?: string | null;
      review_url?: string | null;
      blockers?: Array<{ task_id?: number; blocker_id?: number; reason?: string | null }>;
      custom_fields?: Record<string, unknown> | string | null;
      changed_by?: string;
      authority_by?: string;
    };

    const authorityBy = (req.body.authority_by as string | undefined) ?? changed_by;
    const normalizedStoryPoints = normalizeStoryPoints(story_points);
    const normalizedCustomFields = custom_fields !== undefined
      ? parseCustomFields(custom_fields)
      : parseCustomFields(existing.custom_fields_json);
    if (task_type !== undefined && task_type !== null && !isValidTaskType(task_type)) {
      return res.status(400).json({ error: `Invalid task_type "${task_type}". Valid: ${VALID_TASK_TYPES.join(', ')}` });
    }
    if (defect_type !== undefined && defect_type !== null && !isValidDefectType(defect_type)) {
      return res.status(400).json({ error: `Invalid defect_type "${defect_type}". Valid: ${VALID_DEFECT_TYPES.join(', ')}` });
    }
    if (status !== undefined && status !== null && !isTaskStatus(status)) {
      return res.status(400).json({ error: `"${status}" is not a valid task status. Valid values: ${RELEASE_TASK_STATUSES.join(', ')}` });
    }
    if (origin_task_id !== undefined && origin_task_id !== null) {
      const originExists = db.prepare(`SELECT id FROM tasks WHERE id = ?`).get(origin_task_id);
      if (!originExists) return res.status(400).json({ error: `origin_task_id ${origin_task_id} does not exist` });
    }

    const updated = {
      title: title ?? existing.title,
      description: description ?? existing.description,
      status: status ?? existing.status,
      priority: priority ?? existing.priority,
      job_id: job_id !== undefined ? (job_id ?? null) : existing.job_id,
      agent_id: agent_id !== undefined ? (agent_id ?? job_id ?? null) : (job_id !== undefined ? (job_id ?? null) : existing.agent_id),
      project_id: project_id !== undefined ? (project_id ?? null) : existing.project_id,
      sprint_id: sprint_id !== undefined ? (sprint_id ?? null) : existing.sprint_id,
      recurring: recurring !== undefined ? (recurring ? 1 : 0) : existing.recurring,
      branch_url: branch_url !== undefined ? (branch_url ?? null) : existing.branch_url,
      task_type: task_type !== undefined ? (task_type ?? null) : existing.task_type,
      story_points: normalizedStoryPoints !== undefined ? normalizedStoryPoints : existing.story_points,
      origin_task_id: origin_task_id !== undefined ? (origin_task_id ?? null) : existing.origin_task_id,
      defect_type: defect_type !== undefined ? (defect_type ?? null) : existing.defect_type,
      custom_fields_json: JSON.stringify(normalizedCustomFields),
    };

    const resolvedFieldSchema = resolveTaskFieldSchema(updated.sprint_id, updated.task_type);
    const resolvedSprintType = resolveSprintTypeForTask(updated.sprint_id);
    if (typeof updated.task_type === 'string' && !isTaskTypeAllowedForSprintType(db, resolvedSprintType, updated.task_type)) {
      return res.status(400).json({ error: `task_type "${updated.task_type}" is not allowed for sprint type "${resolvedFieldSchema.sprint_type}"` });
    }
    validateTaskCustomFields(normalizedCustomFields, resolvedFieldSchema.schema);

    const reviewEvidencePatch = Object.fromEntries(
      Object.entries({ review_branch, review_commit, review_url }).filter(([, value]) =>
        value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')
      )
    );

    assertTaskStatusUpdateAllowed(
      { status: String(existing.status) },
      status,
      authorityBy,
    );

    if (status !== undefined && status !== existing.status && authorityBy === 'Atlas') {
      assertAtlasDirectStatusGate(db, {
        id,
        status: String(existing.status),
        sprint_id: (updated.sprint_id as number | null | undefined) ?? null,
        task_type: (updated.task_type as string | null | undefined) ?? null,
        review_branch: (existing.review_branch as string | null | undefined) ?? null,
        review_commit: (existing.review_commit as string | null | undefined) ?? null,
        review_url: (existing.review_url as string | null | undefined) ?? null,
        qa_verified_commit: (existing.qa_verified_commit as string | null | undefined) ?? null,
        qa_tested_url: (existing.qa_tested_url as string | null | undefined) ?? null,
        merged_commit: (existing.merged_commit as string | null | undefined) ?? null,
        deployed_commit: (existing.deployed_commit as string | null | undefined) ?? null,
        deployed_at: (existing.deployed_at as string | null | undefined) ?? null,
        live_verified_at: (existing.live_verified_at as string | null | undefined) ?? null,
        live_verified_by: (existing.live_verified_by as string | null | undefined) ?? null,
        deploy_target: (existing.deploy_target as string | null | undefined) ?? null,
        evidence_json: (existing.evidence_json as string | null | undefined) ?? null,
      }, status);
    }

    // ── Track field changes ──────────────────────────────────────────────────
    const trackedFields: Array<keyof typeof updated> = ['status', 'priority', 'title', 'sprint_id', 'agent_id', 'branch_url', 'task_type', 'story_points', 'origin_task_id', 'defect_type', 'custom_fields_json'];
    for (const field of trackedFields) {
      const oldVal = existing[field];
      const newVal = updated[field];
      if (String(oldVal ?? '') !== String(newVal ?? '')) {
        const resolvedOld: string | null = oldVal == null ? null : String(oldVal);
        const resolvedNew: string | null = newVal == null ? null : String(newVal);
        logHistory(id, changed_by as string, field, resolvedOld, resolvedNew);
      }
    }

    db.prepare(`
      UPDATE tasks SET
        title = ?, description = ?, status = ?, priority = ?,
        project_id = ?, agent_id = ?, sprint_id = ?, recurring = ?,
        branch_url = ?, task_type = ?, story_points = ?,
        origin_task_id = ?, defect_type = ?, custom_fields_json = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      updated.title, updated.description, updated.status, updated.priority,
      updated.project_id, updated.agent_id, updated.sprint_id, updated.recurring,
      updated.branch_url, updated.task_type, updated.story_points,
      updated.origin_task_id, updated.defect_type, updated.custom_fields_json,
      id
    );

    if (Object.keys(reviewEvidencePatch).length > 0) {
      updateTaskEvidence(id, changed_by, reviewEvidencePatch);
    }

    if (Array.isArray(blockers)) {
      const normalizedBlockers = blockers
        .map((entry: { task_id?: number; blocker_id?: number; reason?: string | null }) => ({
          blocker_id: Number(entry?.task_id ?? entry?.blocker_id),
          reason: entry?.reason ?? null,
        }))
        .filter((entry: { blocker_id: number; reason: string | null }) => Number.isInteger(entry.blocker_id) && entry.blocker_id > 0);

      db.prepare('DELETE FROM task_dependencies WHERE blocked_id = ?').run(id);

      const insertDependency = db.prepare(`
        INSERT OR IGNORE INTO task_dependencies (blocker_id, blocked_id)
        VALUES (?, ?)
      `);

      for (const blocker of normalizedBlockers) {
        if (blocker.blocker_id === id) continue;
        insertDependency.run(blocker.blocker_id, id);
      }
    }

    cleanupTaskExecutionLinkageForStatus(db, id, String(updated.status));

    // Detect manual status change for telemetry (#586)
    const isManualStatusChange = status !== undefined
      && String(status) !== String(existing.status)
      && !['eligibility','reconciler','watchdog','task_lifecycle','scheduler','system','dispatcher','task_outcome'].includes(String(changed_by));

    // Increment manual_intervention_count if applicable
    if (isManualStatusChange) {
      try {
        const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
        if (cols.some(c => c.name === 'manual_intervention_count')) {
          db.prepare(`UPDATE tasks SET manual_intervention_count = manual_intervention_count + 1 WHERE id = ?`).run(id);
        }
      } catch { /* non-fatal */ }
    }

    if (status !== undefined && String(status) !== String(existing.status)) {
      notifyTaskStatusChange(db, {
        taskId: id,
        fromStatus: String(existing.status),
        toStatus: String(status),
        source: String(changed_by),
      });

      // Emit task_event for direct status changes (#586)
      emitTaskEvent(db, {
        taskId: id,
        fromStatus: String(existing.status),
        toStatus: String(status),
        movedBy: String(changed_by),
        moveType: isManualStatusChange ? 'manual' : 'automatic',
        projectId: (existing.project_id as number | null) ?? null,
        agentId: (existing.agent_id as number | null) ?? null,
      });
    }

    const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as Record<string, unknown>;
    res.json(enrichTask(task));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('may change task status through the generic update endpoint')) {
      return res.status(403).json({ error: message });
    }
    if (message.includes('task_type "') && message.includes('is not allowed for sprint type')) {
      return res.status(400).json({ error: message, code: 'task_type_not_allowed_for_sprint_workflow' });
    }
    if (message.startsWith('Cannot move task from "') || message.startsWith('Cannot apply outcome "')) {
      return res.status(400).json({ error: message, code: 'transition_not_allowed_for_workflow' });
    }
    if (message.includes('requires ') || message.startsWith('done requires task status deployed') || message.includes('story_points') || message.includes('custom field') || message.includes('custom_fields')) {
      return res.status(400).json({ error: message });
    }
    // Safety net: convert raw SQLite CHECK constraint errors into clean 400 responses
    if (message.includes('CHECK constraint failed')) {
      return res.status(400).json({ error: `Invalid field value: ${message.replace(/^.*CHECK constraint failed:\s*/i, '')}` });
    }
    res.status(500).json({ error: message });
  }
});

// ── POST /api/v1/tasks/:id/cancel ────────────────────────────────────────────

router.post('/:id/cancel', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    const oldStatus = existing.status as string;

    db.prepare(`
      UPDATE tasks SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?
    `).run(id);

    cleanupTaskExecutionLinkageForStatus(db, id, 'cancelled');

    logHistory(id, 'Atlas', 'status', oldStatus, 'cancelled');

    db.prepare(`
      INSERT INTO task_notes (task_id, author, content) VALUES (?, ?, ?)
    `).run(id, 'Atlas', 'Task cancelled by user.');

    notifyTaskStatusChange(db, {
      taskId: id,
      fromStatus: oldStatus,
      toStatus: 'cancelled',
      source: 'Atlas',
    });

    const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as Record<string, unknown>;
    res.json({ ok: true, task: enrichTask(task) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/tasks/:id/stop ──────────────────────────────────────────────
// Stop the current active run for a task and pause the task without changing
// its workflow status. Repeated stop requests are idempotent when the task is
// already paused and no active run exists.

router.post('/:id/stop', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const changedBy = (req.body?.changed_by as string | undefined) ?? 'User';
    const reasonRaw = req.body?.reason as string | undefined;
    const pauseReason = typeof reasonRaw === 'string' && reasonRaw.trim().length > 0 ? reasonRaw.trim() : null;
    const result = await stopTaskAndPause(db, id, changedBy, pauseReason);

    const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as Record<string, unknown>;
    return res.json({
      ok: true,
      ...result,
      task: enrichTask(task),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'Task not found') return res.status(404).json({ error: message });
    if (message.startsWith('Cannot stop a task in terminal status')) {
      return res.status(400).json({ error: message });
    }
    return res.status(500).json({ error: message });
  }
});

// ── POST /api/v1/tasks/:id/reopen ────────────────────────────────────────────
// Reopen a failed task: restores it to its previous_status (the status it held
// before failing). Falls back to 'ready' if previous_status is not recorded.
// Only callable on tasks in 'failed' status.

router.post('/:id/reopen', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    if (existing.status !== 'failed') {
      return res.status(400).json({ error: `Cannot reopen a task in '${existing.status}' status. Only 'failed' tasks can be reopened.` });
    }

    const changedBy = (req.body?.changed_by as string | undefined) ?? 'Atlas';
    // Restore the task to its pre-failure position; fall back to 'ready' (task #30)
    const restoreStatus = (existing.previous_status as string | null) ?? 'ready';

    db.prepare(`
      UPDATE tasks
      SET status = ?,
          previous_status = NULL,
          failure_class = NULL,
          failure_detail = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(restoreStatus, id);

    cleanupTaskExecutionLinkageForStatus(db, id, restoreStatus);
    logHistory(id, changedBy, 'status', String(existing.status), restoreStatus);

    db.prepare(`
      INSERT INTO task_notes (task_id, author, content) VALUES (?, ?, ?)
    `).run(id, changedBy, `Task reopened — restored to '${restoreStatus}'${existing.previous_status ? ' (previous position)' : ' (default fallback)'}.`);

    notifyTaskStatusChange(db, {
      taskId: id,
      fromStatus: String(existing.status),
      toStatus: restoreStatus,
      source: changedBy,
    });

    if (restoreStatus === 'ready') {
      maybeTriggerDispatch((existing.project_id as number | null) ?? undefined);
    }

    const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as Record<string, unknown>;
    res.json({ ok: true, restored_to: restoreStatus, task: enrichTask(task) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/tasks/:id/pause ─────────────────────────────────────────────
// Pause a task: sets paused_at = now and stores an optional pause_reason.
// Paused tasks are excluded from routing, dispatch, and lifecycle transitions
// until explicitly unpaused. Status is not changed.

router.post('/:id/pause', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    const terminalStatuses = ['done', 'cancelled', 'failed'];
    if (terminalStatuses.includes(existing.status as string)) {
      return res.status(400).json({ error: `Cannot pause a task in terminal status '${existing.status}'` });
    }

    if (existing.paused_at) {
      return res.status(400).json({ error: 'Task is already paused' });
    }

    const pauseReason = (req.body?.reason as string | undefined) ?? null;
    const changedBy = (req.body?.changed_by as string | undefined) ?? 'user';

    db.prepare(`
      UPDATE tasks SET paused_at = datetime('now'), pause_reason = ?, updated_at = datetime('now') WHERE id = ?
    `).run(pauseReason, id);

    logHistory(id, changedBy, 'paused_at', null, new Date().toISOString());

    db.prepare(`
      INSERT INTO task_notes (task_id, author, content) VALUES (?, ?, ?)
    `).run(id, changedBy, pauseReason ? `Task paused: ${pauseReason}` : 'Task paused by user.');

    const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as Record<string, unknown>;
    res.json({ ok: true, task: enrichTask(task) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/tasks/:id/unpause ───────────────────────────────────────────
// Unpause a task: clears paused_at and pause_reason, restoring full dispatch
// eligibility immediately.

router.post('/:id/unpause', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    if (!existing.paused_at) {
      return res.status(400).json({ error: 'Task is not paused' });
    }

    const changedBy = (req.body?.changed_by as string | undefined) ?? 'user';

    db.prepare(`
      UPDATE tasks SET paused_at = NULL, pause_reason = NULL, updated_at = datetime('now') WHERE id = ?
    `).run(id);

    logHistory(id, changedBy, 'paused_at', existing.paused_at as string, null);

    db.prepare(`
      INSERT INTO task_notes (task_id, author, content) VALUES (?, ?, ?)
    `).run(id, changedBy, 'Task unpaused — routing and dispatch eligibility restored.');

    const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as Record<string, unknown>;
    res.json({ ok: true, task: enrichTask(task) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/tasks/:id/outcome ───────────────────────────────────────────
// Supports atomic evidence writes: pass review_branch, review_commit, etc.
// alongside the outcome. Evidence is validated and written in the same
// SQLite transaction as the status transition, ensuring the task record
// always reflects the actual artifact when completion succeeds.

router.post('/:id/outcome', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare(
      'SELECT id, task_type, review_branch, review_commit, review_url, qa_verified_commit, qa_tested_url FROM tasks WHERE id = ?',
    ).get(id) as {
      id: number;
      task_type: string | null;
      sprint_id: number | null;
      review_branch: string | null;
      review_commit: string | null;
      review_url: string | null;
      qa_verified_commit: string | null;
      qa_tested_url: string | null;
    } | undefined;
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    const { outcome, changed_by = 'system', summary, instance_id, instanceId, failure_class, failure_detail } = req.body as {
      outcome: string;
      changed_by?: string;
      summary?: string;
      instance_id?: number | string | null;
      instanceId?: number | string | null;
      failure_class?: string;
      failure_detail?: string;
    };

    if (!outcome) return res.status(400).json({ error: 'outcome is required' });

    // Extract inline evidence from the request body (if any)
    const inlineEvidence = extractInlineEvidence(req.body as Record<string, unknown>);
    const hasInline = hasAnyEvidence(inlineEvidence);

    // Validate inline evidence coherence for this outcome
    const transitionRequirements = loadSprintTaskTransitionRequirements(db, existing.sprint_id ?? null, outcome, existing.task_type ?? null)
      .map((row): GateRequirement => ({
        field_name: row.field_name,
        requirement_type: row.requirement_type,
        match_field: row.match_field,
        severity: row.severity,
        message: row.message,
      }));

    const evidenceValidation = validateInlineEvidenceForOutcome(outcome, inlineEvidence, {
      review_branch: existing.review_branch,
      review_commit: existing.review_commit,
      review_url: existing.review_url,
      qa_verified_commit: existing.qa_verified_commit,
      qa_tested_url: existing.qa_tested_url,
    }, transitionRequirements);

    const rawInstanceId = instance_id ?? instanceId;
    const authoritativeInstanceId = rawInstanceId == null ? null : Number(rawInstanceId);

    if (!evidenceValidation.valid) {
      const refusal = evidenceValidation.errors[0] ?? 'Evidence validation failed';
      resolveRefusedTaskOutcome(db, {
        taskId: id,
        outcome,
        changedBy: changed_by,
        reason: refusal,
        summary: summary ?? null,
        instanceId: Number.isFinite(authoritativeInstanceId ?? NaN) ? authoritativeInstanceId : null,
      });
      return res.status(400).json({
        error: 'Evidence validation failed',
        validation_errors: evidenceValidation.errors,
      });
    }

    const persistOutcomeRefusal = (reason: string) => {
      resolveRefusedTaskOutcome(db, {
        taskId: id,
        outcome,
        changedBy: changed_by,
        reason,
        summary: summary ?? null,
        instanceId: Number.isFinite(authoritativeInstanceId ?? NaN) ? authoritativeInstanceId : null,
      });
    };

    const isOutcomeRefusalMessage = (message: string) => (
      message.includes('requires ') ||
      message.includes('failure_class') ||
      message.startsWith('qa_pass requires') ||
      message.startsWith('approved_for_merge requires') ||
      message.startsWith('deployed_live requires') ||
      message.startsWith('live_verified requires')
    );

    await db.exec('BEGIN');
    let result;
    try {
      // Keep the evidence write and outcome transition in one transaction.
      // If applyTaskOutcome rejects on the stricter release gate, we rollback
      // so refused inline evidence cannot persist on the task record.
      if (hasInline) {
        updateTaskEvidence(id, changed_by, inlineEvidence as Record<string, unknown>);

        const evFields: string[] = [];
        if (inlineEvidence.review_branch) evFields.push(`Branch: ${inlineEvidence.review_branch}`);
        if (inlineEvidence.review_commit) evFields.push(`Commit: ${inlineEvidence.review_commit}`);
        if (inlineEvidence.review_url) evFields.push(`URL: ${inlineEvidence.review_url}`);
        if (inlineEvidence.qa_verified_commit) evFields.push(`QA commit: ${inlineEvidence.qa_verified_commit}`);
        if (inlineEvidence.qa_tested_url) evFields.push(`QA URL: ${inlineEvidence.qa_tested_url}`);
        if (inlineEvidence.merged_commit) evFields.push(`Merged: ${inlineEvidence.merged_commit}`);
        if (inlineEvidence.deployed_commit) evFields.push(`Deployed: ${inlineEvidence.deployed_commit}`);
        if (inlineEvidence.deploy_target) evFields.push(`Target: ${inlineEvidence.deploy_target}`);
        if (inlineEvidence.deployed_at) evFields.push(`At: ${inlineEvidence.deployed_at}`);
        if (inlineEvidence.live_verified_by) evFields.push(`Verified by: ${inlineEvidence.live_verified_by}`);
        if (evFields.length > 0) {
          addTaskNote(id, changed_by, `Atomic evidence (with ${outcome})\n${evFields.join('\n')}`);
        }
      }

      result = await applyTaskOutcome(db, {
        taskId: id,
        outcome,
        changedBy: changed_by,
        summary: summary ?? null,
        instanceId: Number.isFinite(authoritativeInstanceId ?? NaN) ? authoritativeInstanceId : null,
        failureClass: failure_class ?? null,
        failureDetail: failure_detail ?? null,
      });
      await db.exec('COMMIT');
    } catch (error) {
      try {
        await db.exec('ROLLBACK');
      } catch {
        // Surface the original failure below.
      }
      const message = error instanceof Error ? error.message : String(error);
      if (isOutcomeRefusalMessage(message) && !(error instanceof RefusedTaskOutcomeError)) {
        persistOutcomeRefusal(message);
      }
      throw error;
    }

    const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as Record<string, unknown>;
    maybeTriggerDispatch((task?.project_id as number | null | undefined) ?? null);
    res.json({
      ok: true,
      applied: result.applied,
      ignored: result.ignored,
      reason: result.reason,
      prior_status: result.priorStatus,
      next_status: result.nextStatus,
      outcome: result.outcome,
      instance_closed: result.instanceClosed ?? false,
      evidence_written: hasInline,
      failure_class: result.failureClass ?? null,
      auto_recovered: result.autoRecovered ?? false,
      recovery_description: result.recoveryDescription ?? null,
      task: enrichTask(task),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('No routing config found for')) {
      return res.status(422).json({ error: message });
    }
    if (message.includes('task_type "') && message.includes('is not allowed for sprint type')) {
      return res.status(400).json({ error: message, code: 'task_type_not_allowed_for_sprint_workflow' });
    }
    if (message.startsWith('Cannot move task from "') || message.startsWith('Cannot apply outcome "')) {
      return res.status(400).json({ error: message, code: 'transition_not_allowed_for_workflow' });
    }
    if (
      message.includes('requires ') ||
      message.includes('failure_class') ||
      message.startsWith('qa_pass requires') ||
      message.startsWith('approved_for_merge requires') ||
      message.startsWith('deployed_live requires') ||
      message.startsWith('live_verified requires')
    ) {
      return res.status(400).json({ error: message });
    }
    res.status(500).json({ error: message });
  }
});

// ── PUT /api/v1/tasks/:id/review-evidence ────────────────────────────────────

router.put('/:id/review-evidence', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const {
      review_branch,
      review_commit,
      review_url,
      summary,
      changed_by = 'system',
      instance_id,
    } = req.body as {
      review_branch?: string | null;
      review_commit?: string | null;
      review_url?: string | null;
      summary?: string | null;
      changed_by?: string;
      instance_id?: number | string | null;
    };

    const db = getDb();

    // Guard: if instance_id provided, verify it is still the active instance.
    // Stale or duplicate instances must not overwrite evidence recorded by the
    // current authoritative instance.
    if (instance_id != null) {
      const task = db.prepare(`SELECT active_instance_id FROM tasks WHERE id = ?`).get(id) as { active_instance_id: number | null } | undefined;
      if (!task) return res.status(404).json({ error: 'Task not found' });
      if (task.active_instance_id != null && Number(instance_id) !== task.active_instance_id) {
        return res.status(409).json({
          error: 'Stale instance: review evidence write rejected',
          reason: 'instance_not_authoritative',
          callback_instance_id: Number(instance_id),
          active_instance_id: task.active_instance_id,
        });
      }
    }

    // Validate review evidence payload — reject blank/malformed submissions
    const validation = validateReviewEvidence({ review_branch, review_commit, review_url });
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Review evidence validation failed',
        validation_errors: validation.errors,
      });
    }

    updateTaskEvidence(id, changed_by, {
      review_branch: review_branch ?? null,
      review_commit: review_commit ?? null,
      review_url: review_url ?? null,
    });

    addTaskNote(
      id,
      changed_by,
      `Review evidence recorded\nBranch: ${review_branch ?? '—'}\nCommit: ${review_commit ?? '—'}\nURL: ${review_url ?? '—'}${summary ? `\nSummary: ${summary}` : ''}`,
    );

    const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(enrichTask(task));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('story_points')) return res.status(400).json({ error: message });
    res.status(500).json({ error: message });
  }
});

// ── PUT /api/v1/tasks/:id/qa-evidence ────────────────────────────────────────

router.put('/:id/qa-evidence', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const {
      qa_verified_commit,
      verified_commit,
      qa_url,
      tested_url,
      qa_tested_url,
      summary,
      changed_by = 'system',
      instance_id,
      force_clear,
    } = req.body as {
      qa_verified_commit?: string | null;
      verified_commit?: string | null;
      qa_url?: string | null;
      tested_url?: string | null;
      qa_tested_url?: string | null;
      summary?: string | null;
      changed_by?: string;
      instance_id?: number | string | null;
      force_clear?: boolean;
    };

    const resolvedQaVerifiedCommit = qa_verified_commit ?? verified_commit;
    const resolvedQaTestedUrl = qa_tested_url ?? tested_url ?? qa_url;

    const db = getDb();

    // Guard: if instance_id provided, verify it is still the active instance.
    // Stale or duplicate QA instances must not overwrite QA evidence recorded by
    // the current authoritative instance — this protects qa_verified_commit and
    // qa_tested_url from being cleared by late callbacks after ownership changes.
    if (instance_id != null) {
      const task = db.prepare(`SELECT active_instance_id FROM tasks WHERE id = ?`).get(id) as { active_instance_id: number | null } | undefined;
      if (!task) return res.status(404).json({ error: 'Task not found' });
      if (task.active_instance_id != null && Number(instance_id) !== task.active_instance_id) {
        return res.status(409).json({
          error: 'Stale instance: QA evidence write rejected',
          reason: 'instance_not_authoritative',
          callback_instance_id: Number(instance_id),
          active_instance_id: task.active_instance_id,
        });
      }
    }

    // Intentional clear: caller must pass force_clear=true AND provide null for
    // the fields they want cleared.  Without force_clear, blank-write protection
    // remains in effect (stale/duplicate runs cannot silently erase evidence).
    const explicitClears = new Set<string>();
    if (force_clear === true) {
      const body = req.body as Record<string, unknown>;
      if (
        (Object.prototype.hasOwnProperty.call(body, 'qa_verified_commit') && body.qa_verified_commit === null)
        || (Object.prototype.hasOwnProperty.call(body, 'verified_commit') && body.verified_commit === null)
      ) {
        explicitClears.add('qa_verified_commit');
      }
      if (
        (Object.prototype.hasOwnProperty.call(body, 'qa_tested_url') && body.qa_tested_url === null)
        || (Object.prototype.hasOwnProperty.call(body, 'tested_url') && body.tested_url === null)
        || (Object.prototype.hasOwnProperty.call(body, 'qa_url') && body.qa_url === null)
      ) {
        explicitClears.add('qa_tested_url');
      }
    }

    // Validate QA evidence payload — skip validation for force_clear operations
    // (clearing fields doesn't need coherence checks against review_commit).
    // Also skip when qa_verified_commit isn't substantively provided — partial
    // updates (e.g. just tested_url) don't need full QA evidence validation.
    const hasSubstantiveCommit = resolvedQaVerifiedCommit !== undefined && resolvedQaVerifiedCommit !== null && resolvedQaVerifiedCommit !== '';
    if (explicitClears.size === 0 && hasSubstantiveCommit) {
      const taskRow = db.prepare('SELECT review_commit FROM tasks WHERE id = ?').get(id) as { review_commit: string | null } | undefined;
      const qaValidation = validateQaEvidence(
        { qa_verified_commit: resolvedQaVerifiedCommit, qa_tested_url: resolvedQaTestedUrl },
        taskRow?.review_commit,
      );
      if (!qaValidation.valid) {
        return res.status(400).json({
          error: 'QA evidence validation failed',
          validation_errors: qaValidation.errors,
        });
      }
    }

    updateTaskEvidence(id, changed_by, {
      qa_verified_commit: resolvedQaVerifiedCommit ?? null,
      qa_tested_url: resolvedQaTestedUrl ?? null,
    }, { explicitClears });

    // Build an informative note that distinguishes clears from normal writes
    const commitDisplay = explicitClears.has('qa_verified_commit')
      ? '[cleared]'
      : (resolvedQaVerifiedCommit ?? '—');
    const urlDisplay = explicitClears.has('qa_tested_url')
      ? '[cleared]'
      : (resolvedQaTestedUrl ?? '—');
    const actionLabel = explicitClears.size > 0 ? 'QA evidence reset (intentional clear)' : 'QA evidence recorded';

    addTaskNote(
      id,
      changed_by,
      `${actionLabel}\nVerified commit: ${commitDisplay}\nTested URL: ${urlDisplay}${summary ? `\nSummary: ${summary}` : ''}`,
    );

    const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(enrichTask(task));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('story_points')) return res.status(400).json({ error: message });
    res.status(500).json({ error: message });
  }
});

// ── PUT /api/v1/tasks/:id/deploy-evidence ────────────────────────────────────

router.put('/:id/deploy-evidence', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const {
      merged_commit,
      deployed_commit,
      deploy_target,
      deployed_at,
      summary,
      changed_by = 'system',
    } = req.body as {
      merged_commit?: string | null;
      deployed_commit?: string | null;
      deploy_target?: string | null;
      deployed_at?: string | null;
      summary?: string | null;
      changed_by?: string;
    };

    // Validate deploy evidence payload
    const deployValidation = validateDeployEvidence({ merged_commit, deployed_commit, deploy_target, deployed_at });
    if (!deployValidation.valid) {
      return res.status(400).json({
        error: 'Deploy evidence validation failed',
        validation_errors: deployValidation.errors,
      });
    }

    updateTaskEvidence(id, changed_by, {
      merged_commit: merged_commit ?? null,
      deployed_commit: deployed_commit ?? null,
      deploy_target: deploy_target ?? null,
      deployed_at: deployed_at ?? null,
    });

    addTaskNote(
      id,
      changed_by,
      `Deploy evidence recorded\nMerged commit: ${merged_commit ?? '—'}\nDeployed commit: ${deployed_commit ?? '—'}\nDeploy target: ${deploy_target ?? '—'}\nDeployed at: ${deployed_at ?? '—'}${summary ? `\nSummary: ${summary}` : ''}`,
    );

    const db = getDb();
    const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(enrichTask(task));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('story_points')) return res.status(400).json({ error: message });
    res.status(500).json({ error: message });
  }
});

// ── PUT /api/v1/tasks/:id/live-verification ──────────────────────────────────

router.put('/:id/live-verification', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const {
      live_verified_by,
      live_verified_at,
      summary,
      changed_by = 'system',
    } = req.body as {
      live_verified_by?: string | null;
      live_verified_at?: string | null;
      summary?: string | null;
      changed_by?: string;
    };

    updateTaskEvidence(id, changed_by, {
      live_verified_by: live_verified_by ?? null,
      live_verified_at: live_verified_at ?? new Date().toISOString(),
    });

    addTaskNote(
      id,
      changed_by,
      `Live verification recorded\nVerified by: ${live_verified_by ?? '—'}\nVerified at: ${live_verified_at ?? new Date().toISOString()}${summary ? `\nSummary: ${summary}` : ''}`,
    );

    const db = getDb();
    const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(enrichTask(task));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/tasks/backfill-release-integrity ───────────────────────────

router.post('/backfill-release-integrity', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const tasks = db.prepare('SELECT * FROM tasks').all() as Record<string, unknown>[];
    const results = tasks.map(task => ({
      id: task.id,
      title: task.title,
      ...evaluateTaskIntegrity(task as { status?: string | null; task_type?: string | null }, db),
    }));
    const flagged = results.filter(task => task.integrity_state !== 'clean');
    res.json({ ok: true, total: results.length, flagged: flagged.length, results, flagged_results: flagged });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── DELETE /api/v1/tasks/:id ─────────────────────────────────────────────────

router.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    const deletedBy = (req.query.deleted_by as string | undefined) ?? (req.body?.deleted_by as string | undefined) ?? 'system';

    // Clean up attachment files from disk before deleting
    const attachments = db.prepare(
      'SELECT filepath FROM task_attachments WHERE task_id = ?'
    ).all(id) as Array<{ filepath: string }>;
    for (const att of attachments) {
      try { fs.unlinkSync(att.filepath); } catch { /* file may already be gone */ }
    }

    // Log the deletion to task_history before the cascade removes everything
    db.prepare(`
      INSERT INTO task_history (task_id, changed_by, field, old_value, new_value)
      VALUES (?, ?, 'deleted', ?, NULL)
    `).run(id, deletedBy, String(existing.title ?? ''));

    // Hard delete — task_history/notes/attachments/dependencies cascade via FK ON DELETE CASCADE
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);

    res.json({ ok: true, deleted_id: id, deleted_title: existing.title ?? null });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/tasks/:id/history ────────────────────────────────────────────

router.get('/:id/history', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const history = db.prepare(`
      SELECT * FROM task_history WHERE task_id = ? ORDER BY created_at DESC
    `).all(id);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/tasks/:id/notes ──────────────────────────────────────────────

router.get('/:id/notes', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const notes = db.prepare(`
      SELECT * FROM task_notes WHERE task_id = ? ORDER BY created_at ASC
    `).all(id);
    res.json(notes);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/tasks/:id/notes ─────────────────────────────────────────────

router.post('/:id/notes', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const { author = 'system', content } = req.body as { author?: string; content: string };
    if (!content) return res.status(400).json({ error: 'content is required' });

    const result = db.prepare(`
      INSERT INTO task_notes (task_id, author, content) VALUES (?, ?, ?)
    `).run(id, author, content);

    const note = db.prepare('SELECT * FROM task_notes WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(note);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── DELETE /api/v1/tasks/:id/notes/:noteId ───────────────────────────────────

router.delete('/:id/notes/:noteId', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const taskId = Number(req.params.id);
    const noteId = Number(req.params.noteId);

    const note = db.prepare('SELECT id FROM task_notes WHERE id = ? AND task_id = ?').get(noteId, taskId);
    if (!note) return res.status(404).json({ error: 'Note not found' });

    db.prepare('DELETE FROM task_notes WHERE id = ?').run(noteId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/tasks/:id/blockers ─────────────────────────────────────────

router.post('/:id/blockers', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const blocked_id = Number(req.params.id);
    const { blocker_id } = req.body as { blocker_id: number };

    if (!blocker_id) return res.status(400).json({ error: 'blocker_id is required' });
    if (blocker_id === blocked_id) return res.status(400).json({ error: 'A task cannot block itself' });

    const blockedTask = db.prepare('SELECT id FROM tasks WHERE id = ?').get(blocked_id);
    if (!blockedTask) return res.status(404).json({ error: 'Task not found' });

    const blockerTask = db.prepare('SELECT id FROM tasks WHERE id = ?').get(blocker_id);
    if (!blockerTask) return res.status(404).json({ error: 'Blocker task not found' });

    // Upsert — ignore if already exists
    db.prepare(`
      INSERT OR IGNORE INTO task_dependencies (blocker_id, blocked_id)
      VALUES (?, ?)
    `).run(blocker_id, blocked_id);

    const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(blocked_id) as Record<string, unknown>;
    res.json(enrichTask(task));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── DELETE /api/v1/tasks/:id/blockers/:blocker_id ───────────────────────────

router.delete('/:id/blockers/:blocker_id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const blocked_id = Number(req.params.id);
    const blocker_id = Number(req.params.blocker_id);

    db.prepare(`
      DELETE FROM task_dependencies WHERE blocker_id = ? AND blocked_id = ?
    `).run(blocker_id, blocked_id);

    const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(blocked_id) as Record<string, unknown> | undefined;

    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(enrichTask(task));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/tasks/:id/attachments ────────────────────────────────────────

router.get('/:id/attachments', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const taskId = Number(req.params.id);
    const attachments = db.prepare(
      'SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC'
    ).all(taskId);
    res.json(attachments);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/tasks/:id/attachments ───────────────────────────────────────

router.post('/:id/attachments', upload.single('file'), (req: Request, res: Response) => {
  try {
    const db = getDb();
    const taskId = Number(req.params.id);

    const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file provided' });

    const uploadedBy = (req.body?.uploaded_by as string) || 'system';

    const result = db.prepare(`
      INSERT INTO task_attachments (task_id, filename, filepath, mime_type, size, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(taskId, file.originalname, file.path, file.mimetype || '', file.size, uploadedBy);

    const attachment = db.prepare('SELECT * FROM task_attachments WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(attachment);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/tasks/:id/attachments/:attachmentId/download ─────────────────

router.get('/:id/attachments/:attachmentId/download', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const taskId = Number(req.params.id);
    const attachmentId = Number(req.params.attachmentId);

    const attachment = db.prepare(
      'SELECT * FROM task_attachments WHERE id = ? AND task_id = ?'
    ).get(attachmentId, taskId) as { filepath: string; filename: string; mime_type: string } | undefined;

    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
    if (!fs.existsSync(attachment.filepath)) return res.status(404).json({ error: 'File not found on disk' });

    res.setHeader('Content-Type', attachment.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${attachment.filename}"`);
    fs.createReadStream(attachment.filepath).pipe(res);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── DELETE /api/v1/tasks/:id/attachments/:attachmentId ───────────────────────

router.delete('/:id/attachments/:attachmentId', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const taskId = Number(req.params.id);
    const attachmentId = Number(req.params.attachmentId);

    const attachment = db.prepare(
      'SELECT * FROM task_attachments WHERE id = ? AND task_id = ?'
    ).get(attachmentId, taskId) as { filepath: string } | undefined;

    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

    // Remove file from disk
    try { fs.unlinkSync(attachment.filepath); } catch { /* file may already be gone */ }

    db.prepare('DELETE FROM task_attachments WHERE id = ?').run(attachmentId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/tasks/:id/instances — job runs related to a task
router.get('/:id/instances', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const taskId = Number(req.params.id);
    if (!Number.isFinite(taskId)) return res.status(400).json({ error: 'Invalid task id' });
    const instances = db.prepare(`
      SELECT ji.*, a.job_title as job_title, a.name as agent_name,
             ia.current_stage, ia.last_agent_heartbeat_at, ia.last_meaningful_output_at,
             ia.latest_commit_hash, ia.branch_name, ia.changed_files_json, ia.changed_files_count,
             ia.summary as artifact_summary, ia.blocker_reason, ia.outcome as artifact_outcome,
             ia.stale as run_is_stale, ia.stale_at,
             ji.task_outcome,
             ji.runtime_ended_at,
             ji.runtime_completed_at,
             ji.runtime_end_success,
             ji.runtime_end_error,
             ji.runtime_end_source,
             ji.lifecycle_handoff_status,
             ji.semantic_outcome_missing,
             ji.lifecycle_outcome_posted_at
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id
      LEFT JOIN instance_artifacts ia ON ia.instance_id = ji.id
      WHERE ji.task_id = ?
      ORDER BY ji.created_at DESC
      LIMIT 50
    `).all(taskId);
    return res.json(instances);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
