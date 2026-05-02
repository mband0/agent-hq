/**
 * runtimes/lifecycleProxy.ts — Shared lifecycle proxy for remote agent runtimes.
 *
 * Remote agent runtimes (Custom, Webhook with proxy mode, future runtimes) cannot
 * always make HTTP callbacks to Atlas HQ during execution. This module provides
 * a standard lifecycle proxy that Atlas calls on behalf of those agents.
 *
 * The proxy implements the same engineer lifecycle contract as local agents:
 *   1. PUT  /instances/:id/start           — mark instance running
 *   2. POST /instances/:id/check-in        — heartbeat / progress / blocker
 *   3. PUT  /tasks/:id/review-evidence     — branch/commit/URL from agent output
 *   4. POST /tasks/:id/outcome             — parsed from agent structured output
 *   5. PUT  /instances/:id/complete         — after outcome is posted
 *
 * Agents emit a structured JSON block (```atlas_lifecycle {...}```) at the end
 * of their response. The proxy parses this block for outcome, branch, commit,
 * summary, etc. and drives the Atlas lifecycle on their behalf.
 *
 * Task #470: Extracted from CustomAgentRuntime (task #464) to enable parity
 * across all remote runtimes.
 */

import { getAgentHqBaseUrl } from '../lib/agentHqBaseUrl';
import { getDb } from '../db/client';
import { resolveWorkflowLane } from '../services/contracts/workflowContract';

// ── Lifecycle data types ─────────────────────────────────────────────────────

/** Structured lifecycle data extracted from a remote agent's response. */
export interface AtlasLifecycleData {
  outcome?: string;
  summary?: string;
  branch?: string;
  commit?: string;
  review_url?: string;
  dev_url?: string;
  qa_verified_commit?: string;
  qa_tested_url?: string;
  merged_commit?: string;
  deployed_commit?: string;
  deploy_target?: string;
  deployed_at?: string;
  live_verified_by?: string;
  live_verified_at?: string;
  blocker_reason?: string;
  notes?: string;
}

/** Compatibility-only exported aliases kept for older runtime imports. */
export const VALID_IMPLEMENTATION_OUTCOMES = new Set(['completed_for_review', 'blocked', 'failed']);
export const VALID_QA_OUTCOMES = new Set(['qa_pass', 'qa_fail', 'blocked', 'failed']);
export const VALID_RELEASE_OUTCOMES = new Set(['deployed_live', 'live_verified', 'blocked', 'failed']);
export const ALL_VALID_OUTCOMES = new Set([
  ...VALID_IMPLEMENTATION_OUTCOMES,
  ...VALID_QA_OUTCOMES,
  ...VALID_RELEASE_OUTCOMES,
  'approved_for_merge',
]);

const COMPATIBILITY_FALLBACK_OUTCOMES = ['completed_for_review', 'qa_pass', 'qa_fail', 'approved_for_merge', 'deployed_live', 'live_verified', 'blocked', 'failed'];

interface ResolvedLifecycleOutcomeSet {
  validOutcomes: Set<string>;
  suggestedOutcome: string;
}

function resolveAllowedLifecycleOutcomes(taskId: number): ResolvedLifecycleOutcomeSet {
  try {
    const db = getDb();
    const task = db.prepare(`
      SELECT t.status, t.task_type, t.sprint_id, s.sprint_type
      FROM tasks t
      LEFT JOIN sprints s ON s.id = t.sprint_id
      WHERE t.id = ?
      LIMIT 1
    `).get(taskId) as {
      status: string | null;
      task_type: string | null;
      sprint_id: number | null;
      sprint_type: string | null;
    } | undefined;

    if (!task?.status) {
      return {
        validOutcomes: new Set(COMPATIBILITY_FALLBACK_OUTCOMES),
        suggestedOutcome: 'blocked',
      };
    }

    const resolved = resolveWorkflowLane({
      taskStatus: task.status,
      taskType: task.task_type,
      sprintId: task.sprint_id,
      sprintType: task.sprint_type,
      db,
    });

    if (resolved.validOutcomes.length > 0) {
      return {
        validOutcomes: new Set(resolved.validOutcomes),
        suggestedOutcome: resolved.suggestedOutcome,
      };
    }
  } catch {
    // Fall back to compatibility defaults below.
  }

  return {
    validOutcomes: new Set(COMPATIBILITY_FALLBACK_OUTCOMES),
    suggestedOutcome: 'blocked',
  };
}

// ── Lifecycle context ────────────────────────────────────────────────────────

