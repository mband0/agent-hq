/**
 * runtimes/VeriAgentRuntime.ts — AgentRuntime backed by the Veri LLM fleet.
 *
 * Supports two modes:
 *
 * **Mode 1 — Model Provider** (handled by the dispatcher's model routing):
 *   preferred_provider="veri" selects a veri/* model from story_point_model_routing.
 *   The OpenClawRuntime or ClaudeCodeRuntime forwards inference calls to the
 *   Veri chat completions endpoint via the model string (veri/qwen3-80b, etc.).
 *   No runtime-level changes needed — model routing handles it.
 *
 * **Mode 2 — Agent Runtime** (this file):
 *   Dispatches an entire task to a Veri agent by POSTing a structured prompt
 *   to the Veri chat completions endpoint. The Veri agent stack (Forge, Sentinel-QA,
 *   Legal Counsel, etc.) runs the full agentic loop autonomously.
 *
 * Lifecycle contract parity (task #464):
 *   The runtime now honors the same Atlas engineer lifecycle contract as local
 *   agent runtimes (OpenClaw, ClaudeCode). Because the Veri chat completions
 *   endpoint cannot make outbound HTTP calls back to Atlas, the runtime
 *   handles all lifecycle callbacks on behalf of the Veri agent:
 *
 *   1. PUT  /instances/:id/start           — called before streaming begins
 *   2. POST /instances/:id/check-in        — periodic heartbeats during streaming
 *   3. PUT  /tasks/:id/review-evidence     — branch/commit/review URL from agent output
 *   4. POST /tasks/:id/outcome             — parsed from agent structured output
 *   5. PUT  /instances/:id/complete         — after outcome is posted
 *
 *   The Veri agent is instructed (via system prompt) to emit a structured
 *   JSON block (```atlas_lifecycle {...}```) at the end of its response.
 *   The runtime parses this block for outcome, branch, commit, summary, etc.
 *
 * Credentials loaded from env:
 *   VERI_API_KEY  — Bearer token for the Veri API
 *   VERI_BASE_URL — Base URL for the Veri chat completions endpoint
 *
 * Timeout: 120s (configurable via runtime_config.timeoutMs).
 * Streaming: true (for long-running agent tasks).
 */

import type { AgentRuntime, DispatchParams, RuntimeEndEvent } from './types';
import { getDb } from '../db/client';
import {
  atlasCall,
  parseLifecycleData,
  buildLifecycleSystemPromptSection,
  buildLifecycleUserPromptSection,
  proxyStart,
  proxyHeartbeat,
  proxyProgress,
  proxyBlocker,
  proxyOutcome,
  proxyComplete,
  runPostStreamLifecycle,
  type LifecycleContext,
  type AtlasLifecycleData,
  ALL_VALID_OUTCOMES,
} from './lifecycleProxy';

// ── Config ───────────────────────────────────────────────────────────────────

export interface VeriAgentRuntimeConfig {
  /** Override the Veri API base URL (default: VERI_BASE_URL env var). Used for chat completions fallback. */
  baseUrl?: string;
  /** Veri tenant API base URL (default: VERI_TENANT_URL env var). Used for POST /api/agent/message dispatch. */
  tenantApiUrl?: string;
  /** Override the Veri API key (default: VERI_API_KEY env var). */
  apiKey?: string;
  /** Agent slug on the Veri platform (default: 'forge'). */
  agentSlug?: string;
  /** Model to use for agent dispatch (default: mlx-community/Qwen3-Next-80B-A3B-Instruct-4bit). */
  model?: string;
  /** Request timeout in milliseconds (default: 120_000). */
  timeoutMs?: number;
  /** Heartbeat interval in milliseconds during streaming (default: 60_000). */
  heartbeatIntervalMs?: number;
  /** Additional arbitrary config fields. */
  [key: string]: unknown;
}

const DEFAULT_VERI_MODEL = 'mlx-community/Qwen3-Next-80B-A3B-Instruct-4bit';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

// ── Lifecycle types re-exported from lifecycleProxy ──────────────────────────
// AtlasLifecycleData and ALL_VALID_OUTCOMES are imported from lifecycleProxy.ts.

// ── Helpers ──────────────────────────────────────────────────────────────────

function getVeriBaseUrl(config: VeriAgentRuntimeConfig): string {
  const url =
    config.baseUrl ||
    process.env.VERI_BASE_URL ||
    '';
  return url.replace(/\/+$/, '');
}

function getVeriTenantUrl(config: VeriAgentRuntimeConfig): string {
  const url =
    config.tenantApiUrl ||
    process.env.VERI_TENANT_URL ||
    '';
  return url.replace(/\/+$/, '');
}

function getVeriApiKey(config: VeriAgentRuntimeConfig): string {
  return config.apiKey || process.env.VERI_API_KEY || '';
}

// atlasCall is imported from lifecycleProxy.ts

/**
 * Format a task as a structured prompt for the Veri agent stack.
 *
 * Includes the full task context AND explicit instructions for the agent to
 * emit structured lifecycle output that the runtime can parse.
 * Uses shared lifecycle prompt sections from lifecycleProxy (task #470).
 */
