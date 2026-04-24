import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';

const MANAGED_KEYS_FIELD = 'agentHqManagedMcpServers';

interface AgentMcpRow {
  slug: string;
  command: string | null;
  args: string | null;
  env: string | null;
  cwd: string | null;
  overrides: string | null;
}

interface AgentWorkspaceRow {
  id: number;
  runtime_type: string | null;
  workspace_path: string | null;
}

export interface McpMaterializationResult {
  ok: boolean;
  count: number;
  path: string;
  warnings: string[];
  error?: string;
}

export interface AgentMcpSyncResult {
  agentId: number;
  runtimeType: string;
  workingDirectory: string | null;
  ok: boolean;
  count: number;
  warnings: string[];
  path?: string;
  error?: string;
  skipped?: 'agent_not_found' | 'missing_workspace' | 'unsupported_runtime';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonStringArray(value: string | null | undefined): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    return parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim())
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

function parseJsonStringMap(value: string | null | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) return undefined;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, entry]) => typeof entry === 'string')
        .map(([key, entry]) => [key, String(entry)]),
    );
  } catch {
    return undefined;
  }
}

function extractServerMap(raw: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(raw)) return {};
  const nested = isRecord(raw.mcpServers)
    ? raw.mcpServers
    : isRecord(raw.servers)
      ? raw.servers
      : raw;
  if (!isRecord(nested)) return {};
  return Object.fromEntries(
    Object.entries(nested)
      .filter(([, value]) => isRecord(value))
      .map(([key, value]) => [key, { ...(value as Record<string, unknown>) }]),
  );
}

function buildDesiredServerConfig(row: AgentMcpRow): Record<string, unknown> | null {
  if (!row.command || !row.command.trim()) return null;

  const baseConfig: Record<string, unknown> = {
    command: row.command.trim(),
  };

  const args = parseJsonStringArray(row.args);
  if (args && args.length > 0) baseConfig.args = args;

  const env = parseJsonStringMap(row.env);
  if (env && Object.keys(env).length > 0) baseConfig.env = env;

  if (row.cwd && row.cwd.trim()) baseConfig.cwd = row.cwd.trim();

  const overrides = parseJsonRecord(row.overrides);
  const merged = { ...baseConfig, ...overrides };

  const baseEnv = isRecord(baseConfig.env) ? baseConfig.env as Record<string, string> : {};
  const overrideEnv = isRecord(overrides.env) ? overrides.env as Record<string, unknown> : {};
  if (Object.keys(baseEnv).length > 0 || Object.keys(overrideEnv).length > 0) {
    merged.env = Object.fromEntries(
      [...Object.entries(baseEnv), ...Object.entries(overrideEnv)]
        .filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => [key, String(value)]),
    );
  }

  return merged;
}

export function fetchAssignedMcpServers(
  db: Database.Database,
  agentId: number,
): Record<string, Record<string, unknown>> {
  const rows = db.prepare(`
    SELECT s.slug, s.command, s.args, s.env, s.cwd, ama.overrides
    FROM agent_mcp_assignments ama
    JOIN mcp_servers s ON s.id = ama.mcp_server_id
    WHERE ama.agent_id = ?
      AND ama.enabled = 1
      AND s.enabled = 1
    ORDER BY s.slug ASC
  `).all(agentId) as AgentMcpRow[];

  return Object.fromEntries(
    rows
      .map((row) => [row.slug, buildDesiredServerConfig(row)] as const)
      .filter((entry): entry is [string, Record<string, unknown>] => entry[1] !== null),
  );
}

