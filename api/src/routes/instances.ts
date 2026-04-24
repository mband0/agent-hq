import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDb } from '../db/client';
import { normalizeStopBehavior } from '../lib/instanceStop';
import { recordRunCheckIn } from '../lib/runObservability';
import { writeTaskRuntimeEndHistory, writeTaskStatusChange } from '../lib/taskHistory';
import { notifyTaskStatusChange } from '../lib/taskNotifications';
import { normalizeTokenUsage } from '../lib/tokenUsage';
import { isNeedsAttentionEligibleStatus } from '../lib/reconcilerConfig';
import { removeTaskWorktree } from '../services/worktreeManager';
import { createAgentContext, destroyAgentContext } from '../services/browserPool';
import { stopInstanceExecution } from '../lib/stopInstanceExecution';

import { NODE_BIN_DIR, OPENCLAW_BIN } from '../config';
import { resolveTranscriptProvider } from '../lib/transcriptProvider';
import { ensureCanonicalSessionForInstance, upsertCanonicalSessionForInstance } from '../lib/canonicalSessions';
import { buildGatewayRunSessionKey, parseHookSessionKey, resolveRuntimeAgentSlug } from '../lib/sessionKeys';
const NODE_BIN = NODE_BIN_DIR;
const CRON_RUNS_DIR = path.join(os.homedir(), '.openclaw', 'cron', 'runs');

const router = Router();

