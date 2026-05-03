import { Router, Request, Response } from 'express';
import { WebSocket as WsClient, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import multer from 'multer';
import { getDb } from '../db/client';
import { ATLAS_SESSION_KEY } from '../lib/atlasAgent';
import { normalizeChatMessageRole } from '../lib/chatMessageRoles';
import { extractGatewayErrorMessage, summarizeGatewayErrorForUi } from '../lib/chatGatewayErrors';
import { getConfiguredGatewayAuthToken, getConfiguredGatewayWsUrl } from '../lib/gatewaySettings';
import { extractGatewayStructuredEvents, extractTextFromGatewayMessage, unwrapGatewayMessage } from '../lib/openclawMessageEvents';
import { isPairingRequiredClose, isPairingRequiredText } from '../lib/openclawAutoPair';
import { openClawGatewayWsOptions } from '../lib/openclawGatewayWs';
import {
  buildGatewayDirectSessionKey,
  buildGatewayRunSessionKey,
  parseAgentSessionKey,
  parseRunSessionKey,
  parseHookSessionKey,
  resolveRuntimeAgentSlug,
  toGatewaySessionKey,
} from '../lib/sessionKeys';

const router = Router();

// ─── Chat attachment upload (task #658) ───────────────────────────────────────
const CHAT_UPLOADS_BASE = process.env.AGENT_HQ_CHAT_UPLOADS_DIR
  ?? process.env.AGENT_HQ_CHAT_UPLOADS_DIR
  ?? path.join(path.resolve(__dirname, '../../..'), 'uploads', 'chat');

const chatAttachmentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(CHAT_UPLOADS_BASE, { recursive: true });
    cb(null, CHAT_UPLOADS_BASE);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_.-]/g, '_');
    cb(null, `${Date.now()}-${base}${ext}`);
  },
});

// 25 MB limit; allow images + common docs
const ALLOWED_MIME_PREFIXES = ['image/', 'text/', 'application/pdf', 'application/json',
  'application/zip', 'application/x-zip', 'application/msword',
  'application/vnd.openxmlformats-officedocument', 'application/octet-stream'];
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

const chatUpload = multer({
  storage: chatAttachmentStorage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const allowed = ALLOWED_MIME_PREFIXES.some(p => file.mimetype.startsWith(p));
    if (!allowed) return cb(new Error(`File type ${file.mimetype} is not allowed`));
    cb(null, true);
  },
});

// POST /api/v1/chat/attachments — upload a file, returns { id, url, ... }
router.post('/attachments', (req: Request, res: Response) => {
  chatUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ ok: false, error: `File too large (max 25 MB)` });
      }
      return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file uploaded (field name must be "file")' });
    }
    try {
      const db = getDb();
      const body = req.body as { instance_id?: string; agent_id?: string; uploaded_by?: string };
      const instanceId = body.instance_id ? parseInt(body.instance_id, 10) : null;
      const agentId = body.agent_id ? parseInt(body.agent_id, 10) : null;
      const uploadedBy = body.uploaded_by ?? 'user';

      const result = db.prepare(`
        INSERT INTO chat_attachments (instance_id, agent_id, filename, filepath, mime_type, size, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(instanceId, agentId, req.file.filename, req.file.path, req.file.mimetype, req.file.size, uploadedBy);

      const record = db.prepare('SELECT * FROM chat_attachments WHERE id = ?')
        .get(result.lastInsertRowid) as Record<string, unknown>;

      return res.json({
        ok: true,
        attachment: {
          ...record,
          url: `/api/v1/chat/attachments/${result.lastInsertRowid}/download`,
        },
      });
    } catch (dbErr) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(500).json({ ok: false, error: dbErr instanceof Error ? dbErr.message : String(dbErr) });
    }
  });
});

// GET /api/v1/chat/attachments/:id/download
router.get('/attachments/:id/download', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const record = db.prepare('SELECT * FROM chat_attachments WHERE id = ?')
      .get(parseInt(req.params.id, 10)) as Record<string, unknown> | undefined;
    if (!record) return res.status(404).json({ error: 'Attachment not found' });
    const filepath = record.filepath as string;
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found on disk' });
    res.setHeader('Content-Disposition', `inline; filename="${record.filename as string}"`);
    res.setHeader('Content-Type', record.mime_type as string);
    return res.sendFile(filepath);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

function getDefaultGatewayUrl(): string {
  return getConfiguredGatewayWsUrl();
}

function sessionSlug(sessionKey: string | null | undefined): string | null {
  const parsed = parseAgentSessionKey(sessionKey);
  return parsed?.runtimeSlug ?? null;
}

function resolveAgentRowForSessionKey(sessionKey: string | null | undefined): Record<string, unknown> | null {
  const db = getDb();
  const directAgent = db.prepare(`
    SELECT *
    FROM agents
    WHERE session_key = ?
    LIMIT 1
  `).get(sessionKey ?? null) as Record<string, unknown> | undefined;
  if (directAgent) return directAgent;

  const slug = sessionSlug(sessionKey);
  if (!slug) return null;

  const agent = db.prepare(`
    SELECT *
    FROM agents
    WHERE openclaw_agent_id = ?
       OR session_key LIKE ?
       OR session_key LIKE ?
    ORDER BY CASE WHEN openclaw_agent_id = ? THEN 0 ELSE 1 END, id DESC
    LIMIT 1
  `).get(slug, `agent:${slug}:%`, `agent:%:${slug}:%`, slug) as Record<string, unknown> | undefined;

  return agent ?? null;
}

function resolveAgentRowById(agentId: number | null | undefined): Record<string, unknown> | null {
  if (typeof agentId !== 'number') return null;
  const db = getDb();
  return (db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Record<string, unknown> | undefined) ?? null;
}

function getCanonicalChatSessionKey(agentId: number, channel = 'web'): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT session_key
    FROM canonical_chat_sessions
    WHERE agent_id = ? AND channel = ?
    LIMIT 1
  `).get(agentId, channel) as { session_key?: string | null } | undefined;
  return typeof row?.session_key === 'string' && row.session_key.trim() ? row.session_key.trim() : null;
}

function setCanonicalChatSessionKey(agentId: number, sessionKey: string, channel = 'web'): string {
  const db = getDb();
  db.prepare(`
    INSERT INTO canonical_chat_sessions (agent_id, channel, session_key, created_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(agent_id, channel)
    DO UPDATE SET session_key = excluded.session_key, updated_at = datetime('now')
  `).run(agentId, channel, sessionKey);
  return sessionKey;
}

function buildDerivedDirectSessionKey(sessionKey: string, channel = 'web', agentId?: number | null, rotate = false): string | null {
  const agent = typeof agentId === 'number'
    ? resolveAgentRowById(agentId) ?? undefined
    : resolveAgentRowForSessionKey(sessionKey) ?? undefined;
  if (!agent) return null;
  const resolvedAgentId = Number(agent.id);
  if (!Number.isFinite(resolvedAgentId)) return null;

  if (!rotate) {
    const existing = getCanonicalChatSessionKey(resolvedAgentId, channel);
    if (existing) return existing;
  }

  const next = buildGatewayDirectSessionKey(agent, channel, randomUUID());
  if (!next) return null;
  return setCanonicalChatSessionKey(resolvedAgentId, next, channel);
}

