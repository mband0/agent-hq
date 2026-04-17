import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import { getDb } from '../db/client';
import { OPENCLAW_BIN, OPENCLAW_CONFIG_PATH, OPENCLAW_ENABLED } from '../config';

const router = Router();

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProviderRow {
  id: number;
  slug: string;
  display_name: string;
  status: string;
  config: string;        // JSON — encrypted API key / base URL
  last_validated_at: string | null;
  validation_error: string | null;
  created_at: string;
  updated_at: string;
}

type ProviderSlug = 'anthropic' | 'openai' | 'google' | 'ollama' | 'openai-codex' | 'mlx-studio' | 'minimax';

const VALID_SLUGS: ProviderSlug[] = ['anthropic', 'openai', 'google', 'ollama', 'openai-codex', 'mlx-studio', 'minimax'];

const OAUTH_SLUGS: ProviderSlug[] = ['openai-codex'];

function isOAuthProvider(slug: string): boolean {
  return OAUTH_SLUGS.includes(slug as ProviderSlug);
}

// ─── Validation definitions ──────────────────────────────────────────────────

interface ValidationSpec {
  buildRequest(config: Record<string, unknown>): { url: string; init: RequestInit };
  requiredFields: string[];
}

const VALIDATION_SPECS: Record<ProviderSlug, ValidationSpec> = {
  anthropic: {
    requiredFields: ['api_key'],
    buildRequest(config) {
      return {
        url: 'https://api.anthropic.com/v1/models',
        init: {
          method: 'GET',
          headers: {
            'x-api-key': config.api_key as string,
            'anthropic-version': '2023-06-01',
          },
        },
      };
    },
  },
  openai: {
    requiredFields: ['api_key'],
    buildRequest(config) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.api_key as string}`,
      };
      if (config.organization_id) headers['OpenAI-Organization'] = config.organization_id as string;
      if (config.project_id) headers['OpenAI-Project'] = config.project_id as string;
      return {
        url: 'https://api.openai.com/v1/models',
        init: { method: 'GET', headers },
      };
    },
  },
  google: {
    requiredFields: ['api_key'],
    buildRequest(config) {
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(config.api_key as string)}`,
        init: { method: 'GET' },
      };
    },
  },
  ollama: {
    requiredFields: ['base_url'],
    buildRequest(config) {
      const base = (config.base_url as string).replace(/\/+$/, '');
      return {
        url: `${base}/api/tags`,
        init: { method: 'GET' },
      };
    },
  },
  'mlx-studio': {
    requiredFields: ['base_url'],
    buildRequest(config) {
      const base = (config.base_url as string).replace(/\/+$/, '');
      return {
        url: `${base}/models`,
        init: { method: 'GET' },
      };
    },
  },
  minimax: {
    requiredFields: ['api_key'],
    buildRequest(config) {
      return {
        url: 'https://api.minimax.io/anthropic/v1/messages',
        init: {
          method: 'POST',
          headers: {
            'x-api-key': config.api_key as string,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: 'MiniMax-M2.5', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        },
      };
    },
  },
  'openai-codex': {
    requiredFields: [],
    buildRequest() {
      throw new Error('openai-codex uses OAuth validation, not HTTP request validation');
    },
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function maskSecret(value: string): string {
  return value.length > 12
    ? `${value.slice(0, 6)}${'*'.repeat(Math.max(0, value.length - 10))}${value.slice(-4)}`
    : '****';
}

function maskConfig(slug: string, config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  if (out.api_key && typeof out.api_key === 'string') {
    out.api_key = maskSecret(out.api_key);
  }
  return out;
}

function parseConfig(row: ProviderRow): Record<string, unknown> {
  try { return JSON.parse(row.config); } catch { return {}; }
}


/** Count providers with status = 'connected' */
export function countConnectedProviders(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as n FROM provider_config WHERE status = 'connected'").get() as { n: number };
  return row.n;
}

/** The onboarding provider gate: true when at least one provider is connected */
export function isProviderGatePassed(): boolean {
  return countConnectedProviders() >= 1;
}

// ─── GET /api/v1/providers ───────────────────────────────────────────────────
router.get('/', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM provider_config ORDER BY created_at ASC').all() as ProviderRow[];
    const providers = rows.map(r => ({
      id: r.id,
      slug: r.slug,
      display_name: r.display_name,
      status: r.status,
      config: maskConfig(r.slug, parseConfig(r)),
      last_validated_at: r.last_validated_at,
      validation_error: r.validation_error,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
    res.json({
      providers,
      onboarding_provider_gate_passed: isProviderGatePassed(),
      connected_count: countConnectedProviders(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── GET /api/v1/providers/gate ──────────────────────────────────────────────
router.get('/gate', (_req: Request, res: Response) => {
  try {
    res.json({
      onboarding_provider_gate_passed: isProviderGatePassed(),
      connected_count: countConnectedProviders(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── GET /api/v1/providers/:id ───────────────────────────────────────────────
router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM provider_config WHERE id = ?').get(req.params.id) as ProviderRow | undefined;
    if (!row) { res.status(404).json({ error: 'Provider not found' }); return; }
    res.json({
      ...row,
      config: maskConfig(row.slug, parseConfig(row)),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── POST /api/v1/providers ──────────────────────────────────────────────────
router.post('/', async (req: Request, res: Response) => {
  try {
    const { slug, display_name, config } = req.body;

    if (!slug || !VALID_SLUGS.includes(slug)) {
      res.status(400).json({ error: `Invalid provider slug. Must be one of: ${VALID_SLUGS.join(', ')}` });
      return;
    }

    const oauthProvider = isOAuthProvider(slug);
    const effectiveConfig = oauthProvider ? (config ?? {}) : config;

    if (!effectiveConfig || typeof effectiveConfig !== 'object') {
      res.status(400).json({ error: 'config must be a JSON object' });
      return;
    }

    if (!oauthProvider) {
      const spec = VALIDATION_SPECS[slug as ProviderSlug];
      const missing = spec.requiredFields.filter(f => !effectiveConfig[f]);
      if (missing.length > 0) {
        res.status(400).json({ error: `Missing required config fields: ${missing.join(', ')}` });
        return;
      }
    }

    if ((slug === 'ollama' || slug === 'mlx-studio') && effectiveConfig.base_url) {
      effectiveConfig.base_url = (effectiveConfig.base_url as string).replace(/\/+$/, '');
    }

    const db = getDb();
    const existing = db.prepare('SELECT id FROM provider_config WHERE slug = ?').get(slug) as { id: number } | undefined;
    if (existing) {
      res.status(409).json({ error: `Provider '${slug}' is already configured. Use PUT to update or DELETE to remove it first.` });
      return;
    }

    const validation = await validateProvider(slug as ProviderSlug, effectiveConfig);
    const status = validation.ok ? 'connected' : 'failed';
    const label = display_name || (oauthProvider ? 'OpenAI Codex (OAuth)' : slug);

    const result = db.prepare(`
      INSERT INTO provider_config (slug, display_name, status, config, last_validated_at, validation_error)
      VALUES (?, ?, ?, ?, datetime('now'), ?)
    `).run(slug, label, status, JSON.stringify(effectiveConfig), validation.error || null);

    const row = db.prepare('SELECT * FROM provider_config WHERE id = ?').get(result.lastInsertRowid) as ProviderRow;

    res.status(201).json({
      ...row,
      config: maskConfig(row.slug, parseConfig(row)),
      validation: { ok: validation.ok, error: validation.error || null },
      onboarding_provider_gate_passed: isProviderGatePassed(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── PUT /api/v1/providers/:id ───────────────────────────────────────────────
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM provider_config WHERE id = ?').get(req.params.id) as ProviderRow | undefined;
    if (!existing) { res.status(404).json({ error: 'Provider not found' }); return; }

    const { display_name, config } = req.body;
    const slug = existing.slug as ProviderSlug;

    const newConfig = config && typeof config === 'object' ? config : parseConfig(existing);
    const newLabel = display_name ?? existing.display_name;

    if (!isOAuthProvider(slug)) {
      const spec = VALIDATION_SPECS[slug];
      const missing = spec.requiredFields.filter(f => !newConfig[f]);
      if (missing.length > 0) {
        res.status(400).json({ error: `Missing required config fields: ${missing.join(', ')}` });
        return;
      }
    }

    if ((slug === 'ollama' || slug === 'mlx-studio') && newConfig.base_url) {
      newConfig.base_url = (newConfig.base_url as string).replace(/\/+$/, '');
    }

    const validation = await validateProvider(slug, newConfig);
    const status = validation.ok ? 'connected' : 'failed';

    db.prepare(`
      UPDATE provider_config
      SET display_name = ?, status = ?, config = ?, last_validated_at = datetime('now'),
          validation_error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(newLabel, status, JSON.stringify(newConfig), validation.error || null, req.params.id);

    const row = db.prepare('SELECT * FROM provider_config WHERE id = ?').get(req.params.id) as ProviderRow;

    res.json({
      ...row,
      config: maskConfig(row.slug, parseConfig(row)),
      validation: { ok: validation.ok, error: validation.error || null },
      onboarding_provider_gate_passed: isProviderGatePassed(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── POST /api/v1/providers/:id/validate ─────────────────────────────────────
router.post('/:id/validate', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM provider_config WHERE id = ?').get(req.params.id) as ProviderRow | undefined;
    if (!row) { res.status(404).json({ error: 'Provider not found' }); return; }

    const slug = row.slug as ProviderSlug;
    const config = parseConfig(row);
    const validation = await validateProvider(slug, config);
    const status = validation.ok ? 'connected' : 'failed';

    db.prepare(`
      UPDATE provider_config
      SET status = ?, last_validated_at = datetime('now'), validation_error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, validation.error || null, row.id);

    res.json({
      ok: validation.ok,
      status,
      error: validation.error || null,
      onboarding_provider_gate_passed: isProviderGatePassed(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── DELETE /api/v1/providers/:id ────────────────────────────────────────────
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM provider_config WHERE id = ?').get(req.params.id) as { id: number } | undefined;
    if (!existing) { res.status(404).json({ error: 'Provider not found' }); return; }

    db.prepare('DELETE FROM provider_config WHERE id = ?').run(req.params.id);
    res.json({ ok: true, onboarding_provider_gate_passed: isProviderGatePassed() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── GET /api/v1/providers/minimax/models ────────────────────────────────────
// Returns the known MiniMax text models. MiniMax uses the Anthropic-compatible
// API at api.minimax.io/anthropic but has no /models endpoint, so we return
// the known model catalog statically.
router.get('/minimax/models', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const row = db.prepare("SELECT * FROM provider_config WHERE slug = 'minimax'").get() as ProviderRow | undefined;
    if (!row) {
      res.status(404).json({ error: 'MiniMax provider is not configured. Add it in Settings → Providers first.' });
      return;
    }

    res.json({
      models: [
        { id: 'MiniMax-M2.7', label: 'MiniMax M2.7' },
        { id: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed' },
        { id: 'MiniMax-M2.5', label: 'MiniMax M2.5' },
        { id: 'MiniMax-M2.5-highspeed', label: 'MiniMax M2.5 Highspeed' },
        { id: 'MiniMax-M2.5-Lightning', label: 'MiniMax M2.5 Lightning' },
      ],
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── OAuth validation ───────────────────────────────────────────────────────

function validateOAuthProvider(slug: string): { ok: boolean; error?: string } {
  if (!OPENCLAW_ENABLED) {
    return { ok: false, error: 'OpenClaw runtime is not enabled. OAuth providers require OpenClaw.' };
  }
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8');
    const ocConfig = JSON.parse(raw);
    const profiles = ocConfig?.auth?.profiles ?? {};
    const profileKey = `${slug}:default`;
    const profile = profiles[profileKey];
    if (!profile || profile.mode !== 'oauth') {
      return { ok: false, error: `No OAuth profile "${profileKey}" found. Click "Sign in" to authenticate.` };
    }
    const openclawDir = path.dirname(OPENCLAW_CONFIG_PATH);
    const agentsDir = path.join(openclawDir, 'agents');
    if (fs.existsSync(agentsDir)) {
      for (const agentId of fs.readdirSync(agentsDir)) {
        const authFile = path.join(agentsDir, agentId, 'agent', 'auth-profiles.json');
        if (!fs.existsSync(authFile)) continue;
        try {
          const authData = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
          const entries = authData?.profiles ? Object.values(authData.profiles) : [];
          for (const entry of entries as Array<Record<string, unknown>>) {
            if (entry?.provider === slug && entry?.type === 'oauth' && entry?.access) {
              if (!entry.expires || (entry.expires as number) > Date.now()) return { ok: true };
            }
          }
        } catch { /* skip */ }
      }
    }
    return { ok: true, error: 'OAuth profile configured. Token may need refresh on next dispatch.' };
  } catch (err) {
    return { ok: false, error: `Could not read OpenClaw config: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── OpenAI Codex OAuth (native PKCE flow) ─────────────────────────────────
//
// Implements the same OAuth flow as OpenClaw's `models auth login --provider
// openai-codex` but without requiring the OpenClaw CLI or a TTY. Uses the
// same public client_id, redirect_uri, and token storage format so OpenClaw
// picks up the tokens automatically from auth-profiles.json.

const OPENAI_OAUTH = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  callbackPort: 1455,
  redirectUri: 'http://localhost:1455/auth/callback',
  scopes: 'openid profile email offline_access',
};

// In-flight OAuth state (one at a time)
let pendingOAuth: {
  state: string;
  codeVerifier: string;
  server: http.Server;
  resolve: (tokens: { access_token: string; refresh_token: string; expires_in: number }) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
} | null = null;

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function extractAccountIdFromJwt(accessToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString());
    return payload?.['https://api.openai.com/auth']?.chatgpt_account_id ?? null;
  } catch { return null; }
}

function writeTokensToAuthProfiles(tokens: { access_token: string; refresh_token: string; expires_in: number }): void {
  const openclawDir = path.dirname(OPENCLAW_CONFIG_PATH);
  const agentsDir = path.join(openclawDir, 'agents');
  if (!fs.existsSync(agentsDir)) return;

  const accountId = extractAccountIdFromJwt(tokens.access_token);
  const expiresAt = Date.now() + tokens.expires_in * 1000;
  const profile = {
    type: 'oauth',
    provider: 'openai-codex',
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: expiresAt,
    ...(accountId ? { accountId } : {}),
  };

  for (const agentId of fs.readdirSync(agentsDir)) {
    const authFile = path.join(agentsDir, agentId, 'agent', 'auth-profiles.json');
    try {
      let data: Record<string, unknown> = { version: 1, profiles: {}, lastGood: {}, usageStats: {} };
      if (fs.existsSync(authFile)) {
        data = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
      }
      const profiles = (data.profiles ?? {}) as Record<string, unknown>;
      profiles['openai-codex:default'] = profile;
      data.profiles = profiles;
      const lastGood = (data.lastGood ?? {}) as Record<string, string>;
      lastGood['openai-codex'] = 'openai-codex:default';
      data.lastGood = lastGood;
      fs.writeFileSync(authFile, JSON.stringify(data, null, 2) + '\n');
      console.log(`[providers] Wrote OpenAI Codex OAuth tokens to ${authFile}`);
    } catch (err) {
      console.warn(`[providers] Failed to write tokens to ${authFile}:`, err instanceof Error ? err.message : err);
    }
  }
}

// ─── POST /providers/:slug/oauth/initiate ───────────────────────────────────

router.post('/:slug/oauth/initiate', async (req: Request, res: Response) => {
  const { slug } = req.params;
  if (!isOAuthProvider(slug)) { res.status(400).json({ error: `'${slug}' does not support OAuth.` }); return; }

  // Clean up any previous pending OAuth flow
  if (pendingOAuth) {
    clearTimeout(pendingOAuth.timeout);
    try { pendingOAuth.server.close(); } catch { /* ignore */ }
    pendingOAuth.reject(new Error('Superseded by new OAuth initiation'));
    pendingOAuth = null;
  }

  const { verifier, challenge } = generatePkce();
  const state = crypto.randomBytes(16).toString('hex');

  // Start local callback server
  try {
    const tokenPromise = new Promise<{ access_token: string; refresh_token: string; expires_in: number }>((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        if (!req.url?.startsWith('/auth/callback')) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const url = new URL(req.url, `http://localhost:${OPENAI_OAUTH.callbackPort}`);
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');

        if (returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>OAuth Error</h2><p>State mismatch. Please try again.</p></body></html>');
          return;
        }

        if (!code) {
          const error = url.searchParams.get('error') || 'No authorization code received';
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h2>OAuth Error</h2><p>${error}</p></body></html>`);
          reject(new Error(error));
          return;
        }

        // Exchange code for tokens
        try {
          const tokenRes = await fetch(OPENAI_OAUTH.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              client_id: OPENAI_OAUTH.clientId,
              code,
              code_verifier: verifier,
              redirect_uri: OPENAI_OAUTH.redirectUri,
            }).toString(),
          });

          if (!tokenRes.ok) {
            const errBody = await tokenRes.text();
            throw new Error(`Token exchange failed (${tokenRes.status}): ${errBody.slice(0, 300)}`);
          }

          const tokens = await tokenRes.json() as { access_token: string; refresh_token: string; expires_in: number };
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Authentication successful!</h2><p>You can close this tab and return to Atlas HQ.</p><script>window.close()</script></body></html>');
          resolve(tokens);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h2>Token exchange failed</h2><p>${err instanceof Error ? err.message : String(err)}</p></body></html>`);
          reject(err instanceof Error ? err : new Error(String(err)));
        } finally {
          server.close();
          pendingOAuth = null;
        }
      });

      const timeout = setTimeout(() => {
        server.close();
        pendingOAuth = null;
        reject(new Error('OAuth callback timed out (120s)'));
      }, 120_000);

      server.listen(OPENAI_OAUTH.callbackPort, '127.0.0.1', () => {
        console.log(`[providers] OAuth callback server listening on port ${OPENAI_OAUTH.callbackPort}`);
      });

      server.on('error', (err) => {
        pendingOAuth = null;
        reject(new Error(`Failed to start callback server on port ${OPENAI_OAUTH.callbackPort}: ${err.message}`));
      });

      pendingOAuth = { state, codeVerifier: verifier, server, resolve, reject, timeout };
    });

    // Build the OAuth URL
    const oauthUrl = `${OPENAI_OAUTH.authUrl}?` + new URLSearchParams({
      response_type: 'code',
      client_id: OPENAI_OAUTH.clientId,
      redirect_uri: OPENAI_OAUTH.redirectUri,
      scope: OPENAI_OAUTH.scopes,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'pi',
    }).toString();

    // Upsert provider_config row as pending
    try {
      const db = getDb();
      const existing = db.prepare('SELECT id FROM provider_config WHERE slug = ?').get(slug) as { id: number } | undefined;
      if (existing) {
        db.prepare("UPDATE provider_config SET status = 'pending', updated_at = datetime('now') WHERE slug = ?").run(slug);
      } else {
        db.prepare("INSERT INTO provider_config (slug, display_name, status, config) VALUES (?, ?, 'pending', '{}')").run(slug, 'OpenAI Codex (OAuth)');
      }
    } catch { /* row may exist */ }

    // Return URL immediately — token exchange happens async via callback
    res.json({ ok: true, oauthUrl, message: 'Complete sign-in in the browser tab, then click "Check Connection".' });

    // Wait for token exchange in background, then write to auth-profiles
    tokenPromise.then((tokens) => {
      console.log(`[providers] OpenAI Codex OAuth tokens received — writing to auth-profiles`);
      writeTokensToAuthProfiles(tokens);

      // Mark provider as connected
      try {
        const db = getDb();
        db.prepare("UPDATE provider_config SET status = 'connected', validation_error = NULL, updated_at = datetime('now') WHERE slug = ?").run(slug);
      } catch { /* best effort */ }
    }).catch((err) => {
      console.error(`[providers] OpenAI Codex OAuth failed:`, err instanceof Error ? err.message : err);
      try {
        const db = getDb();
        db.prepare("UPDATE provider_config SET status = 'failed', validation_error = ?, updated_at = datetime('now') WHERE slug = ?")
          .run(err instanceof Error ? err.message : String(err), slug);
      } catch { /* best effort */ }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[providers] OAuth initiate failed for ${slug}:`, msg);
    res.status(500).json({ error: msg });
  }
});

// ─── POST /providers/:slug/oauth/exchange ───────────────────────────────────
// Manual callback for remote environments: user pastes the redirect URL or
// just the authorization code after authenticating in their local browser.

router.post('/:slug/oauth/exchange', async (req: Request, res: Response) => {
  const { slug } = req.params;
  if (!isOAuthProvider(slug)) { res.status(400).json({ error: `'${slug}' does not support OAuth.` }); return; }

  const { callbackUrl } = req.body ?? {};
  if (!callbackUrl || typeof callbackUrl !== 'string' || !callbackUrl.trim()) {
    res.status(400).json({ error: 'callbackUrl is required. Paste the full redirect URL from your browser.' });
    return;
  }

  if (!pendingOAuth) {
    res.status(400).json({ error: 'No pending OAuth flow. Click "Sign in with OpenAI" first.' });
    return;
  }

  // Extract code from the URL or treat the whole string as a code
  let code: string;
  let returnedState: string | null = null;
  try {
    const url = new URL(callbackUrl.trim());
    code = url.searchParams.get('code') ?? '';
    returnedState = url.searchParams.get('state');
  } catch {
    // Not a valid URL — treat the whole string as the authorization code
    code = callbackUrl.trim();
  }

  if (!code) {
    res.status(400).json({ error: 'Could not extract authorization code from the provided URL.' });
    return;
  }

  // Validate state if present in the URL
  if (returnedState && returnedState !== pendingOAuth.state) {
    res.status(400).json({ error: 'State mismatch. Please initiate a new OAuth flow.' });
    return;
  }

  const { codeVerifier } = pendingOAuth;

  // Clean up the pending flow (stop callback server)
  clearTimeout(pendingOAuth.timeout);
  try { pendingOAuth.server.close(); } catch { /* ignore */ }
  pendingOAuth = null;

  // Exchange code for tokens
  try {
    const tokenRes = await fetch(OPENAI_OAUTH.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: OPENAI_OAUTH.clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: OPENAI_OAUTH.redirectUri,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      throw new Error(`Token exchange failed (${tokenRes.status}): ${errBody.slice(0, 300)}`);
    }

    const tokens = await tokenRes.json() as { access_token: string; refresh_token: string; expires_in: number };

    console.log(`[providers] OpenAI Codex OAuth tokens received via manual exchange — writing to auth-profiles`);
    writeTokensToAuthProfiles(tokens);

    const db = getDb();
    db.prepare("UPDATE provider_config SET status = 'connected', validation_error = NULL, updated_at = datetime('now') WHERE slug = ?").run(slug);

    res.json({ ok: true, message: 'OpenAI Codex connected successfully.' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[providers] OAuth manual exchange failed for ${slug}:`, msg);

    try {
      const db = getDb();
      db.prepare("UPDATE provider_config SET status = 'failed', validation_error = ?, updated_at = datetime('now') WHERE slug = ?").run(msg, slug);
    } catch { /* best effort */ }

    res.status(500).json({ error: msg });
  }
});

// ─── POST /providers/:slug/setup-token ──────────────────────────────────────

router.post('/:slug/setup-token', async (req: Request, res: Response) => {
  const { slug } = req.params;
  if (slug !== 'anthropic') { res.status(400).json({ error: `'${slug}' does not support setup-token.` }); return; }
  if (!OPENCLAW_ENABLED) { res.status(400).json({ error: 'OpenClaw runtime is not enabled.' }); return; }

  const { token } = req.body ?? {};
  if (!token || typeof token !== 'string' || !token.trim()) {
    res.status(400).json({ error: 'token is required.' });
    return;
  }

  try {
    const openclawDir = path.dirname(OPENCLAW_CONFIG_PATH);
    const agentsDir = path.join(openclawDir, 'agents');
    let updated = 0;
    if (fs.existsSync(agentsDir)) {
      for (const agentId of fs.readdirSync(agentsDir)) {
        const authFile = path.join(agentsDir, agentId, 'agent', 'auth-profiles.json');
        if (!fs.existsSync(authFile)) continue;
        try {
          const authData = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
          if (!authData.profiles) authData.profiles = {};
          authData.profiles['anthropic:manual'] = {
            type: 'token',
            provider: 'anthropic',
            token: token.trim(),
          };
          fs.writeFileSync(authFile, JSON.stringify(authData, null, 2));
          updated++;
        } catch { /* skip */ }
      }
    }

    // Validate via OpenClaw — setup tokens are OAuth-derived and don't work
    // with the standard x-api-key header, but OpenClaw can verify them.
    const { spawnSync } = await import('child_process');
    const check = spawnSync(OPENCLAW_BIN, ['models', 'list', '--provider', slug, '--json'], {
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env },
    });
    let validation: { ok: boolean; error?: string };
    try {
      const parsed = JSON.parse(check.stdout || '{}');
      const models = parsed.models as Array<{ available?: boolean }> | undefined;
      const anyAvailable = models?.some(m => m.available);
      validation = anyAvailable
        ? { ok: true }
        : { ok: false, error: 'Token was written but no Anthropic models are available. The token may be invalid or expired.' };
    } catch {
      validation = { ok: false, error: 'Could not verify token via OpenClaw. Check that OpenClaw is running.' };
    }
    const db = getDb();
    const existing = db.prepare('SELECT id FROM provider_config WHERE slug = ?').get(slug) as { id: number } | undefined;
    const status = validation.ok ? 'connected' : 'failed';

    if (existing) {
      db.prepare(`
        UPDATE provider_config SET status = ?, config = ?, last_validated_at = datetime('now'), validation_error = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(status, JSON.stringify({ setup_token: true }), validation.error || null, existing.id);
    } else {
      db.prepare(`
        INSERT INTO provider_config (slug, display_name, status, config, last_validated_at, validation_error)
        VALUES (?, 'Anthropic', ?, ?, datetime('now'), ?)
      `).run(slug, status, JSON.stringify({ setup_token: true }), validation.error || null);
    }

    res.json({
      ok: validation.ok,
      message: validation.ok
        ? `Token synced to ${updated} agent profile(s) and validated successfully.`
        : `Token written but validation failed: ${validation.error}`,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Validation Engine ───────────────────────────────────────────────────────

async function validateProvider(
  slug: ProviderSlug,
  config: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  if (isOAuthProvider(slug)) return validateOAuthProvider(slug);

  const spec = VALIDATION_SPECS[slug];
  if (!spec) return { ok: false, error: `Unknown provider: ${slug}` };

  try {
    const { url, init } = spec.buildRequest(config);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const response = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timeout);

    if (response.ok) {
      if (slug === 'ollama') {
        try {
          const body = await response.json() as { models?: unknown[] };
          if (!body.models || body.models.length === 0) {
            return { ok: true, error: 'Connected, but no models installed. Run `ollama pull <model>` to add one.' };
          }
        } catch { /* proceed */ }
      }
      if (slug === 'mlx-studio') {
        try {
          const body = await response.json() as { data?: unknown[] };
          if (!body.data || body.data.length === 0) {
            return { ok: true, error: 'Connected to MLX Studio, but no models are loaded. Load a model in MLX Studio first.' };
          }
        } catch { /* proceed */ }
      }
      return { ok: true };
    }

    const status = response.status;
    if (status === 401 || status === 403) {
      const providerName = slug.charAt(0).toUpperCase() + slug.slice(1);
      return { ok: false, error: `${providerName} couldn't verify your key. Double-check it and try again.` };
    }
    if (status === 429) {
      return { ok: false, error: 'Rate limited — your key appears valid but you\'ve hit a usage limit. Try again later.' };
    }
    return { ok: false, error: `Unexpected response (HTTP ${status}) from ${slug}. Check your credentials.` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort') || msg.includes('timeout')) {
      return { ok: false, error: `Connection to ${slug} timed out. Check your network and try again.` };
    }
    if (slug === 'ollama') {
      const base = (config.base_url as string) || 'http://localhost:11434';
      return { ok: false, error: `Ollama isn't running at \`${base}\`. Start Ollama and try again.` };
    }
    if (slug === 'mlx-studio') {
      const base = (config.base_url as string) || 'http://localhost:10240/v1';
      return { ok: false, error: `MLX Studio isn't running at \`${base}\`. Make sure MLX Studio is open and a model is loaded.` };
    }
    if (slug === 'minimax') {
      return { ok: false, error: 'Could not reach MiniMax API. Check your API key and network connection.' };
    }
    const providerName = slug.charAt(0).toUpperCase() + slug.slice(1);
    return { ok: false, error: `Couldn't reach ${providerName}. Check your connection and try again.` };
  }
}

export default router;