/** Context required for lifecycle proxy calls. */
export interface LifecycleContext {
  instanceId: number;
  taskId: number;
  sessionKey: string;
  /** Agent identifier for changed_by / author fields (e.g. 'veri-forge', 'webhook-agent'). */
  changedBy: string;
}

// ── Lifecycle proxy config ───────────────────────────────────────────────────

export interface LifecycleProxyConfig {
  /** Agent HQ API base URL. Prefer agentHqBaseUrl; atlasBaseUrl remains as a legacy alias. */
  agentHqBaseUrl?: string;
  atlasBaseUrl?: string;
}

// ── Lifecycle result ─────────────────────────────────────────────────────────

export interface LifecycleResult {
  /** The lifecycle data parsed from the agent output (null if not found). */
  lifecycleData: AtlasLifecycleData | null;
  /** The effective outcome that was applied. */
  effectiveOutcome: string;
  /** The effective summary that was applied. */
  effectiveSummary: string;
  /** Whether review evidence was recorded. */
  evidenceRecorded: boolean;
  /** Whether the outcome was posted successfully. */
  outcomePosted: boolean;
  /** Whether the instance was completed. */
  instanceCompleted: boolean;
}

// ── Atlas API helper ─────────────────────────────────────────────────────────

function getAtlasBaseUrl(config?: LifecycleProxyConfig): string {
  return (
    config?.agentHqBaseUrl ??
    config?.atlasBaseUrl ??
    getAgentHqBaseUrl()
  );
}

/**
 * Safe Atlas HQ API call with error logging (never throws).
 */