/**
 * Resolve the WS gateway URL for a given session key.
 * For containerized agents (those with hooks_url set), returns the container's WS URL.
 * Falls back to the configured host gateway for all others.
 */
function resolveGatewayUrl(sessionKey: string | null | undefined): string {
  if (!sessionKey) return getDefaultGatewayUrl();
  try {
    const db = getDb();
    let hooksUrl: string | null = null;

    // Patterns:
    //   run:<id>                                   — canonical short run key
    //   hook:atlas:jobrun:<id>                     — legacy short run key
    //   agent:<project>:<agent>:<role>:run:<id>    — canonical agent-prefixed run key
    //   agent:<slug>:hook:atlas:jobrun:<id>        — legacy agent-prefixed run key
    const hook = parseRunSessionKey(sessionKey);
    if (hook) {
      const row = db.prepare(`
        SELECT a.hooks_url, a.session_key, a.openclaw_agent_id, a.name FROM job_instances ji
        JOIN agents a ON a.id = ji.agent_id
        WHERE ji.id = ?
      `).get(hook.instanceId) as {
        hooks_url: string | null;
        session_key: string | null;
        openclaw_agent_id: string | null;
        name: string | null;
      } | undefined;
      hooksUrl = row?.hooks_url ?? null;
    }

    // If hook-based lookup didn't find a hooks_url, try agent slug resolution
    if (!hooksUrl) {
      const agent = resolveAgentRowForSessionKey(sessionKey);
      const agentSlug = resolveRuntimeAgentSlug({
        session_key: agent?.session_key as string | null | undefined,
        openclaw_agent_id: agent?.openclaw_agent_id as string | null | undefined,
        name: agent?.name as string | null | undefined,
      });
      if (agentSlug) {
        // Try openclaw_agent_id first (canonical for remote agents like Custom),
        // then session_key pattern match, as there is no slug column.
        const row = db.prepare(`
          SELECT hooks_url FROM agents
          WHERE openclaw_agent_id = ?
             OR session_key LIKE ?
             OR session_key LIKE ?
          LIMIT 1
        `).get(agentSlug, `agent:${agentSlug}:%`, `agent:%:${agentSlug}:%`) as { hooks_url: string | null } | undefined;
        hooksUrl = row?.hooks_url ?? null;
      }
    }

    if (hooksUrl) {
      const url = new URL(hooksUrl);
      const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const resolved = `${wsProtocol}//${url.host}`;
      console.log(`[chat-proxy] Container session "${sessionKey}" → ${resolved}`);
      return resolved;
    }
  } catch (err) {
    console.warn('[chat-proxy] resolveGatewayUrl error:', err);
  }
  return getDefaultGatewayUrl();
}
function getGatewayToken(): string {
  return (
    process.env.GATEWAY_TOKEN
    ?? process.env.OPENCLAW_GATEWAY_TOKEN
    ?? getConfiguredGatewayAuthToken()
    ?? ''
  );
}
const PROTOCOL_VERSION = 3;

function gatewayErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) return record.message;
    if (typeof record.code === 'string' && typeof record.details === 'string') {
      return `${record.code}: ${record.details}`;
    }
  }
  return fallback;
}

async function gatewayRpc(method: string, params: Record<string, unknown>, gatewayUrl = getDefaultGatewayUrl()): Promise<{
  ok: boolean;
  payload?: unknown;
  error?: string;
}> {
  console.log('[chat-proxy] gatewayRpc start', { method, gatewayUrl });
  return new Promise((resolve) => {
    let settled = false;
    const pending = new Map<string, (frame: Record<string, unknown>) => void>();
    console.log('[chat-proxy] opening gateway websocket', gatewayUrl);
    const ws = new WsClient(gatewayUrl, openClawGatewayWsOptions(gatewayUrl));

    const finish = (result: { ok: boolean; payload?: unknown; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (ws.readyState === WsClient.OPEN || ws.readyState === WsClient.CONNECTING) {
        ws.close();
      }
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish({ ok: false, error: `Gateway RPC timeout for ${method}` });
    }, 30_000);

    function sendRpc(rpcMethod: string, rpcParams: Record<string, unknown>): Promise<Record<string, unknown>> {
      return new Promise((rpcResolve) => {
        if (ws.readyState !== WsClient.OPEN) {
          rpcResolve({ ok: false, error: { message: 'WebSocket not open' } });
          return;
        }
        const id = randomUUID();
        pending.set(id, rpcResolve);
        ws.send(JSON.stringify({ type: 'req', id, method: rpcMethod, params: rpcParams }));
      });
    }

    ws.on('error', (err) => {
      console.log('[chat-proxy] gateway websocket error', err.message);
      finish({ ok: false, error: `WebSocket error: ${err.message}` });
    });

    ws.on('close', () => {
      if (!settled) finish({ ok: false, error: `Gateway connection closed during ${method}` });
    });

    ws.on('message', async (raw) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (frame.type === 'res' && typeof frame.id === 'string') {
        const handler = pending.get(frame.id);
        if (handler) {
          pending.delete(frame.id);
          handler(frame);
        }
        return;
      }

      if (frame.type !== 'event' || frame.event !== 'connect.challenge') return;

      console.log('[chat-proxy] connect.challenge received');
      const payload = frame.payload as Record<string, unknown> | undefined;
      const nonce = (payload?.nonce as string) ?? '';
      const role = 'operator';
      const scopes = ['operator.read', 'operator.write', 'operator.admin'];
      const buildConnectParams = () => {
        const gatewayToken = getGatewayToken();
        const deviceIdentity = loadDeviceIdentity();
        const signedAtMs = Date.now();
        const device = deviceIdentity
          ? buildDeviceForConnect(deviceIdentity, gatewayToken, nonce, signedAtMs, role, scopes)
          : undefined;

        return {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: 'gateway-client',
            displayName: 'Agent HQ Chat Proxy',
            version: '1.0.0',
            platform: process.platform,
            mode: 'ui',
            instanceId: randomUUID(),
          },
          caps: [],
          role,
          scopes,
          auth: { token: gatewayToken },
          ...(device ? { device } : {}),
        };
      };

      console.log('[chat-proxy] sending connect rpc');
      const connectResult = await sendRpc('connect', buildConnectParams());
      console.log('[chat-proxy] connect rpc result', connectResult.ok === true ? 'ok' : 'error');

      if (connectResult.ok !== true) {
        finish({
          ok: false,
          error: gatewayErrorMessage(connectResult.error, `Gateway connect failed during ${method}`),
        });
        return;
      }

      const rpcResult = await sendRpc(method, params);
      if (rpcResult.ok !== true) {
        finish({
          ok: false,
          error: gatewayErrorMessage(rpcResult.error, `${method} failed`),
        });
        return;
      }

      finish({
        ok: true,
        payload: rpcResult.payload ?? rpcResult.result ?? null,
      });
    });
  });
}

