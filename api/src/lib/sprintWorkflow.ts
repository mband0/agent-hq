import Database from 'better-sqlite3';

export interface ResolvedSprintWorkflowStatus {
  statusName: string;
  isVisibleOnBoard: boolean;
  columnOrder: number;
}

export interface ResolvedSprintWorkflowTransition {
  fromStatus: string;
  outcome: string;
  toStatus: string;
  taskType: string | null;
  priority: number;
  isProtected: boolean;
}

export interface ResolvedSprintWorkflow {
  sprintId: number | null;
  sprintType: string | null;
  workflowTemplateKey: string | null;
  statuses: ResolvedSprintWorkflowStatus[];
  transitions: ResolvedSprintWorkflowTransition[];
}

interface WorkflowTemplateRow {
  id: number;
  key: string;
}

const LEGACY_FALLBACK_TRANSITIONS: ResolvedSprintWorkflowTransition[] = [
  { fromStatus: 'in_progress', outcome: 'completed_for_review', toStatus: 'review', taskType: null, priority: 0, isProtected: true },
  { fromStatus: 'in_progress', outcome: 'blocked', toStatus: 'blocked', taskType: null, priority: 0, isProtected: false },
  { fromStatus: 'in_progress', outcome: 'failed', toStatus: 'failed', taskType: null, priority: 0, isProtected: false },
  { fromStatus: 'review', outcome: 'qa_pass', toStatus: 'qa_pass', taskType: null, priority: 0, isProtected: true },
  { fromStatus: 'review', outcome: 'qa_fail', toStatus: 'ready', taskType: null, priority: 0, isProtected: false },
  { fromStatus: 'review', outcome: 'blocked', toStatus: 'blocked', taskType: null, priority: 0, isProtected: false },
  { fromStatus: 'review', outcome: 'failed', toStatus: 'failed', taskType: null, priority: 0, isProtected: false },
  { fromStatus: 'qa_pass', outcome: 'approved_for_merge', toStatus: 'ready_to_merge', taskType: null, priority: 0, isProtected: true },
  { fromStatus: 'qa_pass', outcome: 'qa_fail', toStatus: 'ready', taskType: null, priority: 0, isProtected: false },
  { fromStatus: 'qa_pass', outcome: 'failed', toStatus: 'failed', taskType: null, priority: 0, isProtected: false },
  { fromStatus: 'ready_to_merge', outcome: 'deployed_live', toStatus: 'deployed', taskType: null, priority: 0, isProtected: true },
  { fromStatus: 'ready_to_merge', outcome: 'qa_fail', toStatus: 'ready', taskType: null, priority: 0, isProtected: false },
  { fromStatus: 'ready_to_merge', outcome: 'failed', toStatus: 'failed', taskType: null, priority: 0, isProtected: false },
  { fromStatus: 'deployed', outcome: 'live_verified', toStatus: 'done', taskType: null, priority: 0, isProtected: true },
  { fromStatus: 'deployed', outcome: 'qa_fail', toStatus: 'ready', taskType: null, priority: 0, isProtected: false },
  { fromStatus: 'deployed', outcome: 'failed', toStatus: 'failed', taskType: null, priority: 0, isProtected: false },
  { fromStatus: 'stalled', outcome: 'retry', toStatus: 'ready', taskType: null, priority: 0, isProtected: false },
];

const LEGACY_FALLBACK_STATUSES: ResolvedSprintWorkflowStatus[] = [
  'todo',
  'ready',
  'dispatched',
  'in_progress',
  'review',
  'qa_pass',
  'ready_to_merge',
  'deployed',
  'done',
  'needs_attention',
  'stalled',
  'cancelled',
  'failed',
].map((statusName, columnOrder) => ({ statusName, isVisibleOnBoard: true, columnOrder }));

function normalizeSprintType(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized.length > 0 ? normalized : null;
}