function formatTaskPrompt(params: DispatchParams): string {
  const parts: string[] = [
    `# Task Dispatch from Atlas HQ`,
    ``,
    `**Task:** ${params.name}`,
    `**Agent:** ${params.agentSlug}`,
    `**Session:** ${params.sessionKey}`,
    `**Timeout:** ${params.timeoutSeconds}s`,
  ];

  if (params.instanceId) {
    parts.push(`**Instance ID:** ${params.instanceId}`);
  }
  if (params.taskId) {
    parts.push(`**Task ID:** ${params.taskId}`);
  }

  parts.push('', '## Instructions', '', params.message);

  // Only inject lifecycle user prompt if the dispatcher hasn't already included
  // proxy-managed contract instructions (task #632). Check for the atlas_lifecycle
  // marker that the contracts/transportAdapters.ts proxy-managed adapter emits.
  if (params.instanceId && !params.message.includes('Runtime: Proxy-Managed')) {
    parts.push('', buildLifecycleUserPromptSection());
  }

  return parts.join('\n');
}

/**
 * Build the system prompt for the Veri agent.
 *
 * Enhanced (task #464) to instruct the agent to operate as a full Atlas
 * engineer — including branching, testing, and structured lifecycle output.
 * Uses shared lifecycle prompt section from lifecycleProxy (task #470).
 */
function buildSystemPrompt(_params: DispatchParams): string {
  return [
    'You are a senior engineer dispatched by Atlas HQ to execute a task.',
    '',
    'Your workflow:',
    '1. Read the task description and acceptance criteria carefully.',
    '2. Work on a feature branch (naming: forge/task-{id}-{short-slug}).',
    '3. Write clean, tested code. Run tests before declaring completion.',
    '4. When done, emit a structured `atlas_lifecycle` JSON block at the END of your response.',
    '',
    buildLifecycleSystemPromptSection(),
  ].join('\n');
}

// parseLifecycleData is imported from lifecycleProxy.ts (task #470)

// ── Runtime ──────────────────────────────────────────────────────────────────

export class VeriAgentRuntime implements AgentRuntime {
  private config: VeriAgentRuntimeConfig;

  constructor(config: VeriAgentRuntimeConfig = {}) {
    this.config = config;
  }

  /**
   * dispatch — POST a structured task prompt to the Veri chat completions endpoint.
   *
   * Lifecycle parity (task #464):
   * 1. Calls PUT /instances/:id/start BEFORE beginning the stream
   * 2. Sends periodic heartbeat check-ins DURING streaming
   * 3. Parses structured lifecycle data from the agent's response
   * 4. Records review evidence (branch/commit) if provided
   * 5. Posts task outcome with correct semantics
   * 6. Completes the instance with structured metadata
   *
   * Returns a synthetic runId derived from the instance ID.
   */
  async dispatch(params: DispatchParams): Promise<{ runId: string }> {
    const tenantUrl = getVeriTenantUrl(this.config);
    const apiKey = getVeriApiKey(this.config);
    const agentSlug = this.config.agentSlug || params.agentSlug || 'forge';
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!apiKey) {
      throw new Error(
        'VeriAgentRuntime: VERI_API_KEY is not set. ' +
        'Set it in ~/.openclaw/secrets/veri.env or runtime_config.apiKey.',
      );
    }

    // Build a structured prompt that wraps the raw task message with lifecycle
    // instructions (emit atlas_lifecycle JSON) so the runtime can parse outcomes.
    const prompt = formatTaskPrompt(params);

    // Use the Veri API base URL (not the tenant dashboard relay).
    // VERI_BASE_URL points to /veri/api/v1 — the agent/run endpoint lives there.
    const baseUrl = getVeriBaseUrl(this.config);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // ── Step 1: Start callback (via shared lifecycle proxy, task #470) ────────
    if (params.instanceId && params.taskId) {
      await proxyStart({
        instanceId: params.instanceId,
        taskId: params.taskId,
        sessionKey: params.sessionKey,
        changedBy: 'veri-forge',
      });
    }

