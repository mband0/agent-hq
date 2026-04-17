/**
 * runtimes/OpenClawRuntime.ts — AgentRuntime backed by the OpenClaw gateway.
 *
 * Contains the dispatch and abort logic previously inlined in dispatcher.ts
 * (fireAgentRun) and integrations/openclaw.ts (abortChatRunBySessionKey).
 * The dispatcher now calls this via the AgentRuntime interface.
 */

import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'child_process';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import { WebSocket } from 'ws';
import type { AgentRuntime, DispatchParams, RuntimeEndEvent } from './types';
import {
  OPENCLAW_BIN,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_ENABLED,
  OPENCLAW_GATEWAY_URL,
  OPENCLAW_GATEWAY_WS_URL,
  OPENCLAW_PATH,
} from '../config';
import { getDb } from '../db/client';
import { openClawGatewayWsOptions } from '../lib/openclawGatewayWs';
import { startTranscriptCapture, stopTranscriptCapture } from '../lib/gatewayTranscriptCapture';
import { recordRunCheckIn } from '../lib/runObservability';

// ── Config ───────────────────────────────────────────────────────────────────

const GATEWAY_URL = OPENCLAW_GATEWAY_URL;
function readGatewayTokenFromConfig(): string | null {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw) as { gateway?: { auth?: { token?: string } } };
    const token = cfg.gateway?.auth?.token;
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

function getGatewayAuthToken(): string {
  return process.env.OPENCLAW_GATEWAY_TOKEN ?? readGatewayTokenFromConfig() ?? '';
}

