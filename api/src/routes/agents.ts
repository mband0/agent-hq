import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDb } from '../db/client';
import { generateClaudeMd, OPENCLAW_SKILLS_PATH } from '../services/dispatcher';
import { OPENCLAW_CONFIG_PATH, OPENCLAW_ENABLED } from '../config';
import { ATLAS_SYSTEM_ROLE } from '../lib/atlasAgent';
import {
  buildCanonicalAgentMainSessionKey,
  buildLegacyAgentMainSessionKey,
  normalizeAgentRoleLabel,
  parseAgentSessionKey,
  resolveRuntimeAgentSlug,
  slugifySessionKeyPart,
} from '../lib/sessionKeys';
import { resolveWorkspaceProvider } from '../lib/workspaceProvider';
import { seedSprintTaskPolicy } from '../lib/sprintTaskPolicy';
import { syncStarterRoutingForProject } from '../lib/starterSetup';
import { getSkillMaterializationAdapter } from '../runtimes/skillMaterialization';
import { syncAssignedMcpForAgent } from '../runtimes/mcpMaterialization';
import { VALID_TASK_TYPES } from '../lib/taskTypes';
import { ensureOpenClawGatewayAvailable, requireOpenClawOutput, runOpenClawSync } from '../lib/openclawCli';

const router = Router();

const CONNECTABLE_PROVIDER_SLUGS = ['anthropic', 'openai', 'openai-codex', 'google', 'ollama', 'mlx-studio', 'minimax'] as const;
const AGENT_MODEL_PROVIDER_PREFIX: Record<string, string> = {
  'anthropic/claude-sonnet-4-6': 'anthropic',
  'anthropic/claude-opus-4-6': 'anthropic',
  'openai-codex/gpt-5.4': 'openai-codex',
};
const DEFAULT_AGENT_MODEL_BY_PROVIDER: Record<string, string> = {
  anthropic: 'anthropic/claude-sonnet-4-6',
  'openai-codex': 'openai-codex/gpt-5.4',
};

function getConnectedProviderSlugs(): string[] {
  const db = getDb();
  const rows = db.prepare(`SELECT slug FROM provider_config WHERE status = 'connected'`).all() as Array<{ slug: string }>;
  return rows.map(row => row.slug);
}

// Local/OpenAI-compatible providers that accept freeform model names (no fixed model list)
const LOCAL_MODEL_PROVIDER_SLUGS: string[] = ['ollama', 'mlx-studio', 'minimax'];

function validateAgentProviderSelection(preferredProvider: string | null | undefined, model: string | null | undefined): string | null {
  if (!preferredProvider) return null;
  if (!CONNECTABLE_PROVIDER_SLUGS.includes(preferredProvider as typeof CONNECTABLE_PROVIDER_SLUGS[number])) {
    return `preferred_provider must be one of: ${CONNECTABLE_PROVIDER_SLUGS.join(', ')}`;
  }
  const connectedProviders = getConnectedProviderSlugs();
  if (!connectedProviders.includes(preferredProvider)) {
    return `preferred_provider '${preferredProvider}' is not currently connected`;
  }
  if (model) {
    // Local providers (Ollama, MLX Studio) accept any freeform model name — skip validation
    if (LOCAL_MODEL_PROVIDER_SLUGS.includes(preferredProvider)) return null;
    const expectedProvider = AGENT_MODEL_PROVIDER_PREFIX[model];
    if (!expectedProvider) {
      return `model '${model}' is not allowed for agent preferences`;
    }
    if (expectedProvider !== preferredProvider) {
      return `model '${model}' does not belong to preferred_provider '${preferredProvider}'`;
    }
  }
  return null;
}

function defaultAgentModelForProvider(preferredProvider: string | null | undefined): string | null {
  if (!preferredProvider) return null;
  return DEFAULT_AGENT_MODEL_BY_PROVIDER[preferredProvider] ?? null;
}

function getProjectName(projectId: number | null | undefined): string | null {
  if (!projectId) return null;
  const db = getDb();
  const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string | null } | undefined;
  return row?.name?.trim() || null;
}

function buildDefaultAgentSessionKey(params: {
  name: string;
  role?: string | null;
  projectId?: number | null;
  systemRole?: string | null;
}): string {
  if (params.systemRole === ATLAS_SYSTEM_ROLE) {
    return buildLegacyAgentMainSessionKey('atlas');
  }

  const projectName = getProjectName(params.projectId ?? null);
  const db = getDb();
  let candidate = buildCanonicalAgentMainSessionKey({
    projectName,
    projectSlug: slugifySessionKeyPart(projectName, 'unassigned'),
    agentName: params.name,
    role: params.role ?? null,
  });

  if (!db.prepare('SELECT id FROM agents WHERE session_key = ? LIMIT 1').get(candidate)) {
    return candidate;
  }

  const baseAgentSlug = slugifySessionKeyPart(params.name, 'agent');
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    candidate = buildCanonicalAgentMainSessionKey({
      projectName,
      projectSlug: slugifySessionKeyPart(projectName, 'unassigned'),
      agentNameSlug: `${baseAgentSlug}-${suffix}`,
      role: params.role ?? null,
    });
    if (!db.prepare('SELECT id FROM agents WHERE session_key = ? LIMIT 1').get(candidate)) {
      return candidate;
    }
  }

  return candidate;
}

type ProvisionPhaseStatus = 'created' | 'updated' | 'reused' | 'skipped' | 'verified' | 'failed';

interface ProvisionPhaseReport {
  ok: boolean;
  status: ProvisionPhaseStatus;
  details?: Record<string, unknown>;
  warnings?: string[];
  error?: string;
}

interface ProvisionFullRequest {
  name: string;
  role?: string | null;
  session_key?: string;
  workspace_path?: string;
  repo_path?: string | null;
  status?: string;
  runtime_type?: string;
  runtime_config?: ClaudeCodeRuntimeConfig | null;
  project_id?: number | null;
  preferred_provider?: string | null;
  model?: string | null;
  system_role?: string | null;
  hooks_url?: string | null;
  hooks_auth_header?: string | null;
  os_user?: string | null;
  enabled?: number | boolean;
  github_identity_id?: number | null;
  job_title?: string;
  schedule?: string;
  pre_instructions?: string;
  skill_names?: string[];
  timeout_seconds?: number | null;
  startup_grace_seconds?: number | null;
  heartbeat_stale_seconds?: number | null;
  stall_threshold_min?: number;
  max_retries?: number;
  sort_rules?: string[];
  openclaw_agent_id?: string;
  routing_rules?: Array<{
    sprint_id?: number | null;
    task_type: string;
    status: string;
    priority?: number;
  }>;
  tool_ids?: number[];
  mcp_server_ids?: number[];
  reflection?: {
    enabled?: boolean;
    schedule?: string;
  };
  restart_gateway?: boolean;
}

interface AgentInsertParams {
  name: string;
  role: string;
  sessionKey: string;
  workspacePath: string;
  repoPath: string | null;
  status: string;
  openclawAgentId: string | null;
  runtimeType: string;
  runtimeConfig: ClaudeCodeRuntimeConfig | null;
  projectId: number | null;
  preferredProvider: string;
  model: string | null;
  systemRole: string | null;
  hooksUrl: string | null;
  hooksAuthHeader: string | null;
  osUser: string | null;
  enabled: number;
  githubIdentityId: number | null;
  jobTitle: string;
  schedule: string;
  preInstructions: string;
  skillNames: string[];
  timeoutSeconds: number;
  startupGraceSeconds: number | null;
  heartbeatStaleSeconds: number | null;
  stallThresholdMin: number;
  maxRetries: number;
  sortRules: string[];
}

interface WorkspaceScaffoldResult {
  workspacePath: string;
  memoryDir: string;
  docsWritten: string[];
}

interface OpenClawRegistrationResult {
  slug: string;
  workspacePath: string;
  agentDirPath: string;
  added: boolean;
  updated: boolean;
  gatewayRestarted: boolean;
  authProvidersSynced: string[];
}

function normalizeJsonArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function createEmptyAuthProfilesDocument(): Record<string, unknown> {
  return {
    version: 1,
    profiles: {},
    lastGood: {},
    usageStats: {},
  };
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function upsertAgentAuthProfile(filePath: string, slug: string, profile: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const data = fs.existsSync(filePath)
    ? (readJsonFile(filePath) ?? createEmptyAuthProfilesDocument())
    : createEmptyAuthProfilesDocument();
  const profiles = (data.profiles && typeof data.profiles === 'object')
    ? data.profiles as Record<string, unknown>
    : {};
  profiles[`${slug}:default`] = profile;
  data.profiles = profiles;

  const lastGood = (data.lastGood && typeof data.lastGood === 'object')
    ? data.lastGood as Record<string, string>
    : {};
  lastGood[slug] = `${slug}:default`;
  data.lastGood = lastGood;

  if (!data.usageStats || typeof data.usageStats !== 'object') {
    data.usageStats = {};
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function syncStoredProviderAuthProfiles(agentDirPath: string): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT slug, config
    FROM provider_config
    WHERE status = 'connected'
  `).all() as Array<{ slug: string; config: string }>;

  const synced: string[] = [];
  const authFilePath = path.join(agentDirPath, 'auth-profiles.json');
  for (const row of rows) {
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(row.config ?? '{}') as Record<string, unknown>;
    } catch {
      continue;
    }

    if (row.slug !== 'openai-codex' || config.auth_type !== 'oauth') {
      continue;
    }

    const tokens = config.tokens && typeof config.tokens === 'object'
      ? config.tokens as Record<string, unknown>
      : null;
    const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token.trim() : '';
    const refreshToken = typeof tokens?.refresh_token === 'string' ? tokens.refresh_token.trim() : '';
    if (!accessToken && !refreshToken) {
      continue;
    }

    const expiresAt = typeof config.expires_at === 'number' && Number.isFinite(config.expires_at)
      ? config.expires_at
      : Date.now() + 3600_000;
    const accountId = typeof config.account_id === 'string' && config.account_id.trim()
      ? config.account_id.trim()
      : null;

    upsertAgentAuthProfile(authFilePath, row.slug, {
      type: 'oauth',
      provider: row.slug,
      access: accessToken,
      refresh: refreshToken,
      expires: expiresAt,
      ...(accountId ? { accountId } : {}),
    });
    synced.push(row.slug);
  }

  return synced;
}

function buildDefaultWorkspacePath(slug: string): string {
  return path.join(os.homedir(), '.openclaw', `workspace-${slug}`);
}

function buildDefaultAgentDirPath(slug: string): string {
  return path.join(os.homedir(), '.openclaw', 'agents', slug, 'agent');
}

function buildProvisionedDocTemplates(params: {
  name: string;
  role: string;
  projectName: string | null;
  sessionKey: string;
  runtimeSlug: string;
}): Record<string, string> {
  const projectLine = params.projectName ? `- **Project:** ${params.projectName}` : '- **Project:** Unassigned';
  return {
    'SOUL.md': `# SOUL.md — ${params.name}\n\nYou are ${params.name}${params.role ? `, ${params.role}` : ''}.\n\n## Core Principles\n- Be direct and useful.\n- Push back on weak assumptions.\n- Prefer concrete evidence over vague confidence.\n- Leave the workspace cleaner than you found it.\n`,
    'IDENTITY.md': `# IDENTITY.md — ${params.name}\n\n- **Name:** ${params.name}\n- **Role:** ${params.role || 'Agent'}\n${projectLine}\n- **Session Key:** ${params.sessionKey}\n- **Runtime Slug:** ${params.runtimeSlug}\n`,
    'USER.md': '# USER.md\n\nDocument the human/operator context this agent should learn over time.\n',
    'MEMORY.md': `# MEMORY.md — ${params.name}\n\nPersistent notes and durable context for future sessions.\n`,
    'TOOLS.md': `# TOOLS.md — ${params.name}\n\nEnvironment notes, operational shortcuts, and workspace-specific constraints.\n`,
    'HEARTBEAT.md': `# HEARTBEAT.md — ${params.name}\n\nWeekly reflection, execution notes, and operating cadence live here.\n`,
    'LESSONS.md': `# LESSONS.md — ${params.name}\n\nCapture failures, recoveries, and durable lessons worth reusing.\n`,
  };
}

function ensureWorkspaceScaffold(params: {
  name: string;
  role: string;
  projectName: string | null;
  sessionKey: string;
  runtimeSlug: string;
  workspacePath: string;
}): WorkspaceScaffoldResult {
  fs.mkdirSync(params.workspacePath, { recursive: true });
  const memoryDir = path.join(params.workspacePath, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });

  const docs = buildProvisionedDocTemplates(params);
  const docsWritten: string[] = [];
  for (const [filename, content] of Object.entries(docs)) {
    const target = path.join(params.workspacePath, filename);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, content, 'utf-8');
      docsWritten.push(filename);
    }
  }

  const canonicalAgentsPath = path.join(os.homedir(), '.openclaw', 'workspace', 'AGENTS.md');
  const agentsTarget = path.join(params.workspacePath, 'AGENTS.md');
  if (!fs.existsSync(agentsTarget)) {
    if (fs.existsSync(canonicalAgentsPath)) {
      fs.copyFileSync(canonicalAgentsPath, agentsTarget);
    } else {
      fs.writeFileSync(agentsTarget, `# AGENTS.md — ${params.name}\n\n1. Read SOUL.md\n2. Read IDENTITY.md\n3. Check MEMORY.md and LESSONS.md\n4. Execute the current assignment\n`, 'utf-8');
    }
    docsWritten.push('AGENTS.md');
  }

  return {
    workspacePath: params.workspacePath,
    memoryDir,
    docsWritten,
  };
}

function readOpenclawJsonOrDefault(): Record<string, unknown> {
  if (!fs.existsSync(OPENCLAW_JSON)) {
    return { agents: { list: [] } };
  }
  return readOpenclawJson();
}

function ensureOpenClawRegistration(params: {
  slug: string;
  workspacePath: string;
  model: string | null;
  restartGateway: boolean;
}): OpenClawRegistrationResult {
  const config = readOpenclawJsonOrDefault();
  const agentsConfig = (config.agents as Record<string, unknown> | undefined) ?? {};
  const list = (agentsConfig.list as Array<Record<string, unknown>> | undefined) ?? [];
  const agentDirPath = buildDefaultAgentDirPath(params.slug);
  fs.mkdirSync(agentDirPath, { recursive: true });
  const authProvidersSynced = syncStoredProviderAuthProfiles(agentDirPath);

  let added = false;
  let updated = false;
  const existing = list.find((entry) => entry.id === params.slug);
  if (existing) {
    existing.name = params.slug;
    existing.workspace = params.workspacePath;
    existing.agentDir = agentDirPath;
    if (params.model) existing.model = { primary: params.model };
    updated = true;
  } else {
    list.push({
      id: params.slug,
      name: params.slug,
      workspace: params.workspacePath,
      agentDir: agentDirPath,
      ...(params.model ? { model: { primary: params.model } } : {}),
    });
    added = true;
  }
  agentsConfig.list = list;
  config.agents = agentsConfig;
  writeOpenclawJson(config);

  let gatewayRestarted = false;
  if (params.restartGateway) {
    const gateway = ensureOpenClawGatewayAvailable();
    if (!gateway.ok) {
      throw new Error(gateway.message);
    }
    gatewayRestarted = true;
  }

  return {
    slug: params.slug,
    workspacePath: params.workspacePath,
    agentDirPath,
    added,
    updated,
    gatewayRestarted,
    authProvidersSynced,
  };
}

