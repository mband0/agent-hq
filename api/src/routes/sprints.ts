import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { writeProjectAudit, diffFields, extractActor } from '../lib/projectAudit';
import { buildDispatchMessage, dispatchInstance } from '../services/dispatcher';
import { seedSprintTaskPolicy } from '../lib/sprintTaskPolicy';
import { syncStarterRoutingForSprint } from '../lib/starterSetup';
import { getAgentHqBaseUrl } from '../lib/agentHqBaseUrl';

const router = Router();

// ── Types ─────────────────────────────────────────────────────────────────────

interface Sprint {
  id: number;
  project_id: number;
  name: string;
  goal: string;
  sprint_type: string;
  workflow_template_key: string | null;
  status: 'planning' | 'active' | 'paused' | 'complete' | 'closed';
  length_kind: 'time' | 'runs';
  length_value: string;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

interface SprintWorkflowTemplateRow {
  id: number;
  sprint_type_key: string;
  key: string;
  name: string;
  description: string;
  is_default: number;
  is_system: number;
  created_at: string;
  updated_at: string;
}

interface WorkflowTemplateUsageSummary {
  total_sprints: number;
  active_planning_sprints: number;
  active_planning_sprint_ids: number[];
}

interface SprintTypeRow {
  key: string;
  name: string;
  description: string;
  is_system: number;
  created_at: string;
  updated_at: string;
}

interface TaskFieldSchemaRow {
  id: number;
  sprint_type_key: string;
  task_type: string | null;
  schema_json: string;
  is_system: number;
  created_at: string;
  updated_at: string;
}

interface SprintWorkflowStatusRow {
  id: number;
  template_id: number;
  status_key: string;
  label: string;
  color: string;
  stage_order: number;
  terminal: number;
  is_default_entry: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface SprintWorkflowTransitionRow {
  id: number;
  template_id: number;
  from_status_key: string;
  to_status_key: string;
  transition_key: string;
  label: string;
  outcome: string | null;
  stage_order: number;
  is_system: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface WorkflowTemplateInput {
  key?: unknown;
  name?: unknown;
  description?: unknown;
  is_default?: unknown;
  statuses?: unknown;
  transitions?: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse a length_value like "2w", "3d", "4h", "30m" to milliseconds. Returns null if unparseable. */
function parseLengthToMs(value: string): number | null {
  const match = /^(\d+)([wdhm])$/.exec(value.trim().toLowerCase());
  if (!match) return null;
  const n = parseInt(match[1], 10);
  switch (match[2]) {
    case 'w': return n * 7 * 24 * 60 * 60 * 1000;
    case 'd': return n * 24 * 60 * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    case 'm': return n * 60 * 1000;
    default: return null;
  }
}

function resolveSprintTypeOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return value.length > 0 ? value : null;
}

function normalizeOptionalText(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function normalizeBooleanInt(raw: unknown): number {
  return raw === true || raw === 1 || raw === '1' ? 1 : 0;
}

function normalizeConfigKey(raw: unknown, fieldName: string): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) throw new Error(`${fieldName} is required`);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
    throw new Error(`${fieldName} must use lowercase letters, numbers, underscores, or hyphens`);
  }
  return value;
}

function parseMetadataObject(raw: unknown, fieldName: string): Record<string, unknown> {
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(fieldName);
      return parsed as Record<string, unknown>;
    } catch {
      throw new Error(`${fieldName} must be a JSON object`);
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  throw new Error(`${fieldName} must be an object`);
}

function parseFieldSchema(raw: unknown): { fields: Array<Record<string, unknown>> } {
  const source = raw === undefined ? {} : raw;
  const parsed = parseMetadataObject(source, 'schema');
  const fields = Array.isArray(parsed.fields) ? parsed.fields : [];
  const normalizedFields = fields.map((field, index) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      throw new Error(`schema.fields[${index}] must be an object`);
    }
    const key = normalizeConfigKey((field as Record<string, unknown>).key, `schema.fields[${index}].key`);
    const label = normalizeOptionalText((field as Record<string, unknown>).label) || key;
    const type = normalizeOptionalText((field as Record<string, unknown>).type) || 'text';
    if (!['text', 'textarea', 'url', 'select', 'number', 'checkbox'].includes(type)) {
      throw new Error(`schema.fields[${index}].type is invalid`);
    }
    const optionsRaw = (field as Record<string, unknown>).options;
    const options = Array.isArray(optionsRaw)
      ? optionsRaw.map((option, optionIndex) => {
          const value = normalizeOptionalText(option);
          if (!value) throw new Error(`schema.fields[${index}].options[${optionIndex}] cannot be empty`);
          return value;
        })
      : undefined;
    if (type === 'select' && (!options || options.length === 0)) {
      throw new Error(`schema.fields[${index}].options is required for select fields`);
    }
    return {
      key,
      label,
      type,
      required: normalizeBooleanInt((field as Record<string, unknown>).required) === 1,
      options,
      help_text: normalizeOptionalText((field as Record<string, unknown>).help_text),
    };
  });

  const uniqueKeys = new Set<string>();
  for (const field of normalizedFields) {
    if (uniqueKeys.has(field.key as string)) throw new Error(`Duplicate field key "${field.key}" in schema`);
    uniqueKeys.add(field.key as string);
  }

  return { fields: normalizedFields };
}

function getSprintTypeOr404(db: ReturnType<typeof getDb>, sprintTypeKey: string): SprintTypeRow | null {
  return db.prepare(`
    SELECT key, name, description, is_system, created_at, updated_at
    FROM sprint_types
    WHERE key = ?
    LIMIT 1
  `).get(sprintTypeKey) as SprintTypeRow | null;
}

function getTaskTypesForSprintType(db: ReturnType<typeof getDb>, sprintTypeKey: string) {
  return db.prepare(`
    SELECT id, sprint_type_key, task_type, is_system, created_at, updated_at
    FROM sprint_type_task_types
    WHERE sprint_type_key = ?
    ORDER BY task_type ASC, id ASC
  `).all(sprintTypeKey) as Array<{
    id: number;
    sprint_type_key: string;
    task_type: string;
    is_system: number;
    created_at: string;
    updated_at: string;
  }>;
}

function getFieldSchemasForSprintType(db: ReturnType<typeof getDb>, sprintTypeKey: string) {
  const rows = db.prepare(`
    SELECT id, sprint_type_key, task_type, schema_json, is_system, created_at, updated_at
    FROM task_field_schemas
    WHERE sprint_type_key = ?
    ORDER BY CASE WHEN task_type IS NULL THEN 0 ELSE 1 END, task_type ASC, id ASC
  `).all(sprintTypeKey) as TaskFieldSchemaRow[];

  return rows.map((row) => ({
    ...row,
    schema: JSON.parse(row.schema_json || '{}'),
  }));
}

function buildWorkflowTemplateUsageSummary(
  rows: Array<{ id: number; status: string | null }>,
): WorkflowTemplateUsageSummary {
  const activePlanningSprintIds = rows
    .filter((row) => row.status === 'planning' || row.status === 'active')
    .map((row) => row.id);

  return {
    total_sprints: rows.length,
    active_planning_sprints: activePlanningSprintIds.length,
    active_planning_sprint_ids: activePlanningSprintIds,
  };
}

function getWorkflowTemplateUsageSummary(
  db: ReturnType<typeof getDb>,
  sprintTypeKey: string,
  templateKey: string,
): WorkflowTemplateUsageSummary {
  const rows = db.prepare(`
    SELECT id, status
    FROM sprints
    WHERE sprint_type = ? AND workflow_template_key = ?
    ORDER BY id ASC
  `).all(sprintTypeKey, templateKey) as Array<{ id: number; status: string | null }>;

  return buildWorkflowTemplateUsageSummary(rows);
}