export async function atlasCall(
  method: string,
  path: string,
  body: Record<string, unknown>,
  label: string,
  config?: LifecycleProxyConfig,
): Promise<{ ok: boolean; status?: number; body?: unknown }> {
  const baseUrl = getAtlasBaseUrl(config);
  try {
    const resp = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.warn(`[LifecycleProxy] ${label} returned ${resp.status}: ${text.slice(0, 300)}`);
      return { ok: false, status: resp.status };
    }
    const result = await resp.json().catch(() => ({}));
    console.log(`[LifecycleProxy] ${label} succeeded`);
    return { ok: true, status: resp.status, body: result };
  } catch (err) {
    console.error(
      `[LifecycleProxy] ${label} failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false };
  }
}

// ── Lifecycle data parsing ───────────────────────────────────────────────────

/**
 * parseLifecycleData — Parse a remote agent's response for a structured
 * atlas_lifecycle JSON block.
 *
 * Looks for (in order):
 *   1. Fenced code block: ```atlas_lifecycle\n{ ... }\n```
 *   2. JSON block with atlas_lifecycle key
 *   3. Any JSON object with an "outcome" field near the end of the text
 *
 * Returns null if no lifecycle data is found.
 */
export function parseLifecycleData(text: string): AtlasLifecycleData | null {
  // Strategy 1: Fenced code block with atlas_lifecycle tag
  const fencedMatch = text.match(
    /```atlas_lifecycle\s*\n([\s\S]*?)\n\s*```/,
  );
  if (fencedMatch) {
    try {
      const data = JSON.parse(fencedMatch[1].trim()) as AtlasLifecycleData;
      if (data && typeof data === 'object') return data;
    } catch {
      // Malformed JSON in fenced block — try other strategies
    }
  }

  // Strategy 2: Look for JSON block with atlas_lifecycle key
  const jsonBlockMatch = text.match(
    /\{[^{}]*"atlas_lifecycle"\s*:\s*(\{[\s\S]*?\})[^{}]*\}/,
  );
  if (jsonBlockMatch) {
    try {
      const data = JSON.parse(jsonBlockMatch[1].trim()) as AtlasLifecycleData;
      if (data && typeof data === 'object') return data;
    } catch {
      // Continue to fallback
    }
  }

  // Strategy 3: Look for any JSON object with an "outcome" field near the end
  // (search the last 2000 chars to avoid false positives in task description)
  const tail = text.slice(-2000);
  const outcomeMatch = tail.match(
    /\{[^{}]*"outcome"\s*:\s*"[^"]+?"[^{}]*\}/g,
  );
  if (outcomeMatch) {
    // Use the last match (most likely the final output)
    const lastMatch = outcomeMatch[outcomeMatch.length - 1];
    try {
      const data = JSON.parse(lastMatch) as AtlasLifecycleData;
      if (data && typeof data === 'object' && data.outcome) return data;
    } catch {
      // No valid JSON found
    }
  }

  return null;
}

// ── Lifecycle prompt builder ─────────────────────────────────────────────────

/**
 * buildLifecycleSystemPromptSection — Returns a system prompt section that
 * instructs a remote agent to emit structured atlas_lifecycle output.
 *
 * Include this in the system prompt for any remote agent that relies on the
 * lifecycle proxy (i.e. agents that cannot make HTTP callbacks themselves).
 */
export function buildLifecycleSystemPromptSection(): string {
  return [
    'You operate as a first-class Atlas engineer — the same standard as local agent lanes.',
    '',
    'The atlas_lifecycle block is CRITICAL — the runtime parses it to:',
    '- Record evidence fields that are configured for the selected outcome',
    '- Report your task outcome to Atlas HQ',
    '- Close the run instance',
    '',
    'If blocked or failed, set the outcome field accordingly and explain why.',
    'Do NOT make HTTP calls to Atlas HQ — the runtime handles all lifecycle callbacks for you.',
    'Do NOT use `openclaw system event` commands — this command is not available in your runtime environment.',
    '',
    'Environment:',
    '- You are a remote agent. Do not assume localhost URLs (e.g. localhost:3510/3511) are reachable from your host.',
    '- If a dev_url is configured or useful for review, use a URL that is externally reachable by the reviewer.',
    '',
    'Security:',
    '- Never hardcode credentials, tokens, or secrets in code, commits, or output.',
    '- Reference environment variables or .env files for sensitive configuration.',
  ].join('\n');
}

/**
 * buildLifecycleUserPromptSection — Returns a user prompt section that
 * instructs a remote agent to emit structured atlas_lifecycle output.
 *
 * Append this to the task message for any remote agent that relies on the
 * lifecycle proxy. Includes the JSON schema and field reference.
 *
 * Does NOT embed any hardcoded localhost URLs — dev environment reachability
 * is runtime-specific and must not be assumed for remote agents.
 */
export function buildLifecycleUserPromptSection(): string {
  return [
    '## Atlas HQ Lifecycle (handled by runtime)',
    `The runtime will make lifecycle callbacks on your behalf. You do NOT need to make HTTP calls.`,
    `Instead, emit a structured JSON block at the END of your response with your results.`,
    ``,
    `### Environment note`,
    `Do NOT assume any Atlas HQ or dev environment is reachable at localhost from your host.`,
    `The runtime handles all outbound lifecycle calls — you only emit the atlas_lifecycle block.`,
    `If you deploy a service or API for QA verification, use a URL that is externally reachable`,
    `(e.g. a tunnel, your agent's public hostname, or another environment the reviewer can reach).`,
    ``,
    `### Required: Emit lifecycle output`,
    `At the end of your response, include a fenced code block tagged \`atlas_lifecycle\`:`,
    ``,
    '```atlas_lifecycle',
    `{`,
    `  "outcome": "<valid outcome key for this task lane>",`,
    `  "summary": "One sentence describing what was done",`,
    `  "branch": "feature/branch-name if configured/needed",`,
    `  "commit": "abc1234... if configured/needed",`,
    `  "review_url": "https://github.com/<owner>/<repo>/tree/feature/branch-name if configured/needed",`,
    `  "dev_url": "https://<your-reachable-dev-endpoint>/relevant-path if useful for review",`,
    `  "notes": "Optional reviewer notes"`,
    `}`,
    '```',
    ``,
    `### Valid outcomes:`,
    `- Use the valid configured outcome keys for this task's current lane and sprint workflow`,
    `- The runtime will reject unconfigured or invalid outcome keys truthfully`,
    `- Include \`blocker_reason\` when using a blocked outcome key, if one exists in the workflow`,
    ``,
    `### Field reference:`,
    `- \`outcome\` (required): a configured valid outcome key for this specific task/lane`,
    `- \`summary\` (required): one-sentence description of what was done or why blocked/failed`,
    `- Evidence fields are required only when configured by the active workflow gate rows. Do not infer required fields from lane names.`,
    `- \`branch\`: lifecycle alias for review_branch when configured or useful for review handoff`,
    `- \`commit\`: lifecycle alias for review_commit when configured or useful for review handoff`,
    `- \`review_url\`: non-production review artifact URL when configured or useful for review handoff`,
    `- \`dev_url\` (recommended): externally reachable URL for QA to verify the work`,
    `- \`blocker_reason\` (optional): specific reason for blocker outcome`,
    `- \`notes\` (optional): additional context for the reviewer`,
    ``,
    `If you cannot emit the lifecycle block (e.g. task analysis only), the runtime will default to \`blocked\` — you MUST emit the block to complete successfully.`,
  ].join('\n');
}

