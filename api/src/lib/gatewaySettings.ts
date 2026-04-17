import { getDb } from '../db/client';
import { OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_WS_URL } from '../config';

export type GatewayRuntimeHint = 'powershell' | 'wsl' | 'macos' | 'linux' | 'external';

const GATEWAY_WS_URL_KEY = 'gateway_ws_url';
const GATEWAY_RUNTIME_HINT_KEY = 'gateway_runtime_hint';

function getSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setSetting(key: string, value: string | null): void {
  const db = getDb();
  if (value === null) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    return;
  }
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

export function normalizeGatewayUrl(raw: string | undefined, target: 'http' | 'ws'): string {
  const fallback = target === 'http' ? OPENCLAW_GATEWAY_URL : OPENCLAW_GATEWAY_WS_URL;
  try {
    const parsed = new URL(raw ?? fallback);
    if (target === 'http') {
      if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
      else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
      else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback;
    } else {
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      else if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return fallback;
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

export function getConfiguredGatewayWsUrl(): string {
  const stored = getSetting(GATEWAY_WS_URL_KEY);
  return normalizeGatewayUrl(stored ?? OPENCLAW_GATEWAY_WS_URL, 'ws');
}

export function getConfiguredGatewayHttpUrl(): string {
  return normalizeGatewayUrl(getConfiguredGatewayWsUrl(), 'http');
}

export function getGatewayRuntimeHint(): GatewayRuntimeHint {
  const stored = (getSetting(GATEWAY_RUNTIME_HINT_KEY) ?? '').trim().toLowerCase();
  switch (stored) {
    case 'powershell':
    case 'wsl':
    case 'macos':
    case 'linux':
    case 'external':
      return stored;
    default:
      return process.platform === 'win32' ? 'powershell' : process.platform === 'darwin' ? 'macos' : 'linux';
  }
}

export function saveGatewaySettings(input: {
  wsUrl: string;
  runtimeHint: GatewayRuntimeHint;
}): {
  wsUrl: string;
  httpUrl: string;
  runtimeHint: GatewayRuntimeHint;
} {
  const wsUrl = normalizeGatewayUrl(input.wsUrl, 'ws');
  setSetting(GATEWAY_WS_URL_KEY, wsUrl);
  setSetting(GATEWAY_RUNTIME_HINT_KEY, input.runtimeHint);
  return {
    wsUrl,
    httpUrl: normalizeGatewayUrl(wsUrl, 'http'),
    runtimeHint: input.runtimeHint,
  };
}

export function readGatewaySettings(): {
  wsUrl: string;
  httpUrl: string;
  runtimeHint: GatewayRuntimeHint;
  source: 'stored' | 'default';
} {
  const storedUrl = getSetting(GATEWAY_WS_URL_KEY);
  const wsUrl = getConfiguredGatewayWsUrl();
  return {
    wsUrl,
    httpUrl: normalizeGatewayUrl(wsUrl, 'http'),
    runtimeHint: getGatewayRuntimeHint(),
    source: storedUrl ? 'stored' : 'default',
  };
}
