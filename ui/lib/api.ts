import { getAgentHqBaseUrl } from './agentHqBaseUrl';

export const getApiBase = () => {
  // Browser clients should always use the UI origin and rely on Next rewrites / route handlers.
  if (typeof window !== 'undefined') return '';
  return getAgentHqBaseUrl();
};

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    let errorMsg = `API error ${res.status}`;
    try {
      const json = JSON.parse(body) as { error?: string };
      errorMsg = json.error ?? errorMsg;
    } catch { /* ignore */ }
    throw new Error(errorMsg);
  }

  return res.json() as Promise<T>;
}

export const api = {
  // Agents
  getAgents: (projectId?: number | null) => apiFetch<Agent[]>(projectId ? `/api/v1/agents?project_id=${projectId}` : '/api/v1/agents'),
  getSetupStatus: () => apiFetch<SetupStatus>('/api/v1/setup/status'),
  completeOnboarding: () =>
    apiFetch<{ ok: boolean; onboarding_completed: boolean; onboarding_provider_gate_passed: boolean }>('/api/v1/setup/onboarding/complete', { method: 'POST' }),

  // Providers
  getProviders: () => apiFetch<ProviderListResponse>('/api/v1/providers'),
  getProviderGate: () => apiFetch<ProviderGateResponse>('/api/v1/providers/gate'),
  createProvider: (data: { slug: ProviderSlug; display_name?: string; config: Record<string, unknown> }) =>
    apiFetch<ProviderSaveResponse>('/api/v1/providers', { method: 'POST', body: JSON.stringify(data) }),
  updateProvider: (id: number, data: { display_name?: string; config: Record<string, unknown> }) =>
    apiFetch<ProviderSaveResponse>(`/api/v1/providers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  revalidateProvider: (id: number) =>
    apiFetch<{ ok: boolean; status: string; error: string | null; onboarding_provider_gate_passed: boolean }>(`/api/v1/providers/${id}/validate`, { method: 'POST' }),
  deleteProvider: (id: number) =>
    apiFetch<{ ok: boolean; onboarding_provider_gate_passed: boolean }>(`/api/v1/providers/${id}`, { method: 'DELETE' }),
  initiateOAuth: (slug: ProviderSlug) =>
    apiFetch<{ ok: boolean; message: string; oauthUrl?: string }>(`/api/v1/providers/${slug}/oauth/initiate`, { method: 'POST' }),
  exchangeOAuth: (slug: ProviderSlug, callbackUrl: string) =>
    apiFetch<{ ok: boolean; message: string }>(`/api/v1/providers/${slug}/oauth/exchange`, { method: 'POST', body: JSON.stringify({ callbackUrl }) }),
  setupToken: (slug: ProviderSlug, token: string) =>
    apiFetch<{ ok: boolean; message: string }>(`/api/v1/providers/${slug}/setup-token`, { method: 'POST', body: JSON.stringify({ token }) }),
  getMiniMaxModels: () =>
    apiFetch<{ models: Array<{ id: string; label: string }> }>('/api/v1/providers/minimax/models'),
  getAgent: (id: number) => apiFetch<Agent>(`/api/v1/agents/${id}`),
  createAgent: (data: Partial<Agent> & { provision_openclaw?: boolean }) =>
    apiFetch<Agent>('/api/v1/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (id: number, data: Partial<Agent>) =>
    apiFetch<Agent>(`/api/v1/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAgent: (id: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/agents/${id}`, { method: 'DELETE' }),

  // Task Instances
  getTaskInstances: (taskId: number) => apiFetch<JobInstance[]>(`/api/v1/tasks/${taskId}/instances`),

  // Instances (Kanban)
  getInstances: () => apiFetch<JobInstance[]>('/api/v1/instances'),
  stopInstance: (id: number, behavior: 'stop' | 'park' | 'requeue' = 'park') =>
    apiFetch<{
      ok: boolean;
      cronRemoved?: boolean;
      cronRemoveError?: string | null;
      behavior: 'stop' | 'park' | 'requeue';
      result?: 'confirmed_stopped' | 'already_gone' | 'stopped_runtime_uncertain' | 'already_finished';
      message?: string;
      runtimeUncertain?: boolean;
      abortAttempted?: boolean;
      abortOk?: boolean | null;
      abortStatus?: 'succeeded' | 'already_gone' | 'timed_out' | 'failed' | null;
      abortError?: string | null;
      taskId?: number | null;
      taskStatusBefore?: string | null;
      taskStatusAfter?: string | null;
      clearedTaskLinkage?: boolean;
    }>(`/api/v1/instances/${id}/stop`, {
      method: 'PUT',
      body: JSON.stringify({ behavior }),
    }),
  resolveSessionKey: (id: number) =>
    apiFetch<{ sessionKey: string | null; source: string; agentId?: number | null }>(`/api/v1/instances/${id}/session-key`),
  getAgentInstances: (agentId: number) =>
    apiFetch<JobInstance[]>('/api/v1/instances').then(all =>
      all.filter(i => i.agent_id === agentId)
    ),
  getCanonicalChatSession: (agentId: number, channel = 'web') =>
    apiFetch<{ sessionKey: string | null; channel: string; agentId: number }>(`/api/v1/chat/canonical-session/${agentId}?channel=${encodeURIComponent(channel)}`),

  // Skills
  getSkills: () => apiFetch<SkillEntry[]>('/api/v1/skills'),
  getSkill: (name: string) => apiFetch<SkillDetail>(`/api/v1/skills/${encodeURIComponent(name)}`),
  getSkillFile: (name: string, filePath: string) =>
    apiFetch<{ name: string; file: string; content: string; path: string }>(
      `/api/v1/skills/${encodeURIComponent(name)}/file/${filePath}`
    ),
  updateSkill: (name: string, content: string) =>
    apiFetch<{ ok: boolean }>(`/api/v1/skills/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
  deleteSkill: (name: string) =>
    apiFetch<{ ok: boolean }>(`/api/v1/skills/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
  createSkill: (name: string, content?: string) =>
    apiFetch<{ ok: boolean }>('/api/v1/skills', {
      method: 'POST',
      body: JSON.stringify({ name, content }),
    }),

  // Tools
  getTools: (params?: { tag?: string; enabled?: 0 | 1 }) => {
    const qs = new URLSearchParams();
    if (params?.tag) qs.set('tag', params.tag);
    if (params?.enabled !== undefined) qs.set('enabled', String(params.enabled));
    const query = qs.toString();
    return apiFetch<Tool[]>(`/api/v1/tools${query ? `?${query}` : ''}`);
  },
  getTool: (id: number) => apiFetch<Tool>(`/api/v1/tools/${id}`),
  createTool: (data: Partial<Tool>) =>
    apiFetch<Tool>('/api/v1/tools', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateTool: (id: number, data: Partial<Tool>) =>
    apiFetch<Tool>(`/api/v1/tools/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteTool: (id: number) =>
    apiFetch<{ ok: boolean; id: number }>(`/api/v1/tools/${id}`, { method: 'DELETE' }),
  testTool: (id: number, input: Record<string, unknown>) =>
    apiFetch<{ output: string | null; duration_ms: number; error?: string }>(`/api/v1/tools/${id}/test`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    }),

  // Agent tool assignments
  getAgentTools: (agentId: number) =>
    apiFetch<AgentToolAssignment[]>(`/api/v1/agents/${agentId}/tools`),
  assignToolToAgent: (agentId: number, toolId: number) =>
    apiFetch<AgentToolAssignment>(`/api/v1/agents/${agentId}/tools`, {
      method: 'POST',
      body: JSON.stringify({ tool_id: toolId }),
    }),
  removeToolFromAgent: (agentId: number, toolId: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/agents/${agentId}/tools/${toolId}`, { method: 'DELETE' }),
  /** @alias assignToolToAgent — used by capabilities tool detail page */
  assignAgentTool: (agentId: number, toolId: number) =>
    apiFetch<AgentToolAssignment>(`/api/v1/agents/${agentId}/tools`, {
      method: 'POST',
      body: JSON.stringify({ tool_id: toolId }),
    }),
  /** @alias removeToolFromAgent — expects toolId, matching the API delete contract */
  unassignAgentTool: (agentId: number, toolId: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/agents/${agentId}/tools/${toolId}`, { method: 'DELETE' }),

  // MCP servers
  getMcpServers: () => apiFetch<McpServer[]>('/api/v1/mcp-servers'),
  getMcpServer: (id: number) => apiFetch<McpServer>(`/api/v1/mcp-servers/${id}`),
  createMcpServer: (data: Partial<McpServer>) =>
    apiFetch<McpServer>('/api/v1/mcp-servers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateMcpServer: (id: number, data: Partial<McpServer>) =>
    apiFetch<McpServer>(`/api/v1/mcp-servers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteMcpServer: (id: number) =>
    apiFetch<{ ok: boolean; id: number }>(`/api/v1/mcp-servers/${id}`, { method: 'DELETE' }),
  getAgentMcpServers: (agentId: number) =>
    apiFetch<AgentMcpAssignment[]>(`/api/v1/agents/${agentId}/mcp-servers`),
  assignMcpServerToAgent: (agentId: number, mcpServerId: number) =>
    apiFetch<AgentMcpAssignment>(`/api/v1/agents/${agentId}/mcp-servers`, {
      method: 'POST',
      body: JSON.stringify({ mcp_server_id: mcpServerId }),
    }),
  removeMcpServerFromAgent: (agentId: number, mcpServerId: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/agents/${agentId}/mcp-servers/${mcpServerId}`, { method: 'DELETE' }),

  // Agent skill assignments (backed by PATCH /agents/:id with skill_names array)
  assignSkillToAgent: (agentId: number, currentSkills: string[], skillName: string) =>
    apiFetch<Agent>(`/api/v1/agents/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify({ skill_names: [...currentSkills, skillName] }),
    }),
  removeSkillFromAgent: (agentId: number, currentSkills: string[], skillName: string) =>
    apiFetch<Agent>(`/api/v1/agents/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify({ skill_names: currentSkills.filter(s => s !== skillName) }),
    }),

  // Logs
  getLogs: (params?: LogParams) => {
    const qs = new URLSearchParams();
    if (params?.agent_id) qs.set('agent_id', String(params.agent_id));
    if (params?.level) qs.set('level', params.level);
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.instance_id) qs.set('instance_id', String(params.instance_id));
    const query = qs.toString();
    return apiFetch<LogEntry[]>(`/api/v1/logs${query ? `?${query}` : ''}`);
  },

  // Stats
  getStats: () => apiFetch<DashboardStats>('/api/v1/stats'),
  getCompletedRecent: (hours = 24) =>
    apiFetch<CompletedRecentResponse>(`/api/v1/tasks/completed-recent?hours=${hours}`),

  // Agent Docs
  getAgentDocs: (id: number) => apiFetch<AgentDoc[]>(`/api/v1/agents/${id}/docs`),

  // CLAUDE.md (claude-code runtime agents)
  getClaudeMd: (id: number) =>
    apiFetch<{ content: string; lastModified: string; path: string }>(`/api/v1/agents/${id}/claude-md`)
      .then(r => ({ exists: true, content: r.content, path: r.path, last_modified: r.lastModified } as ClaudeMdResult)),
  updateClaudeMd: (id: number, content: string) =>
    apiFetch<{ content: string; lastModified: string; path: string }>(`/api/v1/agents/${id}/claude-md`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }).then(r => ({ exists: true, content: r.content, path: r.path, last_modified: r.lastModified } as ClaudeMdResult)),
  regenClaudeMd: (id: number) =>
    apiFetch<{ content: string; lastModified: string; path: string }>(`/api/v1/agents/${id}/claude-md/regen`, { method: 'POST' })
      .then(r => ({ exists: true, content: r.content, path: r.path, last_modified: r.lastModified } as ClaudeMdResult)),

  // Agent Provisioning
  provisionAgent: (id: number, data?: { restart_gateway?: boolean }) =>
    apiFetch<ProvisionResult>(`/api/v1/agents/${id}/provision`, { method: 'POST', body: JSON.stringify(data ?? {}) }),
  getProvisionStatus: (id: number) =>
    apiFetch<ProvisionStatus>(`/api/v1/agents/${id}/provision-status`),
  getGatewayConfig: () =>
    apiFetch<GatewayConfig>('/api/v1/settings/gateway/config'),
  updateGatewayConfig: (data: { ws_url: string; runtime_hint: GatewayRuntimeHint; auth_token?: string | null }) =>
    apiFetch<GatewayConfig>('/api/v1/settings/gateway/config', { method: 'PUT', body: JSON.stringify(data) }),
  getGatewayStatus: () =>
    apiFetch<GatewayStatus>('/api/v1/settings/gateway/status'),
  pairGateway: () =>
    apiFetch<GatewayPairResponse>('/api/v1/settings/gateway/pair', { method: 'POST' }),
  restartGateway: () =>
    apiFetch<GatewayRestartResponse>('/api/v1/settings/gateway/restart', { method: 'POST' }),

  // Projects
  getProjects: () => apiFetch<Project[]>('/api/v1/projects'),
  getProject: (id: number) => apiFetch<Project>(`/api/v1/projects/${id}`),
  createProject: (data: Partial<Project>) =>
    apiFetch<Project>('/api/v1/projects', { method: 'POST', body: JSON.stringify(data) }),
  updateProject: (id: number, data: Partial<Project>) =>
    apiFetch<Project>(`/api/v1/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteProject: (id: number, force = false) =>
    apiFetch<{ ok: boolean }>(`/api/v1/projects/${id}${force ? '?force=true' : ''}`, { method: 'DELETE' }),
  checkProjectCascade: (id: number) =>
    apiFetch<{ active_tasks: number; running_instances: number }>(`/api/v1/projects/${id}/cascade-check`),
  // Artifacts / Workspaces
  getArtifactTree: (agentId?: number) => {
    const qs = agentId ? `?agentId=${agentId}` : '';
    return apiFetch<ArtifactTree>(`/api/v1/artifacts/tree${qs}`);
  },
  getArtifactFile: (path: string, agentId?: number) => {
    const qs = agentId ? `&agentId=${agentId}` : '';
    return apiFetch<ArtifactFile>(`/api/v1/artifacts/file?path=${encodeURIComponent(path)}${qs}`);
  },
  saveArtifactFile: (path: string, content: string, agentId?: number) => {
    const qs = agentId ? `&agentId=${agentId}` : '';
    return apiFetch<{ ok: boolean; path: string; size: number; modified: string }>(
      `/api/v1/artifacts/file?path=${encodeURIComponent(path)}${qs}`,
      { method: 'PUT', body: JSON.stringify({ content }) }
    );
  },
  deleteArtifact: (path: string, agentId?: number) => {
    const qs = agentId ? `&agentId=${agentId}` : '';
    return apiFetch<{ ok: boolean; path: string }>(
      `/api/v1/artifacts/file?path=${encodeURIComponent(path)}${qs}`,
      { method: 'DELETE' }
    );
  },
  renameArtifact: (oldPath: string, newPath: string, agentId?: number) => {
    const qs = agentId ? `?agentId=${agentId}` : '';
    return apiFetch<{ ok: boolean; oldPath: string; newPath: string }>(
      `/api/v1/artifacts/rename${qs}`,
      { method: 'POST', body: JSON.stringify({ oldPath, newPath }) }
    );
  },
  createArtifactDir: (path: string, agentId?: number) => {
    const qs = agentId ? `&agentId=${agentId}` : '';
    return apiFetch<{ ok: boolean; path: string }>(
      `/api/v1/artifacts/mkdir?path=${encodeURIComponent(path)}${qs}`,
      { method: 'POST' }
    );
  },

  // Chat
  getChatConfig: () =>
    apiFetch<ChatConfig>('/api/v1/chat/config'),
  getChatSessions: (agentId?: number, limit = 50) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (agentId) params.set('agent_id', String(agentId));
    return apiFetch<ChatSession[]>(`/api/v1/chat/sessions?${params.toString()}`);
  },
  getChatSessionMessages: (instanceId: number | null, sessionKey: string, limit = 200) => {
    const id = instanceId === null ? '0' : String(instanceId);
    const params = new URLSearchParams({ limit: String(limit) });
    if (instanceId === null) params.set('session_key', sessionKey);
    return apiFetch<ChatMessage[]>(`/api/v1/chat/sessions/${id}/messages?${params.toString()}`);
  },
  getAtlasHeartbeatStatus: () =>
    apiFetch<AtlasHeartbeatStatus>('/api/v1/chat/atlas/heartbeat/status'),
  compactAtlasHeartbeat: () =>
    apiFetch<AtlasHeartbeatMaintenanceResult>('/api/v1/chat/atlas/heartbeat/compact', { method: 'POST' }),
  resetAtlasHeartbeat: () =>
    apiFetch<AtlasHeartbeatMaintenanceResult>('/api/v1/chat/atlas/heartbeat/reset', { method: 'POST' }),

  // Canonical Sessions
  getSessions: (params?: { agent_id?: number; instance_id?: number; task_id?: number; project_id?: number; runtime?: string; status?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.agent_id) qs.set('agent_id', String(params.agent_id));
    if (params?.instance_id) qs.set('instance_id', String(params.instance_id));
    if (params?.task_id) qs.set('task_id', String(params.task_id));
    if (params?.project_id) qs.set('project_id', String(params.project_id));
    if (params?.runtime) qs.set('runtime', params.runtime);
    if (params?.status) qs.set('status', params.status);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    const query = qs.toString();
    return apiFetch<CanonicalSession[]>(`/api/v1/sessions${query ? `?${query}` : ''}`);
  },
  getSession: (id: number) =>
    apiFetch<CanonicalSession>(`/api/v1/sessions/${id}`),
  getSessionByKey: (externalKey: string) =>
    apiFetch<CanonicalSession>(`/api/v1/sessions/by-key/${encodeURIComponent(externalKey)}`),
  getSessionMessages: (sessionId: number, params?: { limit?: number; offset?: number; event_type?: string }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    if (params?.event_type) qs.set('event_type', params.event_type);
    const query = qs.toString();
    return apiFetch<CanonicalMessage[]>(`/api/v1/sessions/${sessionId}/messages${query ? `?${query}` : ''}`);
  },
  /** Ensure a canonical session exists for an instance (creates/updates it via adapter). */
  ensureSessionForInstance: (instanceId: number) =>
    apiFetch<CanonicalSession>(`/api/v1/sessions/import/instance/${instanceId}`, { method: 'POST' }),
  /** Force re-ingest a session by external key (e.g. after a run completes). */
  ingestSession: (params: { external_key: string; instance_id?: number; agent_id?: number; task_id?: number; runtime?: string }) =>
    apiFetch<CanonicalSession>('/api/v1/sessions/ingest', { method: 'POST', body: JSON.stringify(params) }),

  // Sprints
  getSprintTypes: () => apiFetch<SprintType[]>('/api/v1/sprint-types'),
  getWorkflowTemplates: (sprintType?: string, options?: { systemOnly?: boolean }) => {
    const params = new URLSearchParams();
    if (sprintType) params.set('sprint_type', sprintType);
    if (options?.systemOnly === false) params.set('system_only', 'false');
    const qs = params.toString();
    return apiFetch<{ templates: SprintWorkflowTemplate[] }>(`/api/v1/workflow-templates${qs ? `?${qs}` : ''}`);
  },
  getWorkflowConfig: () => apiFetch<WorkflowConfigResponse>('/api/v1/sprints/config'),
  createSprintType: (data: { key: string; name: string; description?: string }) =>
    apiFetch<SprintType>('/api/v1/sprints/types', { method: 'POST', body: JSON.stringify(data) }),
  updateSprintType: (key: string, data: { name?: string; description?: string }) =>
    apiFetch<SprintType>(`/api/v1/sprints/types/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSprintType: (key: string) =>
    apiFetch<{ ok: boolean }>(`/api/v1/sprints/types/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  replaceSprintTypeTaskTypes: (key: string, taskTypes: string[]) =>
    apiFetch<{ sprint_type: SprintType; task_types: SprintTypeTaskType[] }>(`/api/v1/sprints/types/${encodeURIComponent(key)}/task-types`, {
      method: 'PUT',
      body: JSON.stringify({ task_types: taskTypes }),
    }),
  createTaskFieldSchema: (key: string, data: { task_type?: string | null; schema: TaskFieldSchemaDocument }) =>
    apiFetch<TaskFieldSchema>(`/api/v1/sprints/types/${encodeURIComponent(key)}/field-schemas`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateTaskFieldSchema: (key: string, schemaId: number, data: { task_type?: string | null; schema: TaskFieldSchemaDocument }) =>
    apiFetch<TaskFieldSchema>(`/api/v1/sprints/types/${encodeURIComponent(key)}/field-schemas/${schemaId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteTaskFieldSchema: (key: string, schemaId: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/sprints/types/${encodeURIComponent(key)}/field-schemas/${schemaId}`, { method: 'DELETE' }),
  createSprintOutcome: (key: string, data: Omit<SprintTypeOutcome, 'id' | 'sprint_type_key' | 'is_system' | 'created_at' | 'updated_at'>) =>
    apiFetch<SprintTypeOutcome>(`/api/v1/sprints/types/${encodeURIComponent(key)}/outcomes`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateSprintOutcome: (key: string, outcomeId: number, data: Partial<Omit<SprintTypeOutcome, 'id' | 'sprint_type_key' | 'is_system' | 'created_at' | 'updated_at'>>) =>
    apiFetch<SprintTypeOutcome>(`/api/v1/sprints/types/${encodeURIComponent(key)}/outcomes/${outcomeId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteSprintOutcome: (key: string, outcomeId: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/sprints/types/${encodeURIComponent(key)}/outcomes/${outcomeId}`, { method: 'DELETE' }),
  createWorkflowTemplate: (key: string, data: WorkflowTemplateInput) =>
    apiFetch<SprintWorkflowTemplate>(`/api/v1/sprints/types/${encodeURIComponent(key)}/workflow-templates`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateWorkflowTemplate: (key: string, templateId: number, data: WorkflowTemplateInput) =>
    apiFetch<SprintWorkflowTemplate>(`/api/v1/sprints/types/${encodeURIComponent(key)}/workflow-templates/${templateId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteWorkflowTemplate: (key: string, templateId: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/sprints/types/${encodeURIComponent(key)}/workflow-templates/${templateId}`, { method: 'DELETE' }),
  getSprints: (projectId?: number, includeClosed?: boolean) => {
    const params = new URLSearchParams();
    if (projectId) params.set('project_id', String(projectId));
    if (includeClosed) params.set('include_closed', 'true');
    const qs = params.toString() ? `?${params.toString()}` : '';
    return apiFetch<Sprint[]>(`/api/v1/sprints${qs}`);
  },
  getSprint: (id: number) => apiFetch<Sprint>(`/api/v1/sprints/${id}`),
  createSprint: (data: Partial<Sprint>) =>
    apiFetch<Sprint>('/api/v1/sprints', { method: 'POST', body: JSON.stringify(data) }),
  updateSprint: (id: number, data: Partial<Sprint>) =>
    apiFetch<Sprint>(`/api/v1/sprints/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSprint: (id: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/sprints/${id}`, { method: 'DELETE' }),
  completeSprint: (id: number) =>
    apiFetch<Sprint>(`/api/v1/sprints/${id}/complete`, { method: 'POST' }),
  closeSprint: (id: number) =>
    apiFetch<Sprint>(`/api/v1/sprints/${id}/close`, { method: 'POST' }),
  getSprintMetrics: (id: number) => apiFetch<SprintMetrics>(`/api/v1/sprints/${id}/metrics`),
  getProjectMetrics: (id: number) => apiFetch<ProjectMetrics>(`/api/v1/projects/${id}/metrics`),

  // Project Audit History
  getProjectAudit: (id: number, params?: { entity_type?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.entity_type) qs.set('entity_type', params.entity_type);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    const query = qs.toString();
    return apiFetch<ProjectAuditEntry[]>(`/api/v1/projects/${id}/audit${query ? `?${query}` : ''}`);
  },

  // Project Files
  getProjectFiles: (projectId: number) =>
    apiFetch<ProjectFile[]>(`/api/v1/projects/${projectId}/files`),
  uploadProjectFile: async (projectId: number, file: File, uploadedBy?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    if (uploadedBy) formData.append('uploaded_by', uploadedBy);
    const res = await fetch(`${getApiBase()}/api/v1/projects/${projectId}/files`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const body = await res.text();
      let msg = `Upload failed: ${res.status}`;
      try { msg = (JSON.parse(body) as { error?: string }).error ?? msg; } catch { /* */ }
      throw new Error(msg);
    }
    return res.json() as Promise<ProjectFile>;
  },
  getProjectFileUrl: (projectId: number, fileId: number) =>
    `${getApiBase()}/api/v1/projects/${projectId}/files/${fileId}/download`,
  deleteProjectFile: (projectId: number, fileId: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/projects/${projectId}/files/${fileId}`, { method: 'DELETE' }),

  // Tasks
  getTasks: (projectId?: number, sprintId?: number) => {
    const qs = new URLSearchParams();
    if (projectId) qs.set('project_id', String(projectId));
    if (sprintId) qs.set('sprint_id', String(sprintId));
    const q = qs.toString();
    return apiFetch<Task[]>(`/api/v1/tasks${q ? `?${q}` : ''}`);
  },
  searchTasks: (q: string, excludeId?: number) => {
    const qs = new URLSearchParams({ q });
    if (excludeId != null) qs.set('exclude_id', String(excludeId));
    return apiFetch<{ id: number; title: string; status: string }[]>(`/api/v1/tasks/search?${qs}`);
  },
  getTask: (id: number) => apiFetch<Task>(`/api/v1/tasks/${id}`),
  createTask: (data: Partial<Task>) =>
    apiFetch<Task>('/api/v1/tasks', { method: 'POST', body: JSON.stringify(data) }),
  updateTask: (id: number, data: Partial<Task>) =>
    apiFetch<Task>(`/api/v1/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  resolveTaskFieldSchema: (params: { sprint_id?: number | null; task_type?: string | null }) => {
    const qs = new URLSearchParams();
    if (params.sprint_id !== undefined && params.sprint_id !== null) qs.set('sprint_id', String(params.sprint_id));
    if (params.task_type !== undefined && params.task_type !== null) qs.set('task_type', params.task_type);
    return apiFetch<ResolvedTaskFieldSchemaResponse>(`/api/v1/tasks/field-schema/resolve?${qs.toString()}`);
  },
  deleteTask: (id: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/tasks/${id}`, { method: 'DELETE' }),
  cancelTask: (id: number) =>
    apiFetch<{ ok: boolean; task: Task }>(`/api/v1/tasks/${id}/cancel`, { method: 'POST' }),
  stopTask: (id: number, reason?: string) =>
    apiFetch<{
      ok: boolean;
      had_active_run: boolean;
      already_paused: boolean;
      no_op: boolean;
      stop_result: {
        id: number;
        behavior: 'stop' | 'park' | 'requeue';
        result: 'confirmed_stopped' | 'already_gone' | 'stopped_runtime_uncertain';
        message: string;
        runtimeUncertain: boolean;
        taskId: number | null;
        taskStatusBefore: string | null;
        taskStatusAfter: string | null;
        clearedTaskLinkage: boolean;
      } | null;
      task: Task;
    }>(`/api/v1/tasks/${id}/stop`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason ?? null, changed_by: 'User' }),
    }),
  pauseTask: (id: number, reason?: string) =>
    apiFetch<{ ok: boolean; task: Task }>(`/api/v1/tasks/${id}/pause`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason ?? null }),
    }),
  unpauseTask: (id: number) =>
    apiFetch<{ ok: boolean; task: Task }>(`/api/v1/tasks/${id}/unpause`, { method: 'POST' }),
  addBlocker: (taskId: number, blockerId: number) =>
    apiFetch<Task>(`/api/v1/tasks/${taskId}/blockers`, {
      method: 'POST',
      body: JSON.stringify({ blocker_id: blockerId }),
    }),
  removeBlocker: (taskId: number, blockerId: number) =>
    apiFetch<Task>(`/api/v1/tasks/${taskId}/blockers/${blockerId}`, { method: 'DELETE' }),

  // Task Notes
  getTaskNotes: (taskId: number) =>
    apiFetch<TaskNote[]>(`/api/v1/tasks/${taskId}/notes`),
  createTaskNote: (taskId: number, data: { author: string; content: string }) =>
    apiFetch<TaskNote>(`/api/v1/tasks/${taskId}/notes`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteTaskNote: (taskId: number, noteId: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/tasks/${taskId}/notes/${noteId}`, { method: 'DELETE' }),

  // Task History
  getTaskHistory: (taskId: number) =>
    apiFetch<TaskHistory[]>(`/api/v1/tasks/${taskId}/history`),

  // Task Attachments
  getTaskAttachments: (taskId: number) =>
    apiFetch<TaskAttachment[]>(`/api/v1/tasks/${taskId}/attachments`),

  uploadTaskAttachment: async (taskId: number, file: File, uploadedBy?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    if (uploadedBy) formData.append('uploaded_by', uploadedBy);
    const res = await fetch(`${getApiBase()}/api/v1/tasks/${taskId}/attachments`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    return res.json() as Promise<TaskAttachment>;
  },

  deleteTaskAttachment: (taskId: number, attachmentId: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/tasks/${taskId}/attachments/${attachmentId}`, { method: 'DELETE' }),

  getTaskAttachmentUrl: (taskId: number, attachmentId: number) =>
    `${getApiBase()}/api/v1/tasks/${taskId}/attachments/${attachmentId}/download`,

  // Task Outcome
  submitTaskOutcome: (taskId: number, data: { outcome: string; changed_by: string; summary?: string }) =>
    apiFetch<{ ok: boolean; prior_status: string; next_status: string; outcome: string; task: Task }>(
      `/api/v1/tasks/${taskId}/outcome`,
      { method: 'POST', body: JSON.stringify(data) }
    ),
  updateReviewEvidence: (taskId: number, data: { review_branch?: string | null; review_commit?: string | null; review_url?: string | null; summary?: string; changed_by?: string }) =>
    apiFetch<Task>(`/api/v1/tasks/${taskId}/review-evidence`, { method: 'PUT', body: JSON.stringify(data) }),
  updateQaEvidence: (taskId: number, data: { qa_verified_commit?: string | null; tested_url?: string | null; summary?: string; changed_by?: string }) =>
    apiFetch<Task>(`/api/v1/tasks/${taskId}/qa-evidence`, { method: 'PUT', body: JSON.stringify(data) }),
  updateDeployEvidence: (taskId: number, data: { merged_commit?: string | null; deployed_commit?: string | null; deploy_target?: string | null; deployed_at?: string | null; summary?: string; changed_by?: string }) =>
    apiFetch<Task>(`/api/v1/tasks/${taskId}/deploy-evidence`, { method: 'PUT', body: JSON.stringify(data) }),
  updateLiveVerification: (taskId: number, data: { live_verified_by?: string | null; live_verified_at?: string | null; summary?: string; changed_by?: string }) =>
    apiFetch<Task>(`/api/v1/tasks/${taskId}/live-verification`, { method: 'PUT', body: JSON.stringify(data) }),
  backfillReleaseIntegrity: () =>
    apiFetch<{ ok: boolean; total: number; flagged: number }>(`/api/v1/tasks/backfill-release-integrity`, { method: 'POST' }),

  // Routing Config / Routing Admin
  getRoutingConfig: (projectId?: number) => {
    const qs = projectId ? `?project_id=${projectId}` : '';
    return apiFetch<RoutingConfig[]>(`/api/v1/routing-config${qs}`);
  },
  getRoutingConfigs: () =>
    apiFetch<{ configs: RoutingConfig[] }>(`/api/v1/routing/config`),
  getRoutingReconcilerConfig: () =>
    apiFetch<ReconcilerConfig>(`/api/v1/routing/reconciler-config`),
  updateRoutingReconcilerConfig: (data: ReconcilerConfig) =>
    apiFetch<ReconcilerConfig>(`/api/v1/routing/reconciler-config`, { method: 'PUT', body: JSON.stringify(data) }),
  createRoutingConfig: (data: Partial<RoutingConfig>) =>
    apiFetch<RoutingConfig>('/api/v1/routing-config', { method: 'POST', body: JSON.stringify(data) }),
  updateRoutingConfig: (id: number | null | undefined, data: Partial<RoutingConfig>) =>
    apiFetch<RoutingConfig>(`/api/v1/routing/config/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteRoutingConfig: (id: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/routing-config/${id}`, { method: 'DELETE' }),
  getRoutingStatuses: (sprintId?: number) => {
    const qs = sprintId ? `?sprint_id=${sprintId}` : '';
    return apiFetch<{ statuses: TaskStatusMeta[] }>(`/api/v1/routing/statuses${qs}`);
  },
  createRoutingStatus: (data: Partial<TaskStatusMeta> & { name: string; label: string; sprint_id?: number }) =>
    apiFetch<TaskStatusMeta>(`/api/v1/routing/statuses`, { method: 'POST', body: JSON.stringify(data) }),
  updateRoutingStatus: (name: string, data: Partial<TaskStatusMeta> & { sprint_id?: number }) =>
    apiFetch<TaskStatusMeta>(`/api/v1/routing/statuses/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteRoutingStatus: (name: string, sprintId?: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/routing/statuses/${encodeURIComponent(name)}${sprintId ? `?sprint_id=${sprintId}` : ''}`, { method: 'DELETE' }),
  getRoutingTransitions: (projectId?: number, sprintId?: number) => {
    const params = new URLSearchParams();
    if (projectId) params.set('project_id', String(projectId));
    if (sprintId) params.set('sprint_id', String(sprintId));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return apiFetch<{ transitions: RoutingTransition[] }>(`/api/v1/routing/transitions${qs}`);
  },
  createRoutingTransition: (data: Partial<RoutingTransition>) =>
    apiFetch<RoutingTransition>(`/api/v1/routing/transitions`, { method: 'POST', body: JSON.stringify(data) }),
  updateRoutingTransition: (id: number, data: Partial<RoutingTransition>) =>
    apiFetch<RoutingTransition>(`/api/v1/routing/transitions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteRoutingTransition: (id: number, sprintId?: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/routing/transitions/${id}${sprintId ? `?sprint_id=${sprintId}` : ''}`, { method: 'DELETE' }),
  getRoutingRules: (projectId?: number, sprintId?: number) => {
    const params = new URLSearchParams();
    if (projectId) params.set('project_id', String(projectId));
    if (sprintId) params.set('sprint_id', String(sprintId));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return apiFetch<{ rules: TaskRoutingRule[] }>(`/api/v1/routing/rules${qs}`);
  },
  createRoutingRule: (data: Partial<TaskRoutingRule>) =>
    apiFetch<TaskRoutingRule>(`/api/v1/routing/rules`, { method: 'POST', body: JSON.stringify(data) }),
  updateRoutingRule: (id: number, data: Partial<TaskRoutingRule>) =>
    apiFetch<TaskRoutingRule>(`/api/v1/routing/rules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteRoutingRule: (id: number, sprintId?: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/routing/rules/${id}${sprintId ? `?sprint_id=${sprintId}` : ''}`, { method: 'DELETE' }),

  // Lifecycle rules (task #612)
  getLifecycleRules: (taskType?: string) => {
    const qs = taskType ? `?task_type=${encodeURIComponent(taskType)}` : '';
    return apiFetch<{ lifecycle_rules: LifecycleRule[] }>(`/api/v1/routing/lifecycle-rules${qs}`);
  },
  createLifecycleRule: (data: Partial<LifecycleRule>) =>
    apiFetch<LifecycleRule>(`/api/v1/routing/lifecycle-rules`, { method: 'POST', body: JSON.stringify(data) }),
  updateLifecycleRule: (id: number, data: Partial<LifecycleRule>) =>
    apiFetch<LifecycleRule>(`/api/v1/routing/lifecycle-rules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteLifecycleRule: (id: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/routing/lifecycle-rules/${id}`, { method: 'DELETE' }),

  // Transition requirements (task #612)
  getTransitionRequirements: (taskType?: string, outcome?: string, sprintId?: number) => {
    const params = new URLSearchParams();
    if (taskType) params.set('task_type', taskType);
    if (outcome) params.set('outcome', outcome);
    if (sprintId) params.set('sprint_id', String(sprintId));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return apiFetch<{ transition_requirements: TransitionRequirement[] }>(`/api/v1/routing/transition-requirements${qs}`);
  },
  createTransitionRequirement: (data: Partial<TransitionRequirement>) =>
    apiFetch<TransitionRequirement>(`/api/v1/routing/transition-requirements`, { method: 'POST', body: JSON.stringify(data) }),
  updateTransitionRequirement: (id: number, data: Partial<TransitionRequirement>) =>
    apiFetch<TransitionRequirement>(`/api/v1/routing/transition-requirements/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTransitionRequirement: (id: number, sprintId?: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/routing/transition-requirements/${id}${sprintId ? `?sprint_id=${sprintId}` : ''}`, { method: 'DELETE' }),

  // ─── Chat attachments (task #658) ─────────────────────────────────────────
  uploadChatAttachment: async (file: File, agentId?: number): Promise<{ id: number; url: string; filename: string; mime_type: string; size: number }> => {
    const formData = new FormData();
    formData.append('file', file);
    if (agentId != null) formData.append('agent_id', String(agentId));
    formData.append('uploaded_by', 'user');
    const res = await fetch(`${getApiBase()}/api/v1/chat/attachments`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `Upload failed (${res.status})` }));
      throw new Error((err as Record<string, unknown>).error as string ?? `Upload failed (${res.status})`);
    }
    const data = await res.json() as { ok: boolean; attachment: { id: number; url: string; filename: string; mime_type: string; size: number } };
    return data.attachment;
  },
};