// ── Individual lifecycle operations ──────────────────────────────────────────

/**
 * proxyStart — Call PUT /instances/:id/start on behalf of a remote agent.
 */
export async function proxyStart(
  ctx: LifecycleContext,
  config?: LifecycleProxyConfig,
): Promise<boolean> {
  const result = await atlasCall(
    'PUT',
    `/api/v1/instances/${ctx.instanceId}/start`,
    { session_key: ctx.sessionKey },
    `Start instance #${ctx.instanceId}`,
    config,
  );
  return result.ok;
}

/**
 * proxyHeartbeat — POST /instances/:id/check-in (heartbeat stage).
 */
export async function proxyHeartbeat(
  ctx: LifecycleContext,
  summary: string,
  config?: LifecycleProxyConfig,
): Promise<boolean> {
  const result = await atlasCall(
    'POST',
    `/api/v1/instances/${ctx.instanceId}/check-in`,
    {
      stage: 'heartbeat',
      summary,
      session_key: ctx.sessionKey,
    },
    `Heartbeat for instance #${ctx.instanceId}`,
    config,
  );
  return result.ok;
}

/**
 * proxyProgress — POST /instances/:id/check-in (progress stage).
 */
export async function proxyProgress(
  ctx: LifecycleContext,
  summary: string,
  config?: LifecycleProxyConfig,
): Promise<boolean> {
  const result = await atlasCall(
    'POST',
    `/api/v1/instances/${ctx.instanceId}/check-in`,
    {
      stage: 'progress',
      summary,
      session_key: ctx.sessionKey,
      meaningful_output: true,
    },
    `Progress check-in for instance #${ctx.instanceId}`,
    config,
  );
  return result.ok;
}

/**
 * proxyBlocker — POST /instances/:id/check-in (blocker stage).
 */
export async function proxyBlocker(
  ctx: LifecycleContext,
  summary: string,
  blockerReason: string,
  config?: LifecycleProxyConfig,
): Promise<boolean> {
  const result = await atlasCall(
    'POST',
    `/api/v1/instances/${ctx.instanceId}/check-in`,
    {
      stage: 'blocker',
      summary,
      blocker_reason: blockerReason,
      session_key: ctx.sessionKey,
      meaningful_output: true,
    },
    `Blocker check-in for instance #${ctx.instanceId}`,
    config,
  );
  return result.ok;
}

/**
 * proxyReviewEvidence — PUT /tasks/:id/review-evidence.
 */
export async function proxyReviewEvidence(
  ctx: LifecycleContext,
  evidence: {
    branch?: string | null;
    commit?: string | null;
    reviewUrl?: string | null;
    devUrl?: string | null;
    notes?: string | null;
  },
  config?: LifecycleProxyConfig,
): Promise<boolean> {
  const body: Record<string, unknown> = {};
  if (evidence.branch) body.review_branch = evidence.branch;
  if (evidence.commit) body.review_commit = evidence.commit;
  if (evidence.reviewUrl) body.review_url = evidence.reviewUrl;
  if (evidence.devUrl) body.dev_url = evidence.devUrl;
  if (evidence.notes) body.summary = evidence.notes;

  const result = await atlasCall(
    'PUT',
    `/api/v1/tasks/${ctx.taskId}/review-evidence`,
    body,
    `Review evidence for task #${ctx.taskId}`,
    config,
  );
  return result.ok;
}

/**
 * proxyOutcome — POST /tasks/:id/outcome.
 */
export async function proxyOutcome(
  ctx: LifecycleContext,
  outcome: string,
  summary: string,
  blockerReason?: string | null,
  config?: LifecycleProxyConfig,
  lifecycle?: AtlasLifecycleData | null,
): Promise<boolean> {
  const body: Record<string, unknown> = {
    outcome,
    summary,
    changed_by: ctx.changedBy,
    instance_id: ctx.instanceId,
  };
  if (lifecycle?.branch) body.review_branch = lifecycle.branch;
  if (lifecycle?.commit) body.review_commit = lifecycle.commit;
  if (lifecycle?.review_url) body.review_url = lifecycle.review_url;
  if (lifecycle?.qa_verified_commit) body.qa_verified_commit = lifecycle.qa_verified_commit;
  if (lifecycle?.qa_tested_url) body.qa_tested_url = lifecycle.qa_tested_url;
  if (lifecycle?.merged_commit) body.merged_commit = lifecycle.merged_commit;
  if (lifecycle?.deployed_commit) body.deployed_commit = lifecycle.deployed_commit;
  if (lifecycle?.deploy_target) body.deploy_target = lifecycle.deploy_target;
  if (lifecycle?.deployed_at) body.deployed_at = lifecycle.deployed_at;
  if (lifecycle?.live_verified_by) body.live_verified_by = lifecycle.live_verified_by;
  if (lifecycle?.live_verified_at) body.live_verified_at = lifecycle.live_verified_at;
  if (outcome === 'blocked' && blockerReason) {
    body.blocker_reason = blockerReason;
  }

  const result = await atlasCall(
    'POST',
    `/api/v1/tasks/${ctx.taskId}/outcome`,
    body,
    `Outcome (${outcome}) for task #${ctx.taskId}`,
    config,
  );
  return result.ok;
}

