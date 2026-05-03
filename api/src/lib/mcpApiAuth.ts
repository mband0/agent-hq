import crypto from 'crypto';
import type Database from 'better-sqlite3';
import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/client';
import { ATLAS_AGENT_NAME, ATLAS_AGENT_SLUG, ATLAS_SYSTEM_ROLE } from './atlasAgent';
import { resolveRuntimeAgentSlug } from './sessionKeys';

export interface McpApiIdentity {
  keyId: number;
  agentId: number;
  agentName: string;
  agentSlug: string;
  systemRole: string | null;
  auditActor: string;
  authorityActor: string;
}

declare global {
  namespace Express {
    interface Request {
      mcpIdentity?: McpApiIdentity;
    }
  }
}

export class McpApiAuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 401,
    public readonly code = 'mcp_api_unauthorized',
  ) {
    super(message);
    this.name = 'McpApiAuthError';
  }
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
  } catch {
    return false;
  }
}

function readHeader(req: Request, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  return typeof value === 'string' ? value.trim() : '';
}

export function extractMcpApiKeyFromRequest(req: Request): { key: string | null; presented: boolean } {
  const mcpClientMarker = readHeader(req, 'x-agent-hq-mcp-client');
  const xApiKey = readHeader(req, 'x-api-key');
  if (xApiKey) return { key: xApiKey, presented: true };

  const auth = readHeader(req, 'authorization');
  if (auth && mcpClientMarker) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return { key: match?.[1]?.trim() || null, presented: true };
  }

  return { key: null, presented: Boolean(mcpClientMarker) };
}

export function hashMcpApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

export function createMcpApiKeyValue(): string {
  return `ahq_mcp_${crypto.randomBytes(32).toString('base64url')}`;
}