// Types
export interface ClaudeCodeRuntimeConfig {
  workingDirectory: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  allowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPromptSuffix?: string;
}

export interface Agent {
  id: number;
  name: string;
  role: string;
  system_role: string | null;
  session_key: string;
  workspace_path: string;
  /**
   * repo_path — absolute path to the canonical local repository used for worktree isolation.
   * Used only when repo_access_mode = 'worktree'.
   */
  repo_path: string | null;
  /** repo_url — remote Git URL used for task-local clone dispatch. */
  repo_url: string | null;
  /** repo_access_mode — explicit repo source mode for this agent. */
  repo_access_mode: 'worktree' | 'clone' | null;
  openclaw_agent_id: string | null;
  status: 'idle' | 'running' | 'blocked';
  model: string | null;
  /**
   * hooks_url — base URL of this agent's containerised OpenClaw instance.
   * Format: "http://localhost:<port>" or "http://<container-name>:3700".
   * When null the dispatcher uses the host gateway.
   */
  hooks_url: string | null;
  last_active: string | null;
  created_at: string;
  runtime_type: 'openclaw' | 'claude-code' | 'webhook' | 'veri';
  runtime_config: ClaudeCodeRuntimeConfig | null;
  preferred_provider: string | null;

  // Phase 4 (T#459): job-template fields merged onto agent
  job_title: string | null;
  project_id: number | null;
  project_name: string | null;
  sprint_id: number | null;
  schedule: string | null;
  dispatch_mode?: 'agentTurn' | 'systemEvent' | null;
  pre_instructions: string | null;
  skill_name: string | null;
  skill_names: string[];
  enabled: number | null;
  timeout_seconds: number | null;
  startup_grace_seconds: number | null;
  heartbeat_stale_seconds: number | null;
  /** FK to github_identities — per-agent or shared GitHub credential (T#613). */
  github_identity_id: number | null;
}