function getWorkflowTemplatesDetailed(db: ReturnType<typeof getDb>, sprintTypeKey?: string) {
  const templates = sprintTypeKey
    ? db.prepare(`
        SELECT id, sprint_type_key, key, name, description, is_default, is_system, created_at, updated_at
        FROM sprint_workflow_templates
        WHERE sprint_type_key = ?
        ORDER BY sprint_type_key ASC, is_default DESC, name ASC, id ASC
      `).all(sprintTypeKey) as SprintWorkflowTemplateRow[]
    : db.prepare(`
        SELECT id, sprint_type_key, key, name, description, is_default, is_system, created_at, updated_at
        FROM sprint_workflow_templates
        ORDER BY sprint_type_key ASC, is_default DESC, name ASC, id ASC
      `).all() as SprintWorkflowTemplateRow[];

  const statusesStmt = db.prepare(`
    SELECT id, template_id, status_key, label, color, stage_order, terminal, is_default_entry, metadata_json, created_at, updated_at
    FROM sprint_workflow_statuses
    WHERE template_id = ?
    ORDER BY stage_order ASC, id ASC
  `);
  const transitionsStmt = db.prepare(`
    SELECT id, template_id, from_status_key, to_status_key, transition_key, label, outcome, stage_order, is_system, metadata_json, created_at, updated_at
    FROM sprint_workflow_transitions
    WHERE template_id = ?
    ORDER BY stage_order ASC, id ASC
  `);
  const usageStmt = db.prepare(`
    SELECT id, status
    FROM sprints
    WHERE sprint_type = ? AND workflow_template_key = ?
    ORDER BY id ASC
  `);

  return templates.map((template) => ({
    ...template,
    usage: buildWorkflowTemplateUsageSummary(usageStmt.all(template.sprint_type_key, template.key) as Array<{ id: number; status: string | null }>),
    statuses: (statusesStmt.all(template.id) as SprintWorkflowStatusRow[]).map((status) => ({
      ...status,
      metadata: JSON.parse(status.metadata_json || '{}'),
    })),
    transitions: (transitionsStmt.all(template.id) as SprintWorkflowTransitionRow[]).map((transition) => ({
      ...transition,
      metadata: JSON.parse(transition.metadata_json || '{}'),
    })),
  }));
}

function validateInUseWorkflowTemplateMutation(options: {
  existing: SprintWorkflowTemplateRow;
  payload: ReturnType<typeof validateWorkflowTemplatePayload>;
  usage: WorkflowTemplateUsageSummary;
  currentStatuses: SprintWorkflowStatusRow[];
}) {
  const { existing, payload, usage, currentStatuses } = options;
  if (usage.active_planning_sprints === 0) return;

  if (payload.key !== existing.key) {
    throw new Error(
      `Cannot change workflow template key from "${existing.key}" to "${payload.key}" while ${usage.active_planning_sprints} planning/active sprint(s) still use it. Reassign those sprints first, then retry.`,
    );
  }

  const nextStatusKeys = new Set(payload.statuses.map((status) => status.status_key));
  const missingStatusKeys = currentStatuses
    .map((status) => status.status_key)
    .filter((statusKey) => !nextStatusKeys.has(statusKey));

  if (missingStatusKeys.length > 0) {
    throw new Error(
      `Cannot rename or remove status key(s) ${missingStatusKeys.map((key) => `"${key}"`).join(', ')} while ${usage.active_planning_sprints} planning/active sprint(s) still use workflow template "${existing.key}". Add new statuses if needed, but keep existing status keys intact for live sprints.`,
    );
  }
}

function buildWorkflowConfigSnapshot(db: ReturnType<typeof getDb>) {
  const sprintTypes = db.prepare(`
    SELECT key, name, description, is_system, created_at, updated_at
    FROM sprint_types
    ORDER BY is_system DESC, name ASC, key ASC
  `).all() as SprintTypeRow[];
  const visibleSprintTypes = sprintTypes.filter((sprintType) => {
    if (!(sprintType.key === 'pm' && sprintType.is_system === 1)) return true;
    const usage = db.prepare(`
      SELECT COUNT(*) AS n
      FROM sprints
      WHERE sprint_type = ?
    `).get(sprintType.key) as { n: number };
    return (usage.n ?? 0) > 0;
  });

  return {
    sprint_types: visibleSprintTypes.map((sprintType) => ({
      ...sprintType,
      task_types: getTaskTypesForSprintType(db, sprintType.key),
      field_schemas: getFieldSchemasForSprintType(db, sprintType.key),
      workflow_templates: getWorkflowTemplatesDetailed(db, sprintType.key),
    })),
  };
}

function validateWorkflowTemplatePayload(template: WorkflowTemplateInput) {
  const key = normalizeConfigKey(template.key, 'key');
  const name = normalizeOptionalText(template.name);
  if (!name) throw new Error('name is required');
  const description = normalizeOptionalText(template.description);
  const isDefault = normalizeBooleanInt(template.is_default);
  if (!Array.isArray(template.statuses) || template.statuses.length === 0) {
    throw new Error('statuses must include at least one status');
  }

  const statuses = template.statuses.map((status, index) => {
    if (!status || typeof status !== 'object' || Array.isArray(status)) {
      throw new Error(`statuses[${index}] must be an object`);
    }
    const row = status as Record<string, unknown>;
    return {
      status_key: normalizeConfigKey(row.status_key, `statuses[${index}].status_key`),
      label: normalizeOptionalText(row.label) || normalizeConfigKey(row.status_key, `statuses[${index}].status_key`),
      color: normalizeOptionalText(row.color) || 'slate',
      stage_order: Number.isFinite(Number(row.stage_order)) ? Number(row.stage_order) : index,
      terminal: normalizeBooleanInt(row.terminal),
      is_default_entry: normalizeBooleanInt(row.is_default_entry),
      metadata: parseMetadataObject(row.metadata, `statuses[${index}].metadata`),
    };
  });

  const defaultEntries = statuses.filter((status) => status.is_default_entry === 1);
  if (defaultEntries.length !== 1) throw new Error('exactly one status must be marked as the default entry');

  const statusKeys = new Set<string>();
  for (const status of statuses) {
    if (statusKeys.has(status.status_key)) throw new Error(`Duplicate status key "${status.status_key}"`);
    statusKeys.add(status.status_key);
  }

  const transitions = Array.isArray(template.transitions) ? template.transitions.map((transition, index) => {
    if (!transition || typeof transition !== 'object' || Array.isArray(transition)) {
      throw new Error(`transitions[${index}] must be an object`);
    }
    const row = transition as Record<string, unknown>;
    const fromStatusKey = normalizeConfigKey(row.from_status_key, `transitions[${index}].from_status_key`);
    const toStatusKey = normalizeConfigKey(row.to_status_key, `transitions[${index}].to_status_key`);
    if (!statusKeys.has(fromStatusKey)) throw new Error(`Transition from_status_key "${fromStatusKey}" is not defined in statuses`);
    if (!statusKeys.has(toStatusKey)) throw new Error(`Transition to_status_key "${toStatusKey}" is not defined in statuses`);
    return {
      from_status_key: fromStatusKey,
      to_status_key: toStatusKey,
      transition_key: normalizeConfigKey(row.transition_key, `transitions[${index}].transition_key`),
      label: normalizeOptionalText(row.label) || normalizeOptionalText(row.transition_key) || `${fromStatusKey} to ${toStatusKey}`,
      outcome: normalizeOptionalText(row.outcome) || null,
      stage_order: Number.isFinite(Number(row.stage_order)) ? Number(row.stage_order) : index,
      metadata: parseMetadataObject(row.metadata, `transitions[${index}].metadata`),
    };
  }) : [];

  const transitionKeys = new Set<string>();
  const transitionPairs = new Set<string>();
  for (const transition of transitions) {
    if (transitionKeys.has(transition.transition_key)) throw new Error(`Duplicate transition key "${transition.transition_key}"`);
    transitionKeys.add(transition.transition_key);
    const pairKey = `${transition.from_status_key}=>${transition.to_status_key}`;
    if (transitionPairs.has(pairKey)) throw new Error(`Duplicate transition pair "${pairKey}"`);
    transitionPairs.add(pairKey);
  }

  return { key, name, description, is_default: isDefault, statuses, transitions };
}