    try {
      const resp = await fetch(`${baseUrl}/agent/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ prompt, system: buildSystemPrompt(params) }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(
          `VeriAgentRuntime: POST ${baseUrl}/agent/run returned ${resp.status}: ${text.slice(0, 500)}`,
        );
      }

      // The agent/run endpoint returns an SSE stream (text/event-stream).
      // We only need the 200 status + any session/run ID from headers.
      // The agent runs autonomously with tools and will call back to Atlas.
      const sessionId = resp.headers.get('x-session-id');
      const runId = sessionId || `veri-${params.instanceId ?? Date.now()}`;

      const emitRuntimeEnd = async (event: RuntimeEndEvent): Promise<void> => {
        if (params.instanceId != null) {
          this.persistRuntimeEndEvent(params.instanceId, event);
        }
        await params.onRuntimeEnd?.(event);
      };

      // Persist the real Veri session ID to job_instances.run_id so abort()
      // can retrieve the actual session identifier later (task #623).
      if (params.instanceId != null && sessionId) {
        try {
          const db = getDb();
          db.prepare(`UPDATE job_instances SET run_id = ? WHERE id = ?`)
            .run(sessionId, params.instanceId);
          console.log(
            `[VeriAgentRuntime] Persisted Veri session ID ${sessionId} as run_id for instance ${params.instanceId}`,
          );
        } catch (dbErr) {
          console.warn(
            `[VeriAgentRuntime] Failed to persist run_id for instance ${params.instanceId}:`,
            dbErr instanceof Error ? dbErr.message : String(dbErr),
          );
        }
      }

      // Consume the SSE stream in the background — the runtime handles all
      // lifecycle callbacks (heartbeats, review evidence, outcome, instance
      // completion) by parsing the agent's streamed response.
      if (resp.body) {
        this.consumeStream(resp.body, params, runId, emitRuntimeEnd)
          .catch(async err => {
            await this.handleStreamFailure(params, runId, err, emitRuntimeEnd);
          });
      }

      // Poll the Veri events API in the background for rich chat transcript
      // data (thoughts, tool calls, tool results). The events API provides
      // timestamped, ordered events that the SSE stream doesn't reliably
      // deliver to chat_messages.
      if (params.instanceId != null && params.taskId != null) {
        const eventsBaseUrl = getVeriBaseUrl(this.config);
        this.pollEventsApi(eventsBaseUrl, apiKey, runId, params)
          .catch(err => {
            console.warn(
              `[VeriAgentRuntime] Events poller failed for run ${runId}:`,
              err instanceof Error ? err.message : String(err),
            );
          });
      }

      console.log(
        `[VeriAgentRuntime] Dispatched via agent/run — run_id=${runId} ` +
        `session=${params.sessionKey} instance=${params.instanceId ?? 'none'}`,
      );

      return { runId };
    } catch (err) {
      // On dispatch failure, report blocker via shared lifecycle proxy (task #470)
      if (params.instanceId && params.taskId) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const blockerCtx: LifecycleContext = {
          instanceId: params.instanceId,
          taskId: params.taskId,
          sessionKey: params.sessionKey,
          changedBy: 'veri-forge',
        };
        await proxyBlocker(blockerCtx, `Dispatch failed: ${errorMsg.slice(0, 200)}`, errorMsg.slice(0, 300));
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`VeriAgentRuntime: dispatch failed — ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * abort — send a stop signal to the Veri agent engine for the running session.
   *
   * Calls POST {VERI_BASE_URL}/agent/stop with the session_id payload (task #623).
   * This sets a cancellation event on the Veri side; the agent finishes its current
   * turn, emits a cancelled event, and frees the session slot.
   *
   * Resolution priority for session ID:
   *   1. run_id from DB (real Veri session ID persisted at dispatch time)
   *   2. runId param — if it's not a synthetic veri-{id} value, use it directly
   *   3. Fallback: query GET /agent/status for active session IDs
   *
   * Errors are logged but never rethrown — the Atlas stop flow always completes.
   */
  async abort(runId: string, _sessionKey: string): Promise<void> {
    console.log(`[VeriAgentRuntime] abort called for ${runId}`);

    const baseUrl = getVeriBaseUrl(this.config);
    const apiKey = getVeriApiKey(this.config);

    if (!baseUrl || !apiKey) {
      console.warn(
        `[VeriAgentRuntime] abort: missing VERI_BASE_URL or VERI_API_KEY — cannot stop remote session`,
      );
      return;
    }

    // Determine the Veri session ID to stop.
    let sessionId: string | null = null;

    // 1. Try run_id from DB — this is the real Veri session ID captured at dispatch.
    //    Extract the instance ID from the synthetic runId if it has that form.
    const syntheticMatch = runId.match(/^veri-(\d+)$/);
    if (syntheticMatch) {
      const instanceId = Number(syntheticMatch[1]);
      try {
        const db = getDb();
        const row = db.prepare('SELECT run_id FROM job_instances WHERE id = ?')
          .get(instanceId) as { run_id: string | null } | undefined;
        if (row?.run_id && !row.run_id.startsWith('veri-')) {
          sessionId = row.run_id;
          console.log(
            `[VeriAgentRuntime] abort: resolved real session ID ${sessionId} from DB for instance ${instanceId}`,
          );
        }
      } catch (dbErr) {
        console.warn(
          `[VeriAgentRuntime] abort: DB lookup failed for instance ${instanceId}:`,
          dbErr instanceof Error ? dbErr.message : String(dbErr),
        );
      }
    }

    // 2. runId param itself is a real Veri session ID (not synthetic).
    if (!sessionId && !syntheticMatch) {
      sessionId = runId;
    }

    // 3. Fallback: ask the Veri status endpoint which sessions are active.
    if (!sessionId) {
      try {
        const statusResp = await fetch(`${baseUrl}/agent/status`, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (statusResp.ok) {
          const status = await statusResp.json() as { session_ids?: string[] };
          const ids = status.session_ids ?? [];
          if (ids.length > 0) {
            // Use the most recent session as the best guess.
            sessionId = ids[ids.length - 1];
            console.log(
              `[VeriAgentRuntime] abort: discovered session ID ${sessionId} from /agent/status`,
            );
          }
        }
      } catch (statusErr) {
        console.warn(
          `[VeriAgentRuntime] abort: /agent/status lookup failed:`,
          statusErr instanceof Error ? statusErr.message : String(statusErr),
        );
      }
    }

    if (!sessionId) {
      console.warn(
        `[VeriAgentRuntime] abort: could not resolve a Veri session ID for run ${runId} — skipping remote stop`,
      );
      return;
    }

    // Call POST /agent/stop on the Veri engine.
    try {
      const stopResp = await fetch(`${baseUrl}/agent/stop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ session_id: sessionId }),
        signal: AbortSignal.timeout(10_000),
      });

      if (stopResp.status === 404) {
        console.log(
          `[VeriAgentRuntime] abort: session ${sessionId} not found on Veri engine (already finished or never started)`,
        );
        return;
      }

      if (!stopResp.ok) {
        const text = await stopResp.text().catch(() => '');
        console.warn(
          `[VeriAgentRuntime] abort: POST /agent/stop returned ${stopResp.status}: ${text.slice(0, 200)}`,
        );
        return;
      }

      const result = await stopResp.json() as { ok?: boolean };
      console.log(
        `[VeriAgentRuntime] abort: Veri session ${sessionId} stop signal sent — ok=${result.ok}`,
      );
    } catch (stopErr) {
      console.warn(
        `[VeriAgentRuntime] abort: POST /agent/stop failed:`,
        stopErr instanceof Error ? stopErr.message : String(stopErr),
      );
    }
  }

  /**
   * handleStreamFailure — report failure lifecycle when the stream itself errors.
   * Uses shared lifecycle proxy functions (task #470).
   */
  private async handleStreamFailure(
    params: DispatchParams,
    runId: string,
    err: unknown,
    emitRuntimeEnd?: (event: RuntimeEndEvent) => Promise<void>,
  ): Promise<void> {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const summary = `Veri stream failed: ${errorMsg.slice(0, 200)}`;

    if (params.taskId && params.instanceId != null) {
      const ctx: LifecycleContext = {
        instanceId: params.instanceId,
        taskId: params.taskId,
        sessionKey: params.sessionKey,
        changedBy: 'veri-forge',
      };
      await proxyOutcome(ctx, 'failed', summary);
      await proxyComplete(ctx, 'failed', summary);
    } else if (params.taskId) {
      await atlasCall(
        'POST',
        `/api/v1/tasks/${params.taskId}/outcome`,
        {
          outcome: 'failed',
          summary,
          changed_by: 'veri-forge',
        },
        `Failed outcome for task #${params.taskId}`,
      );
    }

    if (emitRuntimeEnd) {
      await emitRuntimeEnd({
        type: 'runEnded',
        source: 'veri',
        sessionKey: params.sessionKey,
        runId,
        success: false,
        endedAt: new Date().toISOString(),
        error: errorMsg,
        reason: errorMsg.toLowerCase().includes('timeout') ? 'timeout' : 'error',
        metadata: {
          runtime_phase: 'stream',
        },
      });
    }
  }

  /**
   * pollEventsApi — poll the Veri agent engine's events API for rich,
   * timestamped event data (thoughts, tool calls, tool results) and persist
   * them as chat_messages rows for the Atlas HQ Chats tab.
   *
   * The events API (`GET /v1/agent/events/{sessionId}`) provides:
   *   - ISO 8601 `ts` timestamps on every event (preserves chronological order)
   *   - Offset-based pagination for incremental polling
   *   - `active` flag to know when the session has ended
   *
   * Events are persisted with their Veri-side timestamps so chat display
   * is chronologically correct regardless of polling latency.
   */
  private async pollEventsApi(
    baseUrl: string,
    apiKey: string,
    runId: string,
    params: DispatchParams,
  ): Promise<void> {
    const POLL_INTERVAL_MS = 3_000;
    const MAX_POLLS = 600; // 30 min max at 3s intervals
    const instanceId = params.instanceId!;

    // Resolve session ID — the Veri engine assigns its own session ID.
    // First check if runId is a Veri session ID (from x-session-id header).
    // If it's our synthetic `veri-{instanceId}`, discover via status endpoint.
    let sessionId = runId.startsWith('veri-') ? '' : runId;

    // Look up agent_id for this instance
    const db = getDb();
    const instRow = db.prepare('SELECT agent_id FROM job_instances WHERE id = ?')
      .get(instanceId) as { agent_id: number } | undefined;
    const agentId = instRow?.agent_id ?? null;
    if (agentId == null) return;

    // Discover session ID from the Veri status endpoint if needed
    if (!sessionId) {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const statusResp = await fetch(`${baseUrl}/agent/status`, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(5_000),
          });
          if (statusResp.ok) {
            const status = await statusResp.json() as {
              session_ids?: string[];
            };
            const ids = status.session_ids ?? [];
            if (ids.length > 0) {
              // Use the most recently started session
              sessionId = ids[ids.length - 1];
              break;
            }
          }
        } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 2_000));
      }
    }

