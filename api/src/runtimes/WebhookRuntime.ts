/**
 * runtimes/WebhookRuntime.ts — Generic HTTP webhook AgentRuntime adapter.
 *
 * Dispatches tasks by POSTing a structured payload to any configured URL.
 * Designed for future runtimes that expose an HTTP endpoint (e.g. a self-hosted
 * Claude Code server, a custom agent framework, etc.).
 *
 * Dispatch payload:
 *   { message, agentId, sessionKey, timeoutSeconds, name, instanceId, callbackUrls }
 *
 * The remote endpoint MUST respond with { runId: string }.
 *
 * Abort (optional): POST to abortUrl with { runId, sessionKey }.
 * If abortUrl is not configured, abort() is a no-op.
 *
 * Lifecycle proxy mode (task #470):
 *   When lifecycleProxy is enabled, the runtime handles the full Atlas lifecycle
 *   on behalf of the remote agent — same as VeriAgentRuntime. The remote agent
 *   emits a structured atlas_lifecycle JSON block in its response body, and the
 *   runtime parses it to record evidence, post outcomes, and close instances.
 *
 *   Enable: set `lifecycleProxy: true` in runtime_config.
 *   When enabled, the response body is consumed and parsed for lifecycle data.
 *   When disabled (default), the remote endpoint is expected to make lifecycle
 *   callbacks itself using the provided callbackUrls.
 */

import type { AgentRuntime, DispatchParams, RuntimeEndEvent } from './types';
import {
  proxyStart,
  proxyBlocker,
  proxyOutcome,
  proxyComplete,
  runPostStreamLifecycle,
  buildLifecycleUserPromptSection,
  type LifecycleContext,
} from './lifecycleProxy';

// ── Config ───────────────────────────────────────────────────────────────────

export interface WebhookRuntimeConfig {
  /** POST endpoint to dispatch agent runs (required). */
  dispatchUrl: string;
  /** Optional Authorization header value, e.g. "Bearer sk-..." */
  authHeader?: string;
  /** Optional URL to POST abort requests. If absent, abort() is a no-op. */
  abortUrl?: string;
  /** Request timeout in milliseconds (default: 30 000). */
  timeoutMs?: number;
  /**
   * Enable lifecycle proxy mode (task #470).
   *
   * When true, the runtime handles Atlas lifecycle callbacks on behalf of the
   * remote agent. The remote agent must emit a structured `atlas_lifecycle`
   * JSON block in its response body. The runtime parses it and drives:
   *   - start callback
   *   - review evidence recording
   *   - task outcome posting
   *   - instance completion
   *
   * When false (default), the remote agent is expected to make lifecycle
   * callbacks itself using the provided callbackUrls.
   */
  lifecycleProxy?: boolean;
  /**
   * Agent identifier for changed_by fields when lifecycle proxy is active.
   * Defaults to the agentSlug from dispatch params.
   */
  lifecycleChangedBy?: string;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface CallbackUrls {
  start: string;
  checkIn: string;
  complete: string;
  outcome: string;
  reviewEvidence: string;
}

interface DispatchPayload {
  message: string;
  agentId: string;
  sessionKey: string;
  timeoutSeconds: number;
  name: string;
  instanceId: number | null;
  taskId: number | null;
  callbackUrls: CallbackUrls | null;
  /** When true, the runtime handles lifecycle — remote should emit atlas_lifecycle block. */
  lifecycleProxy: boolean;
}

interface AbortPayload {
  runId: string;
  sessionKey: string;
}

interface DispatchResponse {
  runId: string;
  /** Optional response body text (used when lifecycleProxy is enabled). */
  output?: string;
}

// ── Runtime ──────────────────────────────────────────────────────────────────

export class WebhookRuntime implements AgentRuntime {
  private config: WebhookRuntimeConfig;

  constructor(config: WebhookRuntimeConfig) {
    if (!config.dispatchUrl) {
      throw new Error('WebhookRuntime: dispatchUrl is required in runtime_config');
    }
    this.config = config;
  }

