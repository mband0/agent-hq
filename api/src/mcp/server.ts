/**
 * Agent HQ MCP Server — Main Entry Point
 *
 * Exposes Agent HQ projects, boards, tasks, and task management to any
 * MCP-compatible AI client via stdio transport.
 *
 * Architecture:
 *   AI client (stdio) -> this process -> Agent HQ REST API (localhost:3501)
 *
 * Transport: stdio (v1). No network port is opened by this server.
 * Auth: None required for v1 (local OS process isolation is sufficient).
 * Rate limit: 60 req/min by default (configurable via MCP_RATE_LIMIT_RPM).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config';
import {
  AgentHqApiClient,
  VALID_TASK_PRIORITIES,
  VALID_TASK_STATUSES,
  VALID_TASK_STORY_POINTS,
  VALID_TASK_TYPES,
} from './apiClient';
import { RateLimiter } from './rateLimiter';
import { getMcpCatalog, registerCatalogTool } from './catalog';

const cfg = loadConfig();
const api = new AgentHqApiClient(cfg.apiUrl);
const limiter = new RateLimiter(cfg.rateLimitRpm);

console.error(
  `[agent-hq-mcp] Starting, API: ${cfg.apiUrl} | Rate limit: ${cfg.rateLimitRpm} req/min`,
);

const server = new McpServer({
  name: 'agent-hq',
  version: '1.0.0',
});

function wrap<T>(
  fn: () => Promise<T>,
): () => Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  return async () => {
    if (!limiter.allow()) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: `Rate limit exceeded. Maximum ${cfg.rateLimitRpm} requests per minute.`,
            }),
          },
        ],
      };
    }
    try {
      const result = await fn();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data: result }) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message }) }],
      };
    }
  };
}

function registerTool(
  names: string[],
  description: string,
  schema: Record<string, z.ZodTypeAny>,
  handler: (args: any) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
  options?: { domain?: string; rest_paths?: string[] },
) {
  for (const name of names) {
    server.tool(name, description, schema, handler);
  }
  registerCatalogTool({
    names,
    description,
    schema,
    domain: options?.domain ?? 'general',
    rest_paths: options?.rest_paths,
  });
}

function registerResource(names: Array<{ id: string; uri: string }>, textFactory: () => Promise<string> | string) {
  for (const { id, uri } of names) {
    server.resource(id, uri, async () => ({
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: await textFactory(),
        },
      ],
    }));
  }
}

registerTool(
  ['agent_hq_get_projects', 'atlas_get_projects', 'agent_hq_list_projects', 'atlas_list_projects'],
  'List Agent HQ projects with clean summary fields.',
  {},
  () => wrap(() => api.listProjects())(),
  { domain: 'projects', rest_paths: ['/api/v1/projects'] },
);

registerTool(
  ['agent_hq_get_project', 'atlas_get_project'],
  'Get a project by ID, including metrics.',
  { project_id: z.number().int().positive().describe('Project ID') },
  ({ project_id }) => wrap(() => api.getProject(project_id))(),
  { domain: 'projects', rest_paths: ['/api/v1/projects/:id'] },
);

registerTool(
  ['agent_hq_create_project', 'atlas_create_project'],
  'Create a project in Agent HQ.',
  {
    name: z.string().min(1).describe('Project name'),
    description: z.string().optional().describe('Project description'),
    context_md: z.string().optional().describe('Project context markdown'),
  },
  ({ name, description, context_md }) => wrap(() => api.createProject({ name, description, context_md }))(),
  { domain: 'projects', rest_paths: ['/api/v1/projects'] },
);

registerTool(
  ['agent_hq_update_project', 'atlas_update_project'],
  'Update a project in Agent HQ.',
  {
    project_id: z.number().int().positive().describe('Project ID'),
    name: z.string().min(1).optional().describe('Project name'),
    description: z.string().optional().describe('Project description'),
    context_md: z.string().optional().describe('Project context markdown'),
  },
  ({ project_id, name, description, context_md }) => wrap(() => api.updateProject(project_id, { name, description, context_md }))(),
  { domain: 'projects', rest_paths: ['/api/v1/projects/:id'] },
);

registerTool(
  ['agent_hq_delete_project', 'atlas_delete_project'],
  'Delete a project. Returns truthful validation errors when active work blocks deletion unless force=true is passed.',
  {
    project_id: z.number().int().positive().describe('Project ID'),
    force: z.boolean().optional().describe('Force delete even if active work exists'),
  },
  ({ project_id, force }) => wrap(() => api.deleteProject(project_id, force))(),
  { domain: 'projects', rest_paths: ['/api/v1/projects/:id'] },
);

registerTool(
  ['agent_hq_get_sprints', 'atlas_get_sprints', 'agent_hq_list_sprints', 'atlas_list_sprints'],
  'List Agent HQ sprints. Optionally filter by project.',
  {
    project_id: z.number().int().positive().optional().describe('Filter by project ID'),
    include_closed: z.boolean().optional().describe('Include closed sprints (default false)'),
  },
  ({ project_id, include_closed }) => wrap(() => api.listSprints({ project_id, include_closed }))(),
  { domain: 'sprints', rest_paths: ['/api/v1/sprints'] },
);

registerTool(
  ['agent_hq_get_sprint', 'atlas_get_sprint'],
  'Get sprint detail and metrics.',
  { sprint_id: z.number().int().positive().describe('Sprint ID') },
  ({ sprint_id }) => wrap(() => api.getSprint(sprint_id))(),
  { domain: 'sprints', rest_paths: ['/api/v1/sprints/:id'] },
);

registerTool(
  ['agent_hq_update_sprint', 'atlas_update_sprint'],
  'Update a sprint in Agent HQ. Project reassignment is passed through truthfully and will fail clearly if the backend rejects it.',
  {
    sprint_id: z.number().int().positive().describe('Sprint ID'),
    project_id: z.number().int().positive().optional().describe('Optional project reassignment request'),
    name: z.string().min(1).optional().describe('Sprint name'),
    goal: z.string().optional().describe('Sprint goal'),
    sprint_type: z.string().optional().describe('Sprint type key'),
    workflow_template_key: z.string().nullable().optional().describe('Workflow template key'),
    status: z.enum(['planning', 'active', 'paused', 'complete', 'closed']).optional().describe('Sprint status'),
    length_kind: z.enum(['time', 'runs']).optional().describe('Sprint length kind'),
    length_value: z.string().optional().describe('Sprint length value'),
    started_at: z.string().nullable().optional().describe('Sprint start timestamp'),
    ended_at: z.string().nullable().optional().describe('Sprint end timestamp'),
  },
  ({ sprint_id, ...patch }) => wrap(() => api.updateSprint(sprint_id, patch))(),
  { domain: 'sprints', rest_paths: ['/api/v1/sprints/:id'] },
);

registerTool(
  ['agent_hq_delete_sprint', 'atlas_delete_sprint'],
  'Delete a sprint in Agent HQ.',
  { sprint_id: z.number().int().positive().describe('Sprint ID') },
  ({ sprint_id }) => wrap(() => api.deleteSprint(sprint_id))(),
  { domain: 'sprints', rest_paths: ['/api/v1/sprints/:id'] },
);

registerTool(
  ['agent_hq_get_tasks', 'atlas_get_tasks', 'agent_hq_list_tasks', 'atlas_list_tasks'],
  'List Agent HQ tasks with optional filtering.',
  {
    project_id: z.number().int().positive().optional().describe('Filter by project ID'),
    sprint_id: z.number().int().positive().optional().describe('Filter by sprint ID'),
    status: z.string().optional().describe('Task status filter'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default 50, max 100)'),
    offset: z.number().int().min(0).optional().describe('Pagination offset (default 0)'),
  },
  ({ project_id, sprint_id, status, limit, offset }) =>
    wrap(() => api.listTasks({ project_id, sprint_id, status, limit, offset }))(),
);

registerTool(
  ['agent_hq_get_task_detail', 'atlas_get_task_detail', 'agent_hq_get_task', 'atlas_get_task'],
  'Get full task detail including blocker, sprint, and assignment context.',
  { task_id: z.number().int().positive().describe('Task ID') },
  ({ task_id }) => wrap(() => api.getTask(task_id))(),
);

registerTool(
  ['agent_hq_delete_task', 'atlas_delete_task'],
  'Delete a task from Agent HQ.',
  {
    task_id: z.number().int().positive().describe('Task ID'),
    deleted_by: z.string().optional().describe('Audit label for the delete operation'),
  },
  ({ task_id, deleted_by }) => wrap(() => api.deleteTask(task_id, deleted_by))(),
  { domain: 'tasks', rest_paths: ['/api/v1/tasks/:id'] },
);

registerTool(
  ['agent_hq_get_task_notes', 'atlas_get_task_notes'],
  'Get notes/comments for a task.',
  { task_id: z.number().int().positive().describe('Task ID') },
  ({ task_id }) => wrap(() => api.getTaskNotes(task_id))(),
);

registerTool(
  ['agent_hq_get_task_history', 'atlas_get_task_history'],
  'Get task history entries for a task.',
  { task_id: z.number().int().positive().describe('Task ID') },
  ({ task_id }) => wrap(() => api.getTaskHistory(task_id))(),
);

registerTool(
  ['agent_hq_list_jobs', 'atlas_list_jobs'],
  'List agents (formerly jobs). Optionally filter by project.',
  { project_id: z.number().int().positive().optional().describe('Filter by project ID') },
  ({ project_id }) => wrap(() => api.listAgents(project_id ? { project_id } : undefined))(),
);

registerTool(
  ['agent_hq_list_agents', 'atlas_list_agents'],
  'List registered agents in Agent HQ.',
  {},
  () => wrap(() => api.listAgents())(),
);

registerTool(
  ['agent_hq_api_request', 'atlas_api_request'],
  'Advanced JSON-only Agent HQ REST request tool. Path must start with /api/v1/. Use this when no typed MCP tool exists yet.',
  {
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).describe('HTTP method'),
    path: z.string().min(1).describe('Absolute API path starting with /api/v1/'),
    body: z.unknown().optional().describe('Optional JSON body for POST/PUT requests'),
  },
  ({ method, path, body }) => wrap(() => api.apiRequest(method, path, body))(),
  { domain: 'advanced', rest_paths: ['/api/v1/*'] },
);

registerTool(
  ['agent_hq_get_agent', 'atlas_get_agent'],
  'Get a single agent by ID.',
  { agent_id: z.number().int().positive().describe('Agent ID') },
  ({ agent_id }) => wrap(() => api.getAgent(agent_id))(),
);

registerTool(
  ['agent_hq_create_agent', 'atlas_create_agent'],
  'Create a new agent.',
  {
    name: z.string().min(1).describe('Agent name'),
    role: z.string().optional().describe('Role label'),
    session_key: z.string().optional().describe('Session key for openclaw agents'),
    workspace_path: z.string().optional().describe('Workspace path'),
    status: z.string().optional().describe('Initial status'),
    provision_openclaw: z.boolean().optional().describe('Provision an OpenClaw-native agent'),
    runtime_type: z.string().optional().describe('Runtime type'),
    runtime_config: z.unknown().optional().describe('Runtime config object'),
    project_id: z.number().int().positive().nullable().optional().describe('Project association'),
    preferred_provider: z.string().nullable().optional().describe('Preferred model provider'),
    model: z.string().nullable().optional().describe('Preferred model'),
    system_role: z.string().nullable().optional().describe('Reserved built-in system role'),
  },
  (args) => wrap(() => api.createAgent(args))(),
);

registerTool(
  ['agent_hq_provision_full_agent', 'atlas_provision_full_agent'],
  'Atomically create and fully provision an OpenClaw agent, including workspace docs, OpenClaw registration, routing, and optional capability assignments.',
  {
    name: z.string().min(1).describe('Agent name'),
    role: z.string().nullable().optional().describe('Role label'),
    session_key: z.string().optional().describe('Explicit session key override'),
    workspace_path: z.string().optional().describe('Explicit workspace path override'),
    repo_path: z.string().nullable().optional().describe('Git repo/worktree source path'),
    status: z.string().optional().describe('Initial status'),
    runtime_type: z.literal('openclaw').optional().describe('Runtime type, currently openclaw only'),
    runtime_config: z.unknown().nullable().optional().describe('Optional runtime config object'),
    project_id: z.number().int().positive().nullable().optional().describe('Project association'),
    preferred_provider: z.string().nullable().optional().describe('Preferred model provider'),
    model: z.string().nullable().optional().describe('Preferred model'),
    system_role: z.string().nullable().optional().describe('Reserved built-in system role'),
    hooks_url: z.string().nullable().optional().describe('Optional hooks base URL'),
    hooks_auth_header: z.string().nullable().optional().describe('Optional hooks auth header'),
    os_user: z.string().nullable().optional().describe('Dedicated OS user'),
    enabled: z.union([z.number().int(), z.boolean()]).optional().describe('Enabled flag'),
    github_identity_id: z.number().int().positive().nullable().optional().describe('Optional GitHub identity'),
    job_title: z.string().optional().describe('Primary job title'),
    schedule: z.string().optional().describe('Primary schedule/cron'),
    pre_instructions: z.string().optional().describe('Pre-run instructions'),
    skill_names: z.array(z.string()).optional().describe('Assigned skills'),
    timeout_seconds: z.number().int().positive().nullable().optional().describe('Run timeout in seconds'),
    startup_grace_seconds: z.number().int().positive().nullable().optional().describe('Startup grace override'),
    heartbeat_stale_seconds: z.number().int().positive().nullable().optional().describe('Heartbeat stale override'),
    stall_threshold_min: z.number().int().min(1).optional().describe('Stall threshold in minutes'),
    max_retries: z.number().int().min(0).optional().describe('Max retries'),
    sort_rules: z.array(z.string()).optional().describe('Routing sort rules'),
    openclaw_agent_id: z.string().optional().describe('Explicit OpenClaw runtime slug'),
    routing_rules: z.array(z.object({
      task_type: z.enum(VALID_TASK_TYPES).describe('Task type'),
      status: z.string().min(1).describe('Route status'),
      priority: z.number().int().optional().describe('Rule priority'),
    })).optional().describe('Task routing rules to create'),
    tool_ids: z.array(z.number().int().positive()).optional().describe('Tool IDs to assign'),
    mcp_server_ids: z.array(z.number().int().positive()).optional().describe('MCP server IDs to assign'),
    reflection: z.object({
      enabled: z.boolean().optional().describe('Enable weekly reflection schedule'),
      schedule: z.string().optional().describe('Reflection cron expression'),
    }).optional().describe('Reflection scheduling preferences'),
    restart_gateway: z.boolean().optional().describe('Restart the OpenClaw gateway after registration'),
  },
  (args) => wrap(() => api.provisionFullAgent(args))(),
);

registerTool(
  ['agent_hq_update_agent', 'atlas_update_agent'],
  'Update an agent. Any provided field is passed through to the Agent HQ API.',
  {
    agent_id: z.number().int().positive().describe('Agent ID'),
    patch: z.record(z.string(), z.unknown()).describe('Partial update payload'),
  },
  ({ agent_id, patch }) => wrap(() => api.updateAgent(agent_id, patch))(),
);

registerTool(
  ['agent_hq_delete_agent', 'atlas_delete_agent'],
  'Delete an agent by ID.',
  { agent_id: z.number().int().positive().describe('Agent ID') },
  ({ agent_id }) => wrap(() => api.deleteAgent(agent_id))(),
);

registerTool(
  ['agent_hq_get_agent_docs', 'atlas_get_agent_docs'],
  'Read the docs bundle for an agent workspace.',
  { agent_id: z.number().int().positive().describe('Agent ID') },
  ({ agent_id }) => wrap(() => api.getAgentDocs(agent_id))(),
);

registerTool(
  ['agent_hq_sync_agent_mcp', 'atlas_sync_agent_mcp'],
  'Force re-materialization of the effective OpenClaw MCP config for an agent workspace.',
  {
    agent_id: z.number().int().positive().describe('Agent ID'),
    working_directory: z.string().optional().describe('Optional working directory override'),
  },
  ({ agent_id, working_directory }) => wrap(() => api.syncAgentMcp(agent_id, working_directory))(),
);

registerTool(
  ['agent_hq_list_tools', 'atlas_list_tools'],
  'List all Atlas HQ tools in the registry.',
  {},
  () => wrap(() => api.listTools())(),
);

registerTool(
  ['agent_hq_get_tool', 'atlas_get_tool'],
  'Get a tool definition by ID.',
  { tool_id: z.number().int().positive().describe('Tool ID') },
  ({ tool_id }) => wrap(() => api.getTool(tool_id))(),
);

registerTool(
  ['agent_hq_create_tool', 'atlas_create_tool'],
  'Create a tool in the Atlas HQ registry.',
  {
    name: z.string().min(1).describe('Tool name'),
    slug: z.string().min(1).describe('Unique tool slug'),
    description: z.string().optional().describe('Tool description'),
    implementation_type: z.string().min(1).describe('Implementation type'),
    implementation_body: z.string().optional().describe('Implementation body'),
    input_schema: z.unknown().optional().describe('JSON schema object'),
    permissions: z.string().optional().describe('Permission label'),
    tags: z.array(z.string()).optional().describe('Tool tags'),
    enabled: z.boolean().optional().describe('Enabled flag'),
  },
  (args) => wrap(() => api.createTool(args))(),
);

registerTool(
  ['agent_hq_update_tool', 'atlas_update_tool'],
  'Update an Atlas HQ tool definition.',
  {
    tool_id: z.number().int().positive().describe('Tool ID'),
    patch: z.record(z.string(), z.unknown()).describe('Partial update payload'),
  },
  ({ tool_id, patch }) => wrap(() => api.updateTool(tool_id, patch))(),
);

registerTool(
  ['agent_hq_delete_tool', 'atlas_delete_tool'],
  'Soft-delete an Atlas HQ tool.',
  { tool_id: z.number().int().positive().describe('Tool ID') },
  ({ tool_id }) => wrap(() => api.deleteTool(tool_id))(),
);

registerTool(
  ['agent_hq_test_tool', 'atlas_test_tool'],
  'Run a tool test with sample input.',
  {
    tool_id: z.number().int().positive().describe('Tool ID'),
    input: z.record(z.string(), z.unknown()).describe('Sample tool input object'),
  },
  ({ tool_id, input }) => wrap(() => api.testTool(tool_id, input))(),
);

registerTool(
  ['agent_hq_list_agent_tools', 'atlas_list_agent_tools'],
  'List all tools assigned to an agent.',
  { agent_id: z.number().int().positive().describe('Agent ID') },
  ({ agent_id }) => wrap(() => api.listAgentTools(agent_id))(),
);

registerTool(
  ['agent_hq_assign_tool_to_agent', 'atlas_assign_tool_to_agent'],
  'Assign a registry tool to an agent.',
  {
    agent_id: z.number().int().positive().describe('Agent ID'),
    tool_id: z.number().int().positive().describe('Tool ID'),
    overrides: z.record(z.string(), z.unknown()).optional().describe('Assignment overrides'),
    enabled: z.boolean().optional().describe('Assignment enabled flag'),
  },
  ({ agent_id, tool_id, overrides, enabled }) => wrap(() => api.assignToolToAgent(agent_id, tool_id, overrides, enabled))(),
);

registerTool(
  ['agent_hq_remove_tool_from_agent', 'atlas_remove_tool_from_agent'],
  'Remove a tool assignment from an agent.',
  {
    agent_id: z.number().int().positive().describe('Agent ID'),
    tool_id: z.number().int().positive().describe('Tool ID'),
  },
  ({ agent_id, tool_id }) => wrap(() => api.removeToolFromAgent(agent_id, tool_id))(),
);

registerTool(
  ['agent_hq_list_skills', 'atlas_list_skills'],
  'List Atlas-managed skills.',
  {},
  () => wrap(() => api.listSkills())(),
);

registerTool(
  ['agent_hq_get_skill', 'atlas_get_skill'],
  'Get a skill by name.',
  { name: z.string().min(1).describe('Skill name') },
  ({ name }) => wrap(() => api.getSkill(name))(),
);

registerTool(
  ['agent_hq_create_skill', 'atlas_create_skill'],
  'Create a new Atlas-managed skill.',
  {
    name: z.string().min(1).describe('Skill name'),
    description: z.string().optional().describe('Optional description'),
    content: z.string().optional().describe('SKILL.md content'),
  },
  ({ name, description, content }) => wrap(() => api.createSkill({ name, description, content }))(),
);

registerTool(
  ['agent_hq_update_skill', 'atlas_update_skill'],
  'Replace a skill\'s SKILL.md content.',
  {
    name: z.string().min(1).describe('Skill name'),
    content: z.string().min(1).describe('New SKILL.md content'),
  },
  ({ name, content }) => wrap(() => api.updateSkill(name, content))(),
);

registerTool(
  ['agent_hq_delete_skill', 'atlas_delete_skill'],
  'Delete an Atlas-managed skill.',
  { name: z.string().min(1).describe('Skill name') },
  ({ name }) => wrap(() => api.deleteSkill(name))(),
);

registerTool(
  ['agent_hq_list_mcp_servers', 'atlas_list_mcp_servers'],
  'List MCP servers in the Atlas HQ registry.',
  {},
  () => wrap(() => api.listMcpServers())(),
);

registerTool(
  ['agent_hq_get_mcp_server', 'atlas_get_mcp_server'],
  'Get an MCP server by ID.',
  { mcp_server_id: z.number().int().positive().describe('MCP server ID') },
  ({ mcp_server_id }) => wrap(() => api.getMcpServer(mcp_server_id))(),
);

registerTool(
  ['agent_hq_create_mcp_server', 'atlas_create_mcp_server'],
  'Create an MCP server entry.',
  {
    name: z.string().min(1).describe('Display name'),
    slug: z.string().min(1).describe('Unique slug'),
    description: z.string().optional().describe('Description'),
    transport: z.string().optional().describe('Transport, currently stdio'),
    command: z.string().min(1).describe('Executable path'),
    args: z.array(z.string()).optional().describe('Command args'),
    env: z.record(z.string(), z.string()).optional().describe('Environment variables'),
    cwd: z.string().optional().describe('Working directory'),
    enabled: z.boolean().optional().describe('Enabled flag'),
  },
  (args) => wrap(() => api.createMcpServer(args))(),
);

registerTool(
  ['agent_hq_update_mcp_server', 'atlas_update_mcp_server'],
  'Update an MCP server entry.',
  {
    mcp_server_id: z.number().int().positive().describe('MCP server ID'),
    patch: z.record(z.string(), z.unknown()).describe('Partial update payload'),
  },
  ({ mcp_server_id, patch }) => wrap(() => api.updateMcpServer(mcp_server_id, patch))(),
);

registerTool(
  ['agent_hq_delete_mcp_server', 'atlas_delete_mcp_server'],
  'Disable an MCP server entry.',
  { mcp_server_id: z.number().int().positive().describe('MCP server ID') },
  ({ mcp_server_id }) => wrap(() => api.deleteMcpServer(mcp_server_id))(),
);

registerTool(
  ['agent_hq_list_agent_mcp_servers', 'atlas_list_agent_mcp_servers'],
  'List MCP servers assigned to an agent.',
  { agent_id: z.number().int().positive().describe('Agent ID') },
  ({ agent_id }) => wrap(() => api.listAgentMcpServers(agent_id))(),
);

registerTool(
  ['agent_hq_assign_mcp_server_to_agent', 'atlas_assign_mcp_server_to_agent'],
  'Assign an MCP server to an agent.',
  {
    agent_id: z.number().int().positive().describe('Agent ID'),
    mcp_server_id: z.number().int().positive().describe('MCP server ID'),
    overrides: z.record(z.string(), z.unknown()).optional().describe('Assignment overrides'),
    enabled: z.boolean().optional().describe('Assignment enabled flag'),
  },
  ({ agent_id, mcp_server_id, overrides, enabled }) =>
    wrap(() => api.assignMcpServerToAgent(agent_id, mcp_server_id, overrides, enabled))(),
);

registerTool(
  ['agent_hq_remove_mcp_server_from_agent', 'atlas_remove_mcp_server_from_agent'],
  'Remove an MCP server assignment from an agent.',
  {
    agent_id: z.number().int().positive().describe('Agent ID'),
    mcp_server_id: z.number().int().positive().describe('MCP server ID'),
  },
  ({ agent_id, mcp_server_id }) => wrap(() => api.removeMcpServerFromAgent(agent_id, mcp_server_id))(),
);

const storyPointsSchema = z
  .union(
    VALID_TASK_STORY_POINTS.map((value) => z.literal(value)) as [
      z.ZodLiteral<1>,
      z.ZodLiteral<2>,
      z.ZodLiteral<3>,
      z.ZodLiteral<5>,
      z.ZodLiteral<8>,
      z.ZodLiteral<13>,
      z.ZodLiteral<21>,
    ],
  )
  .nullable()
  .optional();

registerTool(
  ['agent_hq_create_task', 'atlas_create_task'],
  'Create a new task in Agent HQ, with optional assignment, blockers, and dry-run preview.',
  {
    title: z.string().min(1).describe('Task title (required)'),
    project_id: z.number().int().positive().describe('Project ID (required)'),
    description: z.string().optional().describe('Task description (markdown supported)'),
    sprint_id: z.number().int().positive().nullable().optional().describe('Sprint ID to place the task in'),
    priority: z.enum(VALID_TASK_PRIORITIES).optional().describe('Priority (default: medium)'),
    task_type: z.enum(VALID_TASK_TYPES).optional().describe('Task type (default: backend)'),
    story_points: storyPointsSchema.describe('Story points: 1, 2, 3, 5, 8, 13, or 21'),
    agent_id: z.number().int().positive().nullable().optional().describe('Assign the task to an agent'),
    blockers: z.array(z.number().int().positive()).optional().describe('Task IDs that block this task'),
    dry_run: z.boolean().optional().describe('Return a mutation preview without writing data'),
  },
  ({ title, project_id, description, sprint_id, priority, task_type, story_points, agent_id, blockers, dry_run }) =>
    wrap(() =>
      api.createTask({
        title,
        project_id,
        description,
        sprint_id,
        priority,
        task_type,
        story_points,
        agent_id,
        blockers,
        dry_run,
      }),
    )(),
);

registerTool(
  ['agent_hq_update_task', 'atlas_update_task'],
  'Update editable fields on an existing task, including sprint and assignment, with optional dry-run preview.',
  {
    task_id: z.number().int().positive().describe('Task ID (required)'),
    title: z.string().min(1).optional().describe('New title'),
    description: z.string().optional().describe('New description'),
    priority: z.enum(VALID_TASK_PRIORITIES).optional().describe('New priority'),
    sprint_id: z.number().int().positive().nullable().optional().describe('Move to a different sprint, or null to clear'),
    task_type: z.enum(VALID_TASK_TYPES).optional().describe('New task type'),
    story_points: storyPointsSchema.describe('New story point estimate'),
    agent_id: z.number().int().positive().nullable().optional().describe('Assign to a different agent, or null to clear'),
    dry_run: z.boolean().optional().describe('Return a mutation preview without writing data'),
  },
  ({ task_id, title, description, priority, sprint_id, task_type, story_points, agent_id, dry_run }) =>
    wrap(() => api.updateTask(task_id, { title, description, priority, sprint_id, task_type, story_points, agent_id, dry_run }))(),
);

registerTool(
  ['agent_hq_move_task', 'atlas_move_task'],
  'Move a task to a new status. Uses outcome semantics for gated workflow states and supports dry-run preview.',
  {
    task_id: z.number().int().positive().describe('Task ID (required)'),
    status: z.enum(VALID_TASK_STATUSES).describe('Target status (required)'),
    summary: z.string().optional().describe('Optional summary for outcome-based moves'),
    review_branch: z.string().optional().describe('Review branch for review transition'),
    review_commit: z.string().optional().describe('Review commit for review transition'),
    review_url: z.string().optional().describe('Review URL for review transition'),
    qa_verified_commit: z.string().optional().describe('QA verified commit for qa_pass transition'),
    qa_tested_url: z.string().optional().describe('QA tested URL for qa_pass transition'),
    merged_commit: z.string().optional().describe('Merged commit for deployed transition'),
    deployed_commit: z.string().optional().describe('Deployed commit for deployed/done transition'),
    deploy_target: z.string().optional().describe('Deploy target for deployed transition'),
    deployed_at: z.string().optional().describe('Deploy timestamp for deployed transition'),
    live_verified_by: z.string().optional().describe('Verifier identity for done transition'),
    live_verified_at: z.string().optional().describe('Verification timestamp for done transition'),
    failure_class: z.string().optional().describe('Failure class when moving through a failed outcome'),
    failure_detail: z.string().optional().describe('Failure detail when moving through a failed outcome'),
    dry_run: z.boolean().optional().describe('Return a mutation preview without writing data'),
  },
  ({ task_id, status, summary, review_branch, review_commit, review_url, qa_verified_commit, qa_tested_url, merged_commit, deployed_commit, deploy_target, deployed_at, live_verified_by, live_verified_at, failure_class, failure_detail, dry_run }) =>
    wrap(() =>
      api.moveTask(task_id, {
        status,
        summary,
        review_branch,
        review_commit,
        review_url,
        qa_verified_commit,
        qa_tested_url,
        merged_commit,
        deployed_commit,
        deploy_target,
        deployed_at,
        live_verified_by,
        live_verified_at,
        failure_class,
        failure_detail,
        dry_run,
      }),
    )(),
);

registerTool(
  ['agent_hq_add_task_note', 'atlas_add_task_note'],
  'Add a note or comment to a task.',
  {
    task_id: z.number().int().positive().describe('Task ID (required)'),
    content: z.string().min(1).describe('Note content (required)'),
    author: z.string().optional().describe('Author label (default: mcp-client)'),
  },
  ({ task_id, content, author }) => wrap(() => api.addTaskNote(task_id, content, author ?? 'mcp-client'))(),
);

registerTool(
  ['agent_hq_add_blocker', 'atlas_add_blocker'],
  'Mark a task as blocked by another task, with optional dry-run preview.',
  {
    task_id: z.number().int().positive().describe('The task to mark as blocked (required)'),
    blocked_by_task_id: z.number().int().positive().describe('The task that is blocking it (required)'),
    dry_run: z.boolean().optional().describe('Return a mutation preview without writing data'),
  },
  ({ task_id, blocked_by_task_id, dry_run }) => wrap(() => api.addBlocker(task_id, blocked_by_task_id, dry_run))(),
);

registerTool(
  ['agent_hq_remove_blocker', 'atlas_remove_blocker'],
  'Remove a blocker relationship from a task.',
  {
    task_id: z.number().int().positive().describe('The blocked task (required)'),
    blocker_id: z.number().int().positive().describe('The blocker record ID to remove (required)'),
  },
  ({ task_id, blocker_id }) => wrap(() => api.removeBlocker(task_id, blocker_id))(),
);

registerTool(
  ['agent_hq_create_sprint', 'atlas_create_sprint'],
  'Create a new sprint in Agent HQ, with optional dry-run preview.',
  {
    project_id: z.number().int().positive().describe('Project ID (required)'),
    name: z.string().min(1).describe('Sprint name (required)'),
    goal: z.string().optional().describe('Sprint goal'),
    sprint_type: z.string().optional().describe('Sprint type key'),
    workflow_template_key: z.string().nullable().optional().describe('Workflow template key'),
    status: z.enum(['planning', 'active', 'paused', 'complete', 'closed']).optional().describe('Initial sprint status'),
    length_kind: z.enum(['time', 'runs']).optional().describe('Sprint length kind'),
    length_value: z.string().optional().describe('Sprint length value, e.g. 2w or 10'),
    started_at: z.string().nullable().optional().describe('Sprint start timestamp'),
    dry_run: z.boolean().optional().describe('Return a mutation preview without writing data'),
  },
  ({ project_id, name, goal, sprint_type, workflow_template_key, status, length_kind, length_value, started_at, dry_run }) =>
    wrap(() => api.createSprint({ project_id, name, goal, sprint_type, workflow_template_key, status, length_kind, length_value, started_at, dry_run }))(),
  { domain: 'sprints', rest_paths: ['/api/v1/sprints'] },
);

registerTool(
  ['agent_hq_list_routing_rules', 'atlas_list_routing_rules'],
  'List task routing rules for a sprint.',
  { sprint_id: z.number().int().positive().describe('Sprint ID') },
  ({ sprint_id }) => wrap(() => api.listRoutingRules(sprint_id))(),
  { domain: 'routing_rules', rest_paths: ['/api/v1/routing/rules', '/api/v1/routing-rules'] },
);

registerTool(
  ['agent_hq_get_routing_rule', 'atlas_get_routing_rule'],
  'Get a single task routing rule by ID within a sprint.',
  {
    rule_id: z.number().int().positive().describe('Routing rule ID'),
    sprint_id: z.number().int().positive().describe('Sprint ID'),
  },
  ({ rule_id, sprint_id }) => wrap(() => api.getRoutingRule(rule_id, sprint_id))(),
  { domain: 'routing_rules', rest_paths: ['/api/v1/routing/rules/:id', '/api/v1/routing-rules/:id'] },
);

registerTool(
  ['agent_hq_create_routing_rule', 'atlas_create_routing_rule'],
  'Create a task routing rule for a sprint.',
  {
    sprint_id: z.number().int().positive().describe('Sprint ID'),
    task_type: z.enum(VALID_TASK_TYPES).describe('Task type'),
    status: z.string().min(1).describe('Task status'),
    agent_id: z.number().int().positive().optional().describe('Canonical agent target'),
    job_id: z.number().int().positive().optional().describe('Legacy compat alias for agent_id'),
    priority: z.number().int().optional().describe('Rule priority'),
  },
  (args) => wrap(() => api.createRoutingRule(args))(),
  { domain: 'routing_rules', rest_paths: ['/api/v1/routing/rules', '/api/v1/routing-rules'] },
);

registerTool(
  ['agent_hq_update_routing_rule', 'atlas_update_routing_rule'],
  'Update a task routing rule for a sprint.',
  {
    rule_id: z.number().int().positive().describe('Routing rule ID'),
    sprint_id: z.number().int().positive().describe('Sprint ID'),
    task_type: z.enum(VALID_TASK_TYPES).optional().describe('Task type'),
    status: z.string().min(1).optional().describe('Task status'),
    agent_id: z.number().int().positive().optional().describe('Canonical agent target'),
    job_id: z.number().int().positive().optional().describe('Legacy compat alias for agent_id'),
    priority: z.number().int().optional().describe('Rule priority'),
  },
  ({ rule_id, ...patch }) => wrap(() => api.updateRoutingRule(rule_id, patch))(),
  { domain: 'routing_rules', rest_paths: ['/api/v1/routing/rules/:id', '/api/v1/routing-rules/:id'] },
);

registerTool(
  ['agent_hq_delete_routing_rule', 'atlas_delete_routing_rule'],
  'Delete a task routing rule from a sprint.',
  {
    rule_id: z.number().int().positive().describe('Routing rule ID'),
    sprint_id: z.number().int().positive().describe('Sprint ID'),
  },
  ({ rule_id, sprint_id }) => wrap(() => api.deleteRoutingRule(rule_id, sprint_id))(),
  { domain: 'routing_rules', rest_paths: ['/api/v1/routing/rules/:id', '/api/v1/routing-rules/:id'] },
);

registerTool(
  ['agent_hq_list_routing_transitions', 'atlas_list_routing_transitions'],
  'List canonical routing transitions used for model/workflow routing.',
  {
    sprint_id: z.number().int().positive().optional().describe('Optional sprint scope'),
    project_id: z.number().int().positive().optional().describe('Optional project scope'),
  },
  ({ sprint_id, project_id }) => wrap(() => api.listRoutingTransitions({ sprint_id, project_id }))(),
  { domain: 'routing_transitions', rest_paths: ['/api/v1/routing/transitions'] },
);

registerTool(
  ['agent_hq_get_routing_transition', 'atlas_get_routing_transition'],
  'Get a canonical routing transition by ID.',
  {
    transition_id: z.number().int().positive().describe('Transition ID'),
    sprint_id: z.number().int().positive().optional().describe('Optional sprint scope'),
    project_id: z.number().int().positive().optional().describe('Optional project scope'),
  },
  ({ transition_id, sprint_id, project_id }) => wrap(() => api.getRoutingTransition(transition_id, { sprint_id, project_id }))(),
  { domain: 'routing_transitions', rest_paths: ['/api/v1/routing/transitions/:id'] },
);

registerTool(
  ['agent_hq_create_routing_transition', 'atlas_create_routing_transition'],
  'Create a canonical routing transition.',
  {
    sprint_id: z.number().int().positive().optional().describe('Optional sprint scope'),
    project_id: z.number().int().positive().optional().describe('Optional project scope'),
    task_type: z.enum(VALID_TASK_TYPES).nullable().optional().describe('Optional task type scope'),
    from_status: z.string().min(1).describe('From status'),
    outcome: z.string().min(1).describe('Outcome key'),
    to_status: z.string().min(1).describe('To status'),
    lane: z.string().optional().describe('Lane label'),
    enabled: z.boolean().optional().describe('Enabled flag'),
    priority: z.number().int().optional().describe('Priority'),
    is_protected: z.boolean().optional().describe('Protected flag for sprint-scoped rules'),
  },
  (args) => wrap(() => api.createRoutingTransition(args))(),
  { domain: 'routing_transitions', rest_paths: ['/api/v1/routing/transitions'] },
);

registerTool(
  ['agent_hq_update_routing_transition', 'atlas_update_routing_transition'],
  'Update a canonical routing transition.',
  {
    transition_id: z.number().int().positive().describe('Transition ID'),
    sprint_id: z.number().int().positive().optional().describe('Optional sprint scope'),
    project_id: z.number().int().positive().optional().describe('Optional project scope'),
    task_type: z.enum(VALID_TASK_TYPES).nullable().optional().describe('Optional task type scope'),
    from_status: z.string().min(1).optional().describe('From status'),
    outcome: z.string().min(1).optional().describe('Outcome key'),
    to_status: z.string().min(1).optional().describe('To status'),
    lane: z.string().optional().describe('Lane label'),
    enabled: z.boolean().optional().describe('Enabled flag'),
    priority: z.number().int().optional().describe('Priority'),
    is_protected: z.boolean().optional().describe('Protected flag for sprint-scoped rules'),
  },
  ({ transition_id, ...patch }) => wrap(() => api.updateRoutingTransition(transition_id, patch))(),
  { domain: 'routing_transitions', rest_paths: ['/api/v1/routing/transitions/:id'] },
);

registerTool(
  ['agent_hq_delete_routing_transition', 'atlas_delete_routing_transition'],
  'Delete a canonical routing transition.',
  {
    transition_id: z.number().int().positive().describe('Transition ID'),
    sprint_id: z.number().int().positive().optional().describe('Optional sprint scope'),
  },
  ({ transition_id, sprint_id }) => wrap(() => api.deleteRoutingTransition(transition_id, { sprint_id }))(),
  { domain: 'routing_transitions', rest_paths: ['/api/v1/routing/transitions/:id'] },
);

registerTool(
  ['agent_hq_list_model_routing_rules', 'atlas_list_model_routing_rules'],
  'List story-point model-routing rules.',
  {},
  () => wrap(() => api.listModelRoutingRules())(),
  { domain: 'model_routing', rest_paths: ['/api/v1/model-routing', '/api/v1/story-point-routing'] },
);

registerTool(
  ['agent_hq_get_model_routing_rule', 'atlas_get_model_routing_rule'],
  'Get a story-point model-routing rule by ID.',
  { rule_id: z.number().int().positive().describe('Model-routing rule ID') },
  ({ rule_id }) => wrap(() => api.getModelRoutingRule(rule_id))(),
  { domain: 'model_routing', rest_paths: ['/api/v1/model-routing/:id', '/api/v1/story-point-routing/:id'] },
);

registerTool(
  ['agent_hq_create_model_routing_rule', 'atlas_create_model_routing_rule'],
  'Create a story-point model-routing rule.',
  {
    max_points: z.number().int().positive().describe('Max story points threshold'),
    provider: z.string().optional().describe('Model provider'),
    model: z.string().min(1).describe('Primary model'),
    fallback_model: z.string().nullable().optional().describe('Fallback model'),
    max_turns: z.number().int().positive().nullable().optional().describe('Max turns'),
    max_budget_usd: z.number().nullable().optional().describe('Budget cap'),
    label: z.string().nullable().optional().describe('Rule label'),
  },
  (args) => wrap(() => api.createModelRoutingRule(args))(),
  { domain: 'model_routing', rest_paths: ['/api/v1/model-routing', '/api/v1/story-point-routing'] },
);

registerTool(
  ['agent_hq_update_model_routing_rule', 'atlas_update_model_routing_rule'],
  'Update a story-point model-routing rule.',
  {
    rule_id: z.number().int().positive().describe('Model-routing rule ID'),
    max_points: z.number().int().positive().optional().describe('Max story points threshold'),
    provider: z.string().optional().describe('Model provider'),
    model: z.string().min(1).optional().describe('Primary model'),
    fallback_model: z.string().nullable().optional().describe('Fallback model'),
    max_turns: z.number().int().positive().nullable().optional().describe('Max turns'),
    max_budget_usd: z.number().nullable().optional().describe('Budget cap'),
    label: z.string().nullable().optional().describe('Rule label'),
  },
  ({ rule_id, ...patch }) => wrap(() => api.updateModelRoutingRule(rule_id, patch))(),
  { domain: 'model_routing', rest_paths: ['/api/v1/model-routing/:id', '/api/v1/story-point-routing/:id'] },
);

registerTool(
  ['agent_hq_delete_model_routing_rule', 'atlas_delete_model_routing_rule'],
  'Delete a story-point model-routing rule.',
  { rule_id: z.number().int().positive().describe('Model-routing rule ID') },
  ({ rule_id }) => wrap(() => api.deleteModelRoutingRule(rule_id))(),
  { domain: 'model_routing', rest_paths: ['/api/v1/model-routing/:id', '/api/v1/story-point-routing/:id'] },
);

registerTool(
  ['agent_hq_list_sprint_types', 'atlas_list_sprint_types'],
  'List sprint types.',
  {},
  () => wrap(() => api.listSprintTypes())(),
  { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/list', '/api/v1/task-definitions/sprint-types'] },
);

registerTool(
  ['agent_hq_list_sprint_type_task_types', 'atlas_list_sprint_type_task_types'],
  'List allowed task types for a sprint type.',
  { sprint_type_key: z.string().min(1).describe('Sprint type key') },
  ({ sprint_type_key }) => wrap(() => api.listSprintTypeTaskTypes(sprint_type_key))(),
  { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/task-types', '/api/v1/task-definitions/sprint-types/:key/task-types'] },
);

registerTool(
  ['agent_hq_update_sprint_type_task_types', 'atlas_update_sprint_type_task_types'],
  'Replace the allowed task types for a sprint type.',
  {
    sprint_type_key: z.string().min(1).describe('Sprint type key'),
    task_types: z.array(z.string().min(1)).describe('Allowed task type keys'),
  },
  ({ sprint_type_key, task_types }) => wrap(() => api.updateSprintTypeTaskTypes(sprint_type_key, task_types))(),
  { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/task-types', '/api/v1/task-definitions/sprint-types/:key/task-types'] },
);

registerTool(
  ['agent_hq_create_sprint_type', 'atlas_create_sprint_type'],
  'Create a sprint type.',
  {
    key: z.string().min(1).describe('Sprint type key'),
    name: z.string().min(1).describe('Sprint type name'),
    description: z.string().optional().describe('Sprint type description'),
  },
  (args) => wrap(() => api.createSprintType(args))(),
  { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types', '/api/v1/task-definitions/sprint-types'] },
);

registerTool(
  ['agent_hq_update_sprint_type', 'atlas_update_sprint_type'],
  'Update a sprint type.',
  {
    key: z.string().min(1).describe('Sprint type key'),
    name: z.string().min(1).optional().describe('Sprint type name'),
    description: z.string().optional().describe('Sprint type description'),
  },
  ({ key, ...patch }) => wrap(() => api.updateSprintType(key, patch))(),
  { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key', '/api/v1/task-definitions/sprint-types/:key'] },
);

registerTool(
  ['agent_hq_delete_sprint_type', 'atlas_delete_sprint_type'],
  'Delete a sprint type.',
  { key: z.string().min(1).describe('Sprint type key') },
  ({ key }) => wrap(() => api.deleteSprintType(key))(),
  { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key', '/api/v1/task-definitions/sprint-types/:key'] },
);

registerTool(
  ['agent_hq_list_workflow_templates', 'atlas_list_workflow_templates'],
  'List workflow templates, optionally filtered by sprint type.',
  { sprint_type: z.string().optional().describe('Optional sprint type key') },
  ({ sprint_type }) => wrap(() => api.listWorkflowTemplates(sprint_type))(),
  { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/workflow-templates', '/api/v1/workflow-templates'] },
);

const workflowStatusSchema = z.object({
  status_key: z.string().min(1).describe('Status key'),
  label: z.string().min(1).describe('Status label'),
  color: z.string().optional().describe('Status color'),
  stage_order: z.number().int().min(0).describe('Display order'),
  terminal: z.union([z.boolean(), z.number().int()]).optional().describe('Terminal status flag'),
  is_default_entry: z.union([z.boolean(), z.number().int()]).optional().describe('Default entry flag'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Optional metadata'),
});

const workflowTransitionSchema = z.object({
  from_status_key: z.string().min(1).describe('From status key'),
  to_status_key: z.string().min(1).describe('To status key'),
  transition_key: z.string().min(1).describe('Transition key'),
  label: z.string().min(1).describe('Transition label'),
  outcome: z.string().nullable().optional().describe('Optional mapped outcome'),
  stage_order: z.number().int().min(0).describe('Display order'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Optional metadata'),
});

registerTool(
  ['agent_hq_get_workflow_template', 'atlas_get_workflow_template'],
  'Get a workflow template for a sprint type.',
  {
    sprint_type_key: z.string().min(1).describe('Sprint type key'),
    template_id: z.number().int().positive().describe('Template ID'),
  },
  ({ sprint_type_key, template_id }) => wrap(() => api.getWorkflowTemplate(sprint_type_key, template_id))(),
  { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/workflow-templates/:templateId', '/api/v1/task-definitions/sprint-types/:key/workflow-templates/:templateId'] },
);

registerTool(
  ['agent_hq_create_workflow_template', 'atlas_create_workflow_template'],
  'Create a workflow template for a sprint type.',
  {
    sprint_type_key: z.string().min(1).describe('Sprint type key'),
    key: z.string().min(1).describe('Template key'),
    name: z.string().min(1).describe('Template name'),
    description: z.string().optional().describe('Template description'),
    is_default: z.union([z.boolean(), z.number().int()]).optional().describe('Default template flag'),
    statuses: z.array(workflowStatusSchema).min(1).describe('Workflow statuses'),
    transitions: z.array(workflowTransitionSchema).min(1).describe('Workflow transitions'),
  },
  ({ sprint_type_key, ...payload }) => wrap(() => api.createWorkflowTemplate(sprint_type_key, payload))(),
  { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/workflow-templates', '/api/v1/task-definitions/sprint-types/:key/workflow-templates'] },
);

registerTool(
  ['agent_hq_update_workflow_template', 'atlas_update_workflow_template'],
  'Update a workflow template for a sprint type.',
  {
    sprint_type_key: z.string().min(1).describe('Sprint type key'),
    template_id: z.number().int().positive().describe('Template ID'),
    key: z.string().min(1).optional().describe('Template key'),
    name: z.string().min(1).optional().describe('Template name'),
    description: z.string().optional().describe('Template description'),
    is_default: z.union([z.boolean(), z.number().int()]).optional().describe('Default template flag'),
    statuses: z.array(workflowStatusSchema).optional().describe('Workflow statuses'),
    transitions: z.array(workflowTransitionSchema).optional().describe('Workflow transitions'),
  },
  ({ sprint_type_key, template_id, ...payload }) => wrap(() => api.updateWorkflowTemplate(sprint_type_key, template_id, payload))(),
  { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/workflow-templates/:templateId', '/api/v1/task-definitions/sprint-types/:key/workflow-templates/:templateId'] },
);

registerTool(
  ['agent_hq_delete_workflow_template', 'atlas_delete_workflow_template'],
  'Delete a workflow template from a sprint type.',
  {
    sprint_type_key: z.string().min(1).describe('Sprint type key'),
    template_id: z.number().int().positive().describe('Template ID'),
  },
  ({ sprint_type_key, template_id }) => wrap(() => api.deleteWorkflowTemplate(sprint_type_key, template_id))(),
  { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/workflow-templates/:templateId', '/api/v1/task-definitions/sprint-types/:key/workflow-templates/:templateId'] },
);

registerTool(
  ['agent_hq_list_task_field_schemas', 'atlas_list_task_field_schemas'],
  'List task field schemas for a sprint type.',
  {
    sprint_type_key: z.string().min(1).describe('Sprint type key'),
  },
  ({ sprint_type_key }) => wrap(() => api.listTaskFieldSchemas(sprint_type_key))(),
  { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/field-schemas', '/api/v1/task-definitions/sprint-types/:key/field-schemas'] },
);

registerTool(
  ['agent_hq_get_task_field_schema', 'atlas_get_task_field_schema'],
  'Get a task field schema for a sprint type.',
  {
    sprint_type_key: z.string().min(1).describe('Sprint type key'),
    schema_id: z.number().int().positive().describe('Schema ID'),
  },
  ({ sprint_type_key, schema_id }) => wrap(() => api.getTaskFieldSchema(sprint_type_key, schema_id))(),
  { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/field-schemas/:schemaId', '/api/v1/task-definitions/sprint-types/:key/field-schemas/:schemaId'] },
);

registerTool(
  ['agent_hq_create_task_field_schema', 'atlas_create_task_field_schema'],
  'Create a task field schema for a sprint type.',
  {
    sprint_type_key: z.string().min(1).describe('Sprint type key'),
    task_type: z.string().nullable().optional().describe('Optional task type scope'),
    schema: z.record(z.string(), z.unknown()).describe('Field schema payload'),
  },
  ({ sprint_type_key, ...payload }) => wrap(() => api.createTaskFieldSchema(sprint_type_key, payload))(),
  { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/field-schemas', '/api/v1/task-definitions/sprint-types/:key/field-schemas'] },
);

registerTool(
  ['agent_hq_update_task_field_schema', 'atlas_update_task_field_schema'],
  'Update a task field schema for a sprint type.',
  {
    sprint_type_key: z.string().min(1).describe('Sprint type key'),
    schema_id: z.number().int().positive().describe('Schema ID'),
    task_type: z.string().nullable().optional().describe('Optional task type scope'),
    schema: z.record(z.string(), z.unknown()).optional().describe('Field schema payload'),
  },
  ({ sprint_type_key, schema_id, ...payload }) => wrap(() => api.updateTaskFieldSchema(sprint_type_key, schema_id, payload))(),
  { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/field-schemas/:schemaId', '/api/v1/task-definitions/sprint-types/:key/field-schemas/:schemaId'] },
);

registerTool(
  ['agent_hq_delete_task_field_schema', 'atlas_delete_task_field_schema'],
  'Delete a task field schema from a sprint type.',
  {
    sprint_type_key: z.string().min(1).describe('Sprint type key'),
    schema_id: z.number().int().positive().describe('Schema ID'),
  },
  ({ sprint_type_key, schema_id }) => wrap(() => api.deleteTaskFieldSchema(sprint_type_key, schema_id))(),
  { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/field-schemas/:schemaId', '/api/v1/task-definitions/sprint-types/:key/field-schemas/:schemaId'] },
);

registerTool(
  ['agent_hq_list_agent_skills', 'atlas_list_agent_skills'],
  'List skill assignments for an agent as a first-class relation.',
  { agent_id: z.number().int().positive().describe('Agent ID') },
  ({ agent_id }) => wrap(() => api.listAgentSkills(agent_id))(),
  { domain: 'skills', rest_paths: ['/api/v1/agents/:id/skills'] },
);

registerTool(
  ['agent_hq_assign_skill_to_agent', 'atlas_assign_skill_to_agent'],
  'Assign a skill to an agent as a first-class relation by skill id or skill name.',
  {
    agent_id: z.number().int().positive().describe('Agent ID'),
    skill_id: z.number().int().positive().optional().describe('Skill ID'),
    skill_name: z.string().min(1).optional().describe('Skill name'),
  },
  ({ agent_id, skill_id, skill_name }) => wrap(() => api.assignSkillToAgent(agent_id, { skill_id, skill_name }))(),
  { domain: 'skills', rest_paths: ['/api/v1/agents/:id/skills'] },
);

registerTool(
  ['agent_hq_remove_skill_from_agent', 'atlas_remove_skill_from_agent'],
  'Remove a skill assignment from an agent as a first-class relation by skill id or skill name.',
  {
    agent_id: z.number().int().positive().describe('Agent ID'),
    skill_id: z.number().int().positive().optional().describe('Skill ID'),
    skill_name: z.string().min(1).optional().describe('Skill name'),
  },
  ({ agent_id, skill_id, skill_name }) => wrap(() => api.removeSkillFromAgent(agent_id, skill_name ? skill_name : { skill_id }))(),
  { domain: 'skills', rest_paths: ['/api/v1/agents/:id/skills/:skillIdentifier'] },
);

registerResource(
  [
    { id: 'agent-hq-workflow-statuses', uri: 'agent-hq://workflow/statuses' },
    { id: 'atlas-workflow-statuses', uri: 'atlas://workflow/statuses' },
  ],
  () =>
    JSON.stringify({
      statuses: VALID_TASK_STATUSES,
      pipeline: 'todo → ready → dispatched → in_progress → review → qa_pass → ready_to_merge → deployed → done',
      terminal: ['done', 'cancelled', 'failed'],
      other: ['stalled', 'blocked'],
    }),
);

registerResource(
  [
    { id: 'agent-hq-workflow-task-types', uri: 'agent-hq://workflow/task-types' },
    { id: 'atlas-workflow-task-types', uri: 'atlas://workflow/task-types' },
  ],
  () =>
    JSON.stringify({
      task_types: VALID_TASK_TYPES,
      priorities: VALID_TASK_PRIORITIES,
      story_points: VALID_TASK_STORY_POINTS,
      default: 'backend',
    }),
);

registerResource(
  [
    { id: 'agent-hq-projects-summary', uri: 'agent-hq://projects/summary' },
    { id: 'atlas-projects-summary', uri: 'atlas://projects/summary' },
  ],
  async () => {
    let projects: unknown[] = [];
    try {
      projects = await api.listProjects();
    } catch {
      // If the API is down, return an empty list rather than crashing resource discovery.
    }
    return JSON.stringify({ projects });
  },
);

registerResource(
  [
    { id: 'agent-hq-catalog', uri: 'agent-hq://catalog' },
    { id: 'atlas-catalog', uri: 'atlas://catalog' },
  ],
  () => JSON.stringify(getMcpCatalog()),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[agent-hq-mcp] MCP server connected, ready for tool calls via stdio.');

  const shutdown = async (signal: string) => {
    console.error(`[agent-hq-mcp] Received ${signal}, shutting down...`);
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[agent-hq-mcp] Fatal error:', err);
  process.exit(1);
});