export function ensureMcpApiKeyTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_api_keys (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id     INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name         TEXT NOT NULL DEFAULT '',
      key_prefix   TEXT NOT NULL DEFAULT '',
      key_hash     TEXT NOT NULL UNIQUE,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_agent ON mcp_api_keys(agent_id);
    CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_enabled ON mcp_api_keys(enabled);
  `);
}

function shapeIdentity(row: Record<string, unknown>): McpApiIdentity {
  const agentName = typeof row.agent_name === 'string' && row.agent_name.trim()
    ? row.agent_name.trim()
    : `Agent #${row.agent_id}`;
  const resolvedSlug = resolveRuntimeAgentSlug({
    openclaw_agent_id: typeof row.openclaw_agent_id === 'string' ? row.openclaw_agent_id : null,
    session_key: typeof row.session_key === 'string' ? row.session_key : null,
    name: agentName,
  });
  const agentSlug = resolvedSlug
    ?? (typeof row.slug === 'string' && row.slug.trim() ? row.slug.trim() : agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    ?? `agent-${row.agent_id}`;
  const systemRole = typeof row.system_role === 'string' && row.system_role.trim() ? row.system_role.trim() : null;
  const isAtlas = systemRole === ATLAS_SYSTEM_ROLE || agentSlug === ATLAS_AGENT_SLUG || agentName === ATLAS_AGENT_NAME;

  return {
    keyId: Number(row.key_id),
    agentId: Number(row.agent_id),
    agentName,
    agentSlug,
    systemRole,
    auditActor: agentSlug,
    authorityActor: isAtlas ? ATLAS_AGENT_NAME : agentSlug,
  };
}

export function resolveMcpApiIdentityForKey(
  db: Database.Database,
  apiKey: string,
  options: { updateLastUsed?: boolean } = {},
): McpApiIdentity {
  ensureMcpApiKeyTable(db);
  const normalizedKey = apiKey.trim();
  if (!normalizedKey) {
    throw new McpApiAuthError('MCP API key is required', 401, 'mcp_api_key_missing');
  }

  const hasAgentSlug = hasColumn(db, 'agents', 'slug');
  const hasOpenClawAgentId = hasColumn(db, 'agents', 'openclaw_agent_id');
  const hasSessionKey = hasColumn(db, 'agents', 'session_key');
  const hasSystemRole = hasColumn(db, 'agents', 'system_role');
  const hasAgentEnabled = hasColumn(db, 'agents', 'enabled');
  const hasDeletedAt = hasColumn(db, 'agents', 'deleted_at');

  const row = db.prepare(`
    SELECT
      k.id AS key_id,
      k.agent_id AS agent_id,
      k.enabled AS key_enabled,
      k.revoked_at AS revoked_at,
      a.name AS agent_name,
      ${hasAgentSlug ? 'a.slug' : 'NULL'} AS slug,
      ${hasOpenClawAgentId ? 'a.openclaw_agent_id' : 'NULL'} AS openclaw_agent_id,
      ${hasSessionKey ? 'a.session_key' : 'NULL'} AS session_key,
      ${hasSystemRole ? 'a.system_role' : 'NULL'} AS system_role,
      ${hasAgentEnabled ? 'a.enabled' : '1'} AS agent_enabled,
      ${hasDeletedAt ? 'a.deleted_at' : 'NULL'} AS deleted_at
    FROM mcp_api_keys k
    LEFT JOIN agents a ON a.id = k.agent_id
    WHERE k.key_hash = ?
    LIMIT 1
  `).get(hashMcpApiKey(normalizedKey)) as Record<string, unknown> | undefined;

  if (!row) {
    throw new McpApiAuthError('Invalid MCP API key', 401, 'mcp_api_key_invalid');
  }
  if (Number(row.key_enabled) !== 1 || row.revoked_at != null) {
    throw new McpApiAuthError('MCP API key is disabled or revoked', 403, 'mcp_api_key_disabled');
  }
  if (!row.agent_id || !row.agent_name) {
    throw new McpApiAuthError('MCP API key is not mapped to an agent', 403, 'mcp_api_key_unmapped');
  }
  if (Number(row.agent_enabled) === 0 || row.deleted_at != null) {
    throw new McpApiAuthError('MCP API key is mapped to a disabled agent', 403, 'mcp_agent_disabled');
  }

  if (options.updateLastUsed !== false) {
    db.prepare(`UPDATE mcp_api_keys SET last_used_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(row.key_id);
  }

  return shapeIdentity(row);
}

export function issueMcpApiKeyForAgent(
  db: Database.Database,
  agentId: number,
  name = 'Agent HQ MCP',
): { apiKey: string; keyId: number; keyPrefix: string } {
  ensureMcpApiKeyTable(db);
  const agent = db.prepare(`SELECT id FROM agents WHERE id = ?`).get(agentId) as { id: number } | undefined;
  if (!agent) throw new Error(`Cannot issue MCP API key: agent #${agentId} not found`);

  const apiKey = createMcpApiKeyValue();
  const keyPrefix = apiKey.slice(0, 16);
  const result = db.prepare(`
    INSERT INTO mcp_api_keys (agent_id, name, key_prefix, key_hash)
    VALUES (?, ?, ?, ?)
  `).run(agentId, name, keyPrefix, hashMcpApiKey(apiKey));

  return {
    apiKey,
    keyId: Number(result.lastInsertRowid),
    keyPrefix,
  };
}

export function ensureMaterializedMcpApiKeyForAgent(params: {
  db: Database.Database;
  agentId: number;
  existingApiKey?: string | null;
  name?: string;
}): { apiKey: string; reused: boolean; keyId?: number; keyPrefix?: string } {
  const existingApiKey = params.existingApiKey?.trim();
  if (existingApiKey) {
    try {
      const identity = resolveMcpApiIdentityForKey(params.db, existingApiKey, { updateLastUsed: false });
      if (identity.agentId === params.agentId) {
        return {
          apiKey: existingApiKey,
          reused: true,
          keyId: identity.keyId,
        };
      }
    } catch {
      // Replace missing, revoked, invalid, or mismatched materialized keys below.
    }
  }

  const issued = issueMcpApiKeyForAgent(params.db, params.agentId, params.name);
  return {
    apiKey: issued.apiKey,
    reused: false,
    keyId: issued.keyId,
    keyPrefix: issued.keyPrefix,
  };
}

export function getMcpIdentityFromRequest(req: Request): McpApiIdentity | null {
  return req.mcpIdentity ?? null;
}

export function authenticateMcpApiKeyIfPresent(req: Request, res: Response, next: NextFunction): void {
  try {
    const { key, presented } = extractMcpApiKeyFromRequest(req);
    if (!presented) return next();
    if (!key) throw new McpApiAuthError('MCP API key is required', 401, 'mcp_api_key_missing');

    req.mcpIdentity = resolveMcpApiIdentityForKey(getDb(), key);
    next();
  } catch (err) {
    const authErr = err instanceof McpApiAuthError
      ? err
      : new McpApiAuthError(err instanceof Error ? err.message : String(err));
    res.status(authErr.statusCode).json({
      error: authErr.message,
      code: authErr.code,
    });
  }
}