function isKnownSprintType(sprintType: string): boolean {
  const db = getDb();
  const row = db.prepare(`SELECT key FROM sprint_types WHERE key = ? LIMIT 1`).get(sprintType);
  return Boolean(row);
}

function getWorkflowTemplatesForSprintType(sprintType: string, systemOnly = true): SprintWorkflowTemplateRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT id, sprint_type_key, key, name, description, is_default, is_system, created_at, updated_at
    FROM sprint_workflow_templates
    WHERE sprint_type_key = ?
      AND (? = 0 OR is_system = 1)
    ORDER BY is_default DESC, name ASC, id ASC
  `).all(sprintType, systemOnly ? 1 : 0) as SprintWorkflowTemplateRow[];
}

function resolveWorkflowTemplateKey(sprintType: string, requestedKey: unknown): { key: string | null; error: string | null } {
  const requested = typeof requestedKey === 'string' ? requestedKey.trim() : '';
  const templates = getWorkflowTemplatesForSprintType(sprintType, false);
  if (templates.length === 0) return { key: null, error: null };
  if (requested) {
    const matched = templates.find((template) => template.key === requested);
    if (!matched) {
      return { key: null, error: `Unknown workflow_template_key "${requested}" for sprint_type "${sprintType}"` };
    }
    return { key: matched.key, error: null };
  }

  const defaultTemplate = templates.find((template) => template.is_default === 1) ?? templates[0];
  return { key: defaultTemplate?.key ?? null, error: null };
}

router.get('/types/list', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintTypes = db.prepare(`
      SELECT key, name, description, is_system, created_at, updated_at
      FROM sprint_types
      ORDER BY is_system DESC, name ASC
    `).all();

    res.json(sprintTypes);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/workflow-templates', (req: Request, res: Response) => {
  try {
    const sprintType = resolveSprintTypeOrNull(req.query.sprint_type);
    const systemOnly = req.query.system_only === 'false' ? false : true;
    const db = getDb();

    const templates = sprintType
      ? getWorkflowTemplatesForSprintType(sprintType, systemOnly)
      : db.prepare(`
          SELECT id, sprint_type_key, key, name, description, is_default, is_system, created_at, updated_at
          FROM sprint_workflow_templates
          WHERE (? = 0 OR is_system = 1)
          ORDER BY sprint_type_key ASC, is_default DESC, name ASC, id ASC
        `).all(systemOnly ? 1 : 0) as SprintWorkflowTemplateRow[];

    const statusesStmt = db.prepare(`
      SELECT status_key, label, color, stage_order, terminal, is_default_entry, metadata_json, created_at, updated_at
      FROM sprint_workflow_statuses
      WHERE template_id = ?
      ORDER BY stage_order ASC, id ASC
    `);

    return res.json({
      templates: templates.map((template) => ({
        ...template,
        statuses: statusesStmt.all(template.id).map((status: any) => ({
          ...status,
          metadata: JSON.parse(status.metadata_json || '{}'),
        })),
      })),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

function completeSprint(sprintId: number): void {
  const db = getDb();
  const sprint = db.prepare('SELECT * FROM sprints WHERE id = ?').get(sprintId) as Sprint | undefined;
  if (!sprint || sprint.status === 'complete') return;

  db.prepare(`
    UPDATE sprints SET status = 'complete', ended_at = datetime('now') WHERE id = ?
  `).run(sprintId);

  // Pause all agents in this sprint
  const paused = db.prepare(`
    UPDATE agents SET enabled = 0 WHERE sprint_id = ?
  `).run(sprintId);

  // Log the completion
  db.prepare(`
    INSERT INTO logs (job_title, level, message)
    VALUES (?, 'info', ?)
  `).run(
    `Sprint: ${sprint.name}`,
    `Sprint "${sprint.name}" (id=${sprintId}) completed. ${paused.changes} job(s) paused.`
  );

  console.log(`[sprints] Sprint ${sprintId} "${sprint.name}" completed. ${paused.changes} job(s) paused.`);

  // Dispatch summary request to each agent that has a job in this sprint
  // Now reads directly from agents table which has all job-template columns
  const sprintJobs = db.prepare(`
    SELECT a.*, a.model as agent_model
    FROM agents a
    WHERE a.sprint_id = ?
  `).all(sprintId) as any[];

  for (const job of sprintJobs) {
    // Model precedence: agent-level model > gateway default
    const sprintSummaryModel = (job.agent_model ?? null) as string | null;
    console.log(
      `[sprints] Sprint summary model resolution — agent="${job.name}"` +
      ` agent.model=${job.agent_model ?? 'null'}` +
      ` effective=${sprintSummaryModel ?? 'gateway-default'}`
    );

    // Fire a one-off agentTurn to request a sprint summary
    const instanceResult = db.prepare(`
      INSERT INTO job_instances (agent_id, status) VALUES (?, 'queued')
    `).run(job.id);
    const instanceId = instanceResult.lastInsertRowid as number;

    // Build message + append minimal completion contract (no taskId for sprint summaries)
    let message = buildDispatchMessage({
      preInstructions: job.pre_instructions || '',
      sprintGoal: sprint.goal || null,
      summaryRequest: `The sprint "${sprint.name}" has ended. Please summarize: (1) what tasks you completed this sprint, (2) what tasks remain unfinished, and (3) any current blockers. Keep it concise.`,
    });
    const completionUrl = getAgentHqBaseUrl();
    message += `\n\n---\n## Atlas HQ completion contract\nWhen you have fully completed this task, report back to Atlas HQ:\ncurl -s -X PUT ${completionUrl}/api/v1/instances/${instanceId}/complete \\\n  -H "Content-Type: application/json" \\\n  -d '{"status":"done","summary":"<one sentence summary of what you accomplished>"}'\n---`;

    dispatchInstance({
      instanceId,
      agentId: job.id,
      jobTitle: `Sprint Review: ${sprint.name}`,
      sessionKey: job.session_key,
      message,
      model: sprintSummaryModel,
      hooksUrl: job.hooks_url ?? null,
      hooksAuthHeader: job.hooks_auth_header ?? null,
      runtimeType: job.runtime_type ?? null,
      runtimeConfig: job.runtime_config ?? null,
    }).catch((err: Error) => {
      console.error(`[sprints] Failed to dispatch summary for job ${job.id}:`, err.message);
    });
  }
}

// ── Sprint heartbeat: check if any active sprints have exceeded their length ──