export interface JobInstance {
  id: number;
  template_id: number;
  agent_id: number;
  task_id?: number | null;
  task_title?: string | null;
  task_status?: string | null;
  job_title?: string;
  agent_name?: string;
  agent_session_key?: string;
  status: 'queued' | 'dispatched' | 'running' | 'done' | 'failed';
  dispatched_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  runtime_ended_at?: string | null;
  runtime_end_success?: number | null;
  runtime_end_error?: string | null;
  runtime_end_source?: string | null;
  lifecycle_outcome_posted_at?: string | null;
  payload_sent: string | null;
  response: string | null;
  error: string | null;
  token_input?: number | null;
  token_output?: number | null;
  token_total?: number | null;
  created_at: string;
  session_key: string | null;
  current_stage?: 'dispatch' | 'start' | 'heartbeat' | 'progress' | 'blocker' | 'completion' | null;
  last_agent_heartbeat_at?: string | null;
  last_meaningful_output_at?: string | null;
  latest_commit_hash?: string | null;
  branch_name?: string | null;
  changed_files_json?: string | null;
  changed_files_count?: number | null;
  artifact_summary?: string | null;
  blocker_reason?: string | null;
  artifact_outcome?: string | null;
  run_is_stale?: number | null;
  stale_at?: string | null;
  /** Task workflow outcome (qa_fail, blocked, completed_for_review, qa_pass, etc.) — distinct from execution status */
  task_outcome?: string | null;
  /** Model that was selected / used for this run (e.g. anthropic/claude-sonnet-4-6) */
  effective_model?: string | null;
}