function getHooksToken(): string {
  return process.env.OPENCLAW_HOOKS_TOKEN ?? readGatewayTokenFromConfig() ?? '';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function gatewayFetch(hookPath: string, init: RequestInit): Promise<Response> {
  const url = `${GATEWAY_URL}${hookPath}`;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  return fetch(url, init);
}

type OpenClawRunner = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

function makeSpawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: OPENCLAW_PATH,
    OPENCLAW_HIDE_BANNER: '1',
    OPENCLAW_SUPPRESS_NOTES: '1',
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectAbortText(stdout: string, stderr: string, response: unknown, error?: string): string {
  const responseText =
    typeof response === 'string'
      ? response
      : response && typeof response === 'object'
        ? JSON.stringify(response)
        : '';
  return [stdout, stderr, responseText, error ?? '']
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

function isMissingAbortTarget(stdout: string, stderr: string, response: unknown, error?: string): boolean {
  const haystack = collectAbortText(stdout, stderr, response, error);
  if (!haystack) return false;
  const missingSignals = [
    'session not found', 'session missing', 'unknown session', 'no session',
    'run not found', 'unknown run', 'no active run', 'not running',
    'no live session', 'abort target', 'not found', 'missing',
  ];
  const hasTargetNoun =
    haystack.includes('session') || haystack.includes('run') || haystack.includes('target');
  return hasTargetNoun && missingSignals.some(signal => haystack.includes(signal));
}

// ── Abort result types (re-exported for callers that need them) ───────────────

export type AbortChatRunStatus = 'succeeded' | 'already_gone' | 'timed_out' | 'failed';

export interface AbortChatRunResult {
  attempted: boolean;
  ok: boolean;
  status: AbortChatRunStatus;
  sessionKey: string;
  stopReason?: string | null;
  stdout: string;
  stderr: string;
  response: unknown;
  error?: string;
}

// ── Gateway WebSocket dispatch (chat.send) ──────────────────────────────────
//
// Dispatches via WebSocket `chat.send` RPC instead of HTTP `POST /hooks/agent`
// to avoid OpenClaw's SECURITY NOTICE wrapping (openclaw/openclaw#60521).
//
// chat.send with systemInputProvenance={kind:"internal_system"} marks the
// message as trusted system content — no external-content wrapping applied.

const GATEWAY_WS_URL = OPENCLAW_GATEWAY_WS_URL;
const PROTOCOL_VERSION = 3;

interface DeviceIdentity {
  version: number;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
}

interface GatewayContentBlock {
  type?: string;
  kind?: string;
  text?: string;
  id?: string;
  name?: string;
  tool_name?: string;
  input?: unknown;
  args?: unknown;
  tool_use_id?: string;
  tool_call_id?: string;
  content?: unknown;
  output?: unknown;
  result?: unknown;
  thinking?: string;
  is_error?: boolean;
}

interface OpenClawTerminalEvent {
  type?: string;
  error?: unknown;
  aborted?: unknown;
  timedOut?: unknown;
  timeout?: unknown;
  reason?: unknown;
  stopReason?: unknown;
  source?: unknown;
  [key: string]: unknown;
}

function normalizeTerminalTranscriptText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function extractExactTerminalTranscriptText(message: unknown): string | null {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return null;

  const record = message as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;

  if (Array.isArray(record.content)) {
    const textBlocks = (record.content as Array<Record<string, unknown>>)
      .filter(block => (block.type ?? block.kind) === 'text' && typeof block.text === 'string')
      .map(block => String(block.text));
    if (textBlocks.length === 1) return textBlocks[0];
  }

  return null;
}

export function isRunCompletedFallbackMessage(message: unknown): boolean {
  const text = extractExactTerminalTranscriptText(message);
  if (text === null) return false;
  return normalizeTerminalTranscriptText(text) === 'Run Completed';
}

interface PersistedGatewayEvent {
  event_type: string;
  content: string;
  event_meta: Record<string, unknown>;
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
  if (spki.length >= 44) return base64UrlEncode(spki.slice(spki.length - 32));
  return base64UrlEncode(spki);
}

function signPayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return base64UrlEncode(signature as Buffer);
}

const LIVE_TRANSCRIPT_POLL_MS = 2000;
const LIVE_TRANSCRIPT_MAX_RUNTIME_MS = 30 * 60 * 1000;
const activeTranscriptLoops = new Map<number, NodeJS.Timeout>();
const activeTerminalSignalCaptures = new Map<string, { stop: () => void }>();

function classifyTerminalReason(event: OpenClawTerminalEvent): 'completed' | 'aborted' | 'timeout' | 'error' {
  if (event.error != null) return 'error';
  if (event.timedOut === true || event.timeout === true) return 'timeout';
  if (event.aborted === true) return 'aborted';
  const reason = String(event.reason ?? event.stopReason ?? '').toLowerCase();
  if (reason.includes('timeout')) return 'timeout';
  if (reason.includes('abort') || reason.includes('cancel')) return 'aborted';
  if (reason.includes('error') || reason.includes('fail')) return 'error';
  return 'completed';
}

function terminalEventToRuntimeTurnEnd(
  event: OpenClawTerminalEvent,
  sessionKey: string,
  runId?: string,
  timestamp?: string,
): RuntimeEndEvent {
  const reason = classifyTerminalReason(event);
  const rawError = event.error;
  return {
    type: 'turnEnded',
    source: 'openclaw',
    success: reason === 'completed',
    reason,
    sessionKey,
    runId,
    endedAt: timestamp ?? new Date().toISOString(),
    error: typeof rawError === 'string' ? rawError : rawError != null ? JSON.stringify(rawError) : undefined,
    metadata: {
      openclaw_event_type: event.type ?? 'agent_end',
      source: event.source ?? 'openclaw-native',
      reason_detail: event.reason ?? event.stopReason ?? null,
      aborted: event.aborted === true,
      timed_out: event.timedOut === true || event.timeout === true,
      raw: event,
    },
  };
}

function extractGatewayEvents(msg: Record<string, unknown>): PersistedGatewayEvent[] {
  const contentRaw = msg.content;
  const rawRole = typeof msg.role === 'string' ? msg.role : '';
  const loweredRole = rawRole.toLowerCase();

  if (Array.isArray(contentRaw)) {
    const events: PersistedGatewayEvent[] = [];

    for (const block of contentRaw as GatewayContentBlock[]) {
      const bType = block.type ?? block.kind ?? '';

      if (bType === 'text') {
        const text = block.text ?? (typeof block.content === 'string' ? block.content : '');
        if (text) events.push({ event_type: 'text', content: text, event_meta: {} });
      } else if (bType === 'thinking' || bType === 'thought') {
        const thinkingText = block.thinking ?? (block.text ?? '');
        events.push({ event_type: 'thought', content: thinkingText, event_meta: {} });
      } else if (bType === 'tool_use' || bType === 'tool_call') {
        const toolName = block.name ?? block.tool_name ?? 'unknown';
        const toolArgs = block.input ?? block.args ?? {};
        events.push({
          event_type: 'tool_call',
          content: toolName,
          event_meta: { name: toolName, args: toolArgs, id: block.id ?? null },
        });
      } else if (bType === 'tool_result') {
        const toolUseId = block.tool_use_id ?? block.tool_call_id ?? block.id ?? '';
        let outputContent: unknown = block.output ?? block.result ?? block.content ?? block.text ?? '';
        if (Array.isArray(outputContent)) {
          outputContent = (outputContent as GatewayContentBlock[])
            .filter(b => (b.type ?? b.kind ?? '') === 'text')
            .map(b => b.text ?? '')
            .join('\n');
        }
        const outputStr = typeof outputContent === 'string' ? outputContent : JSON.stringify(outputContent);
        events.push({
          event_type: 'tool_result',
          content: outputStr.slice(0, 4000),
          event_meta: { tool_use_id: toolUseId, output: outputStr, is_error: Boolean(block.is_error) },
        });
      }
    }

    if (events.length > 0) return events;
  }

  const topLevelToolCall = msg.tool_call as Record<string, unknown> | undefined;
  if (topLevelToolCall && typeof topLevelToolCall === 'object') {
    const toolName = String(topLevelToolCall.name ?? topLevelToolCall.tool_name ?? 'unknown');
    return [{
      event_type: 'tool_call',
      content: toolName,
      event_meta: {
        name: toolName,
        args: topLevelToolCall.args ?? topLevelToolCall.input ?? {},
        id: topLevelToolCall.id ?? null,
      },
    }];
  }

  const topLevelToolResult = msg.tool_result as Record<string, unknown> | undefined;
  if (topLevelToolResult && typeof topLevelToolResult === 'object') {
    const output = topLevelToolResult.output ?? topLevelToolResult.result ?? topLevelToolResult.content ?? '';
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    return [{
      event_type: 'tool_result',
      content: outputStr.slice(0, 4000),
      event_meta: {
        tool_use_id: topLevelToolResult.tool_use_id ?? topLevelToolResult.tool_call_id ?? topLevelToolResult.id ?? null,
        output: outputStr,
      },
    }];
  }

  const plainText = typeof contentRaw === 'string'
    ? contentRaw
    : (typeof msg.text === 'string' ? msg.text : '');

  if (loweredRole === 'toolresult' || loweredRole === 'tool_result') {
    return [{ event_type: 'tool_result', content: plainText, event_meta: { source_role: rawRole, output: plainText } }];
  }
  if (loweredRole === 'toolcall' || loweredRole === 'tool_call' || loweredRole === 'tooluse' || loweredRole === 'tool_use') {
    return [{ event_type: 'tool_call', content: plainText || 'tool_call', event_meta: { source_role: rawRole } }];
  }

  return [{ event_type: 'text', content: plainText, event_meta: {} }];
}

function persistGatewayHistory(instanceId: number, agentId: number, messages: Array<Record<string, unknown>>): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp, event_type, event_meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      timestamp = excluded.timestamp,
      event_type = excluded.event_type,
      event_meta = excluded.event_meta
  `);

  let rowIndex = 0;
  for (const m of messages) {
    const sourceRole = typeof m.role === 'string' ? m.role : 'assistant';
    const role = sourceRole === 'user' ? 'user' : 'assistant';
    const ts = typeof m.timestamp === 'number' ? new Date(m.timestamp).toISOString()
      : typeof m.timestamp === 'string' ? m.timestamp
      : new Date().toISOString();

    for (const evt of extractGatewayEvents(m)) {
      const rowId = `oc-hist-${instanceId}-${rowIndex++}`;
      const meta = { ...evt.event_meta, ...(sourceRole !== role ? { source_role: sourceRole } : {}) };
      stmt.run(rowId, agentId, instanceId, role, evt.content, ts, evt.event_type, JSON.stringify(meta));
    }
  }
}

function isInstanceStillActive(instanceId: number): boolean {
  try {
    const db = getDb();
    const row = db.prepare('SELECT status FROM job_instances WHERE id = ?').get(instanceId) as { status?: string } | undefined;
    return row?.status === 'dispatched' || row?.status === 'running';
  } catch {
    return false;
  }
}

function stopLiveTranscriptPersistence(instanceId: number): void {
  const timer = activeTranscriptLoops.get(instanceId);
  if (timer) {
    clearTimeout(timer);
    activeTranscriptLoops.delete(instanceId);
  }
}

function mapChatStateToTurnEnd(
  state: string,
  payload: Record<string, unknown> | undefined,
  sessionKey: string,
  runId?: string,
): RuntimeEndEvent | null {
  if (state === 'final') {
    return {
      type: 'runEnded',
      source: 'openclaw',
      success: true,
      reason: 'completed',
      sessionKey,
      runId,
      endedAt: new Date().toISOString(),
      metadata: { terminal_state: state, payload_event: 'chat' },
    };
  }
  if (state === 'aborted') {
    return {
      type: 'runEnded',
      source: 'openclaw',
      success: false,
      reason: 'aborted',
      sessionKey,
      runId,
      endedAt: new Date().toISOString(),
      metadata: {
        terminal_state: state,
        payload_event: 'chat',
        reason_detail: payload?.reason ?? payload?.stopReason ?? null,
      },
    };
  }
  if (state === 'error') {
    const errorMessage = typeof payload?.error === 'string'
      ? payload.error
      : typeof payload?.message === 'string'
        ? payload.message
        : undefined;
    const reason: RuntimeEndEvent['reason'] = (errorMessage ?? '').toLowerCase().includes('timeout') ? 'timeout' : 'error';
    return {
      type: 'runEnded',
      source: 'openclaw',
      success: false,
      reason,
      sessionKey,
      runId,
      endedAt: new Date().toISOString(),
      error: errorMessage,
      metadata: { terminal_state: state, payload_event: 'chat' },
    };
  }
  return null;
}

function extractNativeTurnEnd(
  payload: Record<string, unknown> | undefined,
  sessionKey: string,
  runId?: string,
): RuntimeEndEvent | null {
  const message = payload?.message;
  if (!message || typeof message !== 'object') return null;
  const rawEvent = (message as Record<string, unknown>).event;
  if (!rawEvent || typeof rawEvent !== 'object') return null;
  const terminalEvent = rawEvent as OpenClawTerminalEvent;
  if (terminalEvent.type !== 'agent_end') return null;
  const rawTimestamp = (message as Record<string, unknown>).timestamp;
  const timestamp = typeof rawTimestamp === 'number'
    ? new Date(rawTimestamp).toISOString()
    : typeof rawTimestamp === 'string'
      ? rawTimestamp
      : undefined;
  return terminalEventToRuntimeTurnEnd(terminalEvent, sessionKey, runId, timestamp);
}

function extractFallbackTurnEnd(
  payload: Record<string, unknown> | undefined,
  sessionKey: string,
  runId?: string,
): RuntimeEndEvent | null {
  const message = payload?.message;
  if (!isRunCompletedFallbackMessage(message)) return null;

  const rawTimestamp = message && typeof message === 'object'
    ? (message as Record<string, unknown>).timestamp
    : undefined;
  const endedAt = typeof rawTimestamp === 'number'
    ? new Date(rawTimestamp).toISOString()
    : typeof rawTimestamp === 'string'
      ? rawTimestamp
      : new Date().toISOString();

  return {
    type: 'runEnded',
    source: 'openclaw',
    success: true,
    reason: 'completed',
    sessionKey,
    runId,
    endedAt,
    metadata: {
      terminal_state: 'Run Completed',
      payload_event: 'chat',
      fallback: 'exact_transcript_message',
    },
  };
}

export function resolveChatTerminalEvent(
  payload: Record<string, unknown> | undefined,
  expectedSessionKey: string,
  runId?: string,
): RuntimeEndEvent | null {
  const eventSessionKey = payload?.sessionKey as string | undefined;
  if (!eventSessionKey || eventSessionKey !== expectedSessionKey) return null;

  const state = typeof payload?.state === 'string' ? payload.state : undefined;
  const nativeTurnEnd = extractNativeTurnEnd(payload, expectedSessionKey, runId);
  const mappedTurnEnd = !nativeTurnEnd && state ? mapChatStateToTurnEnd(state, payload, expectedSessionKey, runId) : null;
  const fallbackTurnEnd = !nativeTurnEnd && !mappedTurnEnd ? extractFallbackTurnEnd(payload, expectedSessionKey, runId) : null;
  return nativeTurnEnd ?? mappedTurnEnd ?? fallbackTurnEnd;
}

function startTerminalSignalCapture(params: {
  sessionKey: string;
  runId?: string;
  timeoutMs?: number;
  onTurnEnd: (event: RuntimeEndEvent) => void;
}): { stop: () => void } {
  const existing = activeTerminalSignalCaptures.get(params.sessionKey);
  if (existing) return existing;

  let stopped = false;
  let ws: WebSocket | null = null;
  const pending = new Map<string, (frame: Record<string, unknown>) => void>();
  const timeout = setTimeout(() => stop(), params.timeoutMs ?? 960_000);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(timeout);
    activeTerminalSignalCaptures.delete(params.sessionKey);
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    ws = null;
  }

  function sendRpc(method: string, rpcParams: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve({ error: 'WS not open' });
        return;
      }
      const id = crypto.randomUUID();
      pending.set(id, resolve);
      ws.send(JSON.stringify({ type: 'req', id, method, params: rpcParams }));
    });
  }

  ws = new WebSocket(GATEWAY_WS_URL, openClawGatewayWsOptions(GATEWAY_WS_URL));

  ws.on('message', async (raw) => {
    if (stopped) return;
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
    if (frame.type !== 'event') return;

    const event = frame.event as string;
    const payload = frame.payload as Record<string, unknown> | undefined;

    if (event === 'connect.challenge') {
      const nonce = (payload?.nonce as string) ?? '';
      const role = 'operator';
      const scopes = ['operator.read', 'operator.write', 'operator.admin'];
      const signedAtMs = Date.now();
      const gatewayAuthToken = getGatewayAuthToken();
      const deviceIdentity = loadDeviceIdentity();
      let device: Record<string, unknown> | undefined;
      if (deviceIdentity) {
        const sigPayload = [
          'v3', deviceIdentity.deviceId, 'gateway-client', 'ui',
          role, scopes.join(','), String(signedAtMs),
          gatewayAuthToken, nonce, process.platform, '',
        ].join('|');
        device = {
          id: deviceIdentity.deviceId,
          publicKey: publicKeyRawBase64Url(deviceIdentity.publicKeyPem),
          signature: signPayload(deviceIdentity.privateKeyPem, sigPayload),
          signedAt: signedAtMs,
          nonce,
        };
      }

      const connectResult = await sendRpc('connect', {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: 'gateway-client',
          displayName: 'Atlas HQ Runtime End Capture',
          version: '1.0.0',
          platform: process.platform,
          mode: 'ui',
          instanceId: crypto.randomUUID(),
        },
        caps: [],
        role,
        scopes,
        auth: { token: gatewayAuthToken },
        ...(device ? { device } : {}),
      });

      if (connectResult.error) {
        stop();
        return;
      }

      await sendRpc('chat.history', { sessionKey: params.sessionKey, limit: 1 });
      return;
    }

    if (event !== 'chat') return;
    const eventSessionKey = payload?.sessionKey as string | undefined;
    if (eventSessionKey && eventSessionKey !== params.sessionKey) return;

    const nativeTurnEnd = extractNativeTurnEnd(payload, params.sessionKey, params.runId);
    if (nativeTurnEnd) {
      params.onTurnEnd(nativeTurnEnd);
      stop();
      return;
    }

    const state = payload?.state as string;
    const fallbackTurnEnd = mapChatStateToTurnEnd(state, payload, params.sessionKey, params.runId);
    if (fallbackTurnEnd) {
      params.onTurnEnd(fallbackTurnEnd);
      stop();
    }
  });

  ws.on('error', () => stop());
  ws.on('close', () => { if (!stopped) stop(); });

  const handle = { stop };
  activeTerminalSignalCaptures.set(params.sessionKey, handle);
  return handle;
}

function startLiveTranscriptPersistence(instanceId: number, agentId: number, sessionKey: string): void {
  stopLiveTranscriptPersistence(instanceId);
  const startedAt = Date.now();

  const tick = async () => {
    try {
      if (!isInstanceStillActive(instanceId)) {
        stopLiveTranscriptPersistence(instanceId);
        return;
      }
      if (Date.now() - startedAt > LIVE_TRANSCRIPT_MAX_RUNTIME_MS) {
        console.warn(`[OpenClawRuntime] Transcript loop timed out for instance #${instanceId}`);
        stopLiveTranscriptPersistence(instanceId);
        return;
      }

      const histResult = await gatewayGetHistory({ sessionKey, limit: 200, timeoutMs: 10_000 });
      if (histResult.ok && histResult.messages.length > 0) {
        persistGatewayHistory(instanceId, agentId, histResult.messages);
      }
    } catch (err) {
      console.warn(
        `[OpenClawRuntime] Live transcript poll failed for instance #${instanceId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    const timer = setTimeout(tick, LIVE_TRANSCRIPT_POLL_MS);
    activeTranscriptLoops.set(instanceId, timer);
  };

  const timer = setTimeout(tick, 0);
  activeTranscriptLoops.set(instanceId, timer);
}

/**
 * Fetch history for a given session key from the gateway via WebSocket `chat.history` RPC.
 *
 * Opens a connection, authenticates with admin scope, issues a chat.history
 * request, waits for the response, and closes.
 *
 * Returns the raw message array on success; an empty array if the session
 * has no history or the call fails.
 */
export async function gatewayGetHistory(params: {
  sessionKey: string;
  limit?: number;
  timeoutMs?: number;
}): Promise<{ ok: boolean; messages: Array<Record<string, unknown>>; error?: string }> {
  const { sessionKey, limit = 200 } = params;

  return new Promise((resolve) => {
    const ws = new WebSocket(GATEWAY_WS_URL, openClawGatewayWsOptions(GATEWAY_WS_URL));

    const timeout = setTimeout(() => {
      ws.close();
      resolve({ ok: false, messages: [], error: 'Gateway WebSocket timeout' });
    }, params.timeoutMs ?? 20_000);

    const pending = new Map<string, (frame: Record<string, unknown>) => void>();

    function sendRpc(method: string, rpcParams: Record<string, unknown>): Promise<Record<string, unknown>> {
      return new Promise((rpcResolve) => {
        const id = crypto.randomUUID();
        pending.set(id, rpcResolve);
        ws.send(JSON.stringify({ type: 'req', id, method, params: rpcParams }));
      });
    }

    ws.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ ok: false, messages: [], error: `WebSocket error: ${err.message}` });
    });

    ws.on('close', () => {
      clearTimeout(timeout);
    });

    ws.on('message', async (raw) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(raw.toString()); } catch { return; }

      // Handle RPC responses
      if (frame.type === 'res' && typeof frame.id === 'string') {
        const handler = pending.get(frame.id);
        if (handler) {
          pending.delete(frame.id);
          handler(frame);
        }
        return;
      }

      // Handle connect challenge
      if (frame.type === 'event' && (frame as Record<string, unknown>).event === 'connect.challenge') {
        const payload = (frame as Record<string, unknown>).payload as Record<string, unknown> | undefined;
        const nonce = (payload?.nonce as string) ?? '';
        const role = 'operator';
        const scopes = ['operator.read', 'operator.write', 'operator.admin'];
        const signedAtMs = Date.now();
        const gatewayAuthToken = getGatewayAuthToken();
        const deviceIdentity = loadDeviceIdentity();

        let device: Record<string, unknown> | undefined;
        if (deviceIdentity) {
          const sigPayload = [
            'v3', deviceIdentity.deviceId, 'gateway-client', 'ui',
            role, scopes.join(','), String(signedAtMs),
            gatewayAuthToken, nonce, process.platform, '',
          ].join('|');
          device = {
            id: deviceIdentity.deviceId,
            publicKey: publicKeyRawBase64Url(deviceIdentity.publicKeyPem),
            signature: signPayload(deviceIdentity.privateKeyPem, sigPayload),
            signedAt: signedAtMs,
            nonce,
          };
        }

        const connectResult = await sendRpc('connect', {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: 'gateway-client',
            displayName: 'Atlas HQ',
            version: '1.0.0',
            platform: process.platform,
            mode: 'ui',
            instanceId: crypto.randomUUID(),
          },
          caps: [],
          role,
          scopes,
          auth: { token: gatewayAuthToken },
          ...(device ? { device } : {}),
        });

        if (connectResult.error) {
          clearTimeout(timeout);
          ws.close();
          resolve({ ok: false, messages: [], error: `Gateway connect failed: ${JSON.stringify(connectResult.error)}` });
          return;
        }

        // Connected — now fetch history
        const histResult = await sendRpc('chat.history', {
          sessionKey,
          limit,
        });

        clearTimeout(timeout);
        ws.close();

        if (histResult.error) {
          resolve({ ok: false, messages: [], error: `chat.history failed: ${JSON.stringify(histResult.error)}` });
        } else {
          const histPayload = histResult.payload as Record<string, unknown> | undefined ?? {};
          const msgs = Array.isArray(histPayload.messages) ? histPayload.messages : [];
          resolve({ ok: true, messages: msgs as Array<Record<string, unknown>> });
        }
      }
    });
  });
}

/**
 * Send a single message to an agent via the gateway WebSocket `chat.send` RPC.
 *
 * Opens a connection, authenticates with admin scope, sends the message,
 * waits for the response, and closes. This avoids the /hooks/agent path
 * entirely so no SECURITY NOTICE wrapping is applied.
 */
export async function gatewayWsSend(params: {
  sessionKey: string;
  message: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const { sessionKey, message, timeoutMs } = params;

  return new Promise((resolve) => {
    const ws = new WebSocket(GATEWAY_WS_URL, openClawGatewayWsOptions(GATEWAY_WS_URL));

    const timeout = setTimeout(() => {
      ws.close();
      resolve({ ok: false, error: 'Gateway WebSocket timeout' });
    }, 30_000);

    const pending = new Map<string, (frame: Record<string, unknown>) => void>();

    function sendRpc(method: string, rpcParams: Record<string, unknown>): Promise<Record<string, unknown>> {
      return new Promise((rpcResolve) => {
        const id = crypto.randomUUID();
        pending.set(id, rpcResolve);
        ws.send(JSON.stringify({ type: 'req', id, method, params: rpcParams }));
      });
    }

    ws.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ ok: false, error: `WebSocket error: ${err.message}` });
    });

    ws.on('close', () => {
      clearTimeout(timeout);
    });

    ws.on('message', async (raw) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(raw.toString()); } catch { return; }

      // Handle RPC responses
      if (frame.type === 'res' && typeof frame.id === 'string') {
        const handler = pending.get(frame.id);
        if (handler) {
          pending.delete(frame.id);
          handler(frame);
        }
        return;
      }

      // Handle connect challenge
      if (frame.type === 'event' && (frame as Record<string, unknown>).event === 'connect.challenge') {
        const payload = (frame as Record<string, unknown>).payload as Record<string, unknown> | undefined;
        const nonce = (payload?.nonce as string) ?? '';
        const role = 'operator';
        const scopes = ['operator.read', 'operator.write', 'operator.admin'];
        const signedAtMs = Date.now();
        const gatewayAuthToken = getGatewayAuthToken();
        const deviceIdentity = loadDeviceIdentity();

        let device: Record<string, unknown> | undefined;
        if (deviceIdentity) {
          const sigPayload = [
            'v3', deviceIdentity.deviceId, 'gateway-client', 'ui',
            role, scopes.join(','), String(signedAtMs),
            gatewayAuthToken, nonce, process.platform, '',
          ].join('|');
          device = {
            id: deviceIdentity.deviceId,
            publicKey: publicKeyRawBase64Url(deviceIdentity.publicKeyPem),
            signature: signPayload(deviceIdentity.privateKeyPem, sigPayload),
            signedAt: signedAtMs,
            nonce,
          };
        }

        const connectResult = await sendRpc('connect', {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: 'gateway-client',
            displayName: 'Atlas HQ Dispatcher',
            version: '1.0.0',
            platform: process.platform,
            mode: 'ui',
            instanceId: crypto.randomUUID(),
          },
          caps: [],
          role,
          scopes,
          auth: { token: gatewayAuthToken },
          ...(device ? { device } : {}),
        });

        if (connectResult.error) {
          clearTimeout(timeout);
          ws.close();
          resolve({ ok: false, error: `Gateway connect failed: ${JSON.stringify(connectResult.error)}` });
          return;
        }

        // Connected — now send chat.send
        // Note: systemInputProvenance is omitted because OpenClaw restricts
        // it to ACP bridge clients. chat.send messages bypass the hooks
        // wrapping pipeline entirely so no SECURITY NOTICE is applied
        // regardless of provenance.
        const sendResult = await sendRpc('chat.send', {
          sessionKey,
          message,
          idempotencyKey: crypto.randomUUID(),
          timeoutMs: timeoutMs ?? 900_000,
        });

        clearTimeout(timeout);
        ws.close();

        if (sendResult.error) {
          resolve({ ok: false, error: `chat.send failed: ${JSON.stringify(sendResult.error)}` });
        } else {
          const result = (sendResult.payload ?? sendResult.result) as Record<string, unknown> | undefined;
          resolve({ ok: true, runId: (result?.runId as string) ?? '' });
        }
      }
    });
  });
}

// ── OpenClawRuntime ───────────────────────────────────────────────────────────

export class OpenClawRuntime implements AgentRuntime {
  /**
   * dispatch — fire an isolated agent turn via POST /hooks/agent.
   *
   * Isolated Atlas HQ job runs need the hook bootstrap path so OpenClaw loads
   * the agent workspace, project settings, and MCP configuration for the run.
   * Direct user chat continues to use the WebSocket proxy path in routes/chat.ts.
   */
  async dispatch(params: DispatchParams): Promise<{ runId: string }> {
    if (!OPENCLAW_ENABLED) {
      console.log(`[OpenClawRuntime] OPENCLAW_ENABLED=false — skipping dispatch for session ${params.sessionKey}`);
      return { runId: 'openclaw-disabled' };
    }
    return this.dispatchViaHooks(params);
  }

  /**
   * dispatchViaHooks — dispatch via POST /hooks/agent.
   * This is the correct endpoint for isolated agent turns — it bootstraps the
   * agent with system prompt, tools, workspace, and model configuration.
   */
  private async dispatchViaHooks(params: DispatchParams): Promise<{ runId: string }> {
    const { message, agentSlug, sessionKey, timeoutSeconds, name, model } = params;

    const payload: Record<string, unknown> = {
      message,
      agentId: agentSlug,
      sessionKey,
      timeoutSeconds,
      name,
      deliver: false,
      allowUnsafeExternalContent: true,
    };

    if (model) {
      payload.model = model;
    }

    const resp = await gatewayFetch('/hooks/agent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getHooksToken()}`,
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`POST /hooks/agent returned ${resp.status}: ${body.slice(0, 500)}`);
    }

    const result = await resp.json().catch(() => ({})) as Record<string, unknown>;
    const runId = typeof (result as any).payload?.runId === 'string'
      ? (result as any).payload.runId
      : typeof result.runId === 'string'
        ? result.runId
        : '';

    this.persistUserPrompt(params);
    this.startCapture(params, runId, sessionKey);
    return { runId };
  }

  /**
   * startCapture — start background real-time transcript capture for this dispatch.
   * Use the stored short hook:* session key first; current OpenClaw gateway
   * history/subscription resolution is keyed on that form for Atlas HQ runs.
   */
  private startCapture(params: DispatchParams, runId?: string, routedSessionKey?: string): void {
    if (params.instanceId == null) return;
    try {
      const db = getDb();
      const instRow = db
        .prepare('SELECT agent_id, session_key FROM job_instances WHERE id = ?')
        .get(params.instanceId) as { agent_id: number; session_key: string | null } | undefined;
      if (!instRow) return;

      const agentId = instRow.agent_id;
      const baseSessionKey = instRow.session_key ?? params.sessionKey;
      if (!baseSessionKey) return;

      // chat.send routes OpenClaw runs into agent-scoped sessions of the form:
      //   agent:<agentSlug>:<hook-session-key>
      // Transcript capture must follow that routed key, not the short persisted
      // hook:* key stored on the instance record, or live chat/agent events will
      // never match the tracked capture.
      const captureSessionKey = baseSessionKey.startsWith('agent:')
        ? baseSessionKey
        : `agent:${params.agentSlug}:${baseSessionKey}`;

      const timeoutSeconds = (params.timeoutSeconds ?? 900) + 120;
      const timeoutMs = timeoutSeconds * 1000;
      startTranscriptCapture(params.instanceId, agentId, captureSessionKey, {
        timeoutMs,
      });
      startTerminalSignalCapture({
        sessionKey: routedSessionKey ?? captureSessionKey,
        runId,
        timeoutMs,
        onTurnEnd: (event) => {
          void this.handleTurnEnd(params.instanceId!, event, params.onRuntimeEnd);
        },
      });
    } catch (err) {
      console.warn(
        '[OpenClawRuntime] Failed to start transcript capture:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * persistUserPrompt — write the dispatched prompt as a user-role chat_messages
   * row so the Chats tab shows what was sent to the agent.
   */
  private persistUserPrompt(params: DispatchParams): number | null {
    try {
      if (params.instanceId == null) return null;
      const db = getDb();
      const instRow = db.prepare('SELECT agent_id FROM job_instances WHERE id = ?')
        .get(params.instanceId) as { agent_id: number } | undefined;
      const agentId = instRow?.agent_id ?? null;
      if (agentId == null) return null;

      const now = new Date().toISOString();
      db.prepare(`
        INSERT OR IGNORE INTO chat_messages (id, agent_id, instance_id, role, content, timestamp)
        VALUES (?, ?, ?, 'user', ?, ?)
      `).run(`oc-user-${params.instanceId}`, agentId, params.instanceId, params.message, now);
      return agentId;
    } catch (err) {
      console.warn(
        `[OpenClawRuntime] Failed to persist user prompt:`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  /**
   * abort — cancel a running agent turn via the OpenClaw gateway CLI.
   *
   * Mirrors the previous abortChatRunBySessionKey logic in integrations/openclaw.ts.
   * "Already gone" (session not found) is treated as a success.
   */
  async abort(runId: string, sessionKey: string): Promise<void> {
    if (!OPENCLAW_ENABLED) {
      console.log(`[OpenClawRuntime] OPENCLAW_ENABLED=false — skipping abort for session ${sessionKey}`);
      return;
    }
    // Stop any active background transcript capture for this session
    stopTranscriptCapture(sessionKey);
    activeTerminalSignalCaptures.get(sessionKey)?.stop();

    const result = abortChatRunBySessionKey(sessionKey);
    if (!result.ok) {
      throw new Error(
        `OpenClawRuntime.abort failed (${result.status}): ${result.error ?? result.stderr}`,
      );
    }
  }

  private async handleTurnEnd(instanceId: number, event: RuntimeEndEvent, onRuntimeEnd?: DispatchParams['onRuntimeEnd']): Promise<void> {
    try {
      const db = getDb();
      const runtimeEndSuccess = event.success ? 1 : 0;
      const runtimeEndError = event.error ?? (event.success ? null : (event.reason ?? 'error'));
      const runtimeEndSource = 'instance_complete';
      const nowIso = new Date().toISOString();
      const claim = db.prepare(`
        UPDATE job_instances
        SET started_at = COALESCE(started_at, ?),
            completed_at = COALESCE(completed_at, ?),
            runtime_ended_at = COALESCE(runtime_ended_at, ?),
            runtime_end_success = COALESCE(runtime_end_success, ?),
            runtime_end_error = COALESCE(?, runtime_end_error),
            runtime_end_source = COALESCE(?, runtime_end_source)
        WHERE id = ?
          AND status IN ('running', 'dispatched')
          AND runtime_ended_at IS NULL
      `).run(
        nowIso,
        nowIso,
        nowIso,
        runtimeEndSuccess,
        runtimeEndError,
        runtimeEndSource,
        instanceId,
      );
      if (!claim.changes) {
        return;
      }

      const eventId = `oc-turn-end-${instanceId}`;
      db.prepare(`
        INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp, event_type, event_meta)
        SELECT ?, agent_id, id, 'system', ?, ?, 'turn_end', ?
        FROM job_instances
        WHERE id = ?
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          timestamp = excluded.timestamp,
          event_type = excluded.event_type,
          event_meta = excluded.event_meta
      `).run(
        eventId,
        `Run ${event.reason ?? (event.success ? 'completed' : 'ended')}`,
        event.endedAt,
        JSON.stringify({
          runtime_end_type: event.type,
          terminal_reason: event.reason ?? (event.success ? 'completed' : 'error'),
          session_key: event.sessionKey,
          run_id: event.runId ?? null,
          success: event.success,
          error: event.error ?? null,
          ...(event.metadata ?? {}),
        }),
        instanceId,
      );

      recordRunCheckIn(db, {
        instanceId,
        stage: 'completion',
        summary: `OpenClaw runtime ${event.type} (${event.reason ?? (event.success ? 'completed' : 'error')})`,
        outcome: event.reason ?? (event.success ? 'completed' : 'error'),
        runtimeEndSuccess: event.success,
        runtimeEndError,
        runtimeEndSource,
        meaningfulOutput: true,
        forceNote: true,
      });

      db.prepare(`
        UPDATE job_instances
        SET response = json_set(COALESCE(response, '{}'), '$.runtimeEnd', json(?))
        WHERE id = ?
      `).run(JSON.stringify(event), instanceId);

      await onRuntimeEnd?.(event);
    } catch (err) {
      console.warn(
        `[OpenClawRuntime] Failed to persist turn-end event for instance #${instanceId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * abortChatRunBySessionKey — low-level abort helper (kept exported for callers
 * in integrations/openclaw.ts and other services that need the rich result).
 */
export function abortChatRunBySessionKey(
  sessionKey: string,
  stopReason?: string,
  runner: OpenClawRunner = spawnSync,
): AbortChatRunResult {
  const args = [
    'gateway', 'call', 'chat.abort',
    '--json',
    '--timeout', '10000',
    '--params', JSON.stringify({ sessionKey }),
  ];

  const gatewayAuthToken = getGatewayAuthToken();
  if (gatewayAuthToken) {
    args.push('--token', gatewayAuthToken);
  }

  const result = runner(OPENCLAW_BIN, args, {
    encoding: 'utf-8',
    timeout: 15000,
    env: makeSpawnEnv(),
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const response = parseJson(stdout);

  if (result.error) {
    const timedOut = result.error.message.includes('ETIMEDOUT');
    return {
      attempted: true,
      ok: false,
      status: timedOut ? 'timed_out' : 'failed',
      sessionKey,
      stopReason,
      stdout,
      stderr,
      response,
      error: result.error.message,
    };
  }

  if (result.status !== 0) {
    const error = stderr.trim() || `openclaw exited with code ${result.status}`;
    const missingAbortTarget = isMissingAbortTarget(stdout, stderr, response, error);
    return {
      attempted: true,
      ok: missingAbortTarget,
      status: missingAbortTarget ? 'already_gone' : 'failed',
      sessionKey,
      stopReason,
      stdout,
      stderr,
      response,
      error,
    };
  }

  return {
    attempted: true,
    ok: true,
    status: 'succeeded',
    sessionKey,
    stopReason,
    stdout,
    stderr,
    response,
  };
}