export function checkSprintCompletion(): void {
  const db = getDb();
  const activeSprints = db.prepare(`
    SELECT * FROM sprints WHERE status = 'active'
  `).all() as Sprint[];

  for (const sprint of activeSprints) {
    if (!sprint.started_at) continue;

    if (sprint.length_kind === 'time') {
      const durationMs = parseLengthToMs(sprint.length_value);
      if (durationMs === null) continue;
      const startedMs = new Date(sprint.started_at).getTime();
      if (Date.now() >= startedMs + durationMs) {
        console.log(`[sprints] Sprint ${sprint.id} "${sprint.name}" time limit reached — completing.`);
        completeSprint(sprint.id);
      }
    } else if (sprint.length_kind === 'runs') {
      const maxRuns = parseInt(sprint.length_value, 10);
      if (isNaN(maxRuns)) continue;
      // Count total job runs for this sprint
      const row = db.prepare(`
        SELECT COUNT(*) as cnt
        FROM job_instances ji
        JOIN agents a ON a.id = ji.agent_id
        WHERE a.sprint_id = ?
          AND ji.status IN ('done', 'failed')
      `).get(sprint.id) as { cnt: number };
      if (row.cnt >= maxRuns) {
        console.log(`[sprints] Sprint ${sprint.id} "${sprint.name}" run limit reached (${row.cnt}/${maxRuns}) — completing.`);
        completeSprint(sprint.id);
      }
    }
  }
}

// ── GET /api/v1/sprints ───────────────────────────────────────────────────────