export interface SkillEntry {
  id: number | null;                         // null for system-only skills
  name: string;
  source: 'atlas' | 'workspace' | 'system';
  description: string;
  files: string[];
  created_at: string | null;
  updated_at: string | null;
}

export interface SkillDetail {
  id: number | null;
  name: string;
  content: string;
  source: 'atlas' | 'workspace' | 'system';
  description: string;
  fs_path: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface Tool {
  id: number;
  name: string;
  slug: string;
  description: string;
  implementation_type: 'bash' | 'mcp' | 'function';
  implementation_body: string;
  input_schema: string; // JSON string
  permissions: string;
  tags: string; // JSON string array
  enabled: number; // 0 | 1
  created_at: string;
  updated_at: string;
}

/** @alias Tool — for backward compat with capability pages using ToolEntry */
export type ToolEntry = Tool;

export interface AgentToolAssignment {
  /** Join-table row id for this assignment. Metadata only, never pass this to DELETE. */
  assignment_id: number;
  /** Agent id owning the assignment. */
  agent_id: number;
  /** Canonical tool id for assigned-tool checks and DELETE /agents/:agentId/tools/:toolId. */
  tool_id: number;
  overrides: string; // JSON
  assignment_enabled: number;
  // Tool fields joined for a consistent agent-tool assignment contract.
  // `tool_id` is the canonical identifier used by the UI contract.
  // `id` mirrors the same tool id for backward compatibility with older consumers.
  id: number;
  name: string;
  slug: string;
  description: string;
  implementation_type: 'bash' | 'mcp' | 'function';
  permissions: string;
  tags: string;
  enabled: number;
}

export interface McpServer {
  id: number;
  name: string;
  slug: string;
  description: string;
  transport: 'stdio';
  command: string;
  args: string;
  env: string;
  cwd: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface AgentMcpAssignment {
  assignment_id: number;
  agent_id: number;
  mcp_server_id: number;
  overrides: string;
  assignment_enabled: number;
  id: number;
  name: string;
  slug: string;
  description: string;
  transport: 'stdio';
  command: string;
  args: string;
  env: string;
  cwd: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface LogEntry {
  id: number;
  instance_id: number | null;
  agent_id: number | null;
  agent_name?: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  created_at: string;
}

export interface LogParams {
  agent_id?: number;
  level?: string;
  from?: string;
  to?: string;
  limit?: number;
  instance_id?: number;
}

export interface AgentDoc {
  filename: string;
  content: string | null;
  exists: boolean;
}

export interface ProvisionResult {
  ok: boolean;
  provisioned?: boolean;
  session_key: string;
  workspace_path: string;
  workspace?: string;
  message?: string;
}

export interface GatewayRestartResponse {
  ok: boolean;
  message?: string;
  output?: string | null;
  error?: string;
  pairing_approved?: boolean;
  pairing_message?: string | null;
}

export type GatewayRuntimeHint = 'powershell' | 'wsl' | 'macos' | 'linux' | 'external';

export interface GatewayConfig {
  ok: boolean;
  ws_url: string;
  http_url: string;
  runtime_hint: GatewayRuntimeHint;
  auth_token?: string;
  auth_token_configured?: boolean;
  auth_token_source?: 'stored' | 'local' | 'none';
  source?: 'stored' | 'default';
  error?: string | null;
}

export interface GatewayStatus extends GatewayConfig {
  state: 'ready' | 'offline' | 'pairing_required' | 'auth_error' | 'timeout';
  reachable: boolean;
  pairing_required: boolean;
  checked_at: string;
  error: string | null;
}

export interface GatewayPairResponse extends GatewayStatus {
  auto_pair_supported: boolean;
  manual_required: boolean;
  pairing_approved: boolean;
  message: string | null;
}

export interface ClaudeMdResult {
  exists: boolean;
  content: string | null;
  path: string | null;
  last_modified: string | null; // ISO timestamp
}

export interface ProvisionStatus {
  provisioned: boolean;
  session_key: string | null;
  workspace_path: string | null;
}

export interface CompletedRecentTask {
  id: number;
  title: string;
  status: string;
  priority: string;
  project_id: number | null;
  project_name: string | null;
  sprint_name: string | null;
  agent_name: string | null;
  live_verified_at: string | null;
  live_verified_by: string | null;
  updated_at: string;
  completed_at: string | null;
  outcome: string | null;
}

export interface CompletedRecentResponse {
  hours: number;
  count: number;
  tasks: CompletedRecentTask[];
}

export interface DashboardStats {
  totalAgents: number;
  activeJobs: number;
  runningJobs: number;
  pendingJobs: number;
  recentRuns: number;
  failedRecent: number;
  doneRecent: number;
  enabledTemplates: number;
  todayTokenUsage: number;
  recentFailed: JobInstance[];
}

export interface Project {
  id: number;
  name: string;
  description: string;
  context_md: string;
  created_at: string;
}

export interface ProjectAuditEntry {
  id: number;
  project_id: number;
  entity_type: 'project' | 'sprint' | 'agent';
  entity_id: number;
  action: 'created' | 'updated' | 'deleted';
  actor: string;
  changes: Record<string, unknown>;
  created_at: string;
}

export interface ProjectFile {
  id: number;
  filename: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  uploaded_by: string;
}

export interface ArtifactTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: ArtifactTreeNode[];
  size?: number;
  modified?: string;
}

export interface ArtifactTree {
  root: string;
  children: ArtifactTreeNode[];
}

export interface ArtifactFile {
  path: string;
  content: string | null;
  size: number;
  modified: string;
  binary: boolean;
}

export type TaskStatus = 'todo' | 'ready' | 'dispatched' | 'in_progress' | 'review' | 'qa_pass' | 'ready_to_merge' | 'deployed' | 'done' | 'needs_attention' | 'cancelled' | 'stalled' | 'failed' | 'blocked';

export interface Task {
  id: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high';
  agent_id?: number | null;
  project_id: number | null;
  sprint_id: number | null;
  sprint_name?: string | null;
  agent_name?: string;
  recurring?: number | boolean;
  story_points?: number | null;
  branch_url?: string | null;
  active_instance_id?: number | null;
  active_instance_status?: string | null;
  active_instance_session_key?: string | null;
  active_instance_created_at?: string | null;
  active_instance_dispatched_at?: string | null;
  active_instance_started_at?: string | null;
  active_instance_completed_at?: string | null;
  active_instance_runtime_ended_at?: string | null;
  active_instance_runtime_end_success?: number | null;
  active_instance_runtime_end_error?: string | null;
  active_instance_runtime_end_source?: string | null;
  active_instance_lifecycle_outcome_posted_at?: string | null;
  active_instance_task_outcome?: string | null;
  latest_run_stage?: string | null;
  last_agent_heartbeat_at?: string | null;
  last_meaningful_output_at?: string | null;
  latest_commit_hash?: string | null;
  branch_name?: string | null;
  changed_files?: string[];
  changed_files_count?: number | null;
  latest_artifact_summary?: string | null;
  blocker_reason?: string | null;
  latest_run_outcome?: string | null;
  run_is_stale?: number | null;
  run_stale_at?: string | null;
  blockers?: Task[];
  blocking?: Task[];
  review_branch?: string | null;
  review_commit?: string | null;
  review_url?: string | null;
  qa_verified_commit?: string | null;
  qa_tested_url?: string | null;
  merged_commit?: string | null;
  deployed_commit?: string | null;
  deployed_at?: string | null;
  live_verified_at?: string | null;
  live_verified_by?: string | null;
  deploy_target?: string | null;
  evidence_json?: string | null;
  failure_class?: 'qa_failure' | 'release_failure' | 'approval_blocked' | 'env_blocked' | 'infra_failure' | 'runtime_failure' | 'unknown' | null;
  failure_detail?: string | null;
  previous_status?: string | null;
  review_owner_agent_id?: number | null;
  failure_display?: {
    label: string;
    badge: string;
    severity: 'error' | 'warning' | 'info';
  } | null;
  failure_recovery?: {
    recoveryStatus: string;
    autoRecoverable: boolean;
    recoveryDescription: string;
    preserveOwner: boolean;
  } | null;
  integrity_state?: 'clean' | 'missing_review_evidence' | 'missing_qa_evidence' | 'missing_deploy_evidence' | 'missing_live_verification' | 'invalid_done_state';
  integrity_warnings?: string[];
  release_state_badge?: 'review build' | 'qa passed' | 'ready to merge' | 'live deployed' | 'live verified' | null;
  release_state_label?: string | null;
  is_legacy_unverified_done?: boolean;
  task_type?: string | null;
  routing_reason?: string | null;
  origin_task_id?: number | null;
  origin_task_title?: string | null;
  defect_type?: string | null;
  spawned_defects?: number | null;
  custom_fields?: Record<string, unknown> | null;
  resolved_sprint_type?: string | null;
  resolved_custom_field_schema?: {
    fields?: CustomFieldDefinition[];
  } | null;
  paused_at?: string | null;
  pause_reason?: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskNote {
  id: number;
  task_id: number;
  author: string;
  content: string;
  created_at: string;
}


export interface CustomFieldDefinition {
  key: string;
  label?: string;
  type?: string;
  required?: boolean;
  options?: string[];
  help_text?: string;
}

export interface ResolvedTaskFieldSchemaResponse {
  sprint_type: string;
  allowed_task_types: string[];
  fields: CustomFieldDefinition[];
}

export interface TaskAttachment {
  id: number;
  task_id: number;
  filename: string;
  filepath: string;
  mime_type: string;
  size: number;
  uploaded_by: string;
  created_at: string;
}

export interface TaskHistory {
  id: number;
  task_id: number;
  changed_by: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

export type ChatEventType = 'text' | 'thought' | 'tool_call' | 'tool_result' | 'turn_start' | 'system' | 'error';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  event_type?: ChatEventType;
  meta?: Record<string, unknown>;
}

export interface ChatConfig {
  gatewayUrl: string;
  token: string;
}

export interface ChatSession {
  instance_id: number | null;
  session_key: string;
  agent_id: number;
  agent_name: string | null;
  message_count: number;
  started_at: string;
  last_activity: string;
  last_message: string | null;
  last_role: 'user' | 'assistant' | null;
}

export interface AtlasHeartbeatStatus {
  session_key: string;
  exists: boolean;
  display_name: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  total_tokens_fresh: boolean | null;
  updated_at: string | null;
  origin_provider: string | null;
}

export interface AtlasHeartbeatMaintenanceResult {
  ok: boolean;
  action: 'compact' | 'reset';
  session_key: string;
  status: AtlasHeartbeatStatus;
}

// ─── Canonical Sessions ───────────────────────────────────────────────────────

export type CanonicalSessionStatus = 'active' | 'completed' | 'failed' | 'abandoned';

export interface CanonicalSession {
  id: number;
  external_key: string;
  runtime: string;
  agent_id: number | null;
  task_id: number | null;
  instance_id: number | null;
  project_id: number | null;
  status: CanonicalSessionStatus;
  title: string;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  token_input: number | null;
  token_output: number | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields
  agent_name?: string | null;
  task_title?: string | null;
  project_name?: string | null;
}

export interface CanonicalMessage {
  id: number;
  session_id: number;
  ordinal: number;
  role: 'user' | 'assistant' | 'system';
  event_type: ChatEventType;
  content: string;
  event_meta: string; // JSON string
  raw_payload: string | null;
  timestamp: string;
  created_at: string;
}

export interface CanonicalSessionMessagesResponse {
  session: CanonicalSession;
  messages: CanonicalMessage[];
  total: number;
  in_progress: boolean;
}

export interface SprintType {
  key: string;
  name: string;
  description: string;
  is_system: number;
  created_at: string;
  updated_at: string;
}

export interface SprintWorkflowStatus {
  id?: number;
  status_key: string;
  label: string;
  color: string;
  stage_order: number;
  terminal: number;
  is_default_entry: number;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SprintWorkflowTransition {
  id?: number;
  from_status_key: string;
  to_status_key: string;
  transition_key: string;
  label: string;
  outcome: string | null;
  stage_order: number;
  is_system?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface WorkflowTemplateUsage {
  total_sprints: number;
  active_planning_sprints: number;
  active_planning_sprint_ids: number[];
}

export interface SprintWorkflowTemplate {
  id: number;
  sprint_type_key: string;
  key: string;
  name: string;
  description: string;
  is_default: number;
  is_system: number;
  usage?: WorkflowTemplateUsage;
  statuses: SprintWorkflowStatus[];
  transitions?: SprintWorkflowTransition[];
  created_at: string;
  updated_at: string;
}

export interface SprintTypeTaskType {
  id: number;
  sprint_type_key: string;
  task_type: string;
  is_system: number;
  created_at: string;
  updated_at: string;
}

export interface TaskFieldSchemaDocument {
  fields: CustomFieldDefinition[];
}

export interface TaskFieldSchema {
  id: number;
  sprint_type_key: string;
  task_type: string | null;
  schema: TaskFieldSchemaDocument;
  is_system: number;
  created_at: string;
  updated_at: string;
}

export interface SprintTypeOutcome {
  id: number;
  sprint_type_key: string;
  task_type: string | null;
  outcome_key: string;
  label: string;
  description: string;
  enabled: number;
  behavior: 'base' | 'extend' | 'override' | 'disable';
  color: string | null;
  badge_variant: string | null;
  stage_order: number;
  is_system: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WorkflowTemplateInput {
  key: string;
  name: string;
  description?: string;
  is_default: number;
  statuses: Array<Pick<SprintWorkflowStatus, 'status_key' | 'label' | 'color' | 'stage_order' | 'terminal' | 'is_default_entry' | 'metadata'>>;
  transitions: Array<Pick<SprintWorkflowTransition, 'from_status_key' | 'to_status_key' | 'transition_key' | 'label' | 'outcome' | 'stage_order' | 'metadata'>>;
}

export interface SprintTypeConfig extends SprintType {
  task_types: SprintTypeTaskType[];
  field_schemas: TaskFieldSchema[];
  outcomes: SprintTypeOutcome[];
  workflow_templates: SprintWorkflowTemplate[];
}

export interface WorkflowConfigResponse {
  sprint_types: SprintTypeConfig[];
}

export interface Sprint {
  id: number;
  project_id: number;
  project_name?: string;
  name: string;
  goal: string;
  sprint_type: string;
  workflow_template_key?: string | null;
  status: 'planning' | 'active' | 'paused' | 'complete' | 'closed';
  length_kind: 'time' | 'runs';
  length_value: string;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  task_count?: number;
  tasks_done?: number;
  total_story_points?: number;
  done_story_points?: number;
  remaining_story_points?: number;
}

export interface SprintAssignment extends Sprint {
  assignment_kind: 'primary' | 'attached';
  is_primary_sprint: number;
}

export interface SprintMetrics {
  sprint_id: number;
  tasks_total: number;
  tasks_done: number;
  completion_rate: number;
  total_story_points: number;
  done_story_points: number;
  remaining_story_points: number;
  job_runs_total: number;
  job_runs_success: number;
  job_runs_failed: number;
  success_rate: number;
  blocker_count: number;
  avg_task_duration_ms: number;
}

export interface ProjectMetrics extends SprintMetrics {
  project_id: number;
  sprint_count: number;
}

export interface TaskStatusMeta {
  name: string;
  label: string;
  color: string;
  terminal: boolean;
  is_system: boolean;
  allowed_transitions: string[];
}

export interface RoutingConfig {
  id: number;
  agent_id?: number | null;
  agent_name?: string | null;
  project_id: number | null;
  from_status: string;
  outcome: string;
  to_status: string;
  lane: string;
  enabled: number;
  stall_threshold_min?: number;
  max_retries?: number;
  sort_rules?: string[];
  created_at: string;
  [key: string]: any;
}

export interface ReconcilerConfig {
  needs_attention_eligible_statuses: string[];
}

export interface RoutingTransition {
  id: number;
  project_id: number | null;
  project_name?: string | null;
  sprint_id?: number | null;
  sprint_name?: string | null;
  task_type?: string | null;
  from_status: string;
  outcome: string;
  to_status: string;
  lane: string;
  enabled: number;
  priority?: number;
  /** is_protected=1: this transition is also enforced in code via evidence gates.
   *  Disabling the row suppresses data-driven routing but does NOT bypass backend enforcement. */
  is_protected?: number;
}

export interface TaskRoutingRule {
  id: number;
  project_id?: number;
  project_name?: string | null;
  sprint_id?: number | null;
  sprint_name?: string | null;
  task_type: string;
  status: string;
  agent_id: number;
  agent_name?: string | null;
  priority: number;
  created_at?: string;
  updated_at?: string;
}

export interface LifecycleRule {
  id: number;
  task_type: string | null;
  from_status: string;
  outcome: string;
  to_status: string;
  lane: string;
  enabled: number;
  priority: number;
  created_at?: string;
  updated_at?: string;
}

export interface TransitionRequirement {
  id: number;
  sprint_id?: number | null;
  task_type: string | null;
  outcome: string;
  field_name: string;
  requirement_type: 'required' | 'match' | 'from_status';
  match_field: string | null;
  severity: 'block' | 'warn';
  message: string;
  enabled: number;
  priority: number;
  created_at?: string;
  updated_at?: string;
}

export interface SetupStatus {
  hasProjects: boolean;
  hasAgents: boolean;
  has_atlas_agent?: boolean;
  onboarding_completed?: boolean;
  onboarding_provider_gate_passed?: boolean;
  connected_provider_count?: number;
}

// ─── Provider types ───────────────────────────────────────────────────────────

export type ProviderSlug = 'anthropic' | 'openai' | 'google' | 'ollama' | 'openai-codex' | 'mlx-studio' | 'minimax';

export interface ProviderRecord {
  id: number;
  slug: ProviderSlug;
  display_name: string;
  status: 'pending' | 'connected' | 'failed' | 'untested';
  config: Record<string, unknown>;
  last_validated_at: string | null;
  validation_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderListResponse {
  providers: ProviderRecord[];
  onboarding_provider_gate_passed: boolean;
  connected_count: number;
}

export interface ProviderSaveResponse extends ProviderRecord {
  validation: { ok: boolean; error: string | null };
  onboarding_provider_gate_passed: boolean;
}

export interface ProviderGateResponse {
  onboarding_provider_gate_passed: boolean;
  connected_count: number;
}