/**
 * proxyComplete — PUT /instances/:id/complete.
 */
export async function proxyComplete(
  ctx: LifecycleContext,
  outcome: string,
  summary: string,
  config?: LifecycleProxyConfig,
): Promise<boolean> {
  const instanceStatus = outcome === 'failed' ? 'failed' : 'done';

  const result = await atlasCall(
    'PUT',
    `/api/v1/instances/${ctx.instanceId}/complete`,
    {
      status: instanceStatus,
      summary,
      outcome,
    },
    `Complete instance #${ctx.instanceId}`,
    config,
  );
  return result.ok;
}

// ── Full post-stream lifecycle ───────────────────────────────────────────────

/**
 * runPostStreamLifecycle — Execute the full Atlas lifecycle after a remote
 * agent completes its response.
 *
 * Steps:
 *   1. Parse the agent output for atlas_lifecycle data
 *   2. Send a progress check-in summarizing the parse result
 *   3. Derive effective outcome and summary
 *   4. Record review evidence (if outcome is completed_for_review and branch/commit present)
 *   5. Post task outcome
 *   6. Complete the instance
 *
 * This is the standard post-stream lifecycle for any remote runtime that uses
 * the lifecycle proxy. Individual runtimes should call this after consuming
 * the agent's response.
 */
export async function runPostStreamLifecycle(
  ctx: LifecycleContext,
  agentOutput: string,
  config?: LifecycleProxyConfig,
): Promise<LifecycleResult> {
  // Step 1: Parse lifecycle data
  const lifecycle = parseLifecycleData(agentOutput);

  // Step 2: Progress check-in
  await proxyProgress(
    ctx,
    lifecycle
      ? `Remote agent completed — parsed lifecycle data (outcome: ${lifecycle.outcome ?? 'unknown'})`
      : `Remote agent completed — no structured lifecycle block found, defaulting to blocked`,
    config,
  );

  // Step 3: Derive effective outcome and summary
  const allowedOutcomes = resolveAllowedLifecycleOutcomes(ctx.taskId);
  const effectiveOutcome =
    lifecycle?.outcome && allowedOutcomes.validOutcomes.has(lifecycle.outcome)
      ? lifecycle.outcome
      : allowedOutcomes.validOutcomes.has('blocked')
        ? 'blocked'
        : allowedOutcomes.suggestedOutcome;

  const effectiveSummary =
    lifecycle?.summary ||
    agentOutput.slice(0, 200) ||
    `Remote agent completed (no summary available)`;

  // Step 4: Record review evidence
  let evidenceRecorded = false;
  if (
    effectiveOutcome === 'completed_for_review' &&
    (lifecycle?.branch || lifecycle?.commit)
  ) {
    evidenceRecorded = await proxyReviewEvidence(
      ctx,
      {
        branch: lifecycle?.branch,
        commit: lifecycle?.commit,
        reviewUrl: lifecycle?.review_url,
        devUrl: lifecycle?.dev_url,
        notes: lifecycle?.notes,
      },
      config,
    );
  }

  // Step 5: Post task outcome
  const blockerReason = effectiveOutcome === 'blocked'
    ? (lifecycle?.blocker_reason ||
       (!lifecycle ? 'No atlas_lifecycle block found in agent output — agent may have failed to emit structured output' : undefined))
    : undefined;

  const outcomePosted = await proxyOutcome(
    ctx,
    effectiveOutcome,
    effectiveSummary,
    blockerReason,
    config,
    lifecycle,
  );

  // Step 6: Complete the instance
  const instanceCompleted = await proxyComplete(
    ctx,
    effectiveOutcome,
    effectiveSummary,
    config,
  );

  return {
    lifecycleData: lifecycle,
    effectiveOutcome,
    effectiveSummary,
    evidenceRecorded,
    outcomePosted,
    instanceCompleted,
  };
}
