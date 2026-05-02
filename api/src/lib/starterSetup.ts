import type Database from 'better-sqlite3';
import { isAtlasAgentRecord } from './atlasAgent';
import {
  STARTER_BACKLOG_SPRINT_NAME,
  STARTER_ROUTING_PRIORITY,
  getStarterTaskTypesForSprintType,
  isStarterSprintTypeKey,
} from './starterCatalog';
import { seedSprintTaskPolicy } from './sprintTaskPolicy';

type SprintRow = {
  id: number;
  project_id: number;
  sprint_type: string | null;
};

type AgentRow = {
  id: number;
  name: string | null;
  role: string | null;
  job_title: string | null;
  system_role: string | null;
  session_key: string | null;
  openclaw_agent_id: string | null;
};

type RoutedAgentSet = {
  atlasId: number | null;
  devId: number | null;
  qaId: number | null;
  opsId: number | null;
};

type StarterRoutingRule = {
  task_type: string;
  status: 'ready' | 'review' | 'ready_to_merge';
  agent_id: number;
  priority: number;
};

function tableHasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  try {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return columns.some((column) => column.name === columnName);
  } catch {
    return false;
  }
}

function resolveDefaultWorkflowTemplateKey(db: Database.Database, sprintType: string): string | null {
  const row = db.prepare(`
    SELECT key
    FROM sprint_workflow_templates
    WHERE sprint_type_key = ?
    ORDER BY is_default DESC, id ASC
    LIMIT 1
  `).get(sprintType) as { key: string } | undefined;
  return row?.key ?? null;
}

function loadSprintRow(db: Database.Database, sprintId: number): SprintRow | null {
  return db.prepare(`
    SELECT id, project_id, sprint_type
    FROM sprints
    WHERE id = ?
    LIMIT 1
  `).get(sprintId) as SprintRow | undefined ?? null;
}

function loadProjectAgents(db: Database.Database, projectId: number): AgentRow[] {
  const deletedFilter = tableHasColumn(db, 'agents', 'deleted_at') ? 'AND deleted_at IS NULL' : '';
  return db.prepare(`
    SELECT id, name, role, job_title, system_role, session_key, openclaw_agent_id
    FROM agents
    WHERE project_id = ?
      ${deletedFilter}
    ORDER BY id ASC
  `).all(projectId) as AgentRow[];
}

function buildAgentHaystack(agent: AgentRow): string {
  return [
    agent.name ?? '',
    agent.role ?? '',
    agent.job_title ?? '',
    agent.openclaw_agent_id ?? '',
  ].join(' ').toLowerCase();
}

function matchesAny(haystack: string, terms: string[]): boolean {
  return terms.some((term) => haystack.includes(term));
}

function classifyProjectAgents(agents: AgentRow[]): RoutedAgentSet {
  const atlas = agents.find((agent) => isAtlasAgentRecord(agent as unknown as Record<string, unknown>));

  const findByTerms = (terms: string[], excludedIds: Set<number>): number | null => {
    const match = agents.find((agent) => {
      if (excludedIds.has(agent.id)) return false;
      return matchesAny(buildAgentHaystack(agent), terms);
    });
    return match?.id ?? null;
  };

  const usedIds = new Set<number>(atlas ? [atlas.id] : []);
  const qaId = findByTerms([' qa ', 'qa', 'quality assurance', 'tester', 'testing', 'validation', 'verify'], usedIds);
  if (qaId != null) usedIds.add(qaId);
  const opsId = findByTerms(['ops', 'operations', 'devops', 'release', 'deployment', 'infra', 'infrastructure', 'sre', 'site reliability'], usedIds);
  if (opsId != null) usedIds.add(opsId);
  const devId = findByTerms(['developer', 'development', 'engineer', 'backend', 'frontend', 'fullstack', 'software', 'implementation', 'app', 'api', 'code'], usedIds);

  return {
    atlasId: atlas?.id ?? null,
    devId,
    qaId,
    opsId,
  };
}

function resolveReadyOwner(taskType: string, agents: RoutedAgentSet): number | null {
  switch (taskType) {
    case 'backend':
    case 'frontend':
    case 'fullstack':
      return agents.devId ?? agents.atlasId ?? null;
    case 'qa':
      return agents.qaId ?? agents.atlasId ?? agents.devId ?? null;
    case 'ops':
      return agents.opsId ?? agents.atlasId ?? null;
    case 'adhoc':
    case 'other':
    default:
      return agents.atlasId ?? agents.devId ?? agents.opsId ?? null;
  }
}

