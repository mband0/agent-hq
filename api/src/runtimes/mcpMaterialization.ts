import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { ensureMaterializedMcpApiKeyForAgent } from '../lib/mcpApiAuth';

const MANAGED_KEYS_FIELD = 'agentHqManagedMcpServers';
const OPENCLAW_MCP_BUNDLE_ID = 'agent-hq-mcp';
const OPENCLAW_MCP_BUNDLE_DIR = path.join('.openclaw', 'extensions', OPENCLAW_MCP_BUNDLE_ID);

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
  bundlePath: string;
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
  bundlePath?: string;
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

function resolveOpenClawConfigPath(): string {
  return process.env.OPENCLAW_CONFIG_PATH
    ?? path.join(process.env.HOME ?? os.homedir(), '.openclaw', 'openclaw.json');
}

export function ensureOpenClawMcpWorkspaceBundleEnabled(configPath = resolveOpenClawConfigPath()): {
  ok: boolean;
  changed: boolean;
  path: string;
  error?: string;
} {
  let rawConfig: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!isRecord(parsed)) {
        return { ok: false, changed: false, path: configPath, error: 'OpenClaw config is not a JSON object' };
      }
      rawConfig = parsed;
    } catch (err) {
      return {
        ok: false,
        changed: false,
        path: configPath,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const before = JSON.stringify(rawConfig);
  const plugins = isRecord(rawConfig.plugins) ? rawConfig.plugins : {};
  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  const existingEntry = isRecord(entries[OPENCLAW_MCP_BUNDLE_ID]) ? entries[OPENCLAW_MCP_BUNDLE_ID] : {};

  entries[OPENCLAW_MCP_BUNDLE_ID] = {
    ...existingEntry,
    enabled: true,
  };
  rawConfig.plugins = {
    ...plugins,
    entries,
  };

  if (JSON.stringify(rawConfig) === before) return { ok: true, changed: false, path: configPath };

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, 'utf8');
    return { ok: true, changed: true, path: configPath };
  } catch (err) {
    return {
      ok: false,
      changed: false,
      path: configPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function readStringEnvValue(env: unknown, key: string): string | null {
  if (!isRecord(env)) return null;
  const value = env[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildDesiredServerConfig(
  row: AgentMcpRow,
  params: {
    db: Database.Database;
    agentId: number;
    existingServer?: Record<string, unknown>;
  },
): Record<string, unknown> | null {
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

  if (row.slug === 'agent-hq') {
    const existingEnv = isRecord(params.existingServer?.env) ? params.existingServer?.env : {};
    const existingApiKey = readStringEnvValue(existingEnv, 'AGENT_HQ_MCP_API_KEY');
    const key = ensureMaterializedMcpApiKeyForAgent({
      db: params.db,
      agentId: params.agentId,
      existingApiKey,
      name: 'Agent HQ MCP materialized key',
    });
    const env = isRecord(merged.env) ? { ...(merged.env as Record<string, unknown>) } : {};
    env.AGENT_HQ_MCP_API_KEY = key.apiKey;
    merged.env = Object.fromEntries(
      Object.entries(env)
        .filter(([, value]) => typeof value === 'string')
        .map(([envKey, value]) => [envKey, String(value)]),
    );
  }

  return merged;
}

export function fetchAssignedMcpServers(
  db: Database.Database,
  agentId: number,
  existingServers: Record<string, Record<string, unknown>> = {},
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
      .map((row) => [row.slug, buildDesiredServerConfig(row, { db, agentId, existingServer: existingServers[row.slug] })] as const)
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
    bundlePath: path.join(params.workingDirectory, OPENCLAW_MCP_BUNDLE_DIR, '.mcp.json'),
    warnings: [],
  };

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
  const existingServers = extractServerMap(existingRaw);
  const desiredServers = fetchAssignedMcpServers(params.db, params.agentId, existingServers);
  const desiredKeys = Object.keys(desiredServers);
  const preservedTopLevel: Record<string, unknown> = {};
  if (isRecord(existingRecord.mcpServers) || isRecord(existingRecord.servers)) {
    for (const [key, value] of Object.entries(existingRecord)) {
      if (key === 'mcpServers' || key === 'servers' || key === MANAGED_KEYS_FIELD) continue;
      preservedTopLevel[key] = value;
    }
  }

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
      if (fs.existsSync(result.bundlePath)) fs.unlinkSync(result.bundlePath);
      return result;
    }

    const nextConfig: Record<string, unknown> = {
      ...preservedTopLevel,
      mcpServers: mergedServers,
    };
    if (desiredKeys.length > 0) nextConfig[MANAGED_KEYS_FIELD] = desiredKeys;

    fs.writeFileSync(result.path, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
    fs.mkdirSync(path.dirname(result.bundlePath), { recursive: true });
    fs.writeFileSync(result.bundlePath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
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

  if (result.ok && result.count > 0) {
    const configResult = ensureOpenClawMcpWorkspaceBundleEnabled();
    if (!configResult.ok) {
      result.warnings.push(
        `[mcp-materialization] could not enable OpenClaw workspace MCP bundle in ${configResult.path}: ${configResult.error ?? 'unknown error'}`,
      );
    }
  }

  return {
    agentId: agent.id,
    runtimeType,
    workingDirectory,
    ok: result.ok,
    count: result.count,
    warnings: result.warnings,
    path: result.path,
    bundlePath: result.bundlePath,
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