export function materializeAgentMcpConfig(params: {
  db: Database.Database;
  agentId: number;
  workingDirectory: string;
}): McpMaterializationResult {
  const result: McpMaterializationResult = {
    ok: true,
    count: 0,
    path: path.join(params.workingDirectory, '.mcp.json'),
    warnings: [],
  };

  const desiredServers = fetchAssignedMcpServers(params.db, params.agentId);
  const desiredKeys = Object.keys(desiredServers);

  let existingRaw: unknown = {};
  if (fs.existsSync(result.path)) {
    try {
      existingRaw = JSON.parse(fs.readFileSync(result.path, 'utf8'));
    } catch (err) {
      result.warnings.push(
        `[mcp-materialization] could not parse existing ${result.path}; replacing it with Atlas-managed config (${err instanceof Error ? err.message : String(err)})`,
      );
      existingRaw = {};
    }
  }

  const existingRecord = isRecord(existingRaw) ? existingRaw : {};
  const preservedTopLevel: Record<string, unknown> = {};
  if (isRecord(existingRecord.mcpServers) || isRecord(existingRecord.servers)) {
    for (const [key, value] of Object.entries(existingRecord)) {
      if (key === 'mcpServers' || key === 'servers' || key === MANAGED_KEYS_FIELD) continue;
      preservedTopLevel[key] = value;
    }
  }

  const existingServers = extractServerMap(existingRaw);
  const previouslyManagedKeys = Array.isArray(existingRecord[MANAGED_KEYS_FIELD])
    ? (existingRecord[MANAGED_KEYS_FIELD] as unknown[])
        .filter((entry): entry is string => typeof entry === 'string')
    : [];

  for (const key of previouslyManagedKeys) {
    delete existingServers[key];
  }

  const mergedServers = {
    ...existingServers,
    ...desiredServers,
  };

  try {
    fs.mkdirSync(params.workingDirectory, { recursive: true });

    if (Object.keys(mergedServers).length === 0 && Object.keys(preservedTopLevel).length === 0) {
      if (fs.existsSync(result.path)) fs.unlinkSync(result.path);
      return result;
    }

    const nextConfig: Record<string, unknown> = {
      ...preservedTopLevel,
      mcpServers: mergedServers,
    };
    if (desiredKeys.length > 0) nextConfig[MANAGED_KEYS_FIELD] = desiredKeys;

    fs.writeFileSync(result.path, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
    result.count = desiredKeys.length;
    return result;
  } catch (err) {
    result.ok = false;
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }
}

export function syncAssignedMcpForAgent(params: {
  db: Database.Database;
  agentId: number;
  workingDirectory?: string | null;
}): AgentMcpSyncResult {
  const agent = params.db.prepare(`
    SELECT id, runtime_type, workspace_path
    FROM agents
    WHERE id = ?
  `).get(params.agentId) as AgentWorkspaceRow | undefined;

  if (!agent) {
    return {
      agentId: params.agentId,
      runtimeType: 'unknown',
      workingDirectory: params.workingDirectory ?? null,
      ok: false,
      count: 0,
      warnings: [],
      skipped: 'agent_not_found',
      error: `Agent #${params.agentId} not found`,
    };
  }

  const runtimeType = (agent.runtime_type ?? 'openclaw').trim() || 'openclaw';
  const workingDirectory = params.workingDirectory ?? agent.workspace_path ?? null;

  if (runtimeType !== 'openclaw') {
    return {
      agentId: agent.id,
      runtimeType,
      workingDirectory,
      ok: true,
      count: 0,
      warnings: [],
      skipped: 'unsupported_runtime',
    };
  }

  if (!workingDirectory) {
    return {
      agentId: agent.id,
      runtimeType,
      workingDirectory: null,
      ok: false,
      count: 0,
      warnings: [],
      skipped: 'missing_workspace',
      error: `Agent #${agent.id} has no workspace_path`,
    };
  }

  const result = materializeAgentMcpConfig({
    db: params.db,
    agentId: agent.id,
    workingDirectory,
  });

  return {
    agentId: agent.id,
    runtimeType,
    workingDirectory,
    ok: result.ok,
    count: result.count,
    warnings: result.warnings,
    path: result.path,
    ...(result.error ? { error: result.error } : {}),
  };
}

export function syncAssignedMcpForServer(params: {
  db: Database.Database;
  mcpServerId: number;
}): AgentMcpSyncResult[] {
  const agentIds = params.db.prepare(`
    SELECT DISTINCT agent_id
    FROM agent_mcp_assignments
    WHERE mcp_server_id = ?
    ORDER BY agent_id ASC
  `).all(params.mcpServerId) as Array<{ agent_id: number }>;

  return agentIds.map(({ agent_id }) => syncAssignedMcpForAgent({
    db: params.db,
    agentId: agent_id,
  }));
}