  /**
   * dispatch — POST dispatchUrl with the task payload.
   *
   * Expects { runId: string } in the response body.
   * Throws on network errors or non-2xx responses so the dispatcher can retry.
   *
   * When lifecycleProxy is enabled (task #470):
   *   1. Calls proxyStart before dispatching
   *   2. Appends lifecycle instructions to the message
   *   3. Parses the response body for atlas_lifecycle data
   *   4. Drives the full Atlas lifecycle (evidence, outcome, completion)
   */
  async dispatch(params: DispatchParams): Promise<{ runId: string }> {
    const {
      message,
      agentSlug,
      sessionKey,
      timeoutSeconds,
      name,
      instanceId,
      taskId,
    } = params;

    const isProxyMode = this.config.lifecycleProxy === true;
    const changedBy = this.config.lifecycleChangedBy || agentSlug;

    // Build lifecycle context (used when proxy mode is active)
    const lifecycleCtx: LifecycleContext | null =
      isProxyMode && instanceId != null && taskId != null
        ? { instanceId, taskId, sessionKey, changedBy }
        : null;

    // Step 1: Start callback (proxy mode only)
    if (lifecycleCtx) {
      await proxyStart(lifecycleCtx);
    }

    const baseUrl = process.env.ATLAS_INTERNAL_BASE_URL ?? 'http://localhost:3501';

    // In proxy mode, callbackUrls are still provided for backward compat / documentation,
    // but the remote agent is NOT expected to use them — the runtime drives lifecycle.
    const callbackUrls: CallbackUrls | null =
      instanceId != null
        ? {
            start: `${baseUrl}/api/v1/instances/${instanceId}/start`,
            checkIn: `${baseUrl}/api/v1/instances/${instanceId}/check-in`,
            complete: `${baseUrl}/api/v1/instances/${instanceId}/complete`,
            outcome: `${baseUrl}/api/v1/tasks/${taskId ?? 0}/outcome`,
            reviewEvidence: `${baseUrl}/api/v1/tasks/${taskId ?? 0}/review-evidence`,
          }
        : null;

    // In proxy mode, append lifecycle instructions to the message — but only if
    // the dispatcher hasn't already included proxy-managed contract instructions (task #632).
    const hasProxyContract = message.includes('Runtime: Proxy-Managed');
    const effectiveMessage = isProxyMode && instanceId != null && !hasProxyContract
      ? `${message}\n\n${buildLifecycleUserPromptSection()}`
      : message;

    const body: DispatchPayload = {
      message: effectiveMessage,
      agentId: agentSlug,
      sessionKey,
      timeoutSeconds,
      name,
      instanceId: instanceId ?? null,
      taskId: taskId ?? null,
      callbackUrls,
      lifecycleProxy: isProxyMode,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.authHeader) {
      headers['Authorization'] = this.config.authHeader;
    }

    const timeoutMs = this.config.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let resp: Response;
    try {
      resp = await fetch(this.config.dispatchUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // On dispatch failure with proxy mode, report blocker
      if (lifecycleCtx) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await proxyBlocker(
          lifecycleCtx,
          `Webhook dispatch failed: ${errorMsg.slice(0, 200)}`,
          errorMsg.slice(0, 300),
        );
      }
      const message =
        err instanceof Error ? err.message : String(err);
      throw new Error(
        `WebhookRuntime: POST ${this.config.dispatchUrl} failed — ${message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      // On non-2xx with proxy mode, report blocker
      if (lifecycleCtx) {
        await proxyBlocker(
          lifecycleCtx,
          `Webhook dispatch returned ${resp.status}`,
          `${resp.status}: ${text.slice(0, 200)}`,
        );
      }
      throw new Error(
        `WebhookRuntime: POST ${this.config.dispatchUrl} returned ${resp.status}: ${text.slice(0, 500)}`,
      );
    }

    const result = (await resp.json().catch(() => ({}))) as Partial<DispatchResponse>;
    const runId = typeof result.runId === 'string' ? result.runId : '';

    // In proxy mode, drive the post-dispatch lifecycle from the response
    if (lifecycleCtx && isProxyMode) {
      const output = typeof result.output === 'string' ? result.output : '';
      if (output) {
        // The remote agent included its output in the response — run lifecycle now
        runPostStreamLifecycle(lifecycleCtx, output)
          .then(async (lifecycleResult) => {
            await params.onRuntimeEnd?.({
              type: 'runEnded',
              source: 'webhook',
              sessionKey,
              runId,
              success: true,
              endedAt: new Date().toISOString(),
              reason: 'completed',
              metadata: {
                lifecycle_outcome: lifecycleResult.effectiveOutcome,
                delivery: 'response-output',
              },
            } satisfies RuntimeEndEvent);
          })
          .catch(async err => {
            console.error(
              `[WebhookRuntime] Post-dispatch lifecycle failed for instance #${instanceId}:`,
              err instanceof Error ? err.message : String(err),
            );
            // Best-effort failure reporting
            proxyOutcome(lifecycleCtx, 'failed', `Lifecycle proxy error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
            proxyComplete(lifecycleCtx, 'failed', `Lifecycle proxy error`).catch(() => {});
            await params.onRuntimeEnd?.({
              type: 'runEnded',
              source: 'webhook',
              sessionKey,
              runId,
              success: false,
              endedAt: new Date().toISOString(),
              error: err instanceof Error ? err.message : String(err),
              reason: (err instanceof Error ? err.message : String(err)).toLowerCase().includes('timeout') ? 'timeout' : 'error',
              metadata: {
                delivery: 'response-output',
                runtime_phase: 'post-dispatch-lifecycle',
              },
            } satisfies RuntimeEndEvent);
          });
      }
      // If output is empty, the remote endpoint will call back asynchronously
      // or the watchdog will eventually time out the instance.
    }

    return { runId };
  }

  /**
   * abort — POST abortUrl with { runId, sessionKey } if configured.
   *
   * Resolves (does not throw) even if the remote is unreachable or the run is
   * already gone, so the dispatcher is never blocked by abort failures.
   */
  async abort(runId: string, sessionKey: string): Promise<void> {
    if (!this.config.abortUrl) {
      // No abort endpoint configured — nothing to do.
      return;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.authHeader) {
      headers['Authorization'] = this.config.authHeader;
    }

    const body: AbortPayload = { runId, sessionKey };
    const timeoutMs = this.config.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(this.config.abortUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Non-2xx is logged but not thrown — abort is best-effort
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        console.warn(
          `[WebhookRuntime] abort POST ${this.config.abortUrl} returned ${resp.status}: ${text.slice(0, 200)}`,
        );
      }
    } catch (err) {
      // Network errors during abort are suppressed — external system manages state
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[WebhookRuntime] abort POST ${this.config.abortUrl} failed — ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
