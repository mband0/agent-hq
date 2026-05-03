/**
 * Agent HQ MCP Server — API Client
 *
 * Thin wrapper around the Agent HQ REST API.
 * All MCP tool implementations call through here.
 * Never accesses the database directly.
 */

import { TASK_STATUSES } from '../lib/taskStatuses';

type RecordLike = Record<string, unknown>;

export interface AgentHqProjectSummary {
  id: number;
  name: string;
  description: string | null;
  agent_count: number;
  created_at: string | null;
}

export interface AgentHqSprintSummary {
  id: number;
  project_id: number;
  project_name: string | null;
  name: string;
  goal: string | null;
  status: string | null;
  task_count: number;
  tasks_done: number;
  total_story_points: number;
  done_story_points: number;
  remaining_story_points: number;
  created_at: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface AgentHqTaskSummary {
  id: number;
  title: string;
  status: string | null;
  priority: string | null;
  task_type: string | null;
  story_points: number | null;
  project_id: number | null;
  sprint_id: number | null;
  sprint_name: string | null;
  agent_id: number | null;
  agent_name: string | null;
  active_instance_id: number | null;
  updated_at: string | null;
  blockers: Array<{ id: number; title: string; status: string | null }>;
  blocking: Array<{ id: number; title: string; status: string | null }>;
}

export interface AgentHqTaskDetail extends AgentHqTaskSummary {
  description: string | null;
  review_branch: string | null;
  review_commit: string | null;
  review_url: string | null;
  qa_verified_commit: string | null;
  qa_tested_url: string | null;
  merged_commit: string | null;
  deployed_commit: string | null;
  deploy_target: string | null;
  latest_run_stage: string | null;
  latest_run_outcome: string | null;
  blocker_reason: string | null;
  integrity_state: string | null;
  integrity_warnings: string[];
  changed_files: string[];
}

export interface AgentHqTaskHistoryEntry {
  id: number;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  created_at: string | null;
}

function asRecord(value: unknown): RecordLike {
  return value && typeof value === 'object' ? (value as RecordLike) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] {
  return asArray(value).map((item) => (typeof item === 'string' ? item : String(item))).filter(Boolean);
}

function shapeTaskRef(value: unknown): { id: number; title: string; status: string | null } | null {
  const row = asRecord(value);
  const id = asNumber(row.id);
  const title = asString(row.title);
  if (id === null || title === null) return null;
  return {
    id,
    title,
    status: asString(row.status),
  };
}

export function shapeProjectSummary(value: unknown): AgentHqProjectSummary {
  const row = asRecord(value);
  return {
    id: asNumber(row.id) ?? 0,
    name: asString(row.name) ?? 'Untitled project',
    description: asString(row.description),
    agent_count: asNumber(row.agent_count) ?? 0,
    created_at: asString(row.created_at),
  };
}

export function shapeSprintSummary(value: unknown): AgentHqSprintSummary {
  const row = asRecord(value);
  return {
    id: asNumber(row.id) ?? 0,
    project_id: asNumber(row.project_id) ?? 0,
    project_name: asString(row.project_name),
    name: asString(row.name) ?? 'Untitled sprint',
    goal: asString(row.goal),
    status: asString(row.status),
    task_count: asNumber(row.task_count) ?? 0,
    tasks_done: asNumber(row.tasks_done) ?? 0,
    total_story_points: asNumber(row.total_story_points) ?? 0,
    done_story_points: asNumber(row.done_story_points) ?? 0,
    remaining_story_points: asNumber(row.remaining_story_points) ?? 0,
    created_at: asString(row.created_at),
    started_at: asString(row.started_at),
    ended_at: asString(row.ended_at),
  };
}

export function shapeTaskSummary(value: unknown): AgentHqTaskSummary {
  const row = asRecord(value);
  return {
    id: asNumber(row.id) ?? 0,
    title: asString(row.title) ?? 'Untitled task',
    status: asString(row.status),
    priority: asString(row.priority),
    task_type: asString(row.task_type),
    story_points: asNumber(row.story_points),
    project_id: asNumber(row.project_id),
    sprint_id: asNumber(row.sprint_id),
    sprint_name: asString(row.sprint_name),
    agent_id: asNumber(row.agent_id),
    agent_name: asString(row.agent_name),
    active_instance_id: asNumber(row.active_instance_id),
    updated_at: asString(row.updated_at),
    blockers: asArray(row.blockers).map(shapeTaskRef).filter((item): item is NonNullable<typeof item> => item !== null),
    blocking: asArray(row.blocking).map(shapeTaskRef).filter((item): item is NonNullable<typeof item> => item !== null),
  };
}

export function shapeTaskDetail(value: unknown): AgentHqTaskDetail {
  const row = asRecord(value);
  const summary = shapeTaskSummary(row);
  return {
    ...summary,
    description: asString(row.description),
    review_branch: asString(row.review_branch),
    review_commit: asString(row.review_commit),
    review_url: asString(row.review_url),
    qa_verified_commit: asString(row.qa_verified_commit),
    qa_tested_url: asString(row.qa_tested_url),
    merged_commit: asString(row.merged_commit),
    deployed_commit: asString(row.deployed_commit),
    deploy_target: asString(row.deploy_target),
    latest_run_stage: asString(row.latest_run_stage),
    latest_run_outcome: asString(row.latest_run_outcome),
    blocker_reason: asString(row.blocker_reason),
    integrity_state: asString(row.integrity_state),
    integrity_warnings: asStringArray(row.integrity_warnings),
    changed_files: asStringArray(row.changed_files),
  };
}

export function shapeTaskHistoryEntry(value: unknown): AgentHqTaskHistoryEntry {
  const row = asRecord(value);
  return {
    id: asNumber(row.id) ?? 0,
    field: asString(row.field),
    old_value: asString(row.old_value),
    new_value: asString(row.new_value),
    changed_by: asString(row.changed_by),
    created_at: asString(row.created_at),
  };
}

export const VALID_TASK_PRIORITIES = ['low', 'medium', 'high'] as const;
export const VALID_TASK_STORY_POINTS = [1, 2, 3, 5, 8, 13, 21] as const;
export const VALID_TASK_TYPES = [
  'frontend',
  'backend',
  'fullstack',
  'qa',
  'design',
  'marketing',
  'pm',
  'pm_analysis',
  'pm_operational',
  'ops',
  'data',
  'adhoc',
  'other',
] as const;
export const VALID_TASK_STATUSES = TASK_STATUSES;

export class AgentHqApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string | null,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-agent-hq-mcp-client': 'agent-hq-mcp',
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const opts: RequestInit = {
      method,
      headers,
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);
    const text = await res.text();

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Agent HQ API returned non-JSON response (${res.status}): ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
      const errMsg =
        (data as Record<string, unknown>)?.error ??
        (data as Record<string, unknown>)?.message ??
        `HTTP ${res.status}`;
      throw new Error(String(errMsg));
    }

    return data as T;
  }

  apiRequest(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) {
    if (!path.startsWith('/api/v1/')) {
      throw new Error('path must start with /api/v1/');
    }
    return this.request<unknown>(method, path, body);
  }

  listProjects() {
    return this.request<unknown[]>('GET', '/api/v1/projects').then((rows) => rows.map(shapeProjectSummary));
  }

  getProject(id: number) {
    return this.request<unknown>('GET', `/api/v1/projects/${id}`).then(shapeProjectSummary);
  }

  createProject(data: { name: string; description?: string; context_md?: string }) {
    return this.request<unknown>('POST', '/api/v1/projects', data);
  }

  updateProject(id: number, data: { name?: string; description?: string; context_md?: string }) {
    return this.request<unknown>('PUT', `/api/v1/projects/${id}`, data);
  }

  deleteProject(id: number, force?: boolean) {
    const qs = new URLSearchParams();
    if (force) qs.set('force', 'true');
    return this.request<unknown>('DELETE', `/api/v1/projects/${id}${qs.toString() ? `?${qs.toString()}` : ''}`);
  }

  listSprints(params: { project_id?: number; include_closed?: boolean } = {}) {
    const qs = new URLSearchParams();
    if (params.project_id !== undefined) qs.set('project_id', String(params.project_id));
    if (params.include_closed) qs.set('include_closed', 'true');
    const q = qs.toString();
    return this.request<unknown[]>('GET', `/api/v1/sprints${q ? `?${q}` : ''}`).then((rows) => rows.map(shapeSprintSummary));
  }

  getSprint(id: number) {
    return this.request<unknown>('GET', `/api/v1/sprints/${id}`).then(shapeSprintSummary);
  }

  updateSprint(id: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/sprints/${id}`, data);
  }

  deleteSprint(id: number) {
    return this.request<unknown>('DELETE', `/api/v1/sprints/${id}`);
  }

  listTasks(params: {
    project_id?: number;
    sprint_id?: number;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const qs = new URLSearchParams();
    if (params.project_id !== undefined) qs.set('project_id', String(params.project_id));
    if (params.sprint_id !== undefined) qs.set('sprint_id', String(params.sprint_id));
    if (params.status) qs.set('status', params.status);
    qs.set('limit', String(Math.min(params.limit ?? 50, 100)));
    qs.set('offset', String(params.offset ?? 0));
    return this.request<unknown>('GET', `/api/v1/tasks?${qs.toString()}`).then((payload) => {
      const body = asRecord(payload);
      const tasks = Array.isArray(payload) ? payload : asArray(body.tasks);
      return {
        tasks: tasks.map(shapeTaskSummary),
        total: asNumber(body.total),
        hasMore: typeof body.hasMore === 'boolean' ? body.hasMore : null,
        limit: asNumber(body.limit),
        offset: asNumber(body.offset),
      };
    });
  }

  getTask(id: number) {
    return this.request<unknown>('GET', `/api/v1/tasks/${id}`).then(shapeTaskDetail);
  }

  deleteTask(id: number, deletedBy?: string) {
    const qs = new URLSearchParams();
    if (deletedBy) qs.set('deleted_by', deletedBy);
    return this.request<unknown>('DELETE', `/api/v1/tasks/${id}${qs.toString() ? `?${qs.toString()}` : ''}`);
  }

  getTaskNotes(id: number) {
    return this.request<unknown[]>('GET', `/api/v1/tasks/${id}/notes`);
  }

  getTaskHistory(id: number) {
    return this.request<unknown[]>('GET', `/api/v1/tasks/${id}/history`).then((rows) => rows.map(shapeTaskHistoryEntry));
  }

  createTask(data: {
    title: string;
    project_id: number;
    description?: string;
    sprint_id?: number | null;
    priority?: string;
    task_type?: string;
    story_points?: number | null;
    agent_id?: number | null;
    blockers?: number[];
    changed_by?: string;
    dry_run?: boolean;
  }) {
    if (data.dry_run) {
      return Promise.resolve({
        dry_run: true,
        preview: {
          method: 'POST',
          path: '/api/v1/tasks',
          body: {
            title: data.title,
            project_id: data.project_id,
            description: data.description ?? '',
            sprint_id: data.sprint_id ?? null,
            priority: data.priority ?? 'medium',
            task_type: data.task_type ?? 'backend',
            story_points: data.story_points ?? null,
            agent_id: data.agent_id ?? null,
            blockers: data.blockers ?? [],
            changed_by: data.changed_by ?? 'Agent HQ',
          },
        },
      });
    }
    return this.request<unknown>('POST', '/api/v1/tasks', {
      title: data.title,
      project_id: data.project_id,
      description: data.description,
      sprint_id: data.sprint_id,
      priority: data.priority,
      task_type: data.task_type,
      story_points: data.story_points,
      agent_id: data.agent_id,
      blockers: data.blockers,
      changed_by: data.changed_by ?? 'Agent HQ',
    });
  }

  updateTask(
    id: number,
    data: {
      title?: string;
      description?: string;
      priority?: string;
      sprint_id?: number | null;
      task_type?: string;
      story_points?: number | null;
      agent_id?: number | null;
      changed_by?: string;
      dry_run?: boolean;
    },
  ) {
    if (data.dry_run) {
      return Promise.resolve({
        dry_run: true,
        preview: {
          method: 'PUT',
          path: `/api/v1/tasks/${id}`,
          body: {
            ...data,
            changed_by: data.changed_by ?? 'Agent HQ',
          },
        },
      });
    }
    return this.request<unknown>('PUT', `/api/v1/tasks/${id}`, {
      ...data,
      changed_by: data.changed_by ?? 'Agent HQ',
    });
  }

  addTaskNote(id: number, content: string, author: string = 'mcp-client') {
    return this.request<unknown>('POST', `/api/v1/tasks/${id}/notes`, {
      content,
      author,
      source: 'mcp',
    });
  }

  addBlocker(taskId: number, blockedByTaskId: number, dryRun?: boolean) {
    if (dryRun) {
      return Promise.resolve({
        dry_run: true,
        preview: {
          method: 'POST',
          path: `/api/v1/tasks/${taskId}/blockers`,
          body: { blocker_id: blockedByTaskId },
        },
      });
    }
    return this.request<unknown>('POST', `/api/v1/tasks/${taskId}/blockers`, {
      blocker_id: blockedByTaskId,
    });
  }

  removeBlocker(taskId: number, blockerId: number) {
    return this.request<unknown>('DELETE', `/api/v1/tasks/${taskId}/blockers/${blockerId}`);
  }

  createSprint(data: {
    project_id: number;
    name: string;
    goal?: string;
    sprint_type?: string;
    workflow_template_key?: string | null;
    status?: 'planning' | 'active' | 'paused' | 'complete' | 'closed';
    length_kind?: 'time' | 'runs';
    length_value?: string;
    started_at?: string | null;
    dry_run?: boolean;
  }) {
    if (data.dry_run) {
      return Promise.resolve({
        dry_run: true,
        preview: {
          method: 'POST',
          path: '/api/v1/sprints',
          body: {
            project_id: data.project_id,
            name: data.name,
            goal: data.goal ?? '',
            sprint_type: data.sprint_type,
            workflow_template_key: data.workflow_template_key ?? null,
            status: data.status ?? 'planning',
            length_kind: data.length_kind ?? 'time',
            length_value: data.length_value ?? '',
            started_at: data.started_at ?? null,
          },
        },
      });
    }
    return this.request<unknown>('POST', '/api/v1/sprints', data);
  }

  moveTask(
    id: number,
    data: {
      status: string;
      summary?: string;
      changed_by?: string;
      review_branch?: string;
      review_commit?: string;
      review_url?: string;
      qa_verified_commit?: string;
      qa_tested_url?: string;
      merged_commit?: string;
      deployed_commit?: string;
      deploy_target?: string;
      deployed_at?: string;
      live_verified_by?: string;
      live_verified_at?: string;
      failure_class?: string;
      failure_detail?: string;
      dry_run?: boolean;
    },
  ) {
    // Compatibility bridge for status-targeted MCP moves.
    // The canonical backend truth is still outcome-driven. These aliases only
    // cover the legacy/default lifecycle statuses, while sprint-type workflows
    // may expose different configured outcome keys.
    const statusToOutcome: Record<string, string> = {
      review: 'completed_for_review',
      qa_pass: 'qa_pass',
      ready_to_merge: 'approved_for_merge',
      deployed: 'deployed_live',
      done: 'live_verified',
    };

    const outcome = statusToOutcome[data.status];
    if (outcome) {
      const body = {
        outcome,
        summary: data.summary,
        changed_by: data.changed_by ?? 'Agent HQ',
        review_branch: data.review_branch,
        review_commit: data.review_commit,
        review_url: data.review_url,
        qa_verified_commit: data.qa_verified_commit,
        qa_tested_url: data.qa_tested_url,
        merged_commit: data.merged_commit,
        deployed_commit: data.deployed_commit,
        deploy_target: data.deploy_target,
        deployed_at: data.deployed_at,
        live_verified_by: data.live_verified_by,
        live_verified_at: data.live_verified_at,
        failure_class: data.failure_class,
        failure_detail: data.failure_detail,
      };
      if (data.dry_run) {
        return Promise.resolve({
          dry_run: true,
          preview: {
            method: 'POST',
            path: `/api/v1/tasks/${id}/outcome`,
            body,
          },
        });
      }
      return this.request<unknown>('POST', `/api/v1/tasks/${id}/outcome`, body);
    }

    const body = {
      status: data.status,
      changed_by: data.changed_by ?? 'Agent HQ',
    };
    if (data.dry_run) {
      return Promise.resolve({
        dry_run: true,
        preview: {
          method: 'PUT',
          path: `/api/v1/tasks/${id}`,
          body,
        },
      });
    }
    return this.request<unknown>('PUT', `/api/v1/tasks/${id}`, body);
  }

  listAgents(params: { project_id?: number } = {}) {
    const qs = new URLSearchParams();
    if (params.project_id !== undefined) qs.set('project_id', String(params.project_id));
    const q = qs.toString();
    return this.request<unknown[]>('GET', `/api/v1/agents${q ? `?${q}` : ''}`);
  }

  getAgent(id: number) {
    return this.request<unknown>('GET', `/api/v1/agents/${id}`);
  }

  createAgent(data: Record<string, unknown>) {
    return this.request<unknown>('POST', '/api/v1/agents', data);
  }

  provisionFullAgent(data: Record<string, unknown>) {
    return this.request<unknown>('POST', '/api/v1/agents/provision-full', data);
  }

  updateAgent(id: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/agents/${id}`, data);
  }

  deleteAgent(id: number) {
    return this.request<unknown>('DELETE', `/api/v1/agents/${id}`);
  }

  getAgentDocs(id: number) {
    return this.request<unknown>('GET', `/api/v1/agents/${id}/docs`);
  }

  syncAgentMcp(id: number, workingDirectory?: string) {
    return this.request<unknown>('POST', `/api/v1/agents/${id}/mcp/sync`, workingDirectory ? { working_directory: workingDirectory } : {});
  }

  listTools() {
    return this.request<unknown[]>('GET', '/api/v1/tools');
  }

  getTool(id: number) {
    return this.request<unknown>('GET', `/api/v1/tools/${id}`);
  }

  createTool(data: Record<string, unknown>) {
    return this.request<unknown>('POST', '/api/v1/tools', data);
  }

  updateTool(id: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/tools/${id}`, data);
  }

  deleteTool(id: number) {
    return this.request<unknown>('DELETE', `/api/v1/tools/${id}`);
  }

  testTool(id: number, input: Record<string, unknown>) {
    return this.request<unknown>('POST', `/api/v1/tools/${id}/test`, { input });
  }

  listAgentTools(agentId: number) {
    return this.request<unknown[]>('GET', `/api/v1/agents/${agentId}/tools`);
  }

  assignToolToAgent(agentId: number, toolId: number, overrides?: Record<string, unknown>, enabled?: boolean) {
    return this.request<unknown>('POST', `/api/v1/agents/${agentId}/tools`, {
      tool_id: toolId,
      ...(overrides ? { overrides } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    });
  }

  removeToolFromAgent(agentId: number, toolId: number) {
    return this.request<unknown>('DELETE', `/api/v1/agents/${agentId}/tools/${toolId}`);
  }

  listSkills() {
    return this.request<unknown[]>('GET', '/api/v1/skills');
  }

  listAgentSkills(agentId: number) {
    return this.request<unknown>('GET', `/api/v1/agents/${agentId}/skills`);
  }

  assignSkillToAgent(agentId: number, input: { skill_name?: string; skill_id?: number }) {
    return this.request<unknown>('POST', `/api/v1/agents/${agentId}/skills`, input);
  }

  removeSkillFromAgent(agentId: number, skillIdentifier: string | number | { skill_name?: string; skill_id?: number | string }) {
    if (typeof skillIdentifier === 'object' && skillIdentifier !== null) {
      const identifier = skillIdentifier.skill_name ?? skillIdentifier.skill_id ?? '';
      return this.request<unknown>('DELETE', `/api/v1/agents/${agentId}/skills/${encodeURIComponent(String(identifier))}`, skillIdentifier);
    }
    return this.request<unknown>('DELETE', `/api/v1/agents/${agentId}/skills/${encodeURIComponent(String(skillIdentifier))}`);
  }

  getSkill(name: string) {
    return this.request<unknown>('GET', `/api/v1/skills/${encodeURIComponent(name)}`);
  }

  createSkill(data: { name: string; description?: string; content?: string }) {
    return this.request<unknown>('POST', '/api/v1/skills', data);
  }

  updateSkill(name: string, content: string) {
    return this.request<unknown>('PUT', `/api/v1/skills/${encodeURIComponent(name)}`, { content });
  }

  deleteSkill(name: string) {
    return this.request<unknown>('DELETE', `/api/v1/skills/${encodeURIComponent(name)}`);
  }

  listMcpServers() {
    return this.request<unknown[]>('GET', '/api/v1/mcp-servers');
  }

  getMcpServer(id: number) {
    return this.request<unknown>('GET', `/api/v1/mcp-servers/${id}`);
  }

  createMcpServer(data: Record<string, unknown>) {
    return this.request<unknown>('POST', '/api/v1/mcp-servers', data);
  }

  updateMcpServer(id: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/mcp-servers/${id}`, data);
  }

  deleteMcpServer(id: number) {
    return this.request<unknown>('DELETE', `/api/v1/mcp-servers/${id}`);
  }

  listAgentMcpServers(agentId: number) {
    return this.request<unknown[]>('GET', `/api/v1/agents/${agentId}/mcp-servers`);
  }

  assignMcpServerToAgent(agentId: number, mcpServerId: number, overrides?: Record<string, unknown>, enabled?: boolean) {
    return this.request<unknown>('POST', `/api/v1/agents/${agentId}/mcp-servers`, {
      mcp_server_id: mcpServerId,
      ...(overrides ? { overrides } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    });
  }

  removeMcpServerFromAgent(agentId: number, mcpServerId: number) {
    return this.request<unknown>('DELETE', `/api/v1/agents/${agentId}/mcp-servers/${mcpServerId}`);
  }

  listRoutingRules(sprintId: number) {
    return this.request<unknown>('GET', `/api/v1/routing/rules?sprint_id=${encodeURIComponent(String(sprintId))}`);
  }

  getRoutingRule(ruleId: number, sprintId: number) {
    return this.request<unknown>('GET', `/api/v1/routing/rules?sprint_id=${encodeURIComponent(String(sprintId))}`).then((payload) => {
      const rules = asArray(asRecord(payload).rules);
      const match = rules.find((row) => asNumber(asRecord(row).id) === ruleId);
      if (!match) throw new Error(`Routing rule ${ruleId} not found in sprint ${sprintId}`);
      return match;
    });
  }

  createRoutingRule(data: Record<string, unknown>) {
    return this.request<unknown>('POST', '/api/v1/routing/rules', data);
  }

  updateRoutingRule(ruleId: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/routing/rules/${ruleId}`, data);
  }

  deleteRoutingRule(ruleId: number, sprintId?: number) {
    const qs = new URLSearchParams();
    if (sprintId !== undefined) qs.set('sprint_id', String(sprintId));
    return this.request<unknown>('DELETE', `/api/v1/routing/rules/${ruleId}${qs.toString() ? `?${qs.toString()}` : ''}`);
  }

  listRoutingTransitions(params: { sprint_id?: number; project_id?: number } = {}) {
    const qs = new URLSearchParams();
    if (params.sprint_id !== undefined) qs.set('sprint_id', String(params.sprint_id));
    if (params.project_id !== undefined) qs.set('project_id', String(params.project_id));
    return this.request<unknown>('GET', `/api/v1/routing/transitions${qs.toString() ? `?${qs.toString()}` : ''}`);
  }

  getRoutingTransition(transitionId: number, params: { sprint_id?: number; project_id?: number } = {}) {
    const qs = new URLSearchParams();
    if (params.sprint_id !== undefined) qs.set('sprint_id', String(params.sprint_id));
    if (params.project_id !== undefined) qs.set('project_id', String(params.project_id));
    return this.request<unknown>('GET', `/api/v1/routing/transitions/${transitionId}${qs.toString() ? `?${qs.toString()}` : ''}`);
  }

  createRoutingTransition(data: Record<string, unknown>) {
    return this.request<unknown>('POST', '/api/v1/routing/transitions', data);
  }

  updateRoutingTransition(transitionId: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/routing/transitions/${transitionId}`, data);
  }

  deleteRoutingTransition(transitionId: number, data?: { sprint_id?: number }) {
    const qs = new URLSearchParams();
    if (data?.sprint_id !== undefined) qs.set('sprint_id', String(data.sprint_id));
    return this.request<unknown>('DELETE', `/api/v1/routing/transitions/${transitionId}${qs.toString() ? `?${qs.toString()}` : ''}`);
  }

  listSprintTypes() {
    return this.request<unknown[]>('GET', '/api/v1/sprints/types/list');
  }

  createSprintType(data: Record<string, unknown>) {
    return this.request<unknown>('POST', '/api/v1/sprints/types', data);
  }

  updateSprintType(key: string, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/sprints/types/${encodeURIComponent(key)}`, data);
  }

  deleteSprintType(key: string) {
    return this.request<unknown>('DELETE', `/api/v1/sprints/types/${encodeURIComponent(key)}`);
  }

  listSprintTypeTaskTypes(sprintTypeKey: string) {
    return this.request<unknown>('GET', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/task-types`);
  }

  updateSprintTypeTaskTypes(sprintTypeKey: string, taskTypes: string[]) {
    return this.request<unknown>('PUT', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/task-types`, { task_types: taskTypes });
  }

  listWorkflowTemplates(sprintType?: string) {
    const qs = new URLSearchParams();
    if (sprintType) qs.set('sprint_type', sprintType);
    qs.set('system_only', 'false');
    return this.request<unknown>('GET', `/api/v1/sprints/workflow-templates${qs.toString() ? `?${qs.toString()}` : ''}`);
  }

  getWorkflowTemplate(sprintTypeKey: string, templateId: number) {
    return this.request<unknown>('GET', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/workflow-templates/${templateId}`);
  }

  createWorkflowTemplate(sprintTypeKey: string, data: Record<string, unknown>) {
    return this.request<unknown>('POST', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/workflow-templates`, data);
  }

  updateWorkflowTemplate(sprintTypeKey: string, templateId: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/workflow-templates/${templateId}`, data);
  }

  deleteWorkflowTemplate(sprintTypeKey: string, templateId: number) {
    return this.request<unknown>('DELETE', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/workflow-templates/${templateId}`);
  }

  listTaskFieldSchemas(sprintTypeKey: string) {
    return this.request<unknown>('GET', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/field-schemas`);
  }

  getTaskFieldSchema(sprintTypeKey: string, schemaId: number) {
    return this.request<unknown>('GET', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/field-schemas/${schemaId}`);
  }

  createTaskFieldSchema(sprintTypeKey: string, data: Record<string, unknown>) {
    return this.request<unknown>('POST', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/field-schemas`, data);
  }

  updateTaskFieldSchema(sprintTypeKey: string, schemaId: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/field-schemas/${schemaId}`, data);
  }

  deleteTaskFieldSchema(sprintTypeKey: string, schemaId: number) {
    return this.request<unknown>('DELETE', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/field-schemas/${schemaId}`);
  }

  listModelRoutingRules() {
    return this.request<unknown[]>('GET', '/api/v1/model-routing');
  }

  listStoryPointRoutingRules() {
    return this.request<unknown[]>('GET', '/api/v1/story-point-routing');
  }

  getModelRoutingRule(id: number) {
    return this.request<unknown>('GET', `/api/v1/model-routing/${id}`);
  }

  getStoryPointRoutingRule(id: number) {
    return this.request<unknown>('GET', `/api/v1/story-point-routing/${id}`);
  }

  createModelRoutingRule(data: Record<string, unknown>) {
    return this.request<unknown>('POST', '/api/v1/model-routing', data);
  }

  createStoryPointRoutingRule(data: Record<string, unknown>) {
    return this.request<unknown>('POST', '/api/v1/story-point-routing', data);
  }

  updateModelRoutingRule(id: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/model-routing/${id}`, data);
  }

  updateStoryPointRoutingRule(id: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/story-point-routing/${id}`, data);
  }

  deleteModelRoutingRule(id: number) {
    return this.request<unknown>('DELETE', `/api/v1/model-routing/${id}`);
  }

  deleteStoryPointRoutingRule(id: number) {
    return this.request<unknown>('DELETE', `/api/v1/story-point-routing/${id}`);
  }
}