function resolveReviewOwner(taskType: string, agents: RoutedAgentSet): number | null {
  switch (taskType) {
    case 'backend':
    case 'frontend':
    case 'fullstack':
      return agents.qaId ?? agents.atlasId ?? agents.devId ?? null;
    case 'qa':
      return agents.atlasId ?? agents.qaId ?? null;
    case 'ops':
      return agents.atlasId ?? agents.opsId ?? null;
    case 'adhoc':
    case 'other':
    default:
      return agents.atlasId ?? agents.devId ?? agents.opsId ?? null;
  }
}

function buildStarterRoutingRules(sprintType: string, agents: RoutedAgentSet): StarterRoutingRule[] {
  const rules = new Map<string, StarterRoutingRule>();
  const taskTypes = getStarterTaskTypesForSprintType(sprintType);

  for (const taskType of taskTypes) {
    const readyOwner = resolveReadyOwner(taskType, agents);
    if (readyOwner != null) {
      rules.set(`${taskType}:ready`, {
        task_type: taskType,
        status: 'ready',
        agent_id: readyOwner,
        priority: STARTER_ROUTING_PRIORITY,
      });
    }

    const reviewOwner = resolveReviewOwner(taskType, agents);
    if (reviewOwner != null) {
      rules.set(`${taskType}:review`, {
        task_type: taskType,
        status: 'review',
        agent_id: reviewOwner,
        priority: STARTER_ROUTING_PRIORITY,
      });
    }

    const mergeOwner = agents.atlasId ?? reviewOwner ?? readyOwner;
    if (mergeOwner != null) {
      rules.set(`${taskType}:ready_to_merge`, {
        task_type: taskType,
        status: 'ready_to_merge',
        agent_id: mergeOwner,
        priority: STARTER_ROUTING_PRIORITY,
      });
    }
  }

  return Array.from(rules.values());
}

export function ensureProjectBacklogSprint(db: Database.Database, projectId: number): number {
  const existing = db.prepare(`
    SELECT id
    FROM sprints
    WHERE project_id = ?
      AND (lower(name) = lower(?) OR sprint_type = 'generic')
    ORDER BY CASE WHEN lower(name) = lower(?) THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `).get(projectId, STARTER_BACKLOG_SPRINT_NAME, STARTER_BACKLOG_SPRINT_NAME) as { id: number } | undefined;
  if (existing) return existing.id;

  const result = db.prepare(`
    INSERT INTO sprints (project_id, name, goal, sprint_type, workflow_template_key, status, length_kind, length_value)
    VALUES (?, ?, '', 'generic', ?, 'active', 'time', 'ongoing')
  `).run(projectId, STARTER_BACKLOG_SPRINT_NAME, resolveDefaultWorkflowTemplateKey(db, 'generic'));

  const sprintId = Number(result.lastInsertRowid);
  seedSprintTaskPolicy(db, sprintId);
  syncStarterRoutingForSprint(db, sprintId);
  return sprintId;
}

export function resolveDefaultProjectSprintId(db: Database.Database, projectId: number | null | undefined): number | null {
  if (!projectId || !Number.isFinite(projectId)) return null;
  return ensureProjectBacklogSprint(db, projectId);
}

export function syncStarterRoutingForProject(db: Database.Database, projectId: number | null | undefined): void {
  if (!projectId || !Number.isFinite(projectId)) return;
  const sprintRows = db.prepare(`
    SELECT id
    FROM sprints
    WHERE project_id = ?
    ORDER BY id ASC
  `).all(projectId) as Array<{ id: number }>;

  for (const sprint of sprintRows) {
    syncStarterRoutingForSprint(db, sprint.id);
  }
}

export function syncStarterRoutingForSprint(db: Database.Database, sprintId: number | null | undefined): void {
  if (!sprintId || !Number.isFinite(sprintId)) return;
  const sprint = loadSprintRow(db, sprintId);
  if (!sprint) return;
  if (!tableHasColumn(db, 'sprint_task_routing_rules', 'is_system')) return;

  seedSprintTaskPolicy(db, sprintId);
  db.prepare(`
    DELETE FROM sprint_task_routing_rules
    WHERE sprint_id = ? AND is_system = 1
  `).run(sprintId);

  if (!isStarterSprintTypeKey(sprint.sprint_type)) return;

  const agents = classifyProjectAgents(loadProjectAgents(db, sprint.project_id));
  const rules = buildStarterRoutingRules(sprint.sprint_type, agents);
  if (rules.length === 0) return;

  const insertRule = db.prepare(`
    INSERT INTO sprint_task_routing_rules (sprint_id, task_type, status, agent_id, priority, is_system, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
  `);

  for (const rule of rules) {
    insertRule.run(sprintId, rule.task_type, rule.status, rule.agent_id, rule.priority);
  }
}