function collectGatewaySessions(payload: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const queue: unknown[] = [payload];

  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (!current || typeof current !== 'object') continue;

    const record = current as Record<string, unknown>;
    if (typeof record.sessionKey === 'string') {
      out.push(record);
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }

  return out;
}

function summarizeGatewaySession(record: Record<string, unknown> | null, sessionKey: string) {
  if (!record) {
    return {
      session_key: sessionKey,
      exists: false,
      display_name: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      total_tokens_fresh: null,
      updated_at: null,
      origin_provider: null,
    };
  }

  const origin = record.origin && typeof record.origin === 'object'
    ? record.origin as Record<string, unknown>
    : null;

  const numberOrNull = (value: unknown): number | null => (
    typeof value === 'number' && Number.isFinite(value) ? value : null
  );
  const stringOrNull = (value: unknown): string | null => (
    typeof value === 'string' && value.trim() ? value : null
  );
  const booleanOrNull = (value: unknown): boolean | null => (
    typeof value === 'boolean' ? value : null
  );

  return {
    session_key: sessionKey,
    exists: true,
    display_name: stringOrNull(record.displayName),
    input_tokens: numberOrNull(record.inputTokens),
    output_tokens: numberOrNull(record.outputTokens),
    total_tokens: numberOrNull(record.totalTokens),
    total_tokens_fresh: booleanOrNull(record.totalTokensFresh),
    updated_at: stringOrNull(record.updatedAt ?? record.updated_at ?? record.lastActivityAt ?? record.last_activity_at),
    origin_provider: stringOrNull(origin?.provider),
  };
}

async function fetchGatewaySessionStatus(sessionKey: string) {
  const result = await gatewayRpc('sessions.list', {});
  if (!result.ok) {
    throw new Error(result.error ?? 'sessions.list failed');
  }
  const sessions = collectGatewaySessions(result.payload);
  const match = sessions.find(session => session.sessionKey === sessionKey) ?? null;
  return summarizeGatewaySession(match, sessionKey);
}

// ─── Device Identity (for signed connect) ────────────────────────────────────

interface DeviceIdentity {
  version: number;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
}

function loadDeviceIdentity(): DeviceIdentity | null {
  try {
    const identityPath = path.join(os.homedir(), '.openclaw', 'identity', 'device.json');
    const raw = fs.readFileSync(identityPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1 && typeof parsed.deviceId === 'string' &&
        typeof parsed.publicKeyPem === 'string' && typeof parsed.privateKeyPem === 'string') {
      return parsed as DeviceIdentity;
    }
    return null;
  } catch {
    return null;
  }
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function publicKeyRawBase64Url(publicKeyPem: string): string {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }) as Buffer;
  // Ed25519 SPKI is 44 bytes total: 12 byte prefix + 32 byte raw key
  if (spki.length >= 44) {
    return base64UrlEncode(spki.slice(spki.length - 32));
  }
  return base64UrlEncode(spki);
}

function signPayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return base64UrlEncode(signature as Buffer);
}

function buildDeviceForConnect(identity: DeviceIdentity, token: string, nonce: string, signedAtMs: number, role: string, scopes: string[]): Record<string, unknown> {
  const payload = [
    'v3',
    identity.deviceId,
    'gateway-client',    // clientId (must match a known GATEWAY_CLIENT_IDS constant)
    'ui',                // clientMode
    role,
    scopes.join(','),
    String(signedAtMs),
    token,
    nonce,
    process.platform,
    '',                  // deviceFamily
  ].join('|');

  const signature = signPayload(identity.privateKeyPem, payload);

  return {
    id: identity.deviceId,
    publicKey: publicKeyRawBase64Url(identity.publicKeyPem),
    signature,
    signedAt: signedAtMs,
    nonce,
  };
}

const startupDeviceIdentity = loadDeviceIdentity();
if (startupDeviceIdentity) {
  console.log('[chat-proxy] Loaded device identity:', startupDeviceIdentity.deviceId);
} else {
  console.warn('[chat-proxy] No device identity found — connect will use token-only auth (scopes may be stripped)');
}

// ─── REST endpoints for chat send/abort ──────────────────────────────────────

// POST /api/v1/chat/instances/:id/send
router.post('/instances/:id/send', async (req: Request, res: Response) => {
  const instanceId = parseInt(req.params.id, 10);
  const body = req.body as { message?: string; attachment_ids?: number[] };
  const message = body.message?.trim() ?? '';
  const attachmentIds: number[] = Array.isArray(body.attachment_ids) ? body.attachment_ids : [];

  if (!message && attachmentIds.length === 0) {
    return res.status(400).json({ ok: false, error: 'message or attachment required' });
  }

  try {
    const db = getDb();
    const inst = db.prepare('SELECT session_key, agent_id FROM job_instances WHERE id = ?')
      .get(instanceId) as { session_key: string; agent_id: number } | undefined;
    if (!inst) {
      return res.status(404).json({ ok: false, error: 'Instance not found' });
    }

    // Resolve attachment metadata and link to this instance
    let attachmentLines = '';
    if (attachmentIds.length > 0) {
      const placeholders = attachmentIds.map(() => '?').join(',');
      const attachments = db.prepare(`SELECT * FROM chat_attachments WHERE id IN (${placeholders})`)
        .all(...attachmentIds) as Array<Record<string, unknown>>;
      // Update instance linkage
      for (const a of attachments) {
        db.prepare('UPDATE chat_attachments SET instance_id = ?, agent_id = ? WHERE id = ?')
          .run(instanceId, inst.agent_id, a.id);
      }
      attachmentLines = attachments.map(a => {
        const url = `/api/v1/chat/attachments/${a.id as number}/download`;
        return `[Attachment: ${a.filename as string} (${a.mime_type as string}, ${Math.round((a.size as number) / 1024)} KB) — ${url}]`;
      }).join('\n');
    }

    const fullMessage = [message, attachmentLines].filter(Boolean).join('\n');

    // Persist user message
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type, event_meta)
      VALUES (?, ?, ?, ?, 'user', ?, ?, 'text', '{}')
    `).run(`oc-chat-user-${instanceId}-${Date.now()}`, inst.agent_id, instanceId, inst.session_key, fullMessage, now);

    // Forward to gateway
    const { gatewayWsSend } = await import('../runtimes/OpenClawRuntime');
    const result = await gatewayWsSend({
      sessionKey: inst.session_key,
      message: fullMessage,
    });

    if (!result.ok) {
      return res.status(502).json({ ok: false, error: result.error });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/v1/chat/instances/:id/abort
router.post('/instances/:id/abort', async (req: Request, res: Response) => {
  const instanceId = parseInt(req.params.id, 10);

  try {
    const db = getDb();
    const inst = db.prepare('SELECT session_key FROM job_instances WHERE id = ?')
      .get(instanceId) as { session_key: string } | undefined;
    if (!inst) {
      return res.status(404).json({ ok: false, error: 'Instance not found' });
    }

    const { abortChatRunBySessionKey } = await import('../runtimes/OpenClawRuntime');
    const result = abortChatRunBySessionKey(inst.session_key);
    res.json({ ok: result.ok, status: result.status });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/v1/chat/canonical-session/:agentId
router.get('/canonical-session/:agentId', (req: Request, res: Response) => {
  const agentId = Number(req.params.agentId);
  const channel = typeof req.query.channel === 'string' && req.query.channel.trim() ? req.query.channel.trim() : 'web';
  if (!Number.isFinite(agentId)) {
    return res.status(400).json({ error: 'Invalid agent id' });
  }

  const agent = resolveAgentRowById(agentId);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const baseSessionKey = typeof agent.session_key === 'string' ? agent.session_key : '';
  const sessionKey = getCanonicalChatSessionKey(agentId, channel)
    ?? buildDerivedDirectSessionKey(baseSessionKey, channel, agentId, false);

  return res.json({ sessionKey, channel, agentId });
});

// GET /api/v1/chat/config
router.get('/config', (req: Request, res: Response) => {
  // Use the request host so remote clients (e.g. laptop on Tailnet) get the right WS URL
  const host = req.headers.host || 'localhost:3501';
  const protocol = req.secure ? 'wss' : 'ws';
  res.json({
    gatewayUrl: `${protocol}://${host}/api/v1/chat/ws`,
    token: getGatewayToken(),
  });
});