function insertProvisionedAgent(db: ReturnType<typeof getDb>, params: AgentInsertParams): number {
  const result = db.prepare(`
    INSERT INTO agents (
      name, role, session_key, workspace_path, repo_path, status, openclaw_agent_id,
      runtime_type, runtime_config, project_id, preferred_provider, model, system_role,
      hooks_url, hooks_auth_header, os_user, enabled, github_identity_id, job_title, schedule,
      pre_instructions, skill_names, timeout_seconds, startup_grace_seconds, heartbeat_stale_seconds,
      stall_threshold_min, max_retries, sort_rules
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.name,
    params.role,
    params.sessionKey,
    params.workspacePath,
    params.repoPath,
    params.status,
    params.openclawAgentId,
    params.runtimeType,
    params.runtimeConfig ? JSON.stringify(params.runtimeConfig) : null,
    params.projectId,
    params.preferredProvider,
    params.model,
    params.systemRole,
    params.hooksUrl,
    params.hooksAuthHeader,
    params.osUser,
    params.enabled,
    params.githubIdentityId,
    params.jobTitle,
    params.schedule,
    params.preInstructions,
    JSON.stringify(params.skillNames),
    params.timeoutSeconds,
    params.startupGraceSeconds,
    params.heartbeatStaleSeconds,
    params.stallThresholdMin,
    params.maxRetries,
    JSON.stringify(params.sortRules),
  );
  return Number(result.lastInsertRowid);
}

function validateRoutingRules(routingRules: ProvisionFullRequest['routing_rules']): string[] {
  const errors: string[] = [];
  for (const rule of routingRules ?? []) {
    if (!rule.task_type || !rule.status) {
      errors.push('Each routing rule requires task_type and status');
      continue;
    }
    if (rule.sprint_id !== undefined && rule.sprint_id !== null && (!Number.isInteger(rule.sprint_id) || rule.sprint_id <= 0)) {
      errors.push(`Invalid sprint_id "${String(rule.sprint_id)}"`);
    }
    if (!VALID_TASK_TYPES.includes(rule.task_type as typeof VALID_TASK_TYPES[number])) {
      errors.push(`Invalid task_type "${rule.task_type}"`);
    }
  }
  return errors;
}

// GET /api/v1/agents
// Supports optional ?project_id=N filter.
// Each agent is enriched with project_id and project_name derived from their
// most-recently-updated job template (primary job). Agents with no jobs get nulls.
router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const projectId = req.query.project_id !== undefined ? Number(req.query.project_id) : null;

    // Task #594: agents table is the canonical entity.
    const baseQuery = `
      SELECT a.*,
        p.name                     AS project_name
      FROM agents a
      LEFT JOIN projects p ON p.id = a.project_id
    `;

    let agents: unknown[];
    if (projectId !== null) {
      agents = db.prepare(`${baseQuery} WHERE a.project_id = ? ORDER BY a.created_at ASC`).all(projectId);
    } else {
      agents = db.prepare(`${baseQuery} ORDER BY a.created_at ASC`).all();
    }

    res.json(parseAgents(agents));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/agents/local-mlx/status — MUST be before /:id wildcard
// Proxies a health check to the local MLX server so the browser avoids CORS issues.
router.get('/local-mlx/status', async (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await new Promise<{ online: boolean; model?: string }>((resolve) => {
      const options = { hostname: '127.0.0.1', port: 8090, path: '/v1/models', method: 'GET', timeout: 8000 };
      const http = require('http');
      const request = http.request(options, (r: any) => {
        let body = '';
        r.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        r.on('end', () => {
          try {
            const json = JSON.parse(body);
            resolve({ online: true, model: json?.data?.[0]?.id ?? null });
          } catch {
            resolve({ online: r.statusCode === 200 });
          }
        });
      });
      request.on('error', () => resolve({ online: false }));
      request.on('timeout', () => { request.destroy(); resolve({ online: false }); });
      request.end();
    });
    res.json(result);
  } catch {
    res.json({ online: false });
  }
});

// POST /api/v1/agents/provision-full
// Atomic end-to-end OpenClaw agent provisioning with structured phase reporting.
router.post('/provision-full', (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body as ProvisionFullRequest;
  const report: Record<string, ProvisionPhaseReport> = {};

  try {
    if (!body.name?.trim()) {
      return res.status(400).json({
        ok: false,
        report: {
          validation: { ok: false, status: 'failed', error: 'name is required' },
        },
      });
    }

    const runtimeType = body.runtime_type ?? 'openclaw';
    if (runtimeType !== 'openclaw') {
      return res.status(400).json({
        ok: false,
        report: {
          validation: { ok: false, status: 'failed', error: 'provision-full currently supports runtime_type=openclaw only' },
        },
      });
    }

    const routingErrors = validateRoutingRules(body.routing_rules);
    if (routingErrors.length > 0) {
      return res.status(400).json({
        ok: false,
        report: {
          validation: { ok: false, status: 'failed', error: routingErrors.join('; ') },
        },
      });
    }

    const projectId = body.project_id ?? null;
    const projectName = getProjectName(projectId);
    if (projectId && !projectName) {
      return res.status(404).json({
        ok: false,
        report: {
          validation: { ok: false, status: 'failed', error: `project_id ${projectId} not found` },
        },
      });
    }

    const resolvedSystemRole = body.system_role === ATLAS_SYSTEM_ROLE ? ATLAS_SYSTEM_ROLE : null;
    const resolvedRole = normalizeAgentRoleLabel(body.role ?? '', 'Agent');
    const runtimeSlug = body.openclaw_agent_id?.trim() || toSlug(body.name);
    const sessionKey = body.session_key || buildDefaultAgentSessionKey({
      name: body.name,
      role: resolvedRole,
      projectId,
      systemRole: resolvedSystemRole,
    });
    const workspacePath = body.workspace_path || buildDefaultWorkspacePath(runtimeSlug);
    const repoPath = body.repo_path === undefined ? workspacePath : (body.repo_path || null);
    const reflectionEnabled = body.reflection?.enabled !== false;
    const schedule = body.schedule ?? (reflectionEnabled ? (body.reflection?.schedule ?? '0 9 * * 1') : '');
    const connectedProviders = getConnectedProviderSlugs();
    const preferredProvider = body.preferred_provider
      ?? (connectedProviders.includes('openai') ? 'openai' : connectedProviders[0] ?? 'openai');
    const resolvedModel = body.model ?? defaultAgentModelForProvider(preferredProvider);
    const providerValidationError = validateAgentProviderSelection(preferredProvider, resolvedModel);
    if (providerValidationError) {
      return res.status(400).json({
        ok: false,
        report: {
          validation: { ok: false, status: 'failed', error: providerValidationError },
        },
      });
    }

    const duplicateName = db.prepare('SELECT id FROM agents WHERE lower(name) = lower(?) LIMIT 1').get(body.name) as { id: number } | undefined;
    if (duplicateName) {
      return res.status(409).json({
        ok: false,
        report: {
          validation: { ok: false, status: 'failed', error: `agent name "${body.name}" already exists` },
        },
      });
    }

    const duplicateSlug = db.prepare('SELECT id FROM agents WHERE openclaw_agent_id = ? LIMIT 1').get(runtimeSlug) as { id: number } | undefined;
    if (duplicateSlug) {
      return res.status(409).json({
        ok: false,
        report: {
          validation: { ok: false, status: 'failed', error: `openclaw_agent_id "${runtimeSlug}" already exists` },
        },
      });
    }

    const duplicateSession = db.prepare('SELECT id FROM agents WHERE session_key = ? LIMIT 1').get(sessionKey) as { id: number } | undefined;
    if (duplicateSession) {
      return res.status(409).json({
        ok: false,
        report: {
          validation: { ok: false, status: 'failed', error: `session_key "${sessionKey}" already exists` },
        },
      });
    }

    const toolIds = Array.isArray(body.tool_ids) ? body.tool_ids.map(Number).filter(id => Number.isFinite(id)) : [];
    const mcpServerIds = Array.isArray(body.mcp_server_ids) ? body.mcp_server_ids.map(Number).filter(id => Number.isFinite(id)) : [];
    for (const toolId of toolIds) {
      const row = db.prepare('SELECT id FROM tools WHERE id = ? AND enabled = 1').get(toolId);
      if (!row) {
        return res.status(404).json({
          ok: false,
          report: {
            validation: { ok: false, status: 'failed', error: `tool_id ${toolId} not found or disabled` },
          },
        });
      }
    }
    for (const mcpServerId of mcpServerIds) {
      const row = db.prepare('SELECT id FROM mcp_servers WHERE id = ? AND enabled = 1').get(mcpServerId);
      if (!row) {
        return res.status(404).json({
          ok: false,
          report: {
            validation: { ok: false, status: 'failed', error: `mcp_server_id ${mcpServerId} not found or disabled` },
          },
        });
      }
    }

    report.validation = {
      ok: true,
      status: 'verified',
      details: {
        runtime_type: runtimeType,
        project_id: projectId,
        session_key: sessionKey,
        runtime_slug: runtimeSlug,
      },
    };

    const openclawJsonExisted = fs.existsSync(OPENCLAW_JSON);
    const openclawJsonBackup = openclawJsonExisted ? fs.readFileSync(OPENCLAW_JSON, 'utf-8') : null;
    const workspaceExisted = fs.existsSync(workspacePath);
    const agentDirPath = buildDefaultAgentDirPath(runtimeSlug);
    const agentDirExisted = fs.existsSync(agentDirPath);
    let agentId: number | null = null;
    let createdRoutingRuleIds: number[] = [];
    let createdToolAssignmentIds: number[] = [];
    let createdMcpAssignmentIds: number[] = [];
    let workspaceResult: WorkspaceScaffoldResult | null = null;
    let openclawResult: OpenClawRegistrationResult | null = null;

    const tx = db.transaction(() => {
      agentId = insertProvisionedAgent(db, {
        name: body.name,
        role: resolvedRole,
        sessionKey,
        workspacePath,
        repoPath,
        status: body.status ?? 'idle',
        openclawAgentId: runtimeSlug,
        runtimeType,
        runtimeConfig: body.runtime_config ?? null,
        projectId,
        preferredProvider,
        model: resolvedModel,
        systemRole: resolvedSystemRole,
        hooksUrl: body.hooks_url ?? null,
        hooksAuthHeader: body.hooks_auth_header ?? null,
        osUser: body.os_user ?? null,
        enabled: body.enabled === undefined ? 1 : (body.enabled ? 1 : 0),
        githubIdentityId: body.github_identity_id ?? null,
        jobTitle: body.job_title ?? `${projectName ?? 'Agent'} — ${resolvedRole}`,
        schedule,
        preInstructions: body.pre_instructions ?? '',
        skillNames: normalizeJsonArray(body.skill_names),
        timeoutSeconds: body.timeout_seconds ?? 900,
        startupGraceSeconds: body.startup_grace_seconds ?? null,
        heartbeatStaleSeconds: body.heartbeat_stale_seconds ?? null,
        stallThresholdMin: body.stall_threshold_min ?? 30,
        maxRetries: body.max_retries ?? 3,
        sortRules: normalizeJsonArray(body.sort_rules),
      });
      report.agent = {
        ok: true,
        status: 'created',
        details: { agent_id: agentId, runtime_slug: runtimeSlug, session_key: sessionKey },
      };

      workspaceResult = ensureWorkspaceScaffold({
        name: body.name,
        role: resolvedRole,
        projectName,
        sessionKey,
        runtimeSlug,
        workspacePath,
      });
      report.workspace = {
        ok: true,
        status: workspaceExisted ? 'updated' : 'created',
        details: {
          workspace_path: workspaceResult.workspacePath,
          memory_dir: workspaceResult.memoryDir,
          docs_written: workspaceResult.docsWritten,
        },
      };

      openclawResult = ensureOpenClawRegistration({
        slug: runtimeSlug,
        workspacePath,
        model: body.model ?? null,
        restartGateway: body.restart_gateway === true,
      });
      report.openclaw = {
        ok: true,
        status: openclawResult.added ? 'created' : 'updated',
        details: {
          openclaw_agent_id: openclawResult.slug,
          agent_dir: openclawResult.agentDirPath,
          gateway_restarted: openclawResult.gatewayRestarted,
          auth_providers_synced: openclawResult.authProvidersSynced,
        },
      };

      const projectRoutingStmt = db.prepare(`
        INSERT INTO task_routing_rules (project_id, task_type, status, agent_id, priority)
        VALUES (?, ?, ?, ?, ?)
      `);
      const sprintRoutingStmt = db.prepare(`
        INSERT INTO sprint_task_routing_rules (sprint_id, task_type, status, agent_id, priority)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const rule of body.routing_rules ?? []) {
        let result;
        if (rule.sprint_id != null) {
          seedSprintTaskPolicy(db, rule.sprint_id);
          result = sprintRoutingStmt.run(rule.sprint_id, rule.task_type, rule.status, agentId, rule.priority ?? 0);
        } else {
          result = projectRoutingStmt.run(projectId, rule.task_type, rule.status, agentId, rule.priority ?? 0);
        }
        createdRoutingRuleIds.push(Number(result.lastInsertRowid));
      }
      report.routing = {
        ok: true,
        status: createdRoutingRuleIds.length > 0 ? 'created' : 'skipped',
        details: { rule_ids: createdRoutingRuleIds },
      };

      const toolStmt = db.prepare(`
        INSERT INTO agent_tool_assignments (agent_id, tool_id, overrides, enabled)
        VALUES (?, ?, '{}', 1)
      `);
      for (const toolId of toolIds) {
        const result = toolStmt.run(agentId, toolId);
        createdToolAssignmentIds.push(Number(result.lastInsertRowid));
      }

      const mcpStmt = db.prepare(`
        INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id, overrides, enabled)
        VALUES (?, ?, '{}', 1)
      `);
      for (const mcpServerId of mcpServerIds) {
        const result = mcpStmt.run(agentId, mcpServerId);
        createdMcpAssignmentIds.push(Number(result.lastInsertRowid));
      }

      const adapter = getSkillMaterializationAdapter(runtimeType);
      adapter.materialize({
        workingDirectory: workspacePath,
        skillNames: normalizeJsonArray(body.skill_names),
        skillsBasePath: OPENCLAW_SKILLS_PATH,
        hooksUrl: body.hooks_url ?? null,
      });

      syncAssignedMcpForAgent({
        db,
        agentId,
        workingDirectory: workspacePath,
      });

      report.capabilities = {
        ok: true,
        status: (createdToolAssignmentIds.length > 0 || createdMcpAssignmentIds.length > 0 || normalizeJsonArray(body.skill_names).length > 0) ? 'created' : 'skipped',
        details: {
          skill_names: normalizeJsonArray(body.skill_names),
          tool_assignment_ids: createdToolAssignmentIds,
          mcp_assignment_ids: createdMcpAssignmentIds,
        },
      };
    });

    try {
      tx();
    } catch (err) {
      if (!workspaceExisted && fs.existsSync(workspacePath)) {
        fs.rmSync(workspacePath, { recursive: true, force: true });
      }
      if (!agentDirExisted && fs.existsSync(agentDirPath)) {
        fs.rmSync(agentDirPath, { recursive: true, force: true });
      }
      if (openclawJsonBackup !== null) {
        fs.writeFileSync(OPENCLAW_JSON, openclawJsonBackup, 'utf-8');
      } else if (!openclawJsonExisted && fs.existsSync(OPENCLAW_JSON)) {
        fs.rmSync(OPENCLAW_JSON, { force: true });
      }
      report.provision = {
        ok: false,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
      return res.status(500).json({
        ok: false,
        agent_id: agentId,
        report,
      });
    }

    const agent = db.prepare(`
      SELECT a.*, p.name AS project_name
      FROM agents a
      LEFT JOIN projects p ON p.id = a.project_id
      WHERE a.id = ?
    `).get(agentId) as Record<string, unknown> | undefined;

    let openclawRegistered = false;
    try {
      const config = readOpenclawJsonOrDefault();
      const agentsCfg = (config.agents as Record<string, unknown> | undefined) ?? {};
      const list = (agentsCfg.list as Array<Record<string, unknown>> | undefined) ?? [];
      openclawRegistered = list.some(entry => entry.id === runtimeSlug);
    } catch {
      openclawRegistered = false;
    }

    report.verification = {
      ok: Boolean(
        agent
        && fs.existsSync(workspacePath)
        && fs.existsSync(path.join(workspacePath, 'SOUL.md'))
        && fs.existsSync(path.join(workspacePath, 'IDENTITY.md'))
        && openclawRegistered,
      ),
      status: 'verified',
      details: {
        agent_id: agentId,
        workspace_exists: fs.existsSync(workspacePath),
        openclaw_registered: openclawRegistered,
        routing_rule_count: createdRoutingRuleIds.length,
        tool_assignment_count: createdToolAssignmentIds.length,
        mcp_assignment_count: createdMcpAssignmentIds.length,
        reflection_schedule: schedule || null,
      },
    };

    return res.status(201).json({
      ok: true,
      agent: agent ? parseAgentRuntimeConfig(agent) : null,
      created_resource_ids: {
        agent_id: agentId,
        routing_rule_ids: createdRoutingRuleIds,
        tool_assignment_ids: createdToolAssignmentIds,
        mcp_assignment_ids: createdMcpAssignmentIds,
      },
      report,
    });
  } catch (err) {
    report.provision = {
      ok: false,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
    return res.status(500).json({ ok: false, report });
  }
});

