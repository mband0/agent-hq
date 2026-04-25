import type Database from 'better-sqlite3';

export interface SprintTaskStatusMeta {
  name: string;
  label: string;
  color: string;
  terminal: boolean;
  is_system: boolean;
  allowed_transitions: string[];
}

export interface SprintTaskTransitionRow {
  id: number;
  sprint_id: number;
  task_type: string | null;
  from_status: string;
  outcome: string;
  to_status: string;
  lane: string;
  enabled: number;
  priority: number;
  is_protected: number;
  created_at?: string;
  updated_at?: string;
}

export interface SprintTaskTransitionRequirementRow {
  id: number;
  sprint_id: number;
  task_type: string | null;
  outcome: string;
  field_name: string;
  requirement_type: string;
  match_field: string | null;
  severity: string;
  message: string;
  enabled: number;
  priority: number;
  created_at?: string;
  updated_at?: string;
}

export interface SprintTaskRoutingRuleRow {
  id: number;
  sprint_id: number;
  task_type: string;
  status: string;
  agent_id: number | null;
  priority: number;
  is_system?: number;
  created_at?: string;
  updated_at?: string;
}

type SprintSeedRow = {
  id: number;
  project_id: number | null;
};

function tableExists(db: Database.Database, tableName: string): boolean {
  try {
    const row = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
      LIMIT 1
    `).get(tableName) as { name?: string } | undefined;
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function getSprintSeedRow(db: Database.Database, sprintId: number): SprintSeedRow | null {
  try {
    return db.prepare(`
      SELECT id, project_id
      FROM sprints
      WHERE id = ?
      LIMIT 1
    `).get(sprintId) as SprintSeedRow | undefined ?? null;
  } catch {
    return null;
  }
}

export function seedSprintTaskPolicy(
  db: Database.Database,
  sprintId: number,
  options?: { force?: boolean },
): void {
  if (!Number.isFinite(sprintId)) return;
  if (!tableExists(db, 'sprint_task_statuses')) return;

  const sprint = getSprintSeedRow(db, sprintId);
  if (!sprint) return;

  const force = options?.force === true;
  const statusCount = (db.prepare(`SELECT COUNT(*) AS n FROM sprint_task_statuses WHERE sprint_id = ?`).get(sprintId) as { n: number }).n;
  const transitionCount = (db.prepare(`SELECT COUNT(*) AS n FROM sprint_task_transitions WHERE sprint_id = ?`).get(sprintId) as { n: number }).n;
  const requirementCount = (db.prepare(`SELECT COUNT(*) AS n FROM sprint_task_transition_requirements WHERE sprint_id = ?`).get(sprintId) as { n: number }).n;
  const routingRuleCount = (db.prepare(`SELECT COUNT(*) AS n FROM sprint_task_routing_rules WHERE sprint_id = ?`).get(sprintId) as { n: number }).n;

  if (!force && statusCount > 0 && transitionCount > 0 && requirementCount > 0 && routingRuleCount > 0) {
    return;
  }

  const loadLegacyStatuses = (): Array<{
    name: string;
    label: string;
    color: string;
    terminal: number;
    is_system: number;
    allowed_transitions: string;
  }> => {
    if (!tableExists(db, 'task_statuses')) return [];
    return db.prepare(`
      SELECT name, label, color, terminal, is_system, allowed_transitions
      FROM task_statuses
      ORDER BY terminal ASC, name ASC
    `).all() as Array<{
      name: string;
      label: string;
      color: string;
      terminal: number;
      is_system: number;
      allowed_transitions: string;
    }>;
  };

  const loadLegacyTransitions = (): Array<{
    task_type: string | null;
    from_status: string;
    outcome: string;
    to_status: string;
    lane: string;
    enabled: number;
    priority: number;
    is_protected?: number | null;
  }> => {
    if (!tableExists(db, 'routing_transitions')) return [];
    return db.prepare(`
      SELECT task_type, from_status, outcome, to_status, lane, enabled,
             COALESCE(priority, 0) AS priority,
             COALESCE(is_protected, 0) AS is_protected
      FROM routing_transitions
      WHERE project_id IS NULL OR project_id = ?
      ORDER BY CASE WHEN project_id = ? THEN 0 ELSE 1 END, priority DESC, id ASC
    `).all(sprint.project_id, sprint.project_id) as Array<{
      task_type: string | null;
      from_status: string;
      outcome: string;
      to_status: string;
      lane: string;
      enabled: number;
      priority: number;
      is_protected?: number | null;
    }>;
  };

  const loadLegacyRequirements = (): Array<{
    task_type: string | null;
    outcome: string;
    field_name: string;
    requirement_type: string;
    match_field: string | null;
    severity: string;
    message: string;
    enabled: number;
    priority: number;
  }> => {
    if (!tableExists(db, 'transition_requirements')) return [];
    return db.prepare(`
      SELECT task_type, outcome, field_name, requirement_type, match_field, severity, message,
             enabled, COALESCE(priority, 0) AS priority
      FROM transition_requirements
      ORDER BY outcome ASC, priority DESC, id ASC
    `).all() as Array<{
      task_type: string | null;
      outcome: string;
      field_name: string;
      requirement_type: string;
      match_field: string | null;
      severity: string;
      message: string;
      enabled: number;
      priority: number;
    }>;
  };

  const tx = db.transaction(() => {
    if (force || statusCount === 0) {
      db.prepare(`DELETE FROM sprint_task_statuses WHERE sprint_id = ?`).run(sprintId);
      const insert = db.prepare(`
        INSERT INTO sprint_task_statuses (
          sprint_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', datetime('now'), datetime('now'))
      `);
      const legacyStatuses = loadLegacyStatuses();
      legacyStatuses.forEach((row, index) => {
        insert.run(
          sprintId,
          row.name,
          row.label,
          row.color,
          row.terminal ? 1 : 0,
          row.is_system ? 1 : 0,
          row.allowed_transitions ?? '[]',
          index,
          index === 0 ? 1 : 0,
        );
      });
    }

    if (force || transitionCount === 0) {
      db.prepare(`DELETE FROM sprint_task_transitions WHERE sprint_id = ?`).run(sprintId);
      const insert = db.prepare(`
        INSERT INTO sprint_task_transitions (
          sprint_id, task_type, from_status, outcome, to_status, lane, enabled, priority, is_protected, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `);
      for (const row of loadLegacyTransitions()) {
        insert.run(
          sprintId,
          row.task_type ?? null,
          row.from_status,
          row.outcome,
          row.to_status,
          row.lane ?? 'default',
          row.enabled ? 1 : 0,
          row.priority ?? 0,
          row.is_protected ? 1 : 0,
        );
      }
    }

    if (force || requirementCount === 0) {
      db.prepare(`DELETE FROM sprint_task_transition_requirements WHERE sprint_id = ?`).run(sprintId);
      const insert = db.prepare(`
        INSERT INTO sprint_task_transition_requirements (
          sprint_id, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `);
      for (const row of loadLegacyRequirements()) {
        insert.run(
          sprintId,
          row.task_type ?? null,
          row.outcome,
          row.field_name,
          row.requirement_type,
          row.match_field ?? null,
          row.severity,
          row.message,
          row.enabled ? 1 : 0,
          row.priority ?? 0,
        );
      }
    }

    if (force || routingRuleCount === 0) {
      db.prepare(`DELETE FROM sprint_task_routing_rules WHERE sprint_id = ?`).run(sprintId);
    }
  });

  tx();
}

export function backfillAllSprintTaskPolicies(db: Database.Database): void {
  if (!tableExists(db, 'sprints') || !tableExists(db, 'sprint_task_statuses')) return;
  const sprintIds = db.prepare(`SELECT id FROM sprints ORDER BY id ASC`).all() as Array<{ id: number }>;
  for (const row of sprintIds) {
    seedSprintTaskPolicy(db, row.id);
  }
}

export function listSprintTaskStatuses(
  db: Database.Database,
  sprintId?: number | null,
): SprintTaskStatusMeta[] {
  if (typeof sprintId === 'number' && Number.isFinite(sprintId) && tableExists(db, 'sprint_task_statuses')) {
    seedSprintTaskPolicy(db, sprintId);
    const rows = db.prepare(`
      SELECT status_key, label, color, terminal, is_system, allowed_transitions_json
      FROM sprint_task_statuses
      WHERE sprint_id = ?
      ORDER BY stage_order ASC, id ASC
    `).all(sprintId) as Array<{
      status_key: string;
      label: string;
      color: string;
      terminal: number;
      is_system: number;
      allowed_transitions_json: string | null;
    }>;
    if (rows.length > 0) {
      return rows.map((row) => ({
        name: row.status_key,
        label: row.label,
        color: row.color,
        terminal: Boolean(row.terminal),
        is_system: Boolean(row.is_system),
        allowed_transitions: parseJsonArray(row.allowed_transitions_json),
      }));
    }
  }

  if (!tableExists(db, 'task_statuses')) return [];
  const rows = db.prepare(`
    SELECT name, label, color, terminal, is_system, allowed_transitions
    FROM task_statuses
    ORDER BY terminal ASC, name ASC
  `).all() as Array<{
    name: string;
    label: string;
    color: string;
    terminal: number;
    is_system: number;
    allowed_transitions: string | null;
  }>;

  return rows.map((row) => ({
    name: row.name,
    label: row.label,
    color: row.color,
    terminal: Boolean(row.terminal),
    is_system: Boolean(row.is_system),
    allowed_transitions: parseJsonArray(row.allowed_transitions),
  }));
}

export function listSprintTaskTransitions(
  db: Database.Database,
  sprintId?: number | null,
): SprintTaskTransitionRow[] {
  if (typeof sprintId === 'number' && Number.isFinite(sprintId) && tableExists(db, 'sprint_task_transitions')) {
    seedSprintTaskPolicy(db, sprintId);
    const rows = db.prepare(`
      SELECT id, sprint_id, task_type, from_status, outcome, to_status, lane, enabled,
             priority, is_protected, created_at, updated_at
      FROM sprint_task_transitions
      WHERE sprint_id = ?
      ORDER BY priority DESC, id ASC
    `).all(sprintId) as SprintTaskTransitionRow[];
    if (rows.length > 0) return rows;
  }

  if (!tableExists(db, 'routing_transitions')) return [];
  return db.prepare(`
    SELECT id, NULL AS sprint_id, task_type, from_status, outcome, to_status, lane, enabled,
           COALESCE(priority, 0) AS priority,
           COALESCE(is_protected, 0) AS is_protected,
           created_at,
           NULL AS updated_at
    FROM routing_transitions
    WHERE project_id IS NULL
    ORDER BY priority DESC, id ASC
  `).all() as SprintTaskTransitionRow[];
}

export function resolveSprintTaskTransition(
  db: Database.Database,
  sprintId: number | null | undefined,
  fromStatus: string,
  outcome: string,
  taskType?: string | null,
): SprintTaskTransitionRow | null {
  if (typeof sprintId === 'number' && Number.isFinite(sprintId) && tableExists(db, 'sprint_task_transitions')) {
    seedSprintTaskPolicy(db, sprintId);
    if (taskType) {
      const typeRow = db.prepare(`
        SELECT id, sprint_id, task_type, from_status, outcome, to_status, lane, enabled,
               priority, is_protected, created_at, updated_at
        FROM sprint_task_transitions
        WHERE sprint_id = ? AND task_type = ? AND from_status = ? AND outcome = ? AND enabled = 1
        ORDER BY priority DESC, id ASC
        LIMIT 1
      `).get(sprintId, taskType, fromStatus, outcome) as SprintTaskTransitionRow | undefined;
      if (typeRow) return typeRow;
    }

    const defaultRow = db.prepare(`
      SELECT id, sprint_id, task_type, from_status, outcome, to_status, lane, enabled,
             priority, is_protected, created_at, updated_at
      FROM sprint_task_transitions
      WHERE sprint_id = ? AND task_type IS NULL AND from_status = ? AND outcome = ? AND enabled = 1
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `).get(sprintId, fromStatus, outcome) as SprintTaskTransitionRow | undefined;
    if (defaultRow) return defaultRow;
  }

  return null;
}

export function loadSprintTaskTransitionRequirements(
  db: Database.Database,
  sprintId: number | null | undefined,
  outcome: string,
  taskType?: string | null,
): SprintTaskTransitionRequirementRow[] {
  if (typeof sprintId === 'number' && Number.isFinite(sprintId) && tableExists(db, 'sprint_task_transition_requirements')) {
    seedSprintTaskPolicy(db, sprintId);
    if (taskType) {
      const typeRows = db.prepare(`
        SELECT id, sprint_id, task_type, outcome, field_name, requirement_type, match_field,
               severity, message, enabled, priority, created_at, updated_at
        FROM sprint_task_transition_requirements
        WHERE sprint_id = ? AND task_type = ? AND outcome = ? AND enabled = 1
        ORDER BY priority DESC, id ASC
      `).all(sprintId, taskType, outcome) as SprintTaskTransitionRequirementRow[];
      if (typeRows.length > 0) return typeRows;
    }

    const defaultRows = db.prepare(`
      SELECT id, sprint_id, task_type, outcome, field_name, requirement_type, match_field,
             severity, message, enabled, priority, created_at, updated_at
      FROM sprint_task_transition_requirements
      WHERE sprint_id = ? AND task_type IS NULL AND outcome = ? AND enabled = 1
      ORDER BY priority DESC, id ASC
    `).all(sprintId, outcome) as SprintTaskTransitionRequirementRow[];
    if (defaultRows.length > 0) return defaultRows;
  }

  return [];
}

export function listSprintTaskTransitionRequirements(
  db: Database.Database,
  sprintId?: number | null,
  taskType?: string | null,
  outcome?: string | null,
): SprintTaskTransitionRequirementRow[] {
  if (typeof sprintId === 'number' && Number.isFinite(sprintId) && tableExists(db, 'sprint_task_transition_requirements')) {
    seedSprintTaskPolicy(db, sprintId);
    let query = `
      SELECT id, sprint_id, task_type, outcome, field_name, requirement_type, match_field,
             severity, message, enabled, priority, created_at, updated_at
      FROM sprint_task_transition_requirements
      WHERE sprint_id = ?
    `;
    const params: unknown[] = [sprintId];
    if (taskType) {
      query += ` AND (task_type = ? OR task_type IS NULL)`;
      params.push(taskType);
    }
    if (outcome) {
      query += ` AND outcome = ?`;
      params.push(outcome);
    }
    query += ` ORDER BY outcome ASC, task_type IS NULL ASC, priority DESC, id ASC`;
    return db.prepare(query).all(...params) as SprintTaskTransitionRequirementRow[];
  }

  if (!tableExists(db, 'transition_requirements')) return [];
  let query = `
    SELECT id, NULL AS sprint_id, task_type, outcome, field_name, requirement_type, match_field,
           severity, message, enabled, priority, created_at, updated_at
    FROM transition_requirements
    WHERE 1 = 1
  `;
  const params: unknown[] = [];
  if (taskType) {
    query += ` AND (task_type = ? OR task_type IS NULL)`;
    params.push(taskType);
  }
  if (outcome) {
    query += ` AND outcome = ?`;
    params.push(outcome);
  }
  query += ` ORDER BY outcome ASC, task_type IS NULL ASC, priority DESC, id ASC`;
  return db.prepare(query).all(...params) as SprintTaskTransitionRequirementRow[];
}

export function listSprintTaskRoutingRules(
  db: Database.Database,
  sprintId?: number | null,
): SprintTaskRoutingRuleRow[] {
  if (typeof sprintId === 'number' && Number.isFinite(sprintId) && tableExists(db, 'sprint_task_routing_rules')) {
    seedSprintTaskPolicy(db, sprintId);
    const rows = db.prepare(`
      SELECT id, sprint_id, task_type, status, agent_id, priority, is_system, created_at, updated_at
      FROM sprint_task_routing_rules
      WHERE sprint_id = ?
      ORDER BY status ASC, task_type ASC, priority DESC, id ASC
    `).all(sprintId) as SprintTaskRoutingRuleRow[];
    if (rows.length > 0) return rows;
  }
  return [];
}

export function resolveSprintTaskRoutingAssignment(
  db: Database.Database,
  sprintId: number | null | undefined,
  taskType: string | null,
  status: string,
): { agent_id: number | null } {
  if (!taskType) return { agent_id: null };
  if (typeof sprintId === 'number' && Number.isFinite(sprintId) && tableExists(db, 'sprint_task_routing_rules')) {
    seedSprintTaskPolicy(db, sprintId);
    const row = db.prepare(`
      SELECT agent_id
      FROM sprint_task_routing_rules
      WHERE sprint_id = ? AND task_type = ? AND status = ?
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `).get(sprintId, taskType, status) as { agent_id: number | null } | undefined;
    if (row) return { agent_id: row.agent_id ?? null };
  }
  return { agent_id: null };
}