function markTaskNeedsAttentionForMissingSemanticHandoff(
  db: ReturnType<typeof getDb>,
  taskId: number | null | undefined,
  changedBy: string,
  summary?: string | null,
  runtimeEnd?: { source?: string | null; success?: boolean | null; endedAt?: string | null; error?: string | null },
) {
  if (!taskId) return false;

  const task = db.prepare(`SELECT id, title, status FROM tasks WHERE id = ?`).get(taskId) as
    | { id: number; title: string; status: string }
    | undefined;
  if (!task) return false;
  if (['done', 'cancelled', 'failed', 'needs_attention'].includes(task.status)) return false;
  if (!isNeedsAttentionEligibleStatus(db, task.status)) return false;

  db.prepare(`
    UPDATE tasks
    SET status = 'needs_attention',
        previous_status = COALESCE(previous_status, status),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(taskId);
  writeTaskStatusChange(db, taskId, changedBy, task.status, 'needs_attention');
  notifyTaskStatusChange(db, { taskId, fromStatus: task.status, toStatus: 'needs_attention', source: changedBy });

  writeTaskRuntimeEndHistory(db, taskId, changedBy, {
    endedAt: runtimeEnd?.endedAt,
    success: runtimeEnd?.success ?? null,
    source: runtimeEnd?.source ?? null,
    error: runtimeEnd?.error ?? null,
    lifecycleHandoff: 'missing_after_runtime_end',
  });

  const noteLines = [
    'Moved to Needs Attention because the runtime ended without a semantic lifecycle outcome.',
    'Lifecycle handoff: missing after runtime end',
  ];
  if (runtimeEnd?.source) noteLines.push(`Runtime end source: ${runtimeEnd.source}`);
  if (runtimeEnd?.success !== undefined && runtimeEnd?.success !== null) noteLines.push(`Runtime end success: ${runtimeEnd.success ? 'yes' : 'no'}`);
  if (runtimeEnd?.endedAt) noteLines.push(`Runtime ended at: ${runtimeEnd.endedAt}`);
  if (runtimeEnd?.error) noteLines.push(`Runtime end error: ${runtimeEnd.error}`);
  if (summary) noteLines.push(`Runtime summary: ${summary}`);

  db.prepare(`INSERT INTO task_notes (task_id, author, content) VALUES (?, ?, ?)`).run(taskId, changedBy, noteLines.join('\n'));
  return true;
}

// PUT /api/v1/instances/:id/start
// Called by agents at the beginning of a job run to register their session key
router.put('/:id/start', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const { session_key } = req.body as { session_key?: string };

    const instance = db.prepare('SELECT * FROM job_instances WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    recordRunCheckIn(db, {
      instanceId: id,
      stage: 'start',
      sessionKey: session_key ?? null,
      summary: 'Agent session started',
      statusLabel: 'running',
      forceNote: true,
    });

    if (session_key) {
      db.prepare(`
        INSERT INTO logs (instance_id, agent_id, job_title, level, message)
        VALUES (?, ?, ?, 'info', ?)
      `).run(id, instance.agent_id, instance.agent_id, `Agent started — session key: ${session_key}`);
    }

    // Auto-create an isolated browser context for this agent run.
    // This is best-effort — if the browser pool fails (e.g. Chromium not installed),
    // the task can still proceed without browser capabilities.
    const agentRow = db.prepare(`
      SELECT a.session_key as agent_session_key, a.openclaw_agent_id, a.name
      FROM job_instances ji
      JOIN agents a ON a.id = ji.agent_id
      WHERE ji.id = ?
    `).get(id) as {
      agent_session_key: string | null;
      openclaw_agent_id: string | null;
      name: string | null;
    } | undefined;
    const agentSlug = resolveRuntimeAgentSlug({
      session_key: agentRow?.agent_session_key ?? null,
      openclaw_agent_id: agentRow?.openclaw_agent_id ?? null,
      name: agentRow?.name ?? null,
    });
    if (agentSlug) {
      createAgentContext(agentSlug, id).catch(err => {
        console.warn(`[instances] Browser context creation failed for instance ${id} (non-fatal):`, err instanceof Error ? err.message : err);
      });
    }

    upsertCanonicalSessionForInstance(db, id, session_key ?? null);

    console.log(`[instances] Instance ${id} started — session: ${session_key ?? 'unknown'}`);
    return res.json({ ok: true, id, session_key });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// POST /api/v1/instances/:id/check-in
// Called by agents during a run to mirror progress into Atlas HQ
router.post('/:id/check-in', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const instance = db.prepare('SELECT * FROM job_instances WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    const {
      stage = 'heartbeat',
      summary,
      commit_hash,
      branch_name,
      changed_files,
      changed_files_count,
      blocker_reason,
      outcome,
      session_key,
      meaningful_output,
      token_input,
      token_output,
      token_total,
      usage,
    } = req.body as {
      stage?: 'heartbeat' | 'progress' | 'blocker' | 'completion';
      summary?: string;
      commit_hash?: string;
      branch_name?: string;
      changed_files?: string[];
      changed_files_count?: number;
      blocker_reason?: string;
      outcome?: string;
      session_key?: string;
      meaningful_output?: boolean;
      token_input?: number;
      token_output?: number;
      token_total?: number;
      usage?: unknown;
    };

    const tokenUsage = normalizeTokenUsage(
      { input_tokens: token_input, output_tokens: token_output, total_tokens: token_total },
      usage,
      req.body,
      instance.response ? (() => { try { return JSON.parse(String(instance.response)); } catch { return null; } })() : null,
    );

    if (tokenUsage.input !== null || tokenUsage.output !== null || tokenUsage.total !== null) {
      db.prepare(`
        UPDATE job_instances
        SET token_input = COALESCE(?, token_input),
            token_output = COALESCE(?, token_output),
            token_total = COALESCE(?, token_total)
        WHERE id = ?
      `).run(tokenUsage.input, tokenUsage.output, tokenUsage.total, id);
    }

    const result = recordRunCheckIn(db, {
      instanceId: id,
      stage,
      sessionKey: session_key ?? null,
      summary: summary ?? null,
      commitHash: commit_hash ?? null,
      branchName: branch_name ?? null,
      changedFiles: Array.isArray(changed_files) ? changed_files : null,
      changedFilesCount: typeof changed_files_count === 'number' ? changed_files_count : null,
      blockerReason: blocker_reason ?? null,
      outcome: outcome ?? null,
      meaningfulOutput: meaningful_output ?? (stage === 'progress' || Boolean(summary || commit_hash || branch_name || (Array.isArray(changed_files) && changed_files.length > 0) || blocker_reason)),
    });

    db.prepare(`
      INSERT INTO logs (instance_id, agent_id, job_title, level, message)
      VALUES (?, ?, ?, 'info', ?)
    `).run(id, instance.agent_id, instance.agent_id, `Agent check-in received (${stage})${summary ? ` — ${summary}` : ''}`);

    upsertCanonicalSessionForInstance(db, id, session_key ?? null);

    return res.json({ ok: true, id, task_id: result.taskId, note_created: result.noteCreated });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// PUT /api/v1/instances/:id/complete
// Called by agents when they finish a job run
router.put('/:id/complete', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const { status = 'done', summary, commit_hash, branch_name, changed_files, changed_files_count, outcome, token_input, token_output, token_total, usage } = req.body as {
      status?: string;
      summary?: string;
      commit_hash?: string;
      branch_name?: string;
      changed_files?: string[];
      changed_files_count?: number;
      outcome?: string;
      token_input?: number;
      token_output?: number;
      token_total?: number;
      usage?: unknown;
    };

    const instance = db.prepare('SELECT * FROM job_instances WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    const finalStatus = ['done', 'failed'].includes(status) ? status : 'done';
    const runtimeEndedWithoutLifecycleOutcome = finalStatus === 'done' && !instance.lifecycle_outcome_posted_at;
    const persistedStatus = runtimeEndedWithoutLifecycleOutcome ? 'done' : finalStatus;
    const runtimeEndError = finalStatus === 'failed'
      ? (summary ?? 'Runtime reported failed terminal state')
      : null;

    const tokenUsage = normalizeTokenUsage(
      { input_tokens: token_input, output_tokens: token_output, total_tokens: token_total },
      usage,
      req.body,
      instance.response ? (() => { try { return JSON.parse(String(instance.response)); } catch { return null; } })() : null,
    );

    db.prepare(`
      UPDATE job_instances
      SET status = ?,
          completed_at = datetime('now'),
          runtime_ended_at = COALESCE(runtime_ended_at, datetime('now')),
          runtime_end_success = COALESCE(runtime_end_success, ?),
          runtime_end_error = COALESCE(runtime_end_error, ?),
          runtime_end_source = COALESCE(runtime_end_source, 'instance_complete'),
          token_input = COALESCE(?, token_input),
          token_output = COALESCE(?, token_output),
          token_total = COALESCE(?, token_total)
      WHERE id = ?
    `).run(
      runtimeEndedWithoutLifecycleOutcome ? 'done' : finalStatus,
      finalStatus === 'done' ? 1 : 0,
      runtimeEndError,
      tokenUsage.input,
      tokenUsage.output,
      tokenUsage.total,
      id,
    );

    recordRunCheckIn(db, {
      instanceId: id,
      stage: 'completion',
      summary: summary ?? null,
      commitHash: commit_hash ?? null,
      branchName: branch_name ?? null,
      changedFiles: Array.isArray(changed_files) ? changed_files : null,
      changedFilesCount: typeof changed_files_count === 'number' ? changed_files_count : null,
      outcome: outcome ?? finalStatus,
      meaningfulOutput: true,
      statusLabel: persistedStatus,
      forceNote: true,
      runtimeEndSuccess: finalStatus === 'done',
      runtimeEndError,
      runtimeEndSource: 'instance_complete',
    });

    if (finalStatus === 'done' && instance.task_id && !instance.lifecycle_outcome_posted_at) {
      markTaskNeedsAttentionForMissingSemanticHandoff(
        db,
        Number(instance.task_id),
        instance.agent_id ? `agent:${instance.agent_id}` : 'system',
        summary ?? null,
        {
          source: 'instance_complete',
          success: true,
          endedAt: new Date().toISOString(),
          error: null,
        },
      );
    }

    if (summary) {
      db.prepare(`
        INSERT INTO logs (instance_id, agent_id, job_title, level, message)
        VALUES (?, ?, ?, 'info', ?)
      `).run(id, instance.agent_id, instance.agent_id, `Agent completion report: ${summary}`);
    }

    db.prepare(`
      INSERT INTO logs (instance_id, agent_id, job_title, level, message)
      VALUES (?, ?, ?, 'info', ?)
    `).run(id, instance.agent_id, instance.agent_id, `Job instance ${id} marked ${finalStatus} via agent callback`);

    // Auto-destroy the browser context tied to this instance.
    // Best-effort — if there's no context, destroyAgentContext is a no-op.
    const completedAgentRow = db.prepare(`
      SELECT a.session_key as agent_session_key, a.openclaw_agent_id, a.name
      FROM job_instances ji
      JOIN agents a ON a.id = ji.agent_id
      WHERE ji.id = ?
    `).get(id) as {
      agent_session_key: string | null;
      openclaw_agent_id: string | null;
      name: string | null;
    } | undefined;
    const completedAgentSlug = resolveRuntimeAgentSlug({
      session_key: completedAgentRow?.agent_session_key ?? null,
      openclaw_agent_id: completedAgentRow?.openclaw_agent_id ?? null,
      name: completedAgentRow?.name ?? null,
    });
    if (completedAgentSlug) {
      destroyAgentContext(completedAgentSlug, id).catch(err => {
        console.warn(`[instances] Browser context cleanup failed for instance ${id} (non-fatal):`, err instanceof Error ? err.message : err);
      });
    }

    console.log(`[instances] Instance ${id} marked ${finalStatus}${summary ? ` — ${summary}` : ''}`);

    // Worktree cleanup (task #365) — remove the isolated worktree after completion.
    // Non-blocking: errors are logged but don't fail the completion response.
    const worktreePath = instance.worktree_path as string | null;
    if (worktreePath) {
      setImmediate(() => {
        try {
          // Look up repo_path from the agent directly
          const agentRow = db.prepare(`
            SELECT a.repo_path
            FROM agents a
            WHERE a.id = ?
          `).get(instance.agent_id) as { repo_path: string | null } | undefined;

          if (agentRow?.repo_path) {
            const result = removeTaskWorktree({
              repoPath: agentRow.repo_path,
              worktreePath,
            });
            if (result.removed) {
              console.log(`[instances] Cleaned up worktree: ${worktreePath}`);
            } else {
              console.warn(`[instances] Failed to clean up worktree ${worktreePath}: ${result.error}`);
            }
          }
        } catch (wtErr) {
          console.warn(`[instances] Worktree cleanup error for instance ${id}:`, wtErr);
        }
      });
    }

    upsertCanonicalSessionForInstance(db, id, instance.session_key as string | null);

    return res.json({ ok: true, id, status: finalStatus });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/instances/:id/session-key
// Resolves the real session key for a cron-dispatched job by reading the cron run JSONL
router.get('/:id/session-key', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);

    const instance = db.prepare('SELECT * FROM job_instances WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    const agentId = instance.agent_id as number | null;
    const storedKey = instance.session_key as string | null;

    // If the stored key already has the full agent-prefixed hook format, return it directly
    if (storedKey && storedKey.startsWith('agent:') && parseHookSessionKey(storedKey)) {
      return res.json({ sessionKey: storedKey, source: 'instance', agentId });
    }

    // Legacy: stored key is the short "hook:atlas:jobrun:<id>" format (missing agent prefix).
    // Reconstruct the full key by looking up the agent slug from the job template.
    const hook = parseHookSessionKey(storedKey);
    if (hook) {
      const agentRow = db.prepare(`
        SELECT a.session_key as agent_session_key, a.openclaw_agent_id, a.name
        FROM job_instances ji
        JOIN agents a ON a.id = ji.agent_id
        WHERE ji.id = ?
      `).get(id) as {
        agent_session_key: string | null;
        openclaw_agent_id: string | null;
        name: string | null;
      } | undefined;

      const fullKey = buildGatewayRunSessionKey({
        session_key: agentRow?.agent_session_key ?? null,
        openclaw_agent_id: agentRow?.openclaw_agent_id ?? null,
        name: agentRow?.name ?? null,
      }, hook.shortKey);
      if (fullKey) {
        return res.json({ sessionKey: fullKey, source: 'instance-reconstructed' , agentId });
      }
      return res.json({ sessionKey: storedKey, source: 'instance' , agentId });
    }

    // If instance already has a session_key with :run: in it, return it directly
    if (storedKey && storedKey.includes(':run:')) {
      return res.json({ sessionKey: storedKey, source: 'instance' , agentId });
    }

    // Extract the cron job ID from the response field
    const responseStr = instance.response as string | null;
    let cronJobId: string | null = null;
    if (responseStr) {
      try {
        const parsed = JSON.parse(responseStr) as { jobId?: string };
        cronJobId = parsed.jobId ?? null;
      } catch { /* ignore */ }
    }

    if (!cronJobId) {
      // Try from payload_sent
      const payloadStr = instance.payload_sent as string | null;
      if (payloadStr) {
        try {
          const payload = JSON.parse(payloadStr) as { args?: string[] };
          // The job ID might be the cron job name
        } catch { /* ignore */ }
      }
      // Fall back to stored session_key
      if (storedKey) {
        // Try to extract jobId from session_key like agent:main:cron:{jobId}
        const match = storedKey.match(/cron:([a-f0-9-]+)/);
        if (match) cronJobId = match[1];
      }
    }

    if (!cronJobId) {
      return res.json({ sessionKey: storedKey, source: 'fallback' , agentId });
    }

    // Read the cron run JSONL file
    const runFile = path.join(CRON_RUNS_DIR, `${cronJobId}.jsonl`);
    if (!fs.existsSync(runFile)) {
      return res.json({ sessionKey: storedKey, source: 'fallback', note: 'cron run file not found' , agentId });
    }

    const content = fs.readFileSync(runFile, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { sessionKey?: string; sessionId?: string };
        if (event.sessionKey) {
          // Treat the first confirmed cron-run session key as a trustworthy start signal.
          // This keeps dispatch acceptance separate from actual agent startup, while still
          // allowing Atlas to recover if the agent missed the explicit /start callback.
          recordRunCheckIn(db, {
            instanceId: id,
            stage: 'start',
            sessionKey: event.sessionKey,
            summary: 'Agent session confirmed from cron run event',
            statusLabel: 'running',
          });

          return res.json({ sessionKey: event.sessionKey, source: 'cron-run', cronJobId , agentId });
        }
      } catch { /* skip malformed lines */ }
    }

    return res.json({ sessionKey: storedKey, source: 'fallback', note: 'no sessionKey in cron run' , agentId });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/instances/:id/transcript
// Serves transcript data for job runs via the transcript provider abstraction (task #471).
// The provider is resolved based on the agent's runtime_type:
//   - openclaw  → local chat_messages or gateway
//   - claude-code → .claude/projects JSONL files (fallback: chat_messages)
//   - veri      → chat_messages populated by VeriAgentRuntime (fallback: remote API)
router.get('/:id/transcript', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const provider = resolveTranscriptProvider(id);
    const result = await provider.getTranscript(id);

    await ensureCanonicalSessionForInstance(id);

    if (result.messages.length === 0 && !result.in_progress) {
      return res.status(404).json({
        error: 'No transcript available for this instance',
        hint: `Provider: ${provider.name}. If this run is still in progress, check back after it finishes.`,
      });
    }

    // Transform to the wire format the UI expects:
    //   { type: role, event_type, event_meta, message: { content } }
    const messages = result.messages.map(m => ({
      id: m.id,
      type: m.role,
      event_type: m.event_type ?? 'text',
      event_meta: m.event_meta ?? {},
      timestamp: m.timestamp,
      message: {
        content: m.role === 'assistant'
          ? [{ type: 'text', text: m.content }]
          : m.content,
      },
    }));

    return res.json({
      sessionKey: result.sessionKey,
      source: result.source,
      provider: provider.name,
      messages,
      ...(result.in_progress ? { in_progress: true } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// PUT /api/v1/instances/:id/stop
// Kills the running job, clears task linkage, and applies an explicit stop behavior.
// Default behavior is `park` to prevent immediate redispatch loops.
router.put('/:id/stop', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const body = (req.body ?? {}) as { behavior?: unknown; mode?: unknown; action?: unknown };
    // Manual stops (no explicit behavior specified) should not alter task status.
    // Default to 'stop' so the task remains in its current state; callers who want
    // to cancel ('park') or re-queue ('requeue') must pass an explicit behavior.
    const rawBehavior = body.behavior ?? body.mode ?? body.action;
    const behavior = rawBehavior !== undefined ? normalizeStopBehavior(rawBehavior) : 'stop';

    const instance = db.prepare(`
      SELECT ji.*, a.session_key AS agent_session_key, a.runtime_type, a.runtime_config
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id
      WHERE ji.id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    const status = instance.status as string;
    if (status === 'done' || status === 'failed') {
      return res.status(409).json({
        ok: false,
        code: 'already_finished',
        error: `Instance is already ${status}`,
        result: 'already_finished',
        id,
        behavior,
        instanceStatus: status,
        message: `Run already finished (${status}).`,
      });
    }

    const stopResult = await stopInstanceExecution(db, id, behavior);
    console.log(`[instances] Instance ${id} stopped (authoritative) — behavior=${behavior} abortOk=${stopResult.abortOk ?? !stopResult.sessionKey} abortStatus=${stopResult.abortStatus ?? 'not-attempted'} runtimeUncertain=${stopResult.runtimeUncertain} cronRemoved=${stopResult.cronRemoved}`);
    return res.json({
      ok: true,
      ...stopResult,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