// GET /api/v1/agents/:id
// Phase 4 (T#459): agents table has job-template columns; enrich with project_name + job_template_id
router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const agent = db.prepare(`
      SELECT a.*,
        p.name             AS project_name
      FROM agents a
      LEFT JOIN projects p ON p.id = a.project_id
      WHERE a.id = ?
    `).get(req.params.id) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    return res.json(parseAgentRuntimeConfig(agent));
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// POST /api/v1/agents
router.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { name, role, session_key, workspace_path, status, provision_openclaw, runtime_type, runtime_config, project_id, preferred_provider, model, system_role } = req.body as {
      name: string;
      role?: string;
      session_key?: string;
      workspace_path?: string;
      status?: string;
      provision_openclaw?: boolean;
      runtime_type?: string;
      runtime_config?: ClaudeCodeRuntimeConfig | null;
      project_id?: number;
      preferred_provider?: string | null;
      model?: string | null;
      system_role?: string | null;
    };
    const connectedProviders = getConnectedProviderSlugs();
    const resolvedRole = normalizeAgentRoleLabel(role ?? '', 'Agent');

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const effectiveRuntimeTypeCreate = runtime_type ?? 'openclaw';

    // agents.preferred_provider is NOT NULL in the live schema; when the client
    // omits it (for example the onboarding flow), pick a connected provider at runtime.
    const resolvedPreferredProvider = preferred_provider
      ?? (connectedProviders.includes('openai') ? 'openai' : connectedProviders[0] ?? 'openai');

    const resolvedCreateModel = model ?? defaultAgentModelForProvider(resolvedPreferredProvider);
    if (resolvedPreferredProvider) {
      const providerValidationError = validateAgentProviderSelection(resolvedPreferredProvider, resolvedCreateModel);
      if (providerValidationError) {
        return res.status(400).json({ error: providerValidationError });
      }
    }

    const resolvedSystemRole = system_role === ATLAS_SYSTEM_ROLE ? ATLAS_SYSTEM_ROLE : null;

    // Optionally provision an OpenClaw native agent (only when runtime is openclaw)
    let openclawAgentId: string | null = null;
    let resolvedSessionKey = session_key
      || buildDefaultAgentSessionKey({
        name,
        role: resolvedRole,
        projectId: project_id ?? null,
        systemRole: resolvedSystemRole,
      });
    let resolvedWorkspacePath = workspace_path ?? '';

    if (provision_openclaw && effectiveRuntimeTypeCreate === 'openclaw') {
      // Derive a clean agent ID from the name (lowercase, hyphens)
      const agentId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const homedir = process.env.HOME ?? os.homedir();
      resolvedWorkspacePath = workspace_path || path.join(homedir, '.openclaw', `workspace-${agentId}`);
      // Create workspace dir first
      fs.mkdirSync(resolvedWorkspacePath, { recursive: true });
      try {
        requireOpenClawOutput(
          ['agents', 'add', agentId, '--non-interactive', '--workspace', resolvedWorkspacePath],
          { stdio: 'pipe', timeout: 30000 },
        );
        console.log(`[agents] Provisioned OpenClaw agent: ${agentId}`);
      } catch (provErr) {
        const msg = provErr instanceof Error ? (provErr as NodeJS.ErrnoException & { stderr?: Buffer }).stderr?.toString() ?? provErr.message : String(provErr);
        console.warn(`[agents] openclaw agents add ${agentId}: ${msg}`);
        // Non-fatal — still create the DB record
      }
      openclawAgentId = agentId;
      // Use canonical Agent HQ identity by default; keep the runtime slug separate.
      resolvedSessionKey = session_key || buildDefaultAgentSessionKey({
        name,
        role: resolvedRole,
        projectId: project_id ?? null,
        systemRole: resolvedSystemRole,
      });
    }

    const result = db.prepare(`
      INSERT INTO agents (name, role, session_key, workspace_path, status, openclaw_agent_id, runtime_type, runtime_config, project_id, preferred_provider, model, system_role)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      resolvedRole,
      resolvedSessionKey,
      resolvedWorkspacePath,
      status ?? 'idle',
      openclawAgentId,
      effectiveRuntimeTypeCreate,
      runtime_config != null ? JSON.stringify(runtime_config) : null,
      project_id ?? null,
      resolvedPreferredProvider,
      resolvedCreateModel,
      resolvedSystemRole
    );

    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>;
    syncStarterRoutingForProject(db, project_id ?? null);
    if ((agent.runtime_type as string | null) === 'openclaw' && (agent.workspace_path as string | null)) {
      setImmediate(() => {
        try {
          const mcpResult = syncAssignedMcpForAgent({
            db,
            agentId: Number(result.lastInsertRowid),
            workingDirectory: agent.workspace_path as string,
          });
          for (const warn of mcpResult.warnings) console.warn(`[agents.post] ${warn}`);
        } catch (mcpErr) {
          console.warn(
            `[agents.post] MCP materialization failed for agent #${String(result.lastInsertRowid)}:`,
            mcpErr instanceof Error ? mcpErr.message : String(mcpErr),
          );
        }
      });
    }
    return res.status(201).json(parseAgentRuntimeConfig(agent));
  } catch (err) {
    const msg = String(err);
    if (msg.includes('UNIQUE')) return res.status(409).json({ error: 'session_key already exists' });
    return res.status(500).json({ error: msg });
  }
});