function parseMetadataJson(value: string | null | undefined): Record<string, unknown> {
  if (typeof value !== 'string' || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function toOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function resolveSprintType(db: Database.Database, sprintId: number | null | undefined): string | null {
  if (typeof sprintId !== 'number' || !Number.isFinite(sprintId)) return null;

  try {
    const sprint = db.prepare(`
      SELECT sprint_type
      FROM sprints
      WHERE id = ?
      LIMIT 1
    `).get(sprintId) as { sprint_type: string | null } | undefined;
    return normalizeSprintType(sprint?.sprint_type);
  } catch {
    return null;
  }
}

function loadWorkflowTemplate(db: Database.Database, sprintType: string | null): WorkflowTemplateRow | null {
  const sprintTypesToTry = [
    sprintType,
    sprintType === 'generic' ? null : 'generic',
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

  try {
    const lookupBySprintType = db.prepare(`
      SELECT id, key
      FROM sprint_workflow_templates
      WHERE sprint_type_key = ?
      ORDER BY is_default DESC, id ASC
      LIMIT 1
    `);

    for (const sprintTypeKey of sprintTypesToTry) {
      const template = lookupBySprintType.get(sprintTypeKey) as WorkflowTemplateRow | undefined;
      if (template) return template;
    }

    const genericDefault = db.prepare(`
      SELECT id, key
      FROM sprint_workflow_templates
      ORDER BY CASE WHEN sprint_type_key = 'generic' THEN 0 ELSE 1 END, is_default DESC, id ASC
      LIMIT 1
    `).get() as WorkflowTemplateRow | undefined;

    return genericDefault ?? null;
  } catch {
    return null;
  }
}

function loadStatuses(db: Database.Database, templateId: number | null): ResolvedSprintWorkflowStatus[] {
  if (typeof templateId !== 'number' || !Number.isFinite(templateId)) return LEGACY_FALLBACK_STATUSES;

  try {
    const rows = db.prepare(`
      SELECT status_key, stage_order, metadata_json
      FROM sprint_workflow_statuses
      WHERE template_id = ?
      ORDER BY stage_order ASC, id ASC
    `).all(templateId) as Array<{
      status_key: string | null;
      stage_order?: number | null;
      metadata_json?: string | null;
    }>;

    const statuses = rows
      .map((row, index) => {
        const metadata = parseMetadataJson(row.metadata_json);
        return {
          statusName: typeof row.status_key === 'string' ? row.status_key.trim() : '',
          isVisibleOnBoard: metadata.is_visible_on_board === false || metadata.isVisibleOnBoard === false ? false : true,
          columnOrder: typeof row.stage_order === 'number' ? row.stage_order : index,
        };
      })
      .filter((row): row is ResolvedSprintWorkflowStatus => row.statusName.length > 0);

    return statuses.length > 0 ? statuses : LEGACY_FALLBACK_STATUSES;
  } catch {
    return LEGACY_FALLBACK_STATUSES;
  }
}

function loadTemplateTransitions(db: Database.Database, templateId: number | null): ResolvedSprintWorkflowTransition[] {
  if (typeof templateId !== 'number' || !Number.isFinite(templateId)) return [];

  try {
    const rows = db.prepare(`
      SELECT from_status_key, outcome, to_status_key, stage_order, metadata_json
      FROM sprint_workflow_transitions
      WHERE template_id = ?
      ORDER BY stage_order ASC, id ASC
    `).all(templateId) as Array<{
      from_status_key: string | null;
      outcome?: string | null;
      to_status_key: string | null;
      stage_order?: number | null;
      metadata_json?: string | null;
    }>;

    return rows
      .map((row) => {
        const metadata = parseMetadataJson(row.metadata_json);
        return {
          fromStatus: typeof row.from_status_key === 'string' ? row.from_status_key.trim() : '',
          outcome: typeof row.outcome === 'string' ? row.outcome.trim() : '',
          toStatus: typeof row.to_status_key === 'string' ? row.to_status_key.trim() : '',
          taskType: toOptionalString(metadata.task_type ?? metadata.taskType),
          priority: toNumber(metadata.priority, typeof row.stage_order === 'number' ? row.stage_order : 0),
          isProtected: metadata.is_protected === true || metadata.isProtected === true,
        };
      })
      .filter((row): row is ResolvedSprintWorkflowTransition => (
        row.fromStatus.length > 0 && row.outcome.length > 0 && row.toStatus.length > 0
      ));
  } catch {
    return [];
  }
}

function loadProtectedLegacyTransitions(
  db: Database.Database,
  statuses: ResolvedSprintWorkflowStatus[],
): ResolvedSprintWorkflowTransition[] {
  if (statuses.length === 0) return [];

  const statusSet = new Set(statuses.map((status) => status.statusName));
  const includesReleaseStatuses = ['review', 'qa_pass', 'ready_to_merge', 'deployed', 'done'].some((status) => statusSet.has(status));
  if (!includesReleaseStatuses) return [];

  try {
    const rows = db.prepare(`
      SELECT from_status, outcome, to_status, task_type, priority, is_protected
      FROM routing_transitions
      WHERE project_id IS NULL
        AND COALESCE(is_protected, 0) = 1
      ORDER BY priority DESC, id ASC
    `).all() as Array<{
      from_status: string | null;
      outcome: string | null;
      to_status: string | null;
      task_type?: string | null;
      priority?: number | null;
      is_protected?: number | null;
    }>;

    return rows
      .map((row) => ({
        fromStatus: typeof row.from_status === 'string' ? row.from_status.trim() : '',
        outcome: typeof row.outcome === 'string' ? row.outcome.trim() : '',
        toStatus: typeof row.to_status === 'string' ? row.to_status.trim() : '',
        taskType: typeof row.task_type === 'string' && row.task_type.trim().length > 0 ? row.task_type.trim() : null,
        priority: typeof row.priority === 'number' ? row.priority : 0,
        isProtected: Boolean(row.is_protected),
      }))
      .filter((row): row is ResolvedSprintWorkflowTransition => (
        row.fromStatus.length > 0
        && row.outcome.length > 0
        && row.toStatus.length > 0
        && statusSet.has(row.fromStatus)
        && statusSet.has(row.toStatus)
      ));
  } catch {
    return [];
  }
}

function dedupeTransitions(transitions: ResolvedSprintWorkflowTransition[]): ResolvedSprintWorkflowTransition[] {
  const seen = new Set<string>();
  const deduped: ResolvedSprintWorkflowTransition[] = [];

  for (const transition of transitions) {
    const key = [transition.fromStatus, transition.outcome, transition.toStatus, transition.taskType ?? '', transition.priority].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(transition);
  }

  return deduped;
}

export function resolveSprintWorkflow(
  db: Database.Database,
  sprintId?: number | null,
  sprintTypeHint?: string | null,
): ResolvedSprintWorkflow {
  const resolvedSprintType = resolveSprintType(db, sprintId ?? null) ?? normalizeSprintType(sprintTypeHint) ?? 'generic';
  const template = loadWorkflowTemplate(db, resolvedSprintType);
  const statuses = loadStatuses(db, template?.id ?? null);
  const templateTransitions = loadTemplateTransitions(db, template?.id ?? null);
  const protectedLegacyTransitions = loadProtectedLegacyTransitions(db, statuses);

  return {
    sprintId: typeof sprintId === 'number' && Number.isFinite(sprintId) ? sprintId : null,
    sprintType: resolvedSprintType,
    workflowTemplateKey: template?.key ?? null,
    statuses,
    transitions: dedupeTransitions([...templateTransitions, ...protectedLegacyTransitions]),
  };
}