    if (!sessionId) {
      console.warn(
        `[VeriAgentRuntime] Events poller: could not discover session ID for run ${runId}`,
      );
      return;
    }

    console.log(
      `[VeriAgentRuntime] Events poller started — session=${sessionId} instance=${instanceId}`,
    );

    let offset = 0;

    for (let poll = 0; poll < MAX_POLLS; poll++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      try {
        const eventsResp = await fetch(
          `${baseUrl}/agent/events/${sessionId}`,
          {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(10_000),
          },
        );

        if (!eventsResp.ok) continue;

        const data = await eventsResp.json() as {
          ok: boolean;
          events: Array<{
            ts: string;
            mono: number;
            event: string;
            turn?: number;
            session_id?: string;
            data?: Record<string, unknown>;
          }>;
          next_offset: number;
          active: boolean;
        };

        // Process only new events (beyond our current offset)
        const newEvents = data.events.slice(offset);

        if (newEvents.length > 0) {
          const stmt = db.prepare(`
            INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp, event_type, event_meta)
            VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET content = excluded.content, timestamp = excluded.timestamp,
              event_type = excluded.event_type, event_meta = excluded.event_meta
          `);

          for (let i = 0; i < newEvents.length; i++) {
            const evt = newEvents[i];
            const globalIdx = offset + i;
            const evtId = `veri-poll-${instanceId}-${globalIdx}`;
            const ts = evt.ts; // Use Veri-side timestamp for chronological order

            let eventType: string;
            let content: string;
            let meta: Record<string, unknown> = {};

            switch (evt.event) {
              case 'assistant_thought':
                eventType = 'thought';
                content = String(evt.data?.text ?? '').slice(0, 4000);
                meta = { turn: evt.turn };
                break;
              case 'tool_call':
                eventType = 'tool_call';
                content = String(evt.data?.tool ?? 'unknown');
                meta = {
                  turn: evt.turn,
                  name: evt.data?.tool,
                  args: evt.data?.args_summary,
                };
                break;
              case 'tool_result':
                eventType = 'tool_result';
                content = String(evt.data?.output_summary ?? '').slice(0, 4000);
                meta = {
                  turn: evt.turn,
                  name: evt.data?.tool,
                  output: evt.data?.output_summary,
                  duration_ms: evt.data?.duration_ms,
                };
                break;
              case 'turn_started':
                eventType = 'turn_start';
                content = '';
                meta = { turn: evt.turn };
                break;
              case 'session_started':
                eventType = 'system';
                content = 'Veri agent session started';
                break;
              case 'session_done':
                eventType = 'system';
                content = 'Veri agent session completed';
                meta = evt.data ?? {};
                break;
              case 'micro_checkpoint':
                eventType = 'system';
                content = String(evt.data?.summary ?? 'checkpoint');
                meta = { turn: evt.turn };
                break;
              default:
                // Skip unknown event types
                continue;
            }

            stmt.run(
              evtId,
              agentId,
              instanceId,
              content,
              ts,
              eventType,
              JSON.stringify(meta),
            );
          }

          offset = data.events.length;
          console.log(
            `[VeriAgentRuntime] Events poller: persisted ${newEvents.length} events ` +
            `(offset=${offset}) for session=${sessionId}`,
          );
        }

        // Stop polling when the session is no longer active
        if (!data.active) {
          console.log(
            `[VeriAgentRuntime] Events poller: session ${sessionId} ended — ` +
            `total ${offset} events persisted for instance ${instanceId}`,
          );
          return;
        }
      } catch (err) {
        // Non-fatal — retry on next poll
        console.warn(
          `[VeriAgentRuntime] Events poller error:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    console.warn(
      `[VeriAgentRuntime] Events poller: max polls reached for session ${sessionId}`,
    );
  }

  /**
   * consumeStream — read the streaming response to completion, then execute
   * the full Atlas lifecycle contract based on the agent's output.
   *
   * Lifecycle steps:
   *   1. Stream consumption with periodic heartbeat check-ins
   *   2. Parse the assistant message for structured lifecycle data
   *   3. Record review evidence (branch/commit) if provided
   *   4. Post task outcome with correct semantics
   *   5. Complete the instance with structured metadata
   */
  private async consumeStream(
    body: ReadableStream<Uint8Array>,
    params: DispatchParams,
    runId: string,
    emitRuntimeEnd?: (event: RuntimeEndEvent) => Promise<void>,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    const heartbeatMs =
      this.config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

    // ── Step 2: Periodic heartbeats during streaming ─────────────────────────
    // Track the last meaningful event for descriptive heartbeat summaries
    let lastEventSummary = '';

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    if (params.instanceId && params.taskId && heartbeatMs > 0) {
      const heartbeatCtx: LifecycleContext = {
        instanceId: params.instanceId,
        taskId: params.taskId,
        sessionKey: params.sessionKey,
        changedBy: 'veri-forge',
      };
      heartbeatTimer = setInterval(() => {
        const summary = lastEventSummary
          || `Veri run ${runId} streaming — ${fullText.length} chars received`;
        proxyHeartbeat(heartbeatCtx, summary).catch(() => {
          // Swallow heartbeat errors — non-critical
        });
      }, heartbeatMs);
    }

    // Track parsed assistant content and structured events for real-time transcript streaming
    let assistantContent = '';
    let parsedEvents: SSEEvent[] = [];
    let lastFlushLen = 0;
    let lastEventFlushCount = 0;
    const FLUSH_INTERVAL_MS = 500; // flush transcript every 500ms
    const FLUSH_CHAR_THRESHOLD = 500; // or every 500 new chars
    let lastFlushTime = Date.now();

    // SSE line buffering: maintain a buffer of raw bytes to avoid parsing incomplete lines
    let lineBuffer = '';

    // Write the user prompt immediately so Chats tab shows it at run start
    this.persistUserPrompt(params, runId);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Decode the chunk and append to lineBuffer
        lineBuffer += decoder.decode(value, { stream: true });
        fullText += decoder.decode(value, { stream: false }); // for byte counting only

        // Split on newlines. All complete lines (all but the last) are ready for parsing.
        const lines = lineBuffer.split('\n');
        // The last element is incomplete (or empty if lineBuffer ended with \n) — keep it
        const lastElement = lines[lines.length - 1];
        const completeLines = lines.slice(0, -1);

        // Reconstruct complete lines into a string for parseSSEEvents
        const processedText = completeLines.join('\n') + (completeLines.length > 0 ? '\n' : '');

        // Parse ONLY complete lines (never mid-JSON)
        if (processedText) {
          const parsed = parseSSEEvents(processedText);
          assistantContent = parsed.assistantMessage;
          parsedEvents = parsed.events;

          // Update lastEventSummary from the most recent meaningful event
          for (let i = parsed.events.length - 1; i >= 0; i--) {
            const ev = parsed.events[i];
            if (ev.event_type === 'thought') {
              lastEventSummary = `Thinking: ${ev.content.slice(0, 100)}`;
              break;
            } else if (ev.event_type === 'tool_call') {
              const toolName = (ev.event_meta?.name as string) ?? ev.content;
              const argsStr = ev.event_meta?.args
                ? JSON.stringify(ev.event_meta.args).slice(0, 80)
                : '{}';
              lastEventSummary = `Calling tool: ${toolName} with ${argsStr}`;
              break;
            } else if (ev.event_type === 'tool_result') {
              const toolName = (ev.event_meta?.name as string) ?? 'unknown';
              const outputLen = ev.event_meta?.output
                ? String(ev.event_meta.output).length
                : ev.content.length;
              lastEventSummary = `Tool ${toolName} returned (${outputLen} chars)`;
              break;
            } else if (ev.event_type === 'turn_start') {
              const turn = ev.event_meta?.turn ?? '?';
              const maxTurns = ev.event_meta?.max_turns ?? '?';
              lastEventSummary = `Starting turn ${turn}/${maxTurns}`;
              break;
            }
          }

          // Flush transcript chunk to DB periodically for live visibility
          const now = Date.now();
          const newChars = assistantContent.length - lastFlushLen;
          const newEvents = parsedEvents.length - lastEventFlushCount;
          if (
            (newChars > 0 || newEvents > 0) &&
            (now - lastFlushTime >= FLUSH_INTERVAL_MS || newChars >= FLUSH_CHAR_THRESHOLD)
          ) {
            this.appendTranscriptChunk(params, assistantContent, runId, parsedEvents);
            lastFlushLen = assistantContent.length;
            lastEventFlushCount = parsedEvents.length;
            lastFlushTime = now;
          }
        }

        // Keep the incomplete last segment for the next iteration
        lineBuffer = lastElement;
      }

      // Handle any remaining content in lineBuffer at stream end
      if (lineBuffer) {
        const parsed = parseSSEEvents(lineBuffer);
        if (parsed.assistantMessage) {
          assistantContent = parsed.assistantMessage;
          parsedEvents = parsed.events;
          this.appendTranscriptChunk(params, assistantContent, runId, parsedEvents);
        }
      }
    } catch (err) {
      console.warn(
        `[VeriAgentRuntime] Stream read error for run ${runId}:`,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      reader.releaseLock();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }

    console.log(
      `[VeriAgentRuntime] Run ${runId} stream completed — ` +
      `${fullText.length} chars received for session ${params.sessionKey}`,
    );

    // ── Steps 3-6: Post-stream lifecycle via shared proxy (task #470) ─────────
    // Use already-parsed content from the streaming loop (avoid re-parsing)
    const assistantMessage = assistantContent || parseSSEAssistantMessage(fullText);

    let lifecycleOutcome: string | undefined;
    if (params.instanceId != null && params.taskId != null) {
      const lifecycleCtx: LifecycleContext = {
        instanceId: params.instanceId,
        taskId: params.taskId,
        sessionKey: params.sessionKey,
        changedBy: 'veri-forge',
      };
      const lifecycleResult = await runPostStreamLifecycle(lifecycleCtx, assistantMessage);
      lifecycleOutcome = lifecycleResult.effectiveOutcome;
    }

    // Persist transcript messages to chat_messages for Chats tab visibility
    this.persistTranscript(params, assistantMessage, runId);

    if (emitRuntimeEnd) {
      await emitRuntimeEnd({
        type: 'runEnded',
        source: 'veri',
        sessionKey: params.sessionKey,
        runId,
        success: true,
        endedAt: new Date().toISOString(),
        reason: 'completed',
        metadata: {
          runtime_phase: 'stream',
          lifecycle_outcome: lifecycleOutcome ?? null,
        },
      });
    }
  }

  /**
   * appendTranscriptChunk — upsert the assistant message row with the latest
   * streamed content so the Chats tab shows a live-updating transcript.
   *
   * Uses INSERT OR REPLACE: if the row already exists it is replaced with the
   * full accumulated content (not just the delta). This avoids duplicating
   * message rows while keeping the content fresh.
   */
  private appendTranscriptChunk(
    params: DispatchParams,
    content: string,
    runId: string,
    events?: SSEEvent[],
  ): void {
    try {
      const db = getDb();

      let agentId: number | null = null;
      if (params.instanceId != null) {
        const row = db.prepare(`SELECT agent_id FROM job_instances WHERE id = ?`)
          .get(params.instanceId) as { agent_id: number } | undefined;
        agentId = row?.agent_id ?? null;
      }
      if (agentId == null) return;

      const instanceId = params.instanceId ?? 0;
      const now = new Date().toISOString();
      const msgId = `veri-asst-${instanceId}`;

      // Upsert the rolling assistant message (backward compat)
      db.prepare(`
        INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp, event_type, event_meta)
        VALUES (?, ?, ?, 'assistant', ?, ?, 'text', '{}')
        ON CONFLICT(id) DO UPDATE SET content = excluded.content, timestamp = excluded.timestamp
      `).run(msgId, agentId, instanceId, content, now);

      // Persist individual structured event rows (task #532)
      if (events && events.length > 0) {
        persistEventRows(db, agentId, instanceId, events);
      }
    } catch (err) {
      console.warn(
        `[VeriAgentRuntime] Failed to append transcript chunk for run ${runId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * persistUserPrompt — write the user prompt row at run start so the Chats
   * tab immediately shows what task was dispatched, before any response arrives.
   */
  private persistUserPrompt(
    params: DispatchParams,
    runId: string,
  ): void {
    try {
      const db = getDb();

      let agentId: number | null = null;
      if (params.instanceId != null) {
        const row = db.prepare(`SELECT agent_id FROM job_instances WHERE id = ?`)
          .get(params.instanceId) as { agent_id: number } | undefined;
        agentId = row?.agent_id ?? null;
      }
      if (agentId == null) return;

      const instanceId = params.instanceId ?? 0;
      const now = new Date().toISOString();

      db.prepare(`
        INSERT OR IGNORE INTO chat_messages (id, agent_id, instance_id, role, content, timestamp)
        VALUES (?, ?, ?, 'user', ?, ?)
      `).run(`veri-user-${instanceId}`, agentId, instanceId, params.message, now);

      console.log(`[VeriAgentRuntime] Run ${runId} — persisted user prompt at run start`);
    } catch (err) {
      console.warn(
        `[VeriAgentRuntime] Failed to persist user prompt for run ${runId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * persistTranscript — save the user prompt and assistant response to
   * the chat_messages table so the Chats tab can display Veri run transcripts.
   */
  private persistTranscript(
    params: DispatchParams,
    assistantMessage: string,
    runId: string,
  ): void {
    try {
      const db = getDb();

      // Look up the agent_id from the job instance
      let agentId: number | null = null;
      if (params.instanceId != null) {
        const row = db.prepare(`SELECT agent_id FROM job_instances WHERE id = ?`)
          .get(params.instanceId) as { agent_id: number } | undefined;
        agentId = row?.agent_id ?? null;
      }
      if (agentId == null) return;

      const instanceId = params.instanceId ?? 0;
      const now = new Date().toISOString();

      // Save the dispatched prompt as a "user" message
      db.prepare(`
        INSERT OR IGNORE INTO chat_messages (id, agent_id, instance_id, role, content, timestamp)
        VALUES (?, ?, ?, 'user', ?, ?)
      `).run(`veri-user-${instanceId}`, agentId, instanceId, params.message, now);

      // Save the final assistant response (upsert to replace any partial streaming content)
      if (assistantMessage) {
        db.prepare(`
          INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp)
          VALUES (?, ?, ?, 'assistant', ?, ?)
          ON CONFLICT(id) DO UPDATE SET content = excluded.content, timestamp = excluded.timestamp
        `).run(`veri-asst-${instanceId}`, agentId, instanceId, assistantMessage, now);
      }

      console.log(
        `[VeriAgentRuntime] Run ${runId} — persisted ${assistantMessage ? 2 : 1} transcript message(s)`,
      );
    } catch (err) {
      console.warn(
        `[VeriAgentRuntime] Failed to persist transcript for run ${runId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private persistRuntimeEndEvent(instanceId: number, event: RuntimeEndEvent): void {
    try {
      const db = getDb();
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
        `veri-runtime-end-${instanceId}`,
        `Runtime ${event.type} (${event.reason ?? (event.success ? 'completed' : 'error')})`,
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

      db.prepare(`
        UPDATE job_instances
        SET response = json_set(COALESCE(response, '{}'), '$.runtimeEnd', json(?))
        WHERE id = ?
      `).run(JSON.stringify(event), instanceId);
    } catch (err) {
      console.warn(
        `[VeriAgentRuntime] Failed to persist runtime end for instance ${instanceId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

// ── SSE Parsing ───────────────────────────────────────────────────────────────

/**
 * Structured event extracted from the SSE stream (task #532).
 *
 * Valid event_type values:
 *   'text' | 'thought' | 'tool_call' | 'tool_result' | 'turn_start' | 'system' | 'error'
 */
interface SSEEvent {
  event_type: 'text' | 'thought' | 'tool_call' | 'tool_result' | 'turn_start' | 'system' | 'error';
  content: string;
  event_meta: Record<string, unknown>;
}

/**
 * Parse an SSE stream body and extract ALL structured events (task #532).
 *
 * Returns both the concatenated assistant text (for backward compat) and
 * an array of structured SSEEvent objects for per-row persistence.
 *
 * Supports two formats:
 *
 * **Veri format** — events with `type` field:
 *   - `text_delta`  → event_type=text, content=delta content
 *   - `thought`     → event_type=thought, content=thought content
 *   - `tool_call`   → event_type=tool_call, content=tool name, meta={name, args}
 *   - `tool_result` → event_type=tool_result, content=output[:500], meta={name, output}
 *   - `turn_start`  → event_type=turn_start, content='', meta={turn, max_turns}
 *   - `done`        → event_type=text, content=final_text (authoritative)
 *
 * **OpenAI format** — events with `choices[0].delta.content`:
 *   - Append each delta content fragment as event_type=text
 */
function parseSSEEvents(raw: string): { assistantMessage: string; events: SSEEvent[] } {
  let accumulated = '';
  let finalText: string | null = null;
  const events: SSEEvent[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice('data:'.length).trim();
    if (payload === '[DONE]') break;
    try {
      const chunk = JSON.parse(payload) as {
        type?: string;
        content?: string;
        final_text?: string;
        name?: string;
        args?: unknown;
        output?: string;
        turn?: number;
        max_turns?: number;
        choices?: Array<{ delta?: { content?: string } }>;
      };

      // Veri format: text_delta events carry incremental content
      if (chunk.type === 'text_delta' && typeof chunk.content === 'string') {
        accumulated += chunk.content;
        events.push({ event_type: 'text', content: chunk.content, event_meta: {} });
        continue;
      }

      // Veri format: thought events
      if (chunk.type === 'thought' && typeof chunk.content === 'string') {
        events.push({ event_type: 'thought', content: chunk.content, event_meta: {} });
        continue;
      }

      // Veri format: tool_call events
      if (chunk.type === 'tool_call') {
        const toolName = chunk.name ?? chunk.content ?? 'unknown';
        events.push({
          event_type: 'tool_call',
          content: String(toolName),
          event_meta: { name: toolName, args: chunk.args ?? {} },
        });
        continue;
      }

      // Veri format: tool_result events
      if (chunk.type === 'tool_result') {
        const output = chunk.output ?? chunk.content ?? '';
        events.push({
          event_type: 'tool_result',
          content: String(output).slice(0, 500),
          event_meta: { name: chunk.name ?? 'unknown', output: String(output) },
        });
        continue;
      }

      // Veri format: turn_start events
      if (chunk.type === 'turn_start') {
        events.push({
          event_type: 'turn_start',
          content: '',
          event_meta: {
            turn: chunk.turn ?? null,
            max_turns: chunk.max_turns ?? null,
          },
        });
        continue;
      }

      // Veri format: done event carries the authoritative full text
      if (chunk.type === 'done' && typeof chunk.final_text === 'string') {
        finalText = chunk.final_text;
        continue;
      }

      // OpenAI format fallback: choices[0].delta.content
      const deltaContent = chunk.choices?.[0]?.delta?.content;
      if (deltaContent) {
        accumulated += deltaContent;
        events.push({ event_type: 'text', content: deltaContent, event_meta: {} });
      }
    } catch {
      // Skip malformed lines
    }
  }

  const assistantMessage = finalText ?? accumulated;
  return { assistantMessage, events };
}

/**
 * Parse an SSE stream body and concatenate all assistant content fragments.
 * Backward-compatible wrapper around parseSSEEvents.
 */
function parseSSEAssistantMessage(raw: string): string {
  return parseSSEEvents(raw).assistantMessage;
}

/**
 * Persist structured SSE events as individual chat_messages rows (task #532).
 *
 * Each event gets a stable ID: veri-evt-{instanceId}-{index} to allow
 * idempotent re-insertion if the stream is re-parsed.
 */
function persistEventRows(
  db: ReturnType<typeof getDb>,
  agentId: number,
  instanceId: number,
  events: SSEEvent[],
): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp, event_type, event_meta)
    VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET content = excluded.content, timestamp = excluded.timestamp,
      event_type = excluded.event_type, event_meta = excluded.event_meta
  `);

  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    stmt.run(
      `veri-evt-${instanceId}-${i}`,
      agentId,
      instanceId,
      evt.content,
      now,
      evt.event_type,
      JSON.stringify(evt.event_meta),
    );
  }
}

// ── Exported helpers for testing ─────────────────────────────────────────────

export { parseLifecycleData as _parseLifecycleData };
export { parseSSEAssistantMessage as _parseSSEAssistantMessage };
export { parseSSEEvents as _parseSSEEvents };
export type { SSEEvent as _SSEEvent };