// PUT /api/v1/agents/:id
router.put('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const {
      name, role, session_key, workspace_path, repo_path, status, model,
      runtime_type, runtime_config, hooks_url, hooks_auth_header,
      preferred_provider, os_user, enabled, github_identity_id,
      // Job-template fields (T#619): updated on the agents table directly
      job_title, schedule, pre_instructions, skill_names, timeout_seconds,
      // Watchdog per-agent timeout overrides (T#681)
      startup_grace_seconds, heartbeat_stale_seconds,
      // Routing config fields (T#594/T#596): absorbed from former routing_config_legacy
      stall_threshold_min, max_retries, sort_rules,
      // Project association
      project_id,
      system_role,
    } = req.body as {
      name?: string;
      role?: string;
      session_key?: string;
      workspace_path?: string;
      /**
       * repo_path — absolute path to the git repository used for worktree isolation (T#365).
       * When set, the dispatcher creates an isolated worktree per task under this repo so agents
       * never touch the main checkout. Set to null/empty to disable worktree isolation.
       */
      repo_path?: string | null;
      status?: string;
      model?: string | null;
      runtime_type?: string;
      runtime_config?: ClaudeCodeRuntimeConfig | null;
      /**
       * hooks_url — base URL of this agent's OpenClaw instance when running in a
       * Docker container (e.g. "http://localhost:3701" or "http://agent-name:3700").
       * When null the dispatcher falls back to the host gateway.
       */
      hooks_url?: string | null;
      /**
       * hooks_auth_header — full Authorization header value for hooks_url dispatch (task #431).
       * e.g. "Bearer <token>". When set, dispatcher uses this instead of the global HOOKS_TOKEN.
       */
      hooks_auth_header?: string | null;
      /** preferred_provider — which AI provider to prefer for model routing (default: 'anthropic') */
      preferred_provider?: string;
      /** os_user — dedicated macOS OS user for filesystem isolation (e.g. "agent-forge"). Null = no isolation. */
      os_user?: string | null;
      /** enabled — whether the agent's execution lane is active (1 = enabled, 0 = disabled) */
      enabled?: number | boolean;
      /** github_identity_id — FK to github_identities for per-agent GitHub credentials (task #613) */
      github_identity_id?: number | null;
      /** job_title — job template title merged onto agents table (T#619) */
      job_title?: string;
      /** schedule — cron schedule string (T#619) */
      schedule?: string;
      /** pre_instructions — pre-task instructions appended to dispatch payload (T#619) */
      pre_instructions?: string;
      /** skill_names — JSON array of skill names (T#619) */
      skill_names?: string[];
      /** timeout_seconds — job timeout in seconds (T#619) */
      timeout_seconds?: number | null;
      /** startup_grace_seconds — watchdog startup grace override per-agent (T#681). NULL = global default. */
      startup_grace_seconds?: number | null;
      /** heartbeat_stale_seconds — watchdog heartbeat stale override per-agent (T#681). NULL = global default. */
      heartbeat_stale_seconds?: number | null;
      /** stall_threshold_min — stall detection threshold in minutes (T#594) */
      stall_threshold_min?: number;
      /** max_retries — max dispatch retry count (T#594) */
      max_retries?: number;
      /** sort_rules — JSON array of sort criteria for candidate selection (T#594) */
      sort_rules?: string[];
      /** project_id — associate agent with a project (T#27) */
      project_id?: number | null;
      /** system_role — reserved built-in role identity */
      system_role?: string | null;
    };

    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const previousProjectId = (agent.project_id as number | null | undefined) ?? null;
    const resolvedRole = role !== undefined
      ? normalizeAgentRoleLabel(role, 'Agent')
      : String(agent.role ?? '');
    const resolvedProjectId = project_id !== undefined ? project_id : (agent.project_id as number | null | undefined) ?? null;
    const resolvedName = name ?? String(agent.name ?? '');
    const currentSessionKey = String(agent.session_key ?? '');
    const currentSessionParsed = parseAgentSessionKey(currentSessionKey);

    // Validate claude-code requires workingDirectory
    const effectiveRuntimeType = runtime_type !== undefined ? runtime_type : (agent.runtime_type ?? 'openclaw');
    if (effectiveRuntimeType === 'claude-code') {
      const effectiveConfig = runtime_config !== undefined ? runtime_config : (() => {
        try { return typeof agent.runtime_config === 'string' ? JSON.parse(agent.runtime_config as string) : agent.runtime_config; } catch { return null; }
      })();
      if (!(effectiveConfig as ClaudeCodeRuntimeConfig | null)?.workingDirectory) {
        return res.status(400).json({ error: 'runtime_config.workingDirectory is required for claude-code runtime' });
      }
    }

    const resolvedPreferredProvider = preferred_provider !== undefined ? preferred_provider : (agent.preferred_provider as string | null | undefined);
    const resolvedModelInput = model !== undefined ? model : (agent.model as string | null | undefined);
    const resolvedModel = resolvedModelInput ?? defaultAgentModelForProvider(resolvedPreferredProvider);
    if (resolvedPreferredProvider) {
      const providerValidationError = validateAgentProviderSelection(resolvedPreferredProvider, resolvedModel);
      if (providerValidationError) {
        return res.status(400).json({ error: providerValidationError });
      }
    }

    // Resolve repo_path: explicit null/empty string clears it; undefined keeps existing value
    let resolvedRepoPath: string | null;
    if (repo_path !== undefined) {
      resolvedRepoPath = (repo_path === '' || repo_path === null) ? null : repo_path;
    } else {
      resolvedRepoPath = (agent.repo_path as string | null) ?? null;
    }

    // Resolve skill_names as JSON
    const resolvedSkillNames = skill_names !== undefined
      ? JSON.stringify(Array.isArray(skill_names) ? skill_names : [])
      : (agent.skill_names as string | null) ?? '[]';

    // Resolve sort_rules as JSON (T#594)
    const resolvedSortRules = sort_rules !== undefined
      ? JSON.stringify(Array.isArray(sort_rules) ? sort_rules : [])
      : (agent.sort_rules as string | null) ?? '[]';

    const resolvedSystemRole = system_role === undefined
      ? (agent.system_role as string | null) ?? null
      : (system_role === ATLAS_SYSTEM_ROLE ? ATLAS_SYSTEM_ROLE : null);
    const resolvedSessionKey = session_key !== undefined
      ? session_key
      : (
        currentSessionParsed?.scope === 'main'
          ? buildDefaultAgentSessionKey({
              name: resolvedName,
              role: resolvedRole,
              projectId: resolvedProjectId,
              systemRole: resolvedSystemRole,
            })
          : currentSessionKey
      );

    db.prepare(`
      UPDATE agents SET
        name = ?,
        role = ?,
        session_key = ?,
        workspace_path = ?,
        repo_path = ?,
        status = ?,
        model = ?,
        runtime_type = ?,
        runtime_config = ?,
        hooks_url = ?,
        hooks_auth_header = ?,
        preferred_provider = ?,
        os_user = ?,
        enabled = ?,
        github_identity_id = ?,
        job_title = ?,
        schedule = ?,
        pre_instructions = ?,
        skill_names = ?,
        timeout_seconds = ?,
        startup_grace_seconds = ?,
        heartbeat_stale_seconds = ?,
        stall_threshold_min = ?,
        max_retries = ?,
        sort_rules = ?,
        project_id = ?,
        system_role = ?,
        last_active = datetime('now')
      WHERE id = ?
    `).run(
      resolvedName,
      resolvedRole,
      resolvedSessionKey,
      workspace_path ?? agent.workspace_path,
      resolvedRepoPath,
      status ?? agent.status,
      resolvedModel,
      runtime_type !== undefined ? runtime_type : (agent.runtime_type ?? 'openclaw'),
      runtime_config !== undefined
        ? (runtime_config != null ? JSON.stringify(runtime_config) : null)
        : agent.runtime_config,
      hooks_url !== undefined ? hooks_url : agent.hooks_url,
      hooks_auth_header !== undefined ? hooks_auth_header : (agent.hooks_auth_header ?? null),
      preferred_provider !== undefined ? preferred_provider : (agent.preferred_provider ?? null),
      os_user !== undefined ? os_user : (agent.os_user ?? null),
      enabled !== undefined ? (enabled ? 1 : 0) : agent.enabled,
      github_identity_id !== undefined ? github_identity_id : (agent.github_identity_id ?? null),
      job_title !== undefined ? job_title : (agent.job_title as string | null) ?? '',
      schedule !== undefined ? schedule : (agent.schedule as string | null) ?? '',
      pre_instructions !== undefined ? pre_instructions : (agent.pre_instructions as string | null) ?? '',
      resolvedSkillNames,
      timeout_seconds !== undefined ? timeout_seconds : (agent.timeout_seconds as number | null) ?? 900,
      startup_grace_seconds !== undefined ? startup_grace_seconds : (agent.startup_grace_seconds as number | null) ?? null,
      heartbeat_stale_seconds !== undefined ? heartbeat_stale_seconds : (agent.heartbeat_stale_seconds as number | null) ?? null,
      stall_threshold_min !== undefined ? stall_threshold_min : (agent.stall_threshold_min as number | null) ?? 30,
      max_retries !== undefined ? max_retries : (agent.max_retries as number | null) ?? 3,
      resolvedSortRules,
      resolvedProjectId,
      resolvedSystemRole,
      req.params.id
    );

    // Track pre_instructions changes for prompt effectiveness analytics (#586)
    if (pre_instructions !== undefined && pre_instructions !== (agent.pre_instructions as string | null)) {
      try {
        const agentCols = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
        const hasUpdatedAt = agentCols.some((c: { name: string }) => c.name === 'pre_instructions_updated_at');
        const hasVersion = agentCols.some((c: { name: string }) => c.name === 'instructions_version');
        if (hasUpdatedAt || hasVersion) {
          const clauses: string[] = [];
          if (hasUpdatedAt) clauses.push(`pre_instructions_updated_at = datetime('now')`);
          if (hasVersion)   clauses.push(`instructions_version = instructions_version + 1`);
          db.prepare(`UPDATE agents SET ${clauses.join(', ')} WHERE id = ?`).run(req.params.id);
        }
      } catch { /* non-fatal */ }
    }

    const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown>;
    const nextProjectId = (updated.project_id as number | null | undefined) ?? null;
    syncStarterRoutingForProject(db, previousProjectId);
    if (nextProjectId !== previousProjectId) {
      syncStarterRoutingForProject(db, nextProjectId);
    }

    // Keep OpenClaw agent config in sync for provisioned openclaw-runtime agents.
    // Without this, Atlas HQ can update the DB model/provider while ~/.openclaw/openclaw.json
    // still points at an older model, causing openclaw status and fresh defaulted sessions to drift.
    if ((updated.runtime_type as string | null) === 'openclaw') {
      try {
        const slug = resolveSlug(updated);
        const config = readOpenclawJson();
        const agentsConfig = (config.agents as Record<string, unknown> | undefined) ?? {};
        const list = (agentsConfig.list as Array<Record<string, unknown>> | undefined) ?? [];
        const entry = list.find((a) => a.id === slug);
        if (entry) {
          entry.name = slug;
          if (updated.workspace_path) entry.workspace = updated.workspace_path as string;
          const homedir = os.homedir();
          entry.agentDir = path.join(homedir, '.openclaw', 'agents', slug, 'agent');
          const modelValue = (updated.model as string | null | undefined)?.trim();
          if (modelValue) {
            entry.model = { primary: modelValue };
          } else if (entry.model && typeof entry.model === 'object') {
            delete (entry.model as Record<string, unknown>).primary;
          }
          agentsConfig.list = list;
          config.agents = agentsConfig;
          writeOpenclawJson(config);
          setImmediate(() => {
            try {
              const gateway = ensureOpenClawGatewayAvailable();
              if (!gateway.ok) {
                throw new Error(gateway.message);
              }
            } catch (restartErr) {
              console.warn(
                `[agents.put] openclaw gateway restart failed after syncing agent #${req.params.id}:`,
                restartErr instanceof Error ? restartErr.message : String(restartErr),
              );
            }
          });
        }
      } catch (syncErr) {
        console.warn(
          `[agents.put] failed to sync openclaw.json for agent #${req.params.id}:`,
          syncErr instanceof Error ? syncErr.message : String(syncErr),
        );
      }
    }

    // ── Task #644: propagate skill assignment changes to runtime artifacts ──
    // When skill_names changes, re-materialize runtime artifacts in the background
    // so the workspace reflects the updated assignment without requiring a full dispatch.
    if (skill_names !== undefined && (updated.workspace_path as string | null)) {
      const workingDirectory = updated.workspace_path as string;
      const runtimeType = (updated.runtime_type as string | null) ?? 'openclaw';
      let syncSkillNames: string[] = [];
      try {
        const parsed = JSON.parse(resolvedSkillNames);
        if (Array.isArray(parsed)) syncSkillNames = parsed.filter((s): s is string => typeof s === 'string');
      } catch { /* ignore */ }

      setImmediate(() => {
        try {
          const adapter = getSkillMaterializationAdapter(runtimeType);
          const result = adapter.materialize({
            workingDirectory,
            skillNames: syncSkillNames,
            skillsBasePath: OPENCLAW_SKILLS_PATH,
            hooksUrl: (updated.hooks_url as string | null) ?? null,
          });
          for (const warn of result.warnings) console.warn(`[agents.put] ${warn}`);
          if (result.count > 0 || result.details.length > 0) {
            console.log(
              `[agents.put] skill re-materialization (${adapter.adapterName}) for agent #${req.params.id}: ${result.count} artifact(s) updated`,
            );
          }
        } catch (matErr) {
          console.warn(
            `[agents.put] skill re-materialization failed for agent #${req.params.id}:`,
            matErr instanceof Error ? matErr.message : String(matErr),
          );
        }
      });
    }

    // Keep workspace .mcp.json in sync for OpenClaw agents when the workspace
    // changes so direct chat and fresh sessions see assigned MCP servers
    // without waiting for dispatcher materialization.
    if ((updated.runtime_type as string | null) === 'openclaw' && workspace_path !== undefined) {
      setImmediate(() => {
        try {
          const result = syncAssignedMcpForAgent({
            db,
            agentId: Number(req.params.id),
            workingDirectory: (updated.workspace_path as string | null) ?? null,
          });
          for (const warn of result.warnings) console.warn(`[agents.put] ${warn}`);
          if (result.skipped === 'missing_workspace') return;
          if (!result.ok && result.error) {
            console.warn(`[agents.put] MCP re-materialization failed for agent #${req.params.id}: ${result.error}`);
            return;
          }
          console.log(
            `[agents.put] MCP re-materialization for agent #${req.params.id}: ${result.count} server(s) updated`,
          );
        } catch (mcpErr) {
          console.warn(
            `[agents.put] MCP re-materialization failed for agent #${req.params.id}:`,
            mcpErr instanceof Error ? mcpErr.message : String(mcpErr),
          );
        }
      });
    }

    // ── Sync model to openclaw.json for openclaw-runtime agents ──
    // When preferred_provider or model changes, update the agent's model.primary
    // in the host openclaw.json so the gateway picks up the change on next session.
    // Bug fix: use resolveSlug(updated) — the agents table has no 'slug' column;
    // the correct slug is derived from openclaw_agent_id or session_key.
    if ((model !== undefined || preferred_provider !== undefined) && OPENCLAW_ENABLED) {
      const runtimeType = (updated.runtime_type as string | null) ?? 'openclaw';
      const agentSlug = resolveSlug(updated);
      const provider = (updated.preferred_provider as string | null) ?? 'anthropic';
      const newModel = (updated.model as string | null) ?? defaultAgentModelForProvider(provider);
      if (runtimeType === 'openclaw' && agentSlug && newModel) {
        try {
          const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8');
          const ocConfig = JSON.parse(raw);
          // Resolve the OpenClaw provider prefix — check models.providers keys for a match
          let ocProvider = provider;
          if (!newModel.includes('/')) {
            const providerKeys = Object.keys(ocConfig?.models?.providers ?? {});
            // Prefer exact match, then prefix match (e.g. 'minimax' → 'minimax-portal')
            const match = providerKeys.find(k => k === provider) ?? providerKeys.find(k => k.startsWith(provider));
            if (match) ocProvider = match;
          }
          const qualifiedModel = newModel.includes('/') ? newModel : `${ocProvider}/${newModel}`;
          const agentsList = ocConfig?.agents?.list as Array<Record<string, unknown>> | undefined;
          if (agentsList) {
            const ocAgent = agentsList.find((a: Record<string, unknown>) => a.id === agentSlug);
            if (ocAgent) {
              if (!ocAgent.model || typeof ocAgent.model !== 'object') ocAgent.model = {};
              (ocAgent.model as Record<string, unknown>).primary = qualifiedModel;
              fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(ocConfig, null, 2));
              console.log(`[agents.put] synced model "${qualifiedModel}" to openclaw.json for agent "${agentSlug}"`);
            }
          }
        } catch (err) {
          console.warn(`[agents.put] failed to sync model to openclaw.json:`, err instanceof Error ? err.message : String(err));
        }
      }
    }

    return res.json(parseAgentRuntimeConfig(updated));
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/agents/:id/docs
// Task #469: Uses WorkspaceProvider so remote agents (Veri etc.) serve docs
// through the same endpoint without special-case logic.
router.get('/:id/docs', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const docFiles = ['SOUL.md', 'AGENTS.md', 'USER.md', 'IDENTITY.md', 'MEMORY.md', 'TOOLS.md', 'HEARTBEAT.md', 'LESSONS.md'];
    const provider = resolveWorkspaceProvider(req.params.id);
    const docs = await provider.readDocs(docFiles);

    return res.json(docs);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Helper: derive a clean slug from an agent name
// ---------------------------------------------------------------------------
function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Helper: resolve the best available slug for an agent record.
// Priority: openclaw_agent_id > session-key utility > toSlug(name)
// ---------------------------------------------------------------------------
function resolveSlug(agent: Record<string, unknown>): string {
  const fromSession = resolveRuntimeAgentSlug({
    openclaw_agent_id: agent.openclaw_agent_id as string | null | undefined,
    session_key: agent.session_key as string | null | undefined,
    name: agent.name as string | null | undefined,
  });
  if (fromSession) return fromSession;
  return toSlug(agent.name as string);
}

// ---------------------------------------------------------------------------
// Helper: read + parse openclaw.json safely
// ---------------------------------------------------------------------------
const OPENCLAW_JSON = path.join(os.homedir(), '.openclaw', 'openclaw.json');

function readOpenclawJson(): Record<string, unknown> {
  const raw = fs.readFileSync(OPENCLAW_JSON, 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function writeOpenclawJson(data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(OPENCLAW_JSON), { recursive: true });
  fs.writeFileSync(OPENCLAW_JSON, JSON.stringify(data, null, 4), 'utf-8');
}

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/provision-status
// OpenClaw-specific endpoint — only meaningful for agents with runtime_type = 'openclaw'
// ---------------------------------------------------------------------------
router.get('/:id/provision-status', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Non-OpenClaw runtimes don't use workspace/openclaw.json provisioning
    if (agent.runtime_type && agent.runtime_type !== 'openclaw') {
      return res.json({
        provisioned: false,
        not_applicable: true,
        runtime_type: agent.runtime_type,
        message: `Provisioning is only available for openclaw runtime agents. This agent uses '${agent.runtime_type}'.`,
      });
    }

    const slug = resolveSlug(agent);
    const homedir = os.homedir();
    const workspacePath = (agent.workspace_path as string) || path.join(homedir, '.openclaw', `workspace-${slug}`);
    const agentDirPath = path.join(homedir, '.openclaw', 'agents', slug, 'agent');

    const workspaceExists = fs.existsSync(workspacePath);

    // Check openclaw.json for this agent entry
    let openclawRegistered = false;
    try {
      const config = readOpenclawJson();
      const agents = (config.agents as Record<string, unknown> | undefined) ?? {};
      const list = (agents.list as Array<Record<string, unknown>> | undefined) ?? [];
      openclawRegistered = list.some((a) => a.id === slug);
    } catch {
      openclawRegistered = false;
    }

    return res.json({
      provisioned: workspaceExists && openclawRegistered,
      workspace_exists: workspaceExists,
      workspace_path: workspacePath,
      openclaw_registered: openclawRegistered,
      agent_dir: agentDirPath,
      slug,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/provision
// OpenClaw-specific endpoint — only applicable when runtime_type = 'openclaw'
// ---------------------------------------------------------------------------
router.post('/:id/provision', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { restart_gateway } = req.body as { restart_gateway?: boolean };
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Provisioning is an OpenClaw-specific operation
    if (agent.runtime_type && agent.runtime_type !== 'openclaw') {
      return res.status(400).json({
        error: `Provisioning is only available for openclaw runtime agents. This agent uses '${agent.runtime_type}'.`,
        runtime_type: agent.runtime_type,
      });
    }

    const homedir = os.homedir();
    const slug = resolveSlug(agent);
    const agentModel = (agent.model as string) || 'anthropic/claude-sonnet-4-6';
    const workspacePath = (agent.workspace_path as string) || path.join(homedir, '.openclaw', `workspace-${slug}`);
    const agentDirPath = path.join(homedir, '.openclaw', 'agents', slug, 'agent');
    const sessionKey = (agent.session_key as string) || buildCanonicalAgentMainSessionKey({
      projectName: agent.project_name as string | null | undefined,
      agentName: agent.name as string | null | undefined,
      role: agent.role as string | null | undefined,
    });
    const shouldRestartGateway = restart_gateway === true;

    // --- 1. Create workspace dir ------------------------------------------------
    fs.mkdirSync(workspacePath, { recursive: true });

    // --- 2. Scaffold identity files --------------------------------------------

    // SOUL.md — role-based persona
    const soulPath = path.join(workspacePath, 'SOUL.md');
    if (!fs.existsSync(soulPath)) {
      const roleLine = agent.role ? `You are a ${agent.role}.` : `You are ${agent.name as string}.`;
      fs.writeFileSync(soulPath, `# SOUL.md — ${agent.name as string}\n\n${roleLine}\n\n## Core Principles\n- Be genuinely helpful, not performatively helpful.\n- Have opinions and push back when something doesn't make sense.\n- Be resourceful before asking.\n- Write clean, well-documented work.\n- Deliver results — no fluff, no filler.\n`, 'utf-8');
    }

    // AGENTS.md — copy from workspace base
    const agentsMdPath = path.join(workspacePath, 'AGENTS.md');
    if (!fs.existsSync(agentsMdPath)) {
      const baseAgentsMd = path.join(homedir, '.openclaw', 'workspace', 'AGENTS.md');
      if (fs.existsSync(baseAgentsMd)) {
        fs.copyFileSync(baseAgentsMd, agentsMdPath);
      } else {
        fs.writeFileSync(agentsMdPath, `# AGENTS.md — ${agent.name as string}\n\n## Every Session\n1. Read \`SOUL.md\`\n2. Check task queue\n3. Work the task\n`, 'utf-8');
      }
    }

    // TOOLS.md — blank
    const toolsMdPath = path.join(workspacePath, 'TOOLS.md');
    if (!fs.existsSync(toolsMdPath)) {
      fs.writeFileSync(toolsMdPath, `# TOOLS.md — ${agent.name as string}\n\nEnvironment-specific notes. Add as needed.\n`, 'utf-8');
    }

    // MEMORY.md — blank
    const memoryMdPath = path.join(workspacePath, 'MEMORY.md');
    if (!fs.existsSync(memoryMdPath)) {
      fs.writeFileSync(memoryMdPath, `# MEMORY.md — ${agent.name as string}\n\nLong-term memory. Updated during sessions.\n`, 'utf-8');
    }

    // --- 3. Create agentDir ----------------------------------------------------
    fs.mkdirSync(agentDirPath, { recursive: true });
    const authProvidersSynced = syncStoredProviderAuthProfiles(agentDirPath);

    // --- 4. Patch openclaw.json ------------------------------------------------
    let gatewayRestarted = false;
    let gatewayError: string | null = null;

    try {
      const config = readOpenclawJsonOrDefault();
      const agentsConfig = (config.agents as Record<string, unknown> | undefined) ?? {};
      const list = (agentsConfig.list as Array<Record<string, unknown>> | undefined) ?? [];

      const alreadyRegistered = list.some((a) => a.id === slug);
      if (!alreadyRegistered) {
        const newEntry: Record<string, unknown> = {
          id: slug,
          name: slug,
          workspace: workspacePath,
          agentDir: agentDirPath,
          model: { primary: agentModel },
        };
        list.push(newEntry);
        agentsConfig.list = list;
        config.agents = agentsConfig;
        writeOpenclawJson(config);
      }
    } catch (jsonErr) {
      return res.status(500).json({ error: `Failed to patch openclaw.json: ${String(jsonErr)}` });
    }

    // --- 5. Update DB record ---------------------------------------------------
    db.prepare(`
      UPDATE agents SET
        workspace_path = ?,
        openclaw_agent_id = ?,
        session_key = ?
      WHERE id = ?
    `).run(workspacePath, slug, sessionKey, req.params.id);

    let pairingApproved = false;
    let pairingMessage: string | null = shouldRestartGateway ? null : 'Skipped: gateway restart deferred.';
    if (shouldRestartGateway) {
      // --- 6. Restart gateway ---------------------------------------------------
      try {
        const gateway = ensureOpenClawGatewayAvailable();
        gatewayRestarted = gateway.ok;
        if (!gateway.ok) {
          gatewayError = gateway.message;
        }
      } catch (restartErr) {
        gatewayError = restartErr instanceof Error ? restartErr.message : String(restartErr);
      // Non-fatal — workspace + config are already set up
    }
      pairingApproved = false;
      pairingMessage = 'Pairing is manual. If the restarted gateway asks for pairing, approve the pending request with `openclaw devices list` and `openclaw devices approve <requestId>`.';

    }

    return res.json({
      ok: true,
      provisioned: true,
      slug,
      session_key: sessionKey,
      workspace_path: workspacePath,
      workspace: workspacePath,
      agent_dir: agentDirPath,
      model: agentModel,
      openclaw_agent_id: slug,
      auth_providers_synced: authProvidersSynced,
      gateway_restarted: gatewayRestarted,
      gateway_error: gatewayError,
      restart_required: !shouldRestartGateway,
      message: shouldRestartGateway
        ? (gatewayError ? 'Agent provisioned, but gateway restart did not complete.' : 'Agent provisioned and gateway restart attempted.')
        : 'Agent provisioned. OpenClaw can pick up the new agent configuration without a manual restart.',
      pairing_approved: pairingApproved,
      pairing_message: pairingMessage,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// CLAUDE.md endpoints (claude-code runtime only)
// ---------------------------------------------------------------------------

/**
 * Shared helper: fetch agent, verify it is claude-code runtime, and return
 * the workingDirectory from runtime_config.
 * Returns { agent, workingDirectory } on success, or sends an error response
 * and returns null.
 */
function resolveClaudeCodeAgent(
  req: Request,
  res: Response,
): { agent: Record<string, unknown>; workingDirectory: string } | null {
  const db = getDb();
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return null;
  }

  if ((agent.runtime_type as string) !== 'claude-code') {
    res.status(400).json({ error: 'Agent is not a claude-code runtime agent' });
    return null;
  }

  let runtimeConfig: Record<string, unknown> | null = null;
  try {
    runtimeConfig = typeof agent.runtime_config === 'string'
      ? JSON.parse(agent.runtime_config as string)
      : (agent.runtime_config as Record<string, unknown> | null);
  } catch {
    runtimeConfig = null;
  }

  const workingDirectory = (runtimeConfig as Record<string, unknown> | null)?.workingDirectory as string | undefined;
  if (!workingDirectory) {
    res.status(400).json({ error: 'Agent runtime_config is missing workingDirectory' });
    return null;
  }

  return { agent, workingDirectory };
}

// GET /api/v1/agents/:id/claude-md
router.get('/:id/claude-md', (req: Request, res: Response) => {
  try {
    const resolved = resolveClaudeCodeAgent(req, res);
    if (!resolved) return;
    const { workingDirectory } = resolved;

    const claudeMdPath = path.join(workingDirectory, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      return res.status(404).json({ error: 'CLAUDE.md does not exist for this agent' });
    }

    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    const stat = fs.statSync(claudeMdPath);
    return res.json({
      content,
      lastModified: stat.mtime.toISOString(),
      path: claudeMdPath,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// PUT /api/v1/agents/:id/claude-md
router.put('/:id/claude-md', (req: Request, res: Response) => {
  try {
    const resolved = resolveClaudeCodeAgent(req, res);
    if (!resolved) return;
    const { workingDirectory } = resolved;

    const { content } = req.body as { content?: unknown };
    if (typeof content !== 'string' || content.trim() === '') {
      return res.status(400).json({ error: 'content must be a non-empty string' });
    }

    const claudeMdPath = path.join(workingDirectory, 'CLAUDE.md');
    fs.mkdirSync(workingDirectory, { recursive: true });
    fs.writeFileSync(claudeMdPath, content, 'utf-8');

    const stat = fs.statSync(claudeMdPath);
    return res.json({
      content,
      lastModified: stat.mtime.toISOString(),
      path: claudeMdPath,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// POST /api/v1/agents/:id/claude-md/regen
router.post('/:id/claude-md/regen', (req: Request, res: Response) => {
  try {
    const resolved = resolveClaudeCodeAgent(req, res);
    if (!resolved) return;
    const { agent, workingDirectory } = resolved;

    // Task #596: read skill_names from agents table directly (canonical source)
    const db = getDb();
    let skillNames: string[] = [];
    try {
      const agentRow = db.prepare(`SELECT skill_names FROM agents WHERE id = ?`).get(agent.id) as { skill_names: string | null } | undefined;
      if (agentRow?.skill_names) {
        const parsed = JSON.parse(agentRow.skill_names);
        if (Array.isArray(parsed)) {
          skillNames = parsed.filter((s): s is string => typeof s === 'string');
        }
      }
    } catch { /* ignore — skill_names is optional */ }

    fs.mkdirSync(workingDirectory, { recursive: true });
    generateClaudeMd({
      workingDirectory,
      skillNames,
      hooksUrl: (agent.hooks_url as string | null) ?? null,
    });

    const claudeMdPath = path.join(workingDirectory, 'CLAUDE.md');
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    const stat = fs.statSync(claudeMdPath);
    return res.json({
      content,
      lastModified: stat.mtime.toISOString(),
      path: claudeMdPath,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/skills/sync — task #644: on-demand skill materialization
//
// Triggers runtime-aware skill materialization for the agent without requiring
// a full dispatch. Useful when skills are added/removed/updated and the runtime
// workspace should be updated immediately.
//
// The adapter is selected based on the agent's runtime_type so the correct
// artifacts are created for each runtime (symlinks for claude-code/openclaw,
// no-op for remote runtimes).
// ---------------------------------------------------------------------------
router.post('/:id/skills/sync', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const agent = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Resolve working directory: prefer explicit body override, then workspace_path
    const bodyWorkDir = typeof (req.body as Record<string, unknown>)?.working_directory === 'string'
      ? (req.body as Record<string, unknown>).working_directory as string
      : null;
    const workingDirectory = bodyWorkDir ?? (agent.workspace_path as string | null) ?? null;

    if (!workingDirectory) {
      return res.status(400).json({ error: 'Agent has no workspace_path and no working_directory was provided' });
    }

    // Resolve skill names: prefer body override (for testing), then agent record
    let skillNames: string[] = [];
    const bodySkills = (req.body as Record<string, unknown>)?.skill_names;
    if (Array.isArray(bodySkills)) {
      skillNames = bodySkills.filter((s): s is string => typeof s === 'string');
    } else if (agent.skill_names && typeof agent.skill_names === 'string') {
      try {
        const parsed = JSON.parse(agent.skill_names);
        if (Array.isArray(parsed)) {
          skillNames = parsed.filter((s): s is string => typeof s === 'string');
        }
      } catch { /* ignore */ }
    }

    const runtimeType = (agent.runtime_type as string | null) ?? 'openclaw';
    const adapter = getSkillMaterializationAdapter(runtimeType);

    const result = adapter.materialize({
      workingDirectory,
      skillNames,
      skillsBasePath: OPENCLAW_SKILLS_PATH,
      hooksUrl: (agent.hooks_url as string | null) ?? null,
    });

    return res.json({
      ok: result.ok,
      adapter: adapter.adapterName,
      runtime_type: runtimeType,
      working_directory: workingDirectory,
      skill_names: skillNames,
      count: result.count,
      details: result.details,
      warnings: result.warnings,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/mcp/sync — on-demand OpenClaw MCP materialization
//
// Writes the effective assigned MCP server set into the agent workspace
// immediately so direct chat sessions and future OpenClaw bootstraps do not
// depend on dispatcher-side materialization.
// ---------------------------------------------------------------------------
router.post('/:id/mcp/sync', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const agent = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const bodyWorkDir = typeof (req.body as Record<string, unknown>)?.working_directory === 'string'
      ? (req.body as Record<string, unknown>).working_directory as string
      : null;
    const runtimeType = (agent.runtime_type as string | null) ?? 'openclaw';

    const result = syncAssignedMcpForAgent({
      db,
      agentId: Number(req.params.id),
      workingDirectory: bodyWorkDir ?? (agent.workspace_path as string | null) ?? null,
    });

    if (result.skipped === 'agent_not_found') {
      return res.status(404).json({ error: result.error ?? 'Agent not found' });
    }
    if (result.skipped === 'missing_workspace') {
      return res.status(400).json({ error: result.error ?? 'Agent has no workspace_path and no working_directory was provided' });
    }

    return res.json({
      ok: result.ok,
      runtime_type: runtimeType,
      working_directory: result.workingDirectory,
      count: result.count,
      path: result.path ?? null,
      warnings: result.warnings,
      skipped: result.skipped ?? null,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/instances — agent-native instance list (Task #594)
// Replaces GET /api/v1/jobs/:id/instances
// ---------------------------------------------------------------------------
router.get('/:id/instances', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const instances = db.prepare(`
      SELECT ji.*, a.job_title as job_title, a.name as agent_name,
             ia.current_stage, ia.last_agent_heartbeat_at, ia.last_meaningful_output_at,
             ia.latest_commit_hash, ia.branch_name, ia.changed_files_json, ia.changed_files_count,
             ia.summary as artifact_summary, ia.blocker_reason, ia.outcome as artifact_outcome,
             ia.stale as run_is_stale, ia.stale_at,
             ji.task_outcome
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id
      LEFT JOIN instance_artifacts ia ON ia.instance_id = ji.id
      WHERE ji.agent_id = ?
      ORDER BY ji.created_at DESC
      LIMIT ?
    `).all(req.params.id, limit);
    return res.json(instances);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/routing-config — agent-native routing config (Task #594)
// Replaces GET /api/v1/routing/config/:job_id
// ---------------------------------------------------------------------------
router.get('/:id/routing-config', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const agent = db.prepare(`
      SELECT id, name, job_title, stall_threshold_min, max_retries, sort_rules
      FROM agents WHERE id = ?
    `).get(req.params.id) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    let sortRules: string[] = [];
    try { sortRules = JSON.parse((agent.sort_rules as string) || '[]'); } catch { /* ignore */ }

    return res.json({
      agent_id: agent.id,
      agent_name: agent.name,
      job_title: agent.job_title,
      stall_threshold_min: agent.stall_threshold_min,
      max_retries: agent.max_retries,
      sort_rules: sortRules,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/v1/agents/:id/routing-config — update agent routing config (Task #594)
// Replaces PUT /api/v1/routing/config/:job_id
// ---------------------------------------------------------------------------
router.put('/:id/routing-config', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const { stall_threshold_min, max_retries, sort_rules } = req.body;

    const sets: string[] = [];
    const vals: unknown[] = [];

    if (stall_threshold_min !== undefined) { sets.push('stall_threshold_min = ?'); vals.push(stall_threshold_min); }
    if (max_retries !== undefined) { sets.push('max_retries = ?'); vals.push(max_retries); }
    if (sort_rules !== undefined) { sets.push('sort_rules = ?'); vals.push(JSON.stringify(sort_rules)); }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    sets.push("last_active = datetime('now')");
    vals.push(req.params.id);
    db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    const updated = db.prepare(`
      SELECT id, name, job_title, stall_threshold_min, max_retries, sort_rules
      FROM agents WHERE id = ?
    `).get(req.params.id) as Record<string, unknown>;

    let sortRules: string[] = [];
    try { sortRules = JSON.parse((updated.sort_rules as string) || '[]'); } catch { /* ignore */ }

    return res.json({
      agent_id: updated.id,
      agent_name: updated.name,
      job_title: updated.job_title,
      stall_threshold_min: updated.stall_threshold_min,
      max_retries: updated.max_retries,
      sort_rules: sortRules,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/v1/agents/:id
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = req.params.id;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const previousProjectId = (agent.project_id as number | null | undefined) ?? null;

    // Idle guard — only allow deletion of idle agents
    if (agent.status !== 'idle') {
      return res.status(409).json({
        error: `Cannot delete agent while status is "${agent.status}". Wait until agent is idle.`,
      });
    }

    // OpenClaw native cleanup (if provisioned)
    if (agent.openclaw_agent_id) {
      const result = runOpenClawSync(
        ['agents', 'delete', '--force', agent.openclaw_agent_id as string],
        { stdio: 'pipe' },
      );
      if (result.status !== 0) {
        console.warn(`[agents] openclaw agents delete ${agent.openclaw_agent_id}: ${(result.stderr ?? '').toString().trim()}`);
      } else {
        console.log(`[agents] Deleted OpenClaw agent: ${agent.openclaw_agent_id}`);
      }
    }

    // Workspace cleanup — only delete dirs under ~/.openclaw/workspace-*
    const workspacePath = agent.workspace_path as string;
    const safePrefix = os.homedir() + '/.openclaw/workspace-';
    if (workspacePath && workspacePath.startsWith(safePrefix) && fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
      console.log(`[agents] Removed workspace: ${workspacePath}`);
    }

    // DB cleanup
    db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    syncStarterRoutingForProject(db, previousProjectId);

    return res.json({ ok: true, deleted: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeCodeRuntimeConfig {
  workingDirectory: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPromptSuffix?: string;
}

// ---------------------------------------------------------------------------
// Helpers: parse runtime_config JSON + normalize agent records
// ---------------------------------------------------------------------------

/**
 * Parse runtime_config from a raw DB row (stored as JSON string or null).
 */
function parseAgentRuntimeConfig(agent: Record<string, unknown>): Record<string, unknown> {
  const raw = agent.runtime_config;
  let parsed: ClaudeCodeRuntimeConfig | null = null;
  if (typeof raw === 'string' && raw) {
    try {
      parsed = JSON.parse(raw) as ClaudeCodeRuntimeConfig;
    } catch {
      parsed = null;
    }
  } else if (raw != null && typeof raw === 'object') {
    parsed = raw as ClaudeCodeRuntimeConfig;
  }

  // Phase 4 (T#459): parse skill_names JSON string from job_templates join
  let skillNames: string[] = [];
  const rawSkillNames = agent.skill_names;
  if (typeof rawSkillNames === 'string' && rawSkillNames) {
    try {
      const arr = JSON.parse(rawSkillNames);
      if (Array.isArray(arr)) skillNames = arr.filter((s: unknown): s is string => typeof s === 'string');
    } catch { /* ignore */ }
  }

  // Parse sort_rules JSON string
  let sortRules: string[] = [];
  const rawSortRules = agent.sort_rules;
  if (typeof rawSortRules === 'string' && rawSortRules) {
    try {
      const arr = JSON.parse(rawSortRules);
      if (Array.isArray(arr)) sortRules = arr.filter((s: unknown): s is string => typeof s === 'string');
    } catch { /* ignore */ }
  }

  // Do not default runtime_type to 'openclaw' in API responses — surface the actual stored value
  // so callers can distinguish "explicitly set to openclaw" from "never configured".
  // The dispatcher falls back to openclaw internally; the API should be honest about the stored value.
  const result: Record<string, unknown> = {
    ...agent,
    runtime_type: (agent.runtime_type as string | undefined) ?? 'openclaw',
    runtime_config: parsed,
    skill_names: skillNames,
    sort_rules: sortRules,
  };
  // Remove deprecated field from API responses
  delete result.dispatch_mode;
  return result;
}

/**
 * Parse an array of raw DB rows, normalizing runtime fields on each.
 */
function parseAgents(agents: unknown[]): Record<string, unknown>[] {
  return (agents as Record<string, unknown>[]).map(parseAgentRuntimeConfig);
}

export default router;