router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { project_id } = req.query;

    let query = `
      SELECT s.*,
        p.name as project_name,
        (
          SELECT COUNT(DISTINCT a2.id)
          FROM agents a2
          WHERE a2.sprint_id = s.id
        ) as agent_count,
        COUNT(DISTINCT t.id) as task_count,
        COUNT(DISTINCT CASE WHEN t.status = 'done' THEN t.id END) as tasks_done,
        COALESCE(SUM(COALESCE(t.story_points, 0)), 0) as total_story_points,
        COALESCE(SUM(CASE WHEN t.status = 'done' THEN COALESCE(t.story_points, 0) ELSE 0 END), 0) as done_story_points,
        COALESCE(SUM(CASE WHEN t.status != 'done' THEN COALESCE(t.story_points, 0) ELSE 0 END), 0) as remaining_story_points
      FROM sprints s
      LEFT JOIN projects p ON p.id = s.project_id
      LEFT JOIN tasks t ON t.sprint_id = s.id
    `;
    const params: unknown[] = [];

    const { include_closed } = req.query;
    const conditions: string[] = [];

    if (project_id) {
      conditions.push(`s.project_id = ?`);
      params.push(Number(project_id));
    }

    // By default, exclude closed sprints. Pass ?include_closed=true to see them.
    if (!include_closed || include_closed === 'false') {
      conditions.push(`s.status != 'closed'`);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ` GROUP BY s.id ORDER BY s.created_at DESC`;

    const sprints = db.prepare(query).all(...params);
    res.json(sprints);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/sprints/types/:key/task-types ────────────────────────────────

router.get('/types/:key/task-types', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });

    const sprintType = db.prepare(`
      SELECT key, name, description, is_system, created_at, updated_at
      FROM sprint_types
      WHERE key = ?
      LIMIT 1
    `).get(sprintTypeKey);

    if (!sprintType) return res.status(404).json({ error: 'Sprint type not found' });

    const taskTypes = db.prepare(`
      SELECT task_type, is_system, created_at, updated_at
      FROM sprint_type_task_types
      WHERE sprint_type_key = ?
      ORDER BY task_type ASC
    `).all(sprintTypeKey);

    return res.json({
      sprint_type: sprintType,
      task_types: taskTypes,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/sprints/types/:key/workflow ─────────────────────────────────

router.get('/types/:key/workflow', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });

    const sprintType = db.prepare(`
      SELECT key, name, description, is_system, created_at, updated_at
      FROM sprint_types
      WHERE key = ?
      LIMIT 1
    `).get(sprintTypeKey);

    if (!sprintType) return res.status(404).json({ error: 'Sprint type not found' });

    const templates = db.prepare(`
      SELECT id, key, name, description, is_default, is_system, created_at, updated_at
      FROM sprint_workflow_templates
      WHERE sprint_type_key = ?
      ORDER BY is_default DESC, name ASC, id ASC
    `).all(sprintTypeKey) as Array<Record<string, unknown>>;

    const statusesStmt = db.prepare(`
      SELECT status_key, label, color, stage_order, terminal, is_default_entry, metadata_json, created_at, updated_at
      FROM sprint_workflow_statuses
      WHERE template_id = ?
      ORDER BY stage_order ASC, id ASC
    `);

    const transitionsStmt = db.prepare(`
      SELECT from_status_key, to_status_key, transition_key, label, outcome, stage_order, is_system, metadata_json, created_at, updated_at
      FROM sprint_workflow_transitions
      WHERE template_id = ?
      ORDER BY stage_order ASC, id ASC
    `);

    const parsedTemplates = templates.map((template) => ({
      ...template,
      statuses: statusesStmt.all(template.id).map((status: any) => ({
        ...status,
        metadata: JSON.parse(status.metadata_json || '{}'),
      })),
      transitions: transitionsStmt.all(template.id).map((transition: any) => ({
        ...transition,
        metadata: JSON.parse(transition.metadata_json || '{}'),
      })),
    }));

    return res.json({
      sprint_type: sprintType,
      templates: parsedTemplates,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/sprints/config ───────────────────────────────────────────────

router.get('/config', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    return res.json(buildWorkflowConfigSnapshot(db));
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/sprints/types ───────────────────────────────────────────────

router.post('/types', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const key = normalizeConfigKey(req.body?.key, 'key');
    const name = normalizeOptionalText(req.body?.name);
    if (!name) return res.status(400).json({ error: 'name is required' });
    const description = normalizeOptionalText(req.body?.description);

    const existing = getSprintTypeOr404(db, key);
    if (existing) return res.status(409).json({ error: `Sprint type "${key}" already exists` });

    db.prepare(`
      INSERT INTO sprint_types (key, name, description, is_system, created_at, updated_at)
      VALUES (?, ?, ?, 0, datetime('now'), datetime('now'))
    `).run(key, name, description);

    return res.status(201).json(getSprintTypeOr404(db, key));
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── PUT /api/v1/sprints/types/:key ───────────────────────────────────────────

router.put('/types/:key', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    const existing = getSprintTypeOr404(db, sprintTypeKey);
    if (!existing) return res.status(404).json({ error: 'Sprint type not found' });

    const name = req.body?.name !== undefined ? normalizeOptionalText(req.body.name) : existing.name;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const description = req.body?.description !== undefined ? normalizeOptionalText(req.body.description) : existing.description;

    db.prepare(`
      UPDATE sprint_types
      SET name = ?, description = ?, updated_at = datetime('now')
      WHERE key = ?
    `).run(name, description, sprintTypeKey);

    return res.json(getSprintTypeOr404(db, sprintTypeKey));
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── DELETE /api/v1/sprints/types/:key ────────────────────────────────────────

router.delete('/types/:key', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    const existing = getSprintTypeOr404(db, sprintTypeKey);
    if (!existing) return res.status(404).json({ error: 'Sprint type not found' });

    const sprintCount = db.prepare(`
      SELECT COUNT(*) as count
      FROM sprints
      WHERE sprint_type = ?
    `).get(sprintTypeKey) as { count: number };
    if (sprintCount.count > 0) {
      return res.status(409).json({ error: `Cannot delete sprint type "${sprintTypeKey}" because ${sprintCount.count} sprint(s) still use it` });
    }

    db.prepare(`DELETE FROM sprint_types WHERE key = ?`).run(sprintTypeKey);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── PUT /api/v1/sprints/types/:key/task-types ────────────────────────────────

router.put('/types/:key/task-types', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    const sprintType = getSprintTypeOr404(db, sprintTypeKey);
    if (!sprintType) return res.status(404).json({ error: 'Sprint type not found' });

    if (!Array.isArray(req.body?.task_types)) {
      return res.status(400).json({ error: 'task_types must be an array' });
    }

    const taskTypes = req.body.task_types.map((taskType: unknown, index: number) => {
      try {
        return normalizeConfigKey(taskType, `task_types[${index}]`);
      } catch (error) {
        throw error;
      }
    });
    const dedupedTaskTypes = [...new Set(taskTypes)];

    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM sprint_type_task_types WHERE sprint_type_key = ?`).run(sprintTypeKey);
      const insertStmt = db.prepare(`
        INSERT INTO sprint_type_task_types (sprint_type_key, task_type, is_system, created_at, updated_at)
        VALUES (?, ?, 0, datetime('now'), datetime('now'))
      `);
      for (const taskType of dedupedTaskTypes) {
        insertStmt.run(sprintTypeKey, taskType);
      }
      db.prepare(`UPDATE sprint_types SET updated_at = datetime('now') WHERE key = ?`).run(sprintTypeKey);
    });
    tx();

    return res.json({
      sprint_type: sprintType,
      task_types: getTaskTypesForSprintType(db, sprintTypeKey),
    });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Field schemas CRUD ───────────────────────────────────────────────────────

router.post('/types/:key/field-schemas', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    if (!getSprintTypeOr404(db, sprintTypeKey)) return res.status(404).json({ error: 'Sprint type not found' });

    const taskType = req.body?.task_type === null || req.body?.task_type === '' || req.body?.task_type === undefined
      ? null
      : normalizeConfigKey(req.body.task_type, 'task_type');
    const schema = parseFieldSchema(req.body?.schema);

    const existing = db.prepare(`
      SELECT id FROM task_field_schemas WHERE sprint_type_key = ? AND task_type IS ?
    `).get(sprintTypeKey, taskType) as { id: number } | undefined;
    if (existing) return res.status(409).json({ error: 'A field schema for this sprint type/task type already exists' });

    const result = db.prepare(`
      INSERT INTO task_field_schemas (sprint_type_key, task_type, schema_json, is_system, created_at, updated_at)
      VALUES (?, ?, ?, 0, datetime('now'), datetime('now'))
    `).run(sprintTypeKey, taskType, JSON.stringify(schema));

    const created = db.prepare(`
      SELECT id, sprint_type_key, task_type, schema_json, is_system, created_at, updated_at
      FROM task_field_schemas
      WHERE id = ?
    `).get(Number(result.lastInsertRowid)) as TaskFieldSchemaRow;

    return res.status(201).json({
      ...created,
      schema: JSON.parse(created.schema_json || '{}'),
    });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.put('/types/:key/field-schemas/:schemaId', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    const schemaId = Number(req.params.schemaId);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    const existing = db.prepare(`
      SELECT id, sprint_type_key, task_type, schema_json, is_system, created_at, updated_at
      FROM task_field_schemas
      WHERE id = ? AND sprint_type_key = ?
    `).get(schemaId, sprintTypeKey) as TaskFieldSchemaRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Field schema not found' });

    const taskType = req.body?.task_type === null || req.body?.task_type === '' || req.body?.task_type === undefined
      ? null
      : normalizeConfigKey(req.body.task_type, 'task_type');
    const schema = req.body?.schema !== undefined ? parseFieldSchema(req.body.schema) : JSON.parse(existing.schema_json || '{}');

    const duplicate = db.prepare(`
      SELECT id FROM task_field_schemas
      WHERE sprint_type_key = ? AND task_type IS ? AND id != ?
    `).get(sprintTypeKey, taskType, schemaId) as { id: number } | undefined;
    if (duplicate) return res.status(409).json({ error: 'A field schema for this sprint type/task type already exists' });

    db.prepare(`
      UPDATE task_field_schemas
      SET task_type = ?, schema_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(taskType, JSON.stringify(schema), schemaId);

    const updated = db.prepare(`
      SELECT id, sprint_type_key, task_type, schema_json, is_system, created_at, updated_at
      FROM task_field_schemas
      WHERE id = ?
    `).get(schemaId) as TaskFieldSchemaRow;

    return res.json({
      ...updated,
      schema: JSON.parse(updated.schema_json || '{}'),
    });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete('/types/:key/field-schemas/:schemaId', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    const schemaId = Number(req.params.schemaId);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });

    const result = db.prepare(`
      DELETE FROM task_field_schemas
      WHERE id = ? AND sprint_type_key = ?
    `).run(schemaId, sprintTypeKey);

    if (result.changes === 0) return res.status(404).json({ error: 'Field schema not found' });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── Workflow template CRUD ───────────────────────────────────────────────────

router.post('/types/:key/workflow-templates', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    if (!getSprintTypeOr404(db, sprintTypeKey)) return res.status(404).json({ error: 'Sprint type not found' });

    const payload = validateWorkflowTemplatePayload(req.body ?? {});
    const existing = db.prepare(`
      SELECT id FROM sprint_workflow_templates
      WHERE sprint_type_key = ? AND key = ?
    `).get(sprintTypeKey, payload.key) as { id: number } | undefined;
    if (existing) return res.status(409).json({ error: `Workflow template "${payload.key}" already exists for sprint type "${sprintTypeKey}"` });

    const tx = db.transaction(() => {
      if (payload.is_default === 1) {
        db.prepare(`UPDATE sprint_workflow_templates SET is_default = 0, updated_at = datetime('now') WHERE sprint_type_key = ?`).run(sprintTypeKey);
      }

      const result = db.prepare(`
        INSERT INTO sprint_workflow_templates (sprint_type_key, key, name, description, is_default, is_system, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
      `).run(sprintTypeKey, payload.key, payload.name, payload.description, payload.is_default);
      const templateId = Number(result.lastInsertRowid);

      const insertStatus = db.prepare(`
        INSERT INTO sprint_workflow_statuses (template_id, status_key, label, color, stage_order, terminal, is_default_entry, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `);
      for (const status of payload.statuses) {
        insertStatus.run(templateId, status.status_key, status.label, status.color, status.stage_order, status.terminal, status.is_default_entry, JSON.stringify(status.metadata));
      }

      const insertTransition = db.prepare(`
        INSERT INTO sprint_workflow_transitions (template_id, from_status_key, to_status_key, transition_key, label, outcome, stage_order, is_system, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'), datetime('now'))
      `);
      for (const transition of payload.transitions) {
        insertTransition.run(templateId, transition.from_status_key, transition.to_status_key, transition.transition_key, transition.label, transition.outcome, transition.stage_order, JSON.stringify(transition.metadata));
      }
    });
    tx();

    const created = getWorkflowTemplatesDetailed(db, sprintTypeKey).find((template) => template.key === payload.key);
    return res.status(201).json(created);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.put('/types/:key/workflow-templates/:templateId', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    const templateId = Number(req.params.templateId);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });

    const existing = db.prepare(`
      SELECT id, sprint_type_key, key, name, description, is_default, is_system, created_at, updated_at
      FROM sprint_workflow_templates
      WHERE id = ? AND sprint_type_key = ?
    `).get(templateId, sprintTypeKey) as SprintWorkflowTemplateRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Workflow template not found' });

    const payload = validateWorkflowTemplatePayload({
      key: req.body?.key ?? existing.key,
      name: req.body?.name ?? existing.name,
      description: req.body?.description ?? existing.description,
      is_default: req.body?.is_default ?? existing.is_default,
      statuses: req.body?.statuses,
      transitions: req.body?.transitions,
    });

    const currentStatuses = db.prepare(`
      SELECT id, template_id, status_key, label, color, stage_order, terminal, is_default_entry, metadata_json, created_at, updated_at
      FROM sprint_workflow_statuses
      WHERE template_id = ?
      ORDER BY stage_order ASC, id ASC
    `).all(templateId) as SprintWorkflowStatusRow[];
    const usage = getWorkflowTemplateUsageSummary(db, sprintTypeKey, existing.key);
    validateInUseWorkflowTemplateMutation({
      existing,
      payload,
      usage,
      currentStatuses,
    });

    const duplicate = db.prepare(`
      SELECT id FROM sprint_workflow_templates
      WHERE sprint_type_key = ? AND key = ? AND id != ?
    `).get(sprintTypeKey, payload.key, templateId) as { id: number } | undefined;
    if (duplicate) return res.status(409).json({ error: `Workflow template "${payload.key}" already exists for sprint type "${sprintTypeKey}"` });

    const tx = db.transaction(() => {
      if (payload.is_default === 1) {
        db.prepare(`UPDATE sprint_workflow_templates SET is_default = 0, updated_at = datetime('now') WHERE sprint_type_key = ? AND id != ?`).run(sprintTypeKey, templateId);
      }

      db.prepare(`
        UPDATE sprint_workflow_templates
        SET key = ?, name = ?, description = ?, is_default = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(payload.key, payload.name, payload.description, payload.is_default, templateId);

      db.prepare(`DELETE FROM sprint_workflow_statuses WHERE template_id = ?`).run(templateId);
      db.prepare(`DELETE FROM sprint_workflow_transitions WHERE template_id = ?`).run(templateId);

      const insertStatus = db.prepare(`
        INSERT INTO sprint_workflow_statuses (template_id, status_key, label, color, stage_order, terminal, is_default_entry, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `);
      for (const status of payload.statuses) {
        insertStatus.run(templateId, status.status_key, status.label, status.color, status.stage_order, status.terminal, status.is_default_entry, JSON.stringify(status.metadata));
      }

      const insertTransition = db.prepare(`
        INSERT INTO sprint_workflow_transitions (template_id, from_status_key, to_status_key, transition_key, label, outcome, stage_order, is_system, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'), datetime('now'))
      `);
      for (const transition of payload.transitions) {
        insertTransition.run(templateId, transition.from_status_key, transition.to_status_key, transition.transition_key, transition.label, transition.outcome, transition.stage_order, JSON.stringify(transition.metadata));
      }
    });
    tx();

    const updated = getWorkflowTemplatesDetailed(db, sprintTypeKey).find((template) => template.id === templateId);
    return res.json(updated);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete('/types/:key/workflow-templates/:templateId', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    const templateId = Number(req.params.templateId);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });

    const existing = db.prepare(`
      SELECT id, key
      FROM sprint_workflow_templates
      WHERE id = ? AND sprint_type_key = ?
    `).get(templateId, sprintTypeKey) as { id: number; key: string } | undefined;
    if (!existing) return res.status(404).json({ error: 'Workflow template not found' });

    const sprintCount = db.prepare(`
      SELECT COUNT(*) as count
      FROM sprints
      WHERE sprint_type = ? AND workflow_template_key = ?
    `).get(sprintTypeKey, existing.key) as { count: number };
    if (sprintCount.count > 0) {
      return res.status(409).json({ error: `Cannot delete workflow template "${existing.key}" because ${sprintCount.count} sprint(s) still use it` });
    }

    const remaining = db.prepare(`
      SELECT COUNT(*) as count
      FROM sprint_workflow_templates
      WHERE sprint_type_key = ? AND id != ?
    `).get(sprintTypeKey, templateId) as { count: number };
    if (remaining.count === 0) {
      return res.status(409).json({ error: 'Each sprint type must keep at least one workflow template' });
    }

    const tx = db.transaction(() => {
      const wasDefault = db.prepare(`
        SELECT is_default FROM sprint_workflow_templates WHERE id = ?
      `).get(templateId) as { is_default: number };
      db.prepare(`DELETE FROM sprint_workflow_templates WHERE id = ?`).run(templateId);
      if (wasDefault?.is_default === 1) {
        const fallback = db.prepare(`
          SELECT id FROM sprint_workflow_templates
          WHERE sprint_type_key = ?
          ORDER BY name ASC, id ASC
          LIMIT 1
        `).get(sprintTypeKey) as { id: number } | undefined;
        if (fallback) {
          db.prepare(`UPDATE sprint_workflow_templates SET is_default = 1, updated_at = datetime('now') WHERE id = ?`).run(fallback.id);
        }
      }
    });
    tx();

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/sprints/:id ───────────────────────────────────────────────────

router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprint = db.prepare(`
      SELECT s.*,
        p.name as project_name,
        (
          SELECT COUNT(DISTINCT a2.id)
          FROM agents a2
          WHERE a2.sprint_id = s.id
        ) as agent_count,
        COUNT(DISTINCT t.id) as task_count,
        COUNT(DISTINCT CASE WHEN t.status = 'done' THEN t.id END) as tasks_done,
        COALESCE(SUM(COALESCE(t.story_points, 0)), 0) as total_story_points,
        COALESCE(SUM(CASE WHEN t.status = 'done' THEN COALESCE(t.story_points, 0) ELSE 0 END), 0) as done_story_points,
        COALESCE(SUM(CASE WHEN t.status != 'done' THEN COALESCE(t.story_points, 0) ELSE 0 END), 0) as remaining_story_points
      FROM sprints s
      LEFT JOIN projects p ON p.id = s.project_id
      LEFT JOIN tasks t ON t.sprint_id = s.id
      WHERE s.id = ?
      GROUP BY s.id
    `).get(Number(req.params.id));

    if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
    return res.json(sprint);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/sprints ──────────────────────────────────────────────────────

router.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const {
      project_id,
      name,
      goal = '',
      sprint_type,
      workflow_template_key,
      status = 'planning',
      length_kind = 'time',
      length_value = '',
      started_at,
    } = req.body as Partial<Sprint>;

    if (!project_id) return res.status(400).json({ error: 'project_id is required' });
    if (!name) return res.status(400).json({ error: 'name is required' });

    const resolvedSprintType = resolveSprintTypeOrNull(sprint_type) ?? 'generic';
    if (!isKnownSprintType(resolvedSprintType)) {
      return res.status(400).json({ error: `Unknown sprint_type "${resolvedSprintType}"` });
    }

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const resolvedWorkflowTemplate = resolveWorkflowTemplateKey(resolvedSprintType, workflow_template_key);
    if (resolvedWorkflowTemplate.error) return res.status(400).json({ error: resolvedWorkflowTemplate.error });

    const result = db.prepare(`
      INSERT INTO sprints (project_id, name, goal, sprint_type, workflow_template_key, status, length_kind, length_value, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(project_id, name, goal, resolvedSprintType, resolvedWorkflowTemplate.key, status, length_kind, length_value, started_at ?? null);

    const newId = Number(result.lastInsertRowid);
    seedSprintTaskPolicy(db, newId);
    syncStarterRoutingForSprint(db, newId);
    const actor = extractActor(req);
    writeProjectAudit(db, project_id, 'sprint', newId, 'created', actor, {
      name,
      goal,
      sprint_type: resolvedSprintType,
      workflow_template_key: resolvedWorkflowTemplate.key,
      status,
      length_kind,
      length_value,
    });

    const sprint = db.prepare(`
      SELECT s.*, p.name as project_name,
        0 as agent_count, 0 as task_count, 0 as tasks_done,
        0 as total_story_points, 0 as done_story_points, 0 as remaining_story_points
      FROM sprints s
      LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.id = ?
    `).get(newId);

    return res.status(201).json(sprint);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── PUT /api/v1/sprints/:id ───────────────────────────────────────────────────

router.put('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM sprints WHERE id = ?').get(id) as Sprint | undefined;
    if (!existing) return res.status(404).json({ error: 'Sprint not found' });

    const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
    const allowedFields = new Set([
      'project_id',
      'name',
      'goal',
      'sprint_type',
      'workflow_template_key',
      'status',
      'length_kind',
      'length_value',
      'started_at',
      'ended_at',
    ]);
    const unsupportedFields = Object.keys(body).filter((key) => !allowedFields.has(key));
    if (unsupportedFields.length > 0) {
      return res.status(400).json({
        error: `Unsupported sprint update field(s): ${unsupportedFields.join(', ')}`,
        code: 'unsupported_sprint_update_fields',
        unsupported_fields: unsupportedFields,
        allowed_fields: Array.from(allowedFields),
      });
    }

    const {
      project_id,
      name,
      goal,
      sprint_type,
      workflow_template_key,
      status,
      length_kind,
      length_value,
      started_at,
      ended_at,
    } = body as Partial<Sprint>;

    const resolvedSprintType = sprint_type !== undefined
      ? resolveSprintTypeOrNull(sprint_type)
      : existing.sprint_type;

    if (!resolvedSprintType) {
      return res.status(400).json({ error: 'sprint_type cannot be empty' });
    }
    if (!isKnownSprintType(resolvedSprintType)) {
      return res.status(400).json({ error: `Unknown sprint_type "${resolvedSprintType}"` });
    }

    const resolvedWorkflowTemplate = resolveWorkflowTemplateKey(
      resolvedSprintType,
      workflow_template_key !== undefined ? workflow_template_key : existing.workflow_template_key,
    );
    if (resolvedWorkflowTemplate.error) {
      return res.status(400).json({ error: resolvedWorkflowTemplate.error });
    }

    const requestedProjectId = project_id !== undefined ? Number(project_id) : existing.project_id;
    if (!Number.isInteger(requestedProjectId) || requestedProjectId <= 0) {
      return res.status(400).json({ error: 'project_id must be a positive integer when provided' });
    }

    const targetProject = db.prepare('SELECT id FROM projects WHERE id = ?').get(requestedProjectId);
    if (!targetProject) {
      return res.status(400).json({ error: `Project ${requestedProjectId} does not exist` });
    }

    const newValues = {
      project_id: requestedProjectId,
      name: name ?? existing.name,
      goal: goal !== undefined ? goal : existing.goal,
      sprint_type: resolvedSprintType,
      workflow_template_key: resolvedWorkflowTemplate.key,
      status: status ?? existing.status,
      length_kind: length_kind ?? existing.length_kind,
      length_value: length_value !== undefined ? length_value : existing.length_value,
      started_at: started_at !== undefined ? started_at : existing.started_at,
      ended_at: ended_at !== undefined ? ended_at : existing.ended_at,
    };

    db.prepare(`
      UPDATE sprints SET
        project_id = ?,
        name = ?,
        goal = ?,
        sprint_type = ?,
        workflow_template_key = ?,
        status = ?,
        length_kind = ?,
        length_value = ?,
        started_at = ?,
        ended_at = ?
      WHERE id = ?
    `).run(
      newValues.project_id,
      newValues.name, newValues.goal, newValues.sprint_type, newValues.workflow_template_key, newValues.status,
      newValues.length_kind, newValues.length_value,
      newValues.started_at, newValues.ended_at, id
    );
    seedSprintTaskPolicy(db, id);
    syncStarterRoutingForSprint(db, id);

    const changes = diffFields(
      {
        name: existing.name,
        goal: existing.goal,
        sprint_type: existing.sprint_type,
        workflow_template_key: existing.workflow_template_key,
        status: existing.status,
        length_kind: existing.length_kind,
        length_value: existing.length_value,
        project_id: existing.project_id,
      },
      {
        name: newValues.name,
        goal: newValues.goal,
        sprint_type: newValues.sprint_type,
        workflow_template_key: newValues.workflow_template_key,
        status: newValues.status,
        length_kind: newValues.length_kind,
        length_value: newValues.length_value,
        project_id: newValues.project_id,
      },
    );
    if (Object.keys(changes).length > 0) {
      const actor = extractActor(req);
      writeProjectAudit(db, newValues.project_id, 'sprint', id, 'updated', actor, changes);
    }

    const updated = db.prepare(`
      SELECT s.*,
        p.name as project_name,
        COUNT(DISTINCT ag.id) as agent_count,
        COUNT(DISTINCT t.id) as task_count,
        COUNT(DISTINCT CASE WHEN t.status = 'done' THEN t.id END) as tasks_done,
        COALESCE(SUM(COALESCE(t.story_points, 0)), 0) as total_story_points,
        COALESCE(SUM(CASE WHEN t.status = 'done' THEN COALESCE(t.story_points, 0) ELSE 0 END), 0) as done_story_points,
        COALESCE(SUM(CASE WHEN t.status != 'done' THEN COALESCE(t.story_points, 0) ELSE 0 END), 0) as remaining_story_points
      FROM sprints s
      LEFT JOIN projects p ON p.id = s.project_id
      LEFT JOIN agents ag ON ag.sprint_id = s.id
      LEFT JOIN tasks t ON t.sprint_id = s.id
      WHERE s.id = ?
      GROUP BY s.id
    `).get(id);

    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── DELETE /api/v1/sprints/:id ────────────────────────────────────────────────

router.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const sprint = db.prepare('SELECT * FROM sprints WHERE id = ?').get(id) as Sprint | undefined;
    if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
    const actor = extractActor(req);
    writeProjectAudit(db, sprint.project_id, 'sprint', id, 'deleted', actor, {
      name: sprint.name, status: sprint.status,
    });
    db.prepare('DELETE FROM sprints WHERE id = ?').run(id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/sprints/:id/close ───────────────────────────────────────────

router.post('/:id/close', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const sprint = db.prepare('SELECT * FROM sprints WHERE id = ?').get(id) as Sprint | undefined;
    if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
    if (sprint.status === 'closed') {
      const updated = db.prepare('SELECT * FROM sprints WHERE id = ?').get(id);
      return res.json(updated);
    }

    const oldStatus = sprint.status;
    db.prepare(`
      UPDATE sprints SET status = 'closed', ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ?
    `).run(id);

    const actor = extractActor(req);
    writeProjectAudit(db, sprint.project_id, 'sprint', id, 'updated', actor, {
      status: { old: oldStatus, new: 'closed' },
    });

    db.prepare(`
      INSERT INTO logs (job_title, level, message)
      VALUES (?, 'info', ?)
    `).run(
      `Sprint: ${sprint.name}`,
      `Sprint "${sprint.name}" (id=${id}) closed manually.`
    );

    console.log(`[sprints] Sprint ${id} "${sprint.name}" closed.`);
    const updated = db.prepare('SELECT * FROM sprints WHERE id = ?').get(id);
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/sprints/:id/complete ────────────────────────────────────────

router.post('/:id/complete', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const sprint = db.prepare('SELECT id FROM sprints WHERE id = ?').get(id);
    if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
    completeSprint(id);
    const updated = db.prepare('SELECT * FROM sprints WHERE id = ?').get(id);
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/sprints/:id/metrics ──────────────────────────────────────────

router.get('/:id/metrics', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const sprint = db.prepare('SELECT id FROM sprints WHERE id = ?').get(id);
    if (!sprint) return res.status(404).json({ error: 'Sprint not found' });

    // Task metrics
    const taskRow = db.prepare(`
      SELECT
        COUNT(*) as tasks_total,
        COUNT(CASE WHEN status = 'done' THEN 1 END) as tasks_done,
        COALESCE(SUM(COALESCE(story_points, 0)), 0) as total_story_points,
        COALESCE(SUM(CASE WHEN status = 'done' THEN COALESCE(story_points, 0) ELSE 0 END), 0) as done_story_points,
        COALESCE(SUM(CASE WHEN status != 'done' THEN COALESCE(story_points, 0) ELSE 0 END), 0) as remaining_story_points
      FROM tasks
      WHERE sprint_id = ?
    `).get(id) as { tasks_total: number; tasks_done: number; total_story_points: number; done_story_points: number; remaining_story_points: number };

    // Blocker count: tasks with at least one active (non-done) blocker, within this sprint
    const blockerRow = db.prepare(`
      SELECT COUNT(DISTINCT td.blocked_id) as blocker_count
      FROM task_dependencies td
      JOIN tasks blocked ON blocked.id = td.blocked_id
      JOIN tasks blocker ON blocker.id = td.blocker_id
      WHERE blocked.sprint_id = ?
        AND blocker.status != 'done'
    `).get(id) as { blocker_count: number };

    // Avg task duration: from created_at to updated_at for done tasks in this sprint
    const durationRow = db.prepare(`
      SELECT AVG(
        (strftime('%s', updated_at) - strftime('%s', created_at)) * 1000
      ) as avg_ms
      FROM tasks
      WHERE sprint_id = ? AND status = 'done'
    `).get(id) as { avg_ms: number | null };

    // Job run metrics
    const runRow = db.prepare(`
      SELECT
        COUNT(*) as job_runs_total,
        COUNT(CASE WHEN ji.status = 'done' THEN 1 END) as job_runs_success,
        COUNT(CASE WHEN ji.status = 'failed' THEN 1 END) as job_runs_failed
      FROM job_instances ji
      JOIN agents a ON a.id = ji.agent_id
      WHERE a.sprint_id = ?
    `).get(id) as { job_runs_total: number; job_runs_success: number; job_runs_failed: number };

    const tasks_total = taskRow.tasks_total ?? 0;
    const tasks_done = taskRow.tasks_done ?? 0;
    const completion_rate = tasks_total > 0 ? Math.round((tasks_done / tasks_total) * 100) : 0;
    const job_runs_total = runRow.job_runs_total ?? 0;
    const job_runs_success = runRow.job_runs_success ?? 0;
    const job_runs_failed = runRow.job_runs_failed ?? 0;
    const success_rate = job_runs_total > 0
      ? Math.round((job_runs_success / job_runs_total) * 1000) / 10
      : 0;

    return res.json({
      sprint_id: id,
      tasks_total,
      tasks_done,
      completion_rate,
      total_story_points: taskRow.total_story_points ?? 0,
      done_story_points: taskRow.done_story_points ?? 0,
      remaining_story_points: taskRow.remaining_story_points ?? 0,
      job_runs_total,
      job_runs_success,
      job_runs_failed,
      success_rate,
      blocker_count: blockerRow.blocker_count ?? 0,
      avg_task_duration_ms: Math.round(durationRow.avg_ms ?? 0),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/sprints/:id/jobs ─────────────────────────────────────────────

router.get('/:id/jobs', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const sprint = db.prepare('SELECT id FROM sprints WHERE id = ?').get(id);
    if (!sprint) return res.status(404).json({ error: 'Sprint not found' });

    // Task #596: Read from agents table directly — sprint_job_schedules/assignments removed
    const jobs = db.prepare(`
      SELECT a.*,
        a.name as agent_name,
        a.session_key as agent_session_key,
        a.job_title as title,
        COUNT(ji.id) as run_count,
        COUNT(CASE WHEN ji.status = 'done' THEN 1 END) as run_success,
        COUNT(CASE WHEN ji.status = 'failed' THEN 1 END) as run_failed,
        CASE WHEN a.sprint_id = ? THEN 1 ELSE 0 END as is_primary_sprint
      FROM agents a
      LEFT JOIN job_instances ji ON ji.agent_id = a.id
      WHERE a.sprint_id = ?
      GROUP BY a.id
      ORDER BY a.created_at DESC
    `).all(id, id);

    return res.json(jobs);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/sprints/:id/jobs ────────────────────────────────────────────
// Task #596: sprint_job_assignments table removed. Assign agents to sprints via agents.sprint_id.
router.post('/:id/jobs', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprint_id = Number(req.params.id);
    const { job_id } = req.body as { job_id?: number };

    const sprint = db.prepare('SELECT id FROM sprints WHERE id = ?').get(sprint_id);
    if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
    if (!job_id) return res.status(400).json({ error: 'job_id is required' });

    // job_id now maps to agents.id — set agent's sprint_id directly
    const job = db.prepare('SELECT id FROM agents WHERE id = ?').get(job_id);
    if (!job) return res.status(404).json({ error: 'Agent/job not found' });

    db.prepare(`UPDATE agents SET sprint_id = ? WHERE id = ?`).run(sprint_id, job_id);

    const attached = db.prepare(`
      SELECT a.*, a.name as agent_name, a.session_key as agent_session_key,
             a.job_title as title,
             CASE WHEN a.sprint_id = ? THEN 1 ELSE 0 END as is_primary_sprint
      FROM agents a
      WHERE a.id = ?
    `).get(sprint_id, job_id);

    return res.status(201).json(attached);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── DELETE /api/v1/sprints/:id/jobs/:jobId ───────────────────────────────────
// Task #596: sprint_job_assignments table removed. Unlink agent from sprint via agents.sprint_id.
router.delete('/:id/jobs/:jobId', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprint_id = Number(req.params.id);
    const job_id = Number(req.params.jobId);
    // Only clear sprint_id if the agent is actually assigned to this sprint
    db.prepare('UPDATE agents SET sprint_id = NULL WHERE id = ? AND sprint_id = ?').run(job_id, sprint_id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/sprints/:id/schedules ────────────────────────────────────────
// Task #596: sprint_job_schedules table removed. Return empty array for backward compat.
router.get('/:id/schedules', (_req: Request, res: Response) => {
  return res.json([]);
});

// ── POST /api/v1/sprints/:id/schedules ───────────────────────────────────────
// Task #596: sprint_job_schedules table removed.
router.post('/:id/schedules', (_req: Request, res: Response) => {
  return res.status(410).json({ error: 'Sprint job schedules have been removed (task #596). Use agent-level scheduling instead.' });
});

// ── DELETE /api/v1/sprints/:id/schedules/:scheduleId ─────────────────────────
// Task #596: sprint_job_schedules table removed.
router.delete('/:id/schedules/:scheduleId', (_req: Request, res: Response) => {
  return res.status(410).json({ error: 'Sprint job schedules have been removed (task #596).' });
});

export default router;