// GET /api/v1/chat/atlas/heartbeat/status
router.get('/atlas/heartbeat/status', async (_req: Request, res: Response) => {
  try {
    const status = await fetchGatewaySessionStatus(ATLAS_SESSION_KEY);
    return res.json(status);
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

async function performAtlasHeartbeatMaintenance(
  req: Request,
  res: Response,
  method: 'sessions.compact' | 'sessions.reset',
) {
  try {
    const body = (req.body ?? {}) as { session_key?: string };
    const sessionKey = typeof body.session_key === 'string' && body.session_key.trim()
      ? body.session_key.trim()
      : ATLAS_SESSION_KEY;

    const result = await gatewayRpc(method, { key: sessionKey });
    if (!result.ok) {
      return res.status(502).json({ ok: false, error: result.error ?? `${method} failed`, session_key: sessionKey });
    }

    const status = await fetchGatewaySessionStatus(sessionKey).catch(() => summarizeGatewaySession(null, sessionKey));
    return res.json({
      ok: true,
      action: method === 'sessions.compact' ? 'compact' : 'reset',
      session_key: sessionKey,
      status,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// POST /api/v1/chat/atlas/heartbeat/compact
router.post('/atlas/heartbeat/compact', (req: Request, res: Response) => {
  void performAtlasHeartbeatMaintenance(req, res, 'sessions.compact');
});

// POST /api/v1/chat/atlas/heartbeat/reset
router.post('/atlas/heartbeat/reset', (req: Request, res: Response) => {
  void performAtlasHeartbeatMaintenance(req, res, 'sessions.reset');
});

// GET /api/v1/chat/sessions
// Returns chat sessions grouped by instance, ordered most-recent first.
// Query params:
//   agent_id — filter by agent
//   limit    — max sessions (default 50, max 200)
router.get('/sessions', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const agentId = req.query.agent_id ? Number(req.query.agent_id) : null;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);

    // Check whether session_key column exists (added in a later migration)
    const cols = (db.prepare('PRAGMA table_info(chat_messages)').all() as Array<{ name: string }>)
      .map(c => c.name);
    const hasSessionKey = cols.includes('session_key');

    const params: unknown[] = [];
    const agentFilter = agentId ? 'WHERE cm.agent_id = ?' : '';
    if (agentId) params.push(agentId);
    params.push(limit);

    const sessionKeySelect = hasSessionKey ? 'cm.session_key' : "'' AS session_key";
    const sessionKeyGroupBy = hasSessionKey
      ? "COALESCE(CAST(cm.instance_id AS TEXT), cm.session_key)"
      : "COALESCE(CAST(cm.instance_id AS TEXT), CAST(cm.agent_id AS TEXT))";
    const lastMsgWhere = hasSessionKey
      ? 'cm2.instance_id IS cm.instance_id AND cm2.session_key = cm.session_key AND cm2.agent_id = cm.agent_id'
      : 'cm2.instance_id IS cm.instance_id AND cm2.agent_id = cm.agent_id';
    const lastRoleWhere = hasSessionKey
      ? 'cm3.instance_id IS cm.instance_id AND cm3.session_key = cm.session_key AND cm3.agent_id = cm.agent_id'
      : 'cm3.instance_id IS cm.instance_id AND cm3.agent_id = cm.agent_id';

    const rows = db.prepare(`
      SELECT
        cm.instance_id,
        ${sessionKeySelect},
        cm.agent_id,
        a.name AS agent_name,
        COUNT(*) AS message_count,
        MIN(cm.timestamp) AS started_at,
        MAX(cm.timestamp) AS last_activity,
        (
          SELECT cm2.content
          FROM chat_messages cm2
          WHERE ${lastMsgWhere}
          ORDER BY cm2.timestamp DESC
          LIMIT 1
        ) AS last_message,
        (
          SELECT cm3.role
          FROM chat_messages cm3
          WHERE ${lastRoleWhere}
          ORDER BY cm3.timestamp DESC
          LIMIT 1
        ) AS last_role
      FROM chat_messages cm
      LEFT JOIN agents a ON a.id = cm.agent_id
      ${agentFilter}
      GROUP BY cm.agent_id, ${sessionKeyGroupBy}
      ORDER BY last_activity DESC
      LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>;

    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/chat/sessions/:instanceId/messages
// Returns messages for a session by instance_id.
// Use instanceId=0 + ?session_key= for the persistent/main session.
// Query params: session_key, limit (default 200), offset (default 0)
router.get('/sessions/:instanceId/messages', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const instanceId = req.params.instanceId === '0' ? null : Number(req.params.instanceId);
    const sessionKey = (req.query.session_key as string | undefined) ?? '';
    const limit = Math.min(Number(req.query.limit ?? 200), 500);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    const cols = (db.prepare('PRAGMA table_info(chat_messages)').all() as Array<{ name: string }>)
      .map(c => c.name);
    const hasSessionKey = cols.includes('session_key');

    const selectCols = hasSessionKey
      ? 'id, agent_id, instance_id, session_key, role, content, timestamp, event_type, event_meta'
      : "id, agent_id, instance_id, '' AS session_key, role, content, timestamp, event_type, event_meta";

    let rows: unknown[];
    if (instanceId === null) {
      if (hasSessionKey) {
        rows = db.prepare(`
          SELECT ${selectCols}
          FROM chat_messages
          WHERE instance_id IS NULL AND session_key = ?
          ORDER BY timestamp ASC
          LIMIT ? OFFSET ?
        `).all(sessionKey, limit, offset);
      } else {
        rows = db.prepare(`
          SELECT ${selectCols}
          FROM chat_messages
          WHERE instance_id IS NULL
          ORDER BY timestamp ASC
          LIMIT ? OFFSET ?
        `).all(limit, offset);
      }
    } else {
      rows = db.prepare(`
        SELECT ${selectCols}
        FROM chat_messages
        WHERE instance_id = ?
        ORDER BY timestamp ASC
        LIMIT ? OFFSET ?
      `).all(instanceId, limit, offset);
    }

    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract plain text from a gateway message object */
function extractText(message: unknown): string {
  return extractTextFromGatewayMessage(message);
}

// ─── Structured event extraction ─────────────────────────────────────────────
//
// Gateway history messages can carry tool_use / tool_result / thinking blocks
// in their content array. These need to be mapped to the Agent HQ
// event_type + event_meta schema so the Chat tab renders them correctly.

interface GatewayContentBlock {
  type: string;
  text?: string;
  // tool_use / tool_call
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  content?: unknown;
  // thinking / thought
  thinking?: string;
}

interface StructuredEvent {
  event_type: string;
  content: string;
  event_meta: Record<string, unknown>;
}

/**
 * Extract all structured events from a single gateway history message.
 * A message may be a plain text turn (single event) or a multi-block turn
 * (assistant message with tool calls, thoughts, and/or text).
 *
 * Returns one StructuredEvent per logical block so each can be stored as
 * a separate chat_messages row.
 */
function extractStructuredEvents(msg: unknown): StructuredEvent[] {
  if (!msg || typeof msg !== 'object') {
    return [{ event_type: 'text', content: '', event_meta: {} }];
  }
  const m = unwrapGatewayMessage(msg) ?? (msg as Record<string, unknown>);
  const contentRaw = m.content;
  const stopReason = typeof m.stopReason === 'string' ? m.stopReason.trim().toLowerCase() : '';
  const errorMessage = extractGatewayErrorMessage(m);

  const events = extractGatewayStructuredEvents(m);
  const hasStructuredContent = events.some(evt =>
    evt.event_type !== 'text' || evt.content.trim().length > 0,
  );

  if (stopReason === 'error' && errorMessage) {
    return [
      ...events,
      {
        event_type: 'error',
        content: summarizeGatewayErrorForUi(m),
        event_meta: { stop_reason: stopReason },
      },
    ];
  }

  if (hasStructuredContent) {
    return events;
  }

  const plainText = typeof contentRaw === 'string' ? contentRaw : extractTextFromGatewayMessage(m);
  return [{ event_type: 'text', content: plainText, event_meta: {} }];
}

/**
 * Convert a gateway history message to the UI ChatMessage format.
 * Now maps event_type and event_meta for tool calls, tool results, and thoughts.
 *
 * For multi-block messages we return the primary text content as `content`
 * and embed the event_type/event_meta from the first meaningful block.
 * The full set of structured events is written to chat_messages separately
 * via persistHistoryMessages.
 */
function gatewayMsgToUi(msg: unknown, index: number): Record<string, unknown> {
  if (!msg || typeof msg !== 'object') {
    return { id: `hist-${index}`, role: 'assistant', content: '', event_type: 'text', event_meta: {}, timestamp: new Date().toISOString() };
  }
  const outer = msg as Record<string, unknown>;
  const m = unwrapGatewayMessage(msg) ?? outer;
  const ts = m.timestamp ?? outer.timestamp;
  let timestamp: string;
  if (typeof ts === 'number') {
    timestamp = new Date(ts).toISOString();
  } else if (typeof ts === 'string') {
    timestamp = ts;
  } else {
    timestamp = new Date().toISOString();
  }

  const events = extractStructuredEvents(msg);
  // Primary event for the UI message row
  const primary = events[0] ?? { event_type: 'text', content: '', event_meta: {} };
  const role = normalizeChatRole(m.role, primary.event_type);

  return {
    id: typeof m.id === 'string' ? m.id : typeof outer.id === 'string' ? outer.id : `hist-${index}`,
    role,
    content: primary.content,
    event_type: primary.event_type,
    event_meta: primary.event_meta,
    timestamp,
    // Carry extra events so the UI can render multi-block turns if needed
    extra_events: events.length > 1 ? events.slice(1) : undefined,
  };
}

// ─── Transcript Capture ──────────────────────────────────────────────────────
//
// Every gateway message flowing through the proxy is persisted to chat_messages
// so the transcript API is the single source of truth for all runtimes.

interface SessionContext {
  instanceId: number | null;
  agentId: number;
  sessionKey: string;
}

function normalizeChatRole(role: unknown, eventType?: unknown) {
  return normalizeChatMessageRole(role, eventType);
}

function resolveSessionContext(sessionKey: string): SessionContext | null {
  try {
    const db = getDb();
    // canonical or legacy run-session key → instance ID is in the key
    const hook = parseRunSessionKey(sessionKey);
    if (hook) {
      const instanceId = hook.instanceId;
      const row = db.prepare('SELECT agent_id FROM job_instances WHERE id = ?')
        .get(instanceId) as { agent_id: number } | undefined;
      if (row) return { instanceId, agentId: row.agent_id, sessionKey };
    }
    // Fallback: search by session_key
    const row = db.prepare(
      'SELECT id, agent_id FROM job_instances WHERE session_key = ? ORDER BY id DESC LIMIT 1'
    ).get(sessionKey) as { id: number; agent_id: number } | undefined;
    if (row) return { instanceId: row.id, agentId: row.agent_id, sessionKey };

    // Direct/main chat sessions are keyed off the agent slug and have no job instance.
    const agentRow = resolveAgentRowForSessionKey(sessionKey) as { id: number } | null;
    if (agentRow) return { instanceId: null, agentId: agentRow.id, sessionKey };

    return null;
  } catch {
    return null;
  }
}

function contextRowScope(ctx: SessionContext): string {
  if (ctx.instanceId !== null) return String(ctx.instanceId);
  return crypto.createHash('sha1').update(ctx.sessionKey).digest('hex').slice(0, 12);
}

/** Persist a batch of gateway history messages to chat_messages */
function persistHistoryMessages(ctx: SessionContext, messages: Array<Record<string, unknown>>): void {
  try {
    const db = getDb();
    const rowScope = contextRowScope(ctx);
    const stmt = db.prepare(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type, event_meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        timestamp = excluded.timestamp,
        event_type = excluded.event_type,
        event_meta = excluded.event_meta,
        session_key = excluded.session_key
    `);

    // chat.history returns a full snapshot, so replace prior oc-hist rows for this scope.
    db.prepare('DELETE FROM chat_messages WHERE id LIKE ?').run(`oc-hist-${rowScope}-%`);

    let rowIndex = 0;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const ts = typeof m.timestamp === 'number' ? new Date(m.timestamp).toISOString()
        : typeof m.timestamp === 'string' ? m.timestamp
        : new Date().toISOString();

      // Expand multi-block messages into individual chat_messages rows
      const events = extractStructuredEvents(m);
      for (const evt of events) {
        const rowId = `oc-hist-${rowScope}-${rowIndex++}`;
        stmt.run(
          rowId,
          ctx.agentId,
          ctx.instanceId,
          ctx.sessionKey,
          normalizeChatRole(m.role, evt.event_type),
          evt.content,
          ts,
          evt.event_type,
          JSON.stringify(evt.event_meta),
        );
      }
    }
  } catch (err) {
    console.warn('[chat-proxy] Failed to persist history:', err instanceof Error ? err.message : String(err));
  }
}

/** Upsert the rolling assistant stream to chat_messages */
function persistStreamDelta(ctx: SessionContext, cumulativeText: string): void {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type, event_meta)
      VALUES (?, ?, ?, ?, 'assistant', ?, ?, 'text', '{}')
      ON CONFLICT(id) DO UPDATE SET content = excluded.content, timestamp = excluded.timestamp, session_key = excluded.session_key
    `).run(`oc-stream-${contextRowScope(ctx)}`, ctx.agentId, ctx.instanceId, ctx.sessionKey, cumulativeText, now);
  } catch { /* non-critical */ }
}

/** Finalize the assistant message with a permanent ID */
function persistFinalMessage(ctx: SessionContext, text: string, msgIndex: number): void {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const rowScope = contextRowScope(ctx);
    // Write the final message with a stable ID
    db.prepare(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type, event_meta)
      VALUES (?, ?, ?, ?, 'assistant', ?, ?, 'text', '{}')
      ON CONFLICT(id) DO UPDATE SET content = excluded.content, timestamp = excluded.timestamp, session_key = excluded.session_key
    `).run(`oc-asst-${rowScope}-${msgIndex}`, ctx.agentId, ctx.instanceId, ctx.sessionKey, text, now);
    // Remove the rolling stream row
    db.prepare('DELETE FROM chat_messages WHERE id = ?').run(`oc-stream-${rowScope}`);
  } catch { /* non-critical */ }
}

/** Persist a user message sent via the chat UI */
function persistUserChatMessage(ctx: SessionContext, message: string): void {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    // Use timestamp-based ID to support multiple user messages per instance
    const msgId = `oc-chat-user-${contextRowScope(ctx)}-${Date.now()}`;
    db.prepare(`
      INSERT OR IGNORE INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type, event_meta)
      VALUES (?, ?, ?, ?, 'user', ?, ?, 'text', '{}')
    `).run(msgId, ctx.agentId, ctx.instanceId, ctx.sessionKey, message, now);
  } catch { /* non-critical */ }
}

