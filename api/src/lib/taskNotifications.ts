/**
 * taskNotifications.ts — Task status-change Telegram notification layer
 *
 * Sends a Telegram notification whenever a task changes status.
 * Covers outcome-driven, user-driven, agent-driven, dispatcher-driven,
 * and cancel-driven transitions.
 *
 * Deduplication: An in-memory map tracks (taskId, fromStatus, toStatus)
 * with a short TTL so rapid duplicate calls (e.g. race conditions or
 * retries) don't produce duplicate messages.
 */

import type Database from 'better-sqlite3';
import { notifyTelegram } from '../integrations/telegram';

// ── Deduplication ─────────────────────────────────────────────────────────────

/** TTL (ms) within which an identical transition is considered a duplicate */
const DEDUP_TTL_MS = 5_000;

type DedupKey = string;
const recentTransitions = new Map<DedupKey, number>();

function buildDedupKey(taskId: number, fromStatus: string, toStatus: string): DedupKey {
  return `${taskId}:${fromStatus}→${toStatus}`;
}

function isDuplicate(taskId: number, fromStatus: string, toStatus: string): boolean {
  const key = buildDedupKey(taskId, fromStatus, toStatus);
  const last = recentTransitions.get(key);
  if (last != null && Date.now() - last < DEDUP_TTL_MS) return true;
  recentTransitions.set(key, Date.now());
  // Prune old entries to avoid unbounded growth
  if (recentTransitions.size > 500) {
    const cutoff = Date.now() - DEDUP_TTL_MS * 2;
    for (const [k, ts] of recentTransitions) {
      if (ts < cutoff) recentTransitions.delete(k);
    }
  }
  return false;
}

// ── Context lookup ────────────────────────────────────────────────────────────

interface TaskContext {
  id: number;
  title: string;
  projectName: string | null;
  sprintName: string | null;
}

function loadTaskContext(db: Database.Database, taskId: number): TaskContext | null {
  // Use a resilient query: first try with project/sprint JOIN, fall back to
  // title-only if those tables don't exist (e.g. in test environments).
  try {
    const row = db.prepare(`
      SELECT t.id, t.title, p.name as project_name, s.name as sprint_name
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN sprints  s ON s.id = t.sprint_id
      WHERE t.id = ?
    `).get(taskId) as { id: number; title: string; project_name: string | null; sprint_name: string | null } | undefined;

    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      projectName: row.project_name ?? null,
      sprintName: row.sprint_name ?? null,
    };
  } catch {
    // Fallback: minimal query without optional JOINs (e.g. test DBs missing projects/sprints tables)
    const row = db.prepare(`SELECT id, title FROM tasks WHERE id = ?`).get(taskId) as { id: number; title: string } | undefined;
    if (!row) return null;
    return { id: row.id, title: row.title, projectName: null, sprintName: null };
  }
}

// ── Status emoji map ──────────────────────────────────────────────────────────

function statusEmoji(status: string): string {
  const map: Record<string, string> = {
    todo:           '📋',
    ready:          '🔵',
    dispatched:     '📤',
    in_progress:    '🔨',
    review:         '🔍',
    qa_pass:        '✅',
    ready_to_merge: '🔀',
    deployed:       '🚀',
    done:           '🟢',
    stalled:        '⏸️',
    cancelled:      '🚫',
    failed:         '❌',
  };
  return map[status] ?? '⚙️';
}

// ── Message builder ───────────────────────────────────────────────────────────

function buildMessage(
  ctx: TaskContext,
  fromStatus: string,
  toStatus: string,
  source: string,
): string {
  const lines: string[] = [];

  lines.push(`${statusEmoji(toStatus)} <b>Task #${ctx.id} — Status Changed</b>`);
  lines.push(`<b>${escapeHtml(ctx.title)}</b>`);
  lines.push('');
  lines.push(`${statusEmoji(fromStatus)} <i>${fromStatus}</i>  →  ${statusEmoji(toStatus)} <b>${toStatus}</b>`);
  lines.push('');

  const meta: string[] = [];
  if (ctx.projectName) meta.push(`Project: ${escapeHtml(ctx.projectName)}`);
  if (ctx.sprintName) meta.push(`Sprint: ${escapeHtml(ctx.sprintName)}`);
  meta.push(`Source: ${escapeHtml(source)}`);

  lines.push(meta.join(' · '));

  return lines.join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface TaskStatusChangeEvent {
  taskId: number;
  fromStatus: string;
  toStatus: string;
  /** Human-readable source label: 'Atlas', 'agency-frontend', agent slug, 'reconciler', etc. */
  source?: string;
}

/**
 * Notify Telegram of a task status change.
 * No-ops silently on duplicates, missing task, or missing env vars.
 * Never throws — caller must not depend on outcome.
 */
export function notifyTaskStatusChange(
  db: Database.Database,
  event: TaskStatusChangeEvent,
): void {
  const { taskId, fromStatus, toStatus, source = 'system' } = event;

  // No-op if the status didn't actually change
  if (fromStatus === toStatus) return;

  // Deduplication check
  if (isDuplicate(taskId, fromStatus, toStatus)) return;

  // Fire-and-forget: load context + send
  try {
    const ctx = loadTaskContext(db, taskId);
    if (!ctx) return;

    const message = buildMessage(ctx, fromStatus, toStatus, source);
    notifyTelegram(message).catch((err) => {
      console.error('[taskNotifications] notifyTelegram error:', err);
    });
  } catch (err) {
    console.error('[taskNotifications] Unexpected error building notification:', err);
  }
}