function findNestedString(value: unknown, keys: string[], seen = new Set<unknown>()): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findNestedString(entry, keys, seen);
      if (nested) return nested;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  for (const nestedValue of Object.values(record)) {
    const nested = findNestedString(nestedValue, keys, seen);
    if (nested) return nested;
  }

  return null;
}

// ─── WebSocket Proxy ──────────────────────────────────────────────────────────

export function setupChatProxy(wss: WebSocketServer) {
  wss.on('connection', (clientWs: WsClient, _req: IncomingMessage) => {
    // Connect to the host gateway initially; may switch to a container gateway on first chat.history
    let currentGatewayUrl = getDefaultGatewayUrl();
    let gatewayWs = new WsClient(currentGatewayUrl, openClawGatewayWsOptions(currentGatewayUrl));
    let pairingRetryAttempted = false;
    let pairingRetryInFlight = false;

    // Track pending requests: reqId → method name
    const pending = new Map<string, string>();
    // Track streaming state for delta computation
    let streamText = '';
    let pendingAssistantResponse = false;
    // Track which session the UI is currently viewing
    let activeSessionKey: string | null = null;
    // Transcript capture state
    let sessionCtx: SessionContext | null = null;
    let assistantMsgIndex = 0;
    let lastStreamFlushLen = 0;
    const STREAM_FLUSH_THRESHOLD = 200; // chars between DB flushes
    // Queue messages received from client before gateway auth completes
    let gatewayReady = false;
    const clientMsgQueue: Array<Record<string, unknown>> = [];

    function retryGatewayAfterPairing(): boolean {
      if (pairingRetryAttempted || pairingRetryInFlight) return false;
      pairingRetryAttempted = true;
      pairingRetryInFlight = true;
      console.warn(`[chat-proxy] Pairing is manual for ${currentGatewayUrl}. Approve the pending request with openclaw devices list/approve, then retry.`);
      pairingRetryInFlight = false;
      return false;
    }

    // ── Gateway → Client ──────────────────────────────────────────────────

    /** Attach gateway event handlers. Re-called when gateway is switched. */
    function attachGatewayHandlers(gw: WsClient): void {
    gw.on('message', (raw) => {
      if (clientWs.readyState !== WsClient.OPEN) return;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const frameType = frame.type as string;

      if (frameType === 'event') {
        const event = frame.event as string;
        const payload = frame.payload as Record<string, unknown> | undefined;

        if (event === 'connect.challenge') {
          // Respond with proper connect request
          const nonce = payload?.nonce as string ?? '';
          const connectId = randomUUID();
          pending.set(connectId, 'connect');
          const role = 'operator';
          const scopes = ['operator.read', 'operator.write', 'operator.admin'];
          const signedAtMs = Date.now();
          const instanceId = randomUUID();

          // Build device identity for signed connect (required for gateway to honour scopes)
          const gatewayToken = getGatewayToken();
          const deviceIdentity = loadDeviceIdentity();
          const device = deviceIdentity
            ? buildDeviceForConnect(deviceIdentity, gatewayToken, nonce, signedAtMs, role, scopes)
            : undefined;

          const connectReq = {
            type: 'req',
            id: connectId,
            method: 'connect',
            params: {
              minProtocol: PROTOCOL_VERSION,
              maxProtocol: PROTOCOL_VERSION,
              client: {
                id: 'gateway-client',
                displayName: 'Agent HQ',
                version: '1.0.0',
                platform: process.platform,
                mode: 'ui',
                instanceId,
              },
              caps: [],
              role,
              scopes,
              auth: { token: gatewayToken },
              ...(device ? { device } : {}),
            },
          };
          console.log('[chat-proxy] Responding to challenge with nonce:', nonce, device ? '(signed)' : '(no device identity)');
          gatewayWs.send(JSON.stringify(connectReq));
          return;
        }

        if (event === 'chat') {
          // Only forward chat events for the session the UI is currently viewing
          const eventSessionKey = payload?.sessionKey as string | undefined;
          if (eventSessionKey && activeSessionKey && eventSessionKey !== activeSessionKey) {
            return; // Belongs to a different session — drop it
          }

          // Translate gateway chat event to UI format
          const state = payload?.state as string;
          if (state === 'delta') {
            pendingAssistantResponse = true;
            const newText = extractText(payload?.message);
            // Gateway sends cumulative text; compute incremental delta
            const delta = newText.startsWith(streamText) ? newText.slice(streamText.length) : newText;
            streamText = newText;
            if (delta) {
              clientWs.send(JSON.stringify({ type: 'chat', role: 'assistant', delta, done: false }));
            }
            // Persist streaming content periodically
            if (sessionCtx && streamText.length - lastStreamFlushLen >= STREAM_FLUSH_THRESHOLD) {
              persistStreamDelta(sessionCtx, streamText);
              lastStreamFlushLen = streamText.length;
            }
          } else if (state === 'final') {
            pendingAssistantResponse = false;
            // Final event contains the complete text — flush any remaining delta
            const finalText = extractText(payload?.message);
            if (finalText) {
              const remaining = finalText.startsWith(streamText)
                ? finalText.slice(streamText.length)
                : (streamText ? '' : finalText);  // if stream diverged, don't double-send
              if (remaining) {
                clientWs.send(JSON.stringify({ type: 'chat', role: 'assistant', delta: remaining, done: false }));
              }
            }
            // Persist final assistant message
            if (sessionCtx) {
              persistFinalMessage(sessionCtx, finalText || streamText, assistantMsgIndex++);
              lastStreamFlushLen = 0;
            }
            streamText = '';
            clientWs.send(JSON.stringify({ type: 'chat', role: 'assistant', delta: '', done: true }));
          } else if (state === 'aborted' || state === 'error') {
            pendingAssistantResponse = false;
            // Persist whatever was streamed before abort
            if (sessionCtx && streamText) {
              persistFinalMessage(sessionCtx, streamText, assistantMsgIndex++);
              lastStreamFlushLen = 0;
            }
            const hadPartialStream = Boolean(streamText);
            streamText = '';
            if (hadPartialStream || state === 'aborted') {
              clientWs.send(JSON.stringify({ type: 'chat', role: 'assistant', delta: '', done: true }));
            }
            if (state === 'error') {
              clientWs.send(JSON.stringify({
                type: 'error',
                message: summarizeGatewayErrorForUi(payload),
              }));
            }
          }
          return;
        }

        const customType = findNestedString(frame, ['customType']);
        if (pendingAssistantResponse && customType === 'openclaw:prompt-error') {
          const eventSessionKey = findNestedString(frame, ['sessionKey']);
          if (eventSessionKey && activeSessionKey && eventSessionKey !== activeSessionKey) {
            return;
          }

          // Preserve any streamed partial response before surfacing the provider error.
          if (sessionCtx && streamText) {
            persistFinalMessage(sessionCtx, streamText, assistantMsgIndex++);
            lastStreamFlushLen = 0;
          }
          const hadPartialStream = Boolean(streamText);
          pendingAssistantResponse = false;
          streamText = '';
          if (hadPartialStream) {
            clientWs.send(JSON.stringify({ type: 'chat', role: 'assistant', delta: '', done: true }));
          }
          clientWs.send(JSON.stringify({
            type: 'error',
            message: summarizeGatewayErrorForUi(frame),
          }));
          return;
        }

        // Other events: pass through as-is (future use)
        return;
      }

      if (frameType === 'res') {
        const id = frame.id as string;
        const ok = frame.ok as boolean;
        const method = pending.get(id);
        pending.delete(id);

        if (method === 'connect') {
          // Connect ack — gateway is now ready
          if (!ok) {
            const errMsg = (frame.error as Record<string, unknown>)?.message ?? 'connect failed';
            if (isPairingRequiredText(String(errMsg)) && retryGatewayAfterPairing()) {
              return;
            }
            clientWs.send(JSON.stringify({
              type: 'error',
              message: summarizeGatewayErrorForUi(frame.error ?? errMsg),
            }));
            clientWs.close();
          } else {
            // Flush any messages that arrived before auth completed
            gatewayReady = true;
            for (const queued of clientMsgQueue) {
              processClientMessage(queued);
            }
            clientMsgQueue.length = 0;
          }
          return;
        }

        if (method === 'chat.send') {
          if (ok) {
            pendingAssistantResponse = true;
            streamText = '';
            clientWs.send(JSON.stringify({ type: 'chat.send' }));
          } else {
            pendingAssistantResponse = false;
            const errMsg = (frame.error as Record<string, unknown>)?.message ?? 'chat.send failed';
            clientWs.send(JSON.stringify({
              type: 'error',
              message: summarizeGatewayErrorForUi(frame.error ?? errMsg),
            }));
          }
          return;
        }

        if (method === 'chat.history') {
          if (ok) {
            const payload = frame.payload as Record<string, unknown> ?? {};
            const msgs = Array.isArray(payload.messages) ? payload.messages : [];
            const uiMessages = msgs.map((m: unknown, i: number) => gatewayMsgToUi(m, i));
            clientWs.send(JSON.stringify({ type: 'chat.history', messages: uiMessages }));
            // Persist history to chat_messages for transcript API
            if (sessionCtx && msgs.length > 0) {
              persistHistoryMessages(sessionCtx, msgs as Array<Record<string, unknown>>);
              assistantMsgIndex = msgs.filter((m: unknown) =>
                typeof m === 'object' && m !== null && (m as Record<string, unknown>).role === 'assistant'
              ).length;
            }
          } else {
            clientWs.send(JSON.stringify({ type: 'chat.history', messages: [] }));
          }
          return;
        }

        if (method === 'chat.abort') {
          pendingAssistantResponse = false;
          streamText = '';
          // Nothing to do for abort ack
          return;
        }

        // Unknown method response — pass through
      }
    });

    gw.on('error', (err) => {
      console.error('[chat-proxy] Gateway WS error:', err.message);
      if (clientWs.readyState === WsClient.OPEN) {
        const message = pendingAssistantResponse
          ? 'Connection to Atlas was interrupted before a response completed. Retry.'
          : 'Gateway connection failed';
        pendingAssistantResponse = false;
        streamText = '';
        clientWs.send(JSON.stringify({
          type: 'error',
          message,
        }));
        clientWs.close();
      }
    });

    gw.on('close', (code, reason) => {
      if (gw !== gatewayWs || clientWs.readyState !== WsClient.OPEN) return;
      if (isPairingRequiredClose(code, reason) && retryGatewayAfterPairing()) {
        return;
      }
      if (pendingAssistantResponse) {
        pendingAssistantResponse = false;
        streamText = '';
        clientWs.send(JSON.stringify({
          type: 'error',
          message: 'Connection to Atlas was interrupted before a response completed. Retry.',
        }));
      }
      clientWs.close();
    });

    } // end attachGatewayHandlers

    // Attach handlers to the initial gateway connection
    attachGatewayHandlers(gatewayWs);

    // ── Client → Gateway ──────────────────────────────────────────────────

    /** Process a parsed client message once gateway is authenticated */
    function processClientMessage(msg: Record<string, unknown>): void {
      if (gatewayWs.readyState !== WsClient.OPEN) return;

      const type = msg.type as string;

      if (type === 'chat.history') {
        const sessionKey = msg.sessionKey as string | undefined;
        if (sessionKey) {
          activeSessionKey = sessionKey;
          sessionCtx = resolveSessionContext(sessionKey);
          assistantMsgIndex = 0;
          lastStreamFlushLen = 0;
        }

        // Resolve correct gateway — container agents have their own WS endpoint
        const targetUrl = resolveGatewayUrl(sessionKey ?? null);
        if (targetUrl !== currentGatewayUrl) {
          console.log(`[chat-proxy] Switching gateway ${currentGatewayUrl} → ${targetUrl} for "${sessionKey}"`);
          const oldGw = gatewayWs;
          currentGatewayUrl = targetUrl;
          gatewayReady = false;
          const newGw = new WsClient(targetUrl, openClawGatewayWsOptions(targetUrl));
          gatewayWs = newGw;
          // Attach same event handlers to new gateway
          attachGatewayHandlers(newGw);
          oldGw.close();
          // Queue this message to replay after new gateway authenticates
          clientMsgQueue.push(msg);
          return;
        }

        const reqId = randomUUID();
        pending.set(reqId, 'chat.history');
        const gatewaySessionKey = toGatewaySessionKey(
          msg.sessionKey as string | null | undefined,
          resolveAgentRowForSessionKey(msg.sessionKey as string | null | undefined),
        );
        gatewayWs.send(JSON.stringify({
          type: 'req',
          id: reqId,
          method: 'chat.history',
          params: {
            sessionKey: gatewaySessionKey ?? msg.sessionKey,
            limit: 200,
          },
        }));
        return;
      }

      if (type === 'chat.new') {
        const currentKey = typeof msg.sessionKey === 'string' ? msg.sessionKey : activeSessionKey;
        const channel = typeof msg.channel === 'string' && msg.channel.trim() ? msg.channel.trim() : 'web';
        if (!currentKey) {
          clientWs.send(JSON.stringify({ type: 'error', message: 'No active session to rotate' }));
          return;
        }
        const currentCtx = resolveSessionContext(currentKey);
        if (!currentCtx || currentCtx.instanceId !== null) {
          clientWs.send(JSON.stringify({ type: 'error', message: 'Session rotation only supports direct chats' }));
          return;
        }

        const newSessionKey = buildDerivedDirectSessionKey(currentKey, channel, currentCtx.agentId, true);
        if (!newSessionKey) {
          clientWs.send(JSON.stringify({ type: 'error', message: 'Session rotation only supports agent direct chats' }));
          return;
        }

        activeSessionKey = newSessionKey;
        sessionCtx = resolveSessionContext(newSessionKey);
        assistantMsgIndex = 0;
        lastStreamFlushLen = 0;
        streamText = '';
        pendingAssistantResponse = false;

        clientWs.send(JSON.stringify({ type: 'chat.new', sessionKey: newSessionKey }));
        return;
      }

      if (type === 'chat.send') {
        // Track which session the UI is currently viewing
        if (msg.sessionKey) activeSessionKey = msg.sessionKey as string;

        // Resolve attachment_ids into metadata and append to message text
        let fullMessage = typeof msg.message === 'string' ? msg.message : '';
        const attachmentIds: number[] = Array.isArray(msg.attachment_ids)
          ? (msg.attachment_ids as unknown[]).map(Number).filter(n => !isNaN(n))
          : [];
        if (attachmentIds.length > 0) {
          try {
            const db = getDb();
            const placeholders = attachmentIds.map(() => '?').join(',');
            const attachments = db.prepare(
              `SELECT * FROM chat_attachments WHERE id IN (${placeholders})`
            ).all(...attachmentIds) as Array<Record<string, unknown>>;
            for (const a of attachments) {
              const apiPort = process.env.AGENT_HQ_API_PORT ?? '3501';
              const url = `http://localhost:${apiPort}/api/v1/chat/attachments/${a.id as number}/download`;
              const mime = a.mime_type as string ?? '';
              const label = mime.startsWith('image/')
                ? `[image: ${a.filename as string}](${url})`
                : `[file: ${a.filename as string}](${url})`;
              fullMessage = [fullMessage, label].filter(Boolean).join('\n');
            }
          } catch (e) {
            console.warn('[chat-proxy] Failed to resolve attachments:', e);
          }
        }

        // Persist user message to chat_messages
        if (!sessionCtx && activeSessionKey) sessionCtx = resolveSessionContext(activeSessionKey);
        if (sessionCtx && fullMessage) {
          persistUserChatMessage(sessionCtx, fullMessage);
        }
        const gatewaySessionKey = toGatewaySessionKey(msg.sessionKey as string | null | undefined, resolveAgentRowForSessionKey(msg.sessionKey as string | null | undefined));
        const reqId = randomUUID();
        pending.set(reqId, 'chat.send');
        const chatSendParams: Record<string, unknown> = {
          sessionKey: gatewaySessionKey ?? msg.sessionKey,
          message: fullMessage || msg.message,
          deliver: false,
          idempotencyKey: msg.idempotencyKey ?? randomUUID(),
        };
        if (typeof msg.cwd === 'string' && msg.cwd.trim()) {
          chatSendParams.cwd = msg.cwd.trim();
        }
        if (msg.metadata && typeof msg.metadata === 'object' && !Array.isArray(msg.metadata)) {
          chatSendParams.metadata = msg.metadata;
        }
        gatewayWs.send(JSON.stringify({
          type: 'req',
          id: reqId,
          method: 'chat.send',
          params: chatSendParams,
        }));
        return;
      }

      if (type === 'chat.abort') {
        pendingAssistantResponse = false;
        streamText = '';
        const gatewaySessionKey = toGatewaySessionKey(msg.sessionKey as string | null | undefined, resolveAgentRowForSessionKey(msg.sessionKey as string | null | undefined));
        const reqId = randomUUID();
        pending.set(reqId, 'chat.abort');
        gatewayWs.send(JSON.stringify({
          type: 'req',
          id: reqId,
          method: 'chat.abort',
          params: {
            sessionKey: gatewaySessionKey ?? msg.sessionKey,
          },
        }));
        return;
      }

      // Unknown message type from UI — ignore
      console.warn('[chat-proxy] Unknown client message type:', type);
    }

    clientWs.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const type = msg.type as string;

      // Intercept connect from UI — proxy handles auth internally
      if (type === 'connect') {
        return;
      }

      if (!gatewayReady) {
        // Gateway auth still in progress — queue and replay after connect ack
        clientMsgQueue.push(msg);
        return;
      }

      processClientMessage(msg);
    });

    // ── Error / Close handling ─────────────────────────────────────────────

    clientWs.on('close', () => {
      if (gatewayWs.readyState === WsClient.OPEN) gatewayWs.close();
    });

    clientWs.on('error', (err) => {
      console.error('[chat-proxy] Client WS error:', err.message);
      if (gatewayWs.readyState === WsClient.OPEN) gatewayWs.close();
    });
  });
}

export default router;
