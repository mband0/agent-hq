/**
 * dispatcher.ts — Deterministic task dispatcher service
 *
 * Selects the best candidate task for each enabled job and fires
 * an isolated agent turn via the AgentRuntime interface. Each job instance
 * gets its own session, distinct from the agent's main session.
 *
 * The runtime backend (OpenClaw, Claude Code, etc.) is resolved per-agent
 * via resolveRuntime(). The dispatcher no longer imports OpenClaw-specific
 * functions directly.
 *
 * Call runDispatcher(db, projectId?) after runEligibilityPass()
 * so blocker/lifecycle state is current before selecting explicit ready tasks.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { notifyTaskStatusChange } from '../lib/taskNotifications';
import { writeTaskStatusChange } from '../lib/taskHistory';
import { resolveRuntime } from '../runtimes';
import { createTaskWorktree } from './worktreeManager';
import {
  OPENCLAW_CONFIG_PATH as OPENCLAW_CONFIG_PATH_DISPATCHER,
  OPENCLAW_GATEWAY_URL,
} from '../config';
import {
  resolveGitHubIdentity,
  injectGitHubCredentials,
  cleanupGitHubCredentials,
  buildGitHubIdentityContext,
} from '../lib/githubIdentity';
import {
  buildContractInstructions,
  resolveTransportMode,
  resolveWorkflowLane,
  PM_TASK_TYPES as PM_TASK_TYPES_CONTRACT,
  type TransportContext,
} from './contracts';
import { getSkillMaterializationAdapter } from '../runtimes/skillMaterialization';
import { syncAssignedMcpForAgent } from '../runtimes/mcpMaterialization';
import { getDb } from '../db/client';
import { getAgentHqBaseUrl } from '../lib/agentHqBaseUrl';
import { buildHookSessionKey, resolveRuntimeAgentSlug } from '../lib/sessionKeys';

// ── Dispatch failure backoff (task #355) ─────────────────────────────────────
//
// When a dispatch attempt fails (gateway down, Anthropic overloaded, etc.),
// the dispatcher sets dispatched_at = now on the task and increments retry_count
// before resetting it back to its eligible status. This creates a cooldown window
// during which the reconciler's next tick(s) will NOT re-dispatch the task.
//
// The backoff duration (seconds) is read from the DISPATCH_FAILURE_BACKOFF_SECONDS
// env var or falls back to 120s (2 minutes). This means after a failure the task
// won't be re-dispatched for at least 2 minutes — enough to survive short outages
// without spinning, while still recovering quickly when the gateway comes back up.
//
// Admins can tune this at runtime by setting DISPATCH_FAILURE_BACKOFF_SECONDS
// before restarting the API, or by adjusting the system_policies threshold for
// 'dispatch_failure_backoff' (future: read from DB).
export const DISPATCH_FAILURE_BACKOFF_SECONDS: number =
  parseInt(process.env.DISPATCH_FAILURE_BACKOFF_SECONDS ?? '120', 10) || 120;

// ── Container routing config (task #288) ─────────────────────────────────────
// Used by hooksFetch() when an agent has hooks_url set (container routing).
const GATEWAY_URL = OPENCLAW_GATEWAY_URL;

function readDispatcherGatewayToken(): string | null {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH_DISPATCHER, 'utf-8');
    const cfg = JSON.parse(raw) as { gateway?: { auth?: { token?: string } } };
    const token = cfg.gateway?.auth?.token;
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

const HOOKS_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN ?? readDispatcherGatewayToken() ?? '';

function gatewayFetch(hookPath: string, init: RequestInit): Promise<Response> {
  const url = `${GATEWAY_URL}${hookPath}`;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  return fetch(url, init);
}
// ── End container routing config ─────────────────────────────────────────────

/**
 * hooksFetch — send a /hooks/agent request to the correct OpenClaw instance.
 *
 * If the agent has a hooks_url (e.g. "http://localhost:3701" for a containerised
 * instance), POST there; otherwise fall back to the host gateway via gatewayFetch.
 *
 * Container instances run plain HTTP on a custom port, so no TLS override needed.
 * The host gateway uses HTTPS with a self-signed cert, so we keep the TLS bypass
 * for that path.
 */
function hooksFetch(agentHooksUrl: string | null | undefined, hookPath: string, init: RequestInit): Promise<Response> {
  if (agentHooksUrl) {
    // Container instance — plain HTTP, no TLS concerns
    const url = `${agentHooksUrl}${hookPath}`;
    return fetch(url, init);
  }
  // Default: host gateway (may be HTTPS with self-signed cert)
  return gatewayFetch(hookPath, init);
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface DispatchResult {
  dispatched: number;
  skipped: number;
  errors: string[];
}

interface JobRow {
  id: number;
  title: string;
  agent_id: number;
  project_id: number | null;
  pre_instructions: string;
  enabled: number;
  timeout_seconds: number;
  agent_session_key: string;
  agent_name: string;
  /** Model override for this job (from agents.model). */
  model?: string | null;
  /** Agent-level model (aliased as agent_model for precedence fallback). */
  agent_model?: string | null;
  /** Runtime columns from agents table — used by resolveRuntime() */
  runtime_type?: string | null;
  runtime_config?: unknown;
  /** Container OpenClaw URL, e.g. "http://localhost:3701". Null = host gateway. */
  agent_hooks_url?: string | null;
  /** Per-agent Authorization header for hooks_url dispatch (task #431). */
  agent_hooks_auth_header?: string | null;
  /** Agent workspace directory — used by generateClaudeMd() for claude-code dispatches. */
  workspace_path?: string | null;
  /** Stable OpenClaw runtime slug, preserved even if Agent HQ session_key is canonicalized. */
  openclaw_agent_id?: string | null;
  /** JSON array of skill names assigned to this job — used by generateClaudeMd(). */
  skill_names?: string | null;
  /** Preferred AI provider for model routing (e.g. 'anthropic', 'openai'). */
  preferred_provider?: string | null;
  /** Canonical git repo path for worktree isolation (task #365). */
  repo_path?: string | null;
  /** Dedicated macOS OS user for filesystem isolation (task #377). */
  os_user?: string | null;
}

function slugFromSessionKey(sessionKey: string | null | undefined, fallbackName?: string | null): string | null {
  return resolveRuntimeAgentSlug({
    session_key: sessionKey,
    name: fallbackName ?? null,
  });
}

interface CandidateTask {
  id: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  agent_id: number | null;
  project_id: number | null;
  task_type: string | null;
  sprint_id: number | null;
  sprint_name: string | null;
  sprint_type: string | null;
  created_at: string;
  blocking_count: number;
  story_points: number | null;
}

// ── Story-point model routing ─────────────────────────────────────────────────

interface StoryPointRoutingRule {
  max_points: number;
  model: string;
  max_turns: number | null;
  max_budget_usd: number | null;
  label: string | null;
}

interface ResolvedStoryPointModel {
  model: string;
  max_turns: number | null;
  max_budget_usd: number | null;
  label: string | null;
}

/**
 * resolveModelFromStoryPoints — look up the story_point_model_routing table and
 * return the model (and optional max_turns / max_budget_usd overrides) for the
 * given story_points value and preferred_provider.
 *
 * Precedence rule (highest wins):
 *   1. Row where max_points >= story_points AND provider = preferred_provider
 *      (provider-specific rule for this agent's preferred provider)
 *   2. Row where max_points >= story_points AND provider IS NULL
 *      (provider-agnostic catch-all rule)
 *
 * Within each tier, the rule with the smallest max_points that still covers the
 * story_points value is selected (ORDER BY max_points ASC), which ensures the
 * most targeted/cheapest model is chosen (e.g. haiku for 2pt tasks, not opus).
 *
 * Returns null if story_points is null/unset or no rule matches.
 */
export function resolveModelFromStoryPoints(
  db: Database.Database,
  story_points: number | null | undefined,
  preferred_provider?: string | null,
): ResolvedStoryPointModel | null {
  if (story_points == null) return null;

  try {
    const provider = preferred_provider ?? null;

    // Single query: provider-specific rules win over NULL-provider rules.
    // ORDER BY max_points ASC (smallest bucket that covers the points),
    // then provider match first (CASE: 0 if matching, 1 if NULL).
    const row = db.prepare(`
      SELECT max_points, model, max_turns, max_budget_usd, label
      FROM story_point_model_routing
      WHERE max_points >= ?
        AND (provider = ? OR provider IS NULL)
      ORDER BY max_points ASC,
               CASE WHEN provider = ? THEN 0 ELSE 1 END ASC
      LIMIT 1
    `).get(story_points, provider, provider) as StoryPointRoutingRule | undefined;

    if (row) {
      return {
        model: row.model,
        max_turns: row.max_turns ?? null,
        max_budget_usd: row.max_budget_usd ?? null,
        label: row.label ?? null,
      };
    }
  } catch {
    // Table may not exist in older DBs — degrade gracefully
  }

  return null;
}

/**
 * RoutingRuleRow — a sprint_task_routing_rules row joined with the agent.
 * The `agent_id` field maps directly to the agents table.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RoutingRuleRow = any; // joined rule+job+agent; accessed by field name below

// ── Priority map ─────────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

// ── Routing config helpers ───────────────────────────────────────────────────

interface DispatcherRoutingConfig {
  sort_rules: string[];
}

/**
 * getAgentRoutingConfig — reads routing config from agents table.
 * Task #596: routing_config_legacy has been removed; agents table is the sole source.
 */
function getAgentRoutingConfig(db: Database.Database, agentId: number): DispatcherRoutingConfig {
  const agentRow = db.prepare(
    `SELECT sort_rules FROM agents WHERE id = ?`
  ).get(agentId) as { sort_rules: string } | undefined;

  if (agentRow) {
    let sort_rules: string[] = [];
    try {
      const parsed = JSON.parse(agentRow.sort_rules || '[]');
      sort_rules = Array.isArray(parsed) ? parsed : [];
    } catch {
      sort_rules = [];
    }
    return { sort_rules };
  }

  return { sort_rules: [] };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hasActiveInstance(db: Database.Database, agentId: number): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) as n
    FROM job_instances
    WHERE agent_id = ?
      AND status IN ('queued', 'dispatched', 'running')
  `).get(agentId) as { n: number };
  return row.n > 0;
}

function hasTaskLiveInstance(db: Database.Database, taskId: number): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) as n
    FROM job_instances
    WHERE task_id = ?
      AND status IN ('queued', 'dispatched', 'running')
  `).get(taskId) as { n: number };
  return row.n > 0;
}

function deriveDispatchTaskStatus(currentStatus: string): string {
  if (currentStatus === 'ready') return 'dispatched';
  return currentStatus;
}

function deriveDispatchFailureFallbackStatus(currentStatus: string): string {
  if (currentStatus === 'ready') return 'ready';
  if (currentStatus === 'review') return 'review';
  if (currentStatus === 'ready_to_merge') return 'ready_to_merge';
  return currentStatus;
}

function tableHasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return cols.some(col => col.name === columnName);
  } catch {
    return false;
  }
}

function getCandidates(db: Database.Database, agentId: number, _templateId: number | null, projectId: number | null): CandidateTask[] {
  const ownershipClause = 't.agent_id = ?';
  const ownershipParams: unknown[] = [agentId];

  let sql = `
    SELECT t.id, t.title, t.description, t.status, t.priority,
           t.agent_id, t.project_id, t.task_type, t.sprint_id, s.name as sprint_name, s.sprint_type,
           t.created_at, t.story_points,
           (
             SELECT COUNT(*)
             FROM task_dependencies td2
             WHERE td2.blocker_id = t.id
               AND (SELECT t2.status FROM tasks t2 WHERE t2.id = td2.blocked_id) != 'done'
           ) as blocking_count
    FROM tasks t
    LEFT JOIN sprints s ON s.id = t.sprint_id
    WHERE t.status IN ('ready', 'ready_to_merge', 'in_progress')
      AND ${ownershipClause}
      AND (
        t.dispatched_at IS NULL
        OR t.dispatched_at < datetime('now', '-${DISPATCH_FAILURE_BACKOFF_SECONDS} seconds')
      )
  `;
  const params: unknown[] = [...ownershipParams];

  if (projectId != null) {
    sql += ` AND t.project_id = ?`;
    params.push(projectId);
  }

  // Exclude tasks in paused/completed/closed sprints
  sql += `
    AND (t.sprint_id IS NULL OR EXISTS (
      SELECT 1 FROM sprints sp WHERE sp.id = t.sprint_id AND sp.status = 'active'
    ))
  `;

  // Exclude manually paused tasks (Task #660)
  sql += `
    AND t.paused_at IS NULL
  `;

  // Exclude tasks with unresolved blockers (safety net)
  sql += `
    AND NOT EXISTS (
      SELECT 1
      FROM task_dependencies td
      INNER JOIN tasks blocker ON blocker.id = td.blocker_id
      WHERE td.blocked_id = t.id
        AND blocker.status != 'done'
    )
  `;

  return db.prepare(sql).all(...params) as CandidateTask[];
}

/**
 * getAllDispatchableTasks — returns all tasks across all projects (or a single
 * project) that are ready to dispatch, ordered by priority then creation time.
 * Used by the task-first routing path.
 *
 * Dispatch failure backoff (task #355): tasks with a recent dispatched_at value
 * (set by the failure handler) are excluded until DISPATCH_FAILURE_BACKOFF_SECONDS
 * have elapsed, preventing a spin-loop when the gateway/API is down.
 */
function getAllDispatchableTasks(db: Database.Database, projectId?: number | null): CandidateTask[] {
  let sql = `
    SELECT t.id, t.title, t.description, t.status, t.priority,
           t.agent_id, t.project_id, t.task_type, t.sprint_id, s.name as sprint_name, s.sprint_type,
           t.created_at, t.story_points,
           (
             SELECT COUNT(*)
             FROM task_dependencies td2
             WHERE td2.blocker_id = t.id
               AND (SELECT t2.status FROM tasks t2 WHERE t2.id = td2.blocked_id) != 'done'
           ) as blocking_count
    FROM tasks t
    LEFT JOIN sprints s ON s.id = t.sprint_id
    WHERE t.status IN ('ready', 'ready_to_merge', 'in_progress')
      AND t.active_instance_id IS NULL
      AND t.paused_at IS NULL
      AND (
        t.dispatched_at IS NULL
        OR t.dispatched_at < datetime('now', '-${DISPATCH_FAILURE_BACKOFF_SECONDS} seconds')
      )
      AND (t.sprint_id IS NULL OR EXISTS (
        SELECT 1 FROM sprints sp WHERE sp.id = t.sprint_id AND sp.status = 'active'
      ))
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies td
        INNER JOIN tasks blocker ON blocker.id = td.blocker_id
        WHERE td.blocked_id = t.id AND blocker.status != 'done'
      )
  `;
  const params: unknown[] = [];
  if (projectId != null) {
    sql += ` AND t.project_id = ?`;
    params.push(projectId);
  }
  sql += `
    ORDER BY
      CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC,
      t.created_at ASC
  `;
  return db.prepare(sql).all(...params) as CandidateTask[];
}

/**
 * getMatchingRoutingRules — returns sprint routing rules that match a task's
 * sprint_id/status/task_type, ordered by priority DESC so the highest-priority
 * rule is tried first. Each row includes full agent fields for dispatch.
 */
function getMatchingRoutingRules(db: Database.Database, task: CandidateTask): RoutingRuleRow[] {
  const runRuleQuery = (tableName: string, scopeCondition: string, params: unknown[]): RoutingRuleRow[] => db.prepare(`
      SELECT rr.*,
             a.id as agent_id, a.job_title as job_title,
             a.pre_instructions, a.enabled, a.timeout_seconds, a.model,
             a.skill_names,
             a.session_key as agent_session_key, a.name as agent_name, a.model as agent_model,
             a.openclaw_agent_id, a.runtime_type, a.runtime_config, a.hooks_url as agent_hooks_url,
             a.hooks_auth_header as agent_hooks_auth_header,
             a.workspace_path, a.preferred_provider, a.repo_path, a.os_user
      FROM ${tableName} rr
      JOIN agents a ON a.id = rr.agent_id AND a.enabled = 1
      WHERE ${scopeCondition}
        AND rr.status = ?
        AND (rr.task_type = ? OR rr.task_type IS NULL)
      ORDER BY rr.priority DESC, rr.id ASC
    `).all(...params, task.status, task.task_type ?? null) as RoutingRuleRow[];

  if (task.sprint_id) {
    try {
      const sprintRules = runRuleQuery('sprint_task_routing_rules', 'rr.sprint_id = ?', [task.sprint_id]);
      if (sprintRules.length > 0) return sprintRules;
    } catch {
      // sprint-scoped tables may not exist in minimal test DBs; fall through
    }
  }

  if (task.status === 'in_progress' && task.sprint_id) {
    try {
      const sprintFallback = db.prepare(`
        SELECT rr.*,
               a.id as agent_id, a.job_title as job_title,
               a.pre_instructions, a.enabled, a.timeout_seconds, a.model,
               a.skill_names,
               a.session_key as agent_session_key, a.name as agent_name, a.model as agent_model,
               a.openclaw_agent_id, a.runtime_type, a.runtime_config, a.hooks_url as agent_hooks_url,
               a.hooks_auth_header as agent_hooks_auth_header,
               a.workspace_path, a.preferred_provider, a.repo_path, a.os_user
        FROM sprint_task_routing_rules rr
        JOIN agents a ON a.id = rr.agent_id AND a.enabled = 1
        WHERE rr.sprint_id = ?
          AND rr.status = 'ready'
          AND (rr.task_type = ? OR rr.task_type IS NULL)
        ORDER BY rr.priority DESC, rr.id ASC
      `).all(task.sprint_id, task.task_type ?? null) as RoutingRuleRow[];
      if (sprintFallback.length > 0) return sprintFallback;
    } catch {
      // sprint-scoped tables may not exist in minimal test DBs
    }
  }

  return [];
}

/**
 * sortCandidates — sorts tasks using the provided sort_rules array.
 *
 * Supported rules (applied in order):
 *   "priority_desc"  → high > medium > low
 *   "blocking_first" → tasks blocking more others come first
 *   "oldest_first"   → earliest created_at first
 *   "newest_first"   → latest created_at first
 *
 * If sort_rules is empty/null, falls back to default order:
 *   priority_desc → blocking_first → oldest_first
 */
function sortCandidates(candidates: CandidateTask[], sortRules?: string[]): CandidateTask[] {
  // Use defaults if no sort_rules configured
  const rules: string[] =
    sortRules && sortRules.length > 0
      ? sortRules
      : ['priority_desc', 'blocking_first', 'oldest_first'];

  return [...candidates].sort((a, b) => {
    for (const rule of rules) {
      switch (rule) {
        case 'priority_desc': {
          const pa = PRIORITY_ORDER[a.priority] ?? 0;
          const pb = PRIORITY_ORDER[b.priority] ?? 0;
          if (pb !== pa) return pb - pa;
          break;
        }
        case 'blocking_first': {
          if (b.blocking_count !== a.blocking_count) return b.blocking_count - a.blocking_count;
          break;
        }
        case 'oldest_first': {
          const cmp = a.created_at.localeCompare(b.created_at);
          if (cmp !== 0) return cmp;
          break;
        }
        case 'newest_first': {
          const cmp = b.created_at.localeCompare(a.created_at);
          if (cmp !== 0) return cmp;
          break;
        }
        default:
          // Unknown rule — skip
          break;
      }
    }
    return 0;
  });
}

// ── Message builder ──────────────────────────────────────────────────────────

export function buildTaskMessage(
  job: { pre_instructions: string; title: string },
  task: {
    id: number;
    title: string;
    description: string;
    priority: string;
    status: string;
    sprint_name: string | null;
  }
): string {
  const taskBlock = [
    `## Assigned Task`,
    `Task #${task.id}: ${task.title}`,
    `Priority: ${task.priority} | Sprint: ${task.sprint_name ?? 'none'}`,
    ``,
    task.description,
  ].join('\n');

  return `${job.pre_instructions}\n\n${taskBlock}`;
}

interface DispatchTaskNoteRow {
  created_at: string;
  author: string;
  content: string;
}

interface DispatchTaskNotesContext {
  firstRun: boolean;
  cutoff: string | null;
  totalNotes: number;
  includedNotes: DispatchTaskNoteRow[];
  truncated: boolean;
}

const DISPATCH_TASK_NOTES_CHAR_CAP = 12_000;

function formatDispatchTaskNote(note: DispatchTaskNoteRow): string {
  const content = String(note.content ?? '')
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n');
  return `- [${note.created_at}] ${note.author}\n${content}`;
}

export function getDispatchTaskNotesContext(
  db: Database.Database,
  params: { taskId: number; agentId: number; currentInstanceId: number },
): DispatchTaskNotesContext {
  const priorInstance = db.prepare(`
    SELECT created_at
    FROM job_instances
    WHERE task_id = ?
      AND agent_id = ?
      AND id != ?
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 1
  `).get(params.taskId, params.agentId, params.currentInstanceId) as { created_at: string } | undefined;

  const firstRun = !priorInstance?.created_at;
  const cutoff = priorInstance?.created_at ?? null;

  const notes = (cutoff
    ? db.prepare(`
        SELECT created_at, author, content
        FROM task_notes
        WHERE task_id = ?
          AND created_at >= ?
        ORDER BY datetime(created_at) ASC, id ASC
      `).all(params.taskId, cutoff)
    : db.prepare(`
        SELECT created_at, author, content
        FROM task_notes
        WHERE task_id = ?
        ORDER BY datetime(created_at) ASC, id ASC
      `).all(params.taskId)) as DispatchTaskNoteRow[];

  let totalChars = 0;
  const selected: DispatchTaskNoteRow[] = [];
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    const rendered = formatDispatchTaskNote(notes[i]);
    const renderedLen = rendered.length + 2;
    if (selected.length > 0 && totalChars + renderedLen > DISPATCH_TASK_NOTES_CHAR_CAP) break;
    selected.push(notes[i]);
    totalChars += renderedLen;
  }

  selected.reverse();

  return {
    firstRun,
    cutoff,
    totalNotes: notes.length,
    includedNotes: selected,
    truncated: selected.length < notes.length,
  };
}

export function buildDispatchTaskNotesSection(context: DispatchTaskNotesContext): string {
  if (context.totalNotes === 0) return '';

  const title = context.firstRun
    ? '## Existing Task Notes'
    : '## Task Notes Since Your Last Run';
  const lines: string[] = [title];

  if (context.truncated) {
    lines.push(
      `NOTE: Task notes were truncated to stay within the dispatch size cap. Showing ${context.includedNotes.length} of ${context.totalNotes} note(s), keeping the most recent notes in chronological order.`
    );
  }

  lines.push(
    `[Dispatch note context: first_run=${context.firstRun ? 'yes' : 'no'} | notes_included=${context.includedNotes.length}/${context.totalNotes} | cutoff=${context.cutoff ?? 'none'}]`,
    '',
    ...context.includedNotes.map(formatDispatchTaskNote),
  );

  return lines.join('\n');
}

interface InstanceCallbackContractInput {
  instanceId: number;
  taskId: number;
  taskStatus: string;
  /** Task type (e.g. 'pm', 'pm_analysis', 'pm_operational', 'backend', 'qa'). Used to select the correct terminal outcome. */
  taskType?: string | null;
  sprintType?: string | null;
  agentSlug: string;
  sessionKey: string;
  /** Base URL for callback curl examples. Defaults to Agent HQ base URL env vars (localhost). */
  baseUrl?: string;
  /** Transport mode override — determined by resolveTransportMode() when not specified. */
  transportMode?: 'local' | 'remote-direct' | 'proxy-managed';
}

// ── Agent contract file path ─────────────────────────────────────────────────
// __dirname at runtime = api/dist/services → 3 levels up = repo root
const AGENT_CONTRACT_PATH = process.env.AGENT_CONTRACT_PATH
  ?? path.resolve(__dirname, '../../../agent-contract.md');

/**
 * buildContractFromFile — reads agent-contract.md and interpolates placeholders.
 * Returns null if the file is missing (caller falls back to hardcoded string).
 */
function buildContractFromFile(vars: {
  instanceId: number;
  taskId: number;
  taskStatus: string;
  agentSlug: string;
  sessionKey: string;
  suggestedOutcome: string;
  validOutcomes: string[];
  outcomeHelp: string[];
  baseUrl: string;
}): string | null {
  try {
    if (!fs.existsSync(AGENT_CONTRACT_PATH)) return null;
    let template = fs.readFileSync(AGENT_CONTRACT_PATH, 'utf-8');
    template = template
      .replace(/\{\{baseUrl\}\}/g, vars.baseUrl)
      .replace(/\{\{instanceId\}\}/g, String(vars.instanceId))
      .replace(/\{\{taskId\}\}/g, String(vars.taskId))
      .replace(/\{\{sessionKey\}\}/g, vars.sessionKey)
      .replace(/\{\{agentSlug\}\}/g, vars.agentSlug)
      .replace(/\{\{suggestedOutcome\}\}/g, vars.suggestedOutcome)
      .replace(/\{\{validOutcomes\}\}/g, vars.validOutcomes.join(', '))
      .replace(/\{\{outcomeHelp\}\}/g, vars.outcomeHelp.join('\n'))
      .replace(/\{\{taskStatus\}\}/g, vars.taskStatus);
    return template;
  } catch {
    return null;
  }
}

/**
 * buildInstanceCallbackContract — build the full dispatch contract for an instance.
 *
 * Delegates to the contracts/ module (task #632) which separates shared
 * workflow semantics from runtime-specific transport. The transportMode
 * parameter determines whether the agent gets:
 *   - local: curl commands with localhost URLs + pm2/npm deploy instructions
 *   - remote-direct: HTTP endpoints with the configured base URL (no local commands)
 *   - proxy-managed: structured atlas_lifecycle JSON block instructions (no HTTP calls)
 *
 * Falls back to 'local' transport when transportMode is not specified, preserving
 * backward compatibility with existing local agent dispatches.
 */
export function buildInstanceCallbackContract({
  instanceId,
  taskId,
  taskStatus,
  taskType,
  sprintType,
  agentSlug,
  sessionKey,
  baseUrl: baseUrlOverride,
  transportMode,
}: InstanceCallbackContractInput): string {
  const ctx: TransportContext = {
    instanceId,
    taskId,
    taskStatus,
    taskType,
    sprintType,
    agentSlug,
    sessionKey,
    baseUrl: baseUrlOverride,
    transportMode: transportMode ?? 'local',
    db: getDb(),
  };

  return buildContractInstructions(ctx);
}

function appendInstanceInstructions(
  message: string,
  instanceId: number,
  taskId: number,
  taskStatus: string,
  agentSlug: string,
  sessionKey: string,
  baseUrl?: string,
  taskType?: string | null,
  sprintType?: string | null,
  transportMode?: 'local' | 'remote-direct' | 'proxy-managed',
): string {
  return `${message}\n\n${buildInstanceCallbackContract({ instanceId, taskId, taskStatus, taskType, sprintType, agentSlug, sessionKey, baseUrl, transportMode })}`;
}

// ── Run context file ─────────────────────────────────────────────────────────

/** Context filename written to agent workspaces before dispatch. */
const RUN_CONTEXT_FILENAME = '.atlas-run-context.json';

/**
 * writeRunContext — write `.atlas-run-context.json` to the agent's working
 * directory so the `atlas-callback` CLI (and any other tool) can auto-discover
 * the instance/task/session context without reading prompt prose.
 *
 * The file is written atomically (write to .tmp, rename) to avoid partial reads
 * by the agent process. If the directory doesn't exist, the write is skipped
 * silently (the agent may still fall back to env vars or CLI flags).
 */
export function writeRunContext(params: {
  workingDirectory: string;
  instanceId: number;
  taskId: number;
  sessionKey: string;
  agentSlug: string;
  apiBase?: string;
}): void {
  const { workingDirectory, instanceId, taskId, sessionKey, agentSlug, apiBase } = params;
  const contextPath = path.join(workingDirectory, RUN_CONTEXT_FILENAME);
  const tmpPath = contextPath + '.tmp';
  const data = {
    instance_id: instanceId,
    task_id: taskId,
    session_key: sessionKey,
    agent_slug: agentSlug,
    api_base: apiBase ?? 'http://localhost:3501',
    written_at: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, contextPath);
    console.log(`[dispatcher] writeRunContext: wrote ${contextPath}`);
  } catch (err) {
    console.warn(`[dispatcher] writeRunContext: failed to write ${contextPath}:`, err);
    // Non-fatal — agent can still use env vars or CLI flags
  }
}

/**
 * cleanupRunContext — remove the `.atlas-run-context.json` file from a workspace.
 * Called during dispatch failure cleanup to avoid stale context files.
 */
export function cleanupRunContext(workingDirectory: string): void {
  try {
    const contextPath = path.join(workingDirectory, RUN_CONTEXT_FILENAME);
    if (fs.existsSync(contextPath)) {
      fs.unlinkSync(contextPath);
    }
  } catch {
    // Best-effort cleanup
  }
}

// ── Agent runner ─────────────────────────────────────────────────────────────

/**
 * buildSessionKey — Deterministic, isolated session key per job instance.
 *
 * Format: hook:atlas:jobrun:<instanceId>
 *
 * Uses `hook:` prefix because OpenClaw's allowedSessionKeyPrefixes config
 * restricts caller-provided sessionKey values to this prefix for safety.
 * The `atlas:jobrun:<id>` suffix makes each run uniquely addressable.
 */
function buildSessionKey(instanceId: number): string {
  // Must start with "hook:" — OpenClaw enforces this for /hooks/agent dispatch.
  // OpenClaw internally stores the session as "agent:<runtime-slug>:hook:atlas:jobrun:<id>"
  // but the dispatch payload and stored session_key must use the short hook: form.
  // The session-key resolution endpoint reconstructs the full key for chat.history.
  return buildHookSessionKey(instanceId);
}

// ── CLAUDE.md generator ──────────────────────────────────────────────────────

/**
 * generateClaudeMd — write a CLAUDE.md orientation file to the agent's
 * workingDirectory before each claude-code dispatch.
 *
 * The file contains references (paths) to identity docs, memory, and skills
 * so Claude Code knows what to read. It never pastes file contents directly.
 * Overwrites any existing CLAUDE.md on each dispatch so the timestamp is fresh.
 */
export function generateClaudeMd(params: {
  workingDirectory: string;
  skillNames: string[];
  hooksUrl?: string | null;
}): void {
  const { workingDirectory, skillNames, hooksUrl } = params;
  const timestamp = new Date().toISOString();

  // Identity document table
  const identityDocs = [
    { file: 'SOUL.md',     desc: 'Who you are — persona, values, and working style' },
    { file: 'IDENTITY.md', desc: 'Your role, agent ID, project, and session key' },
    { file: 'AGENTS.md',   desc: 'Operating manual — task workflow, branch conventions, callbacks' },
    { file: 'TOOLS.md',    desc: 'Environment notes — Atlas HQ URLs, SSH/infra details' },
    { file: 'USER.md',     desc: 'About the client — preferences and context' },
  ];

  const identityTable = [
    '| File | Description |',
    '|------|-------------|',
    ...identityDocs.map(d => `| \`${path.join(workingDirectory, d.file)}\` | ${d.desc} |`),
  ].join('\n');

  // Memory section
  const memoryDir  = path.join(workingDirectory, 'memory');
  const memoryFile = path.join(workingDirectory, 'MEMORY.md');
  const memorySection = [
    `- **Memory directory:** \`${memoryDir}/\` — dated session notes (e.g. \`YYYY-MM-DD.md\`)`,
    `- **MEMORY.md:** \`${memoryFile}\` — persistent cross-session notes`,
    '',
    '> Read these when resuming prior work. Write findings here; do not keep mental notes.',
  ].join('\n');

  // Skills section
  let skillsSection: string;
  if (skillNames.length === 0) {
    skillsSection = '_No skills assigned to this job._';
  } else {
    const skillsDir = path.join(workingDirectory, '.claude', 'skills');
    const lines = skillNames.map(name => {
      const skillMd = path.join(skillsDir, name, 'SKILL.md');
      return `- **${name}**: \`${skillMd}\``;
    });
    skillsSection = lines.join('\n');
  }

  // Docker / hooks note
  const dockerNote = hooksUrl
    ? `\n## Docker / Container Note\n\nThis agent runs inside a container. The hooks URL is \`${hooksUrl}\`.\nUse \`curl\` for Atlas HQ callbacks — do not assume local file paths outside the workspace.\n`
    : '';

  const content = [
    `<!-- Auto-generated by Atlas HQ dispatcher — do not edit manually -->`,
    `<!-- Generated: ${timestamp} -->`,
    ``,
    `# Agent Orientation`,
    ``,
    `This file is regenerated on every dispatch. Read the referenced files via the **Read** tool as needed.`,
    ``,
    `## Identity Documents`,
    ``,
    identityTable,
    ``,
    `## Memory`,
    ``,
    memorySection,
    ``,
    `## Skills`,
    ``,
    skillsSection,
    ``,
    `## Workspace`,
    ``,
    `Working directory: \`${workingDirectory}\``,
    dockerNote,
  ].join('\n');

  fs.writeFileSync(path.join(workingDirectory, 'CLAUDE.md'), content, 'utf-8');
  console.log(`[dispatcher] generateClaudeMd: wrote CLAUDE.md to ${workingDirectory}`);
}

// ── Skill symlink sync ────────────────────────────────────────────────────────

/**
 * OPENCLAW_SKILLS_PATH — the skills directory shipped with the OpenClaw package.
 *
 * Resolved once at module load time from the `openclaw` binary location so it
 * works regardless of NVM node version or install prefix.  Falls back to the
 * well-known default path when the binary cannot be located.
 *
 * Override with the OPENCLAW_SKILLS_PATH env var in tests or non-standard installs.
 */
function resolveOpenClawSkillsPath(): string {
  if (process.env.OPENCLAW_SKILLS_PATH) return process.env.OPENCLAW_SKILLS_PATH;

  try {
    // Locate the openclaw binary via PATH and walk up to the package root.
    // Typical layout: <prefix>/bin/openclaw → resolves to <prefix>/lib/node_modules/openclaw/openclaw.mjs
    // Skills live at: <prefix>/lib/node_modules/openclaw/skills/
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const binPath = execFileSync('which', ['openclaw'], { encoding: 'utf-8' }).trim();
    const resolved = fs.realpathSync(binPath);
    // Ascend from the resolved binary file until we find a `skills/` sibling directory.
    let dir = path.dirname(resolved);
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'skills');
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
      dir = path.dirname(dir);
    }
  } catch {
    // which / realpathSync failed — fall through to default
  }

  // Hard-coded fallback matching the standard NVM install used in production
  return path.join(
    process.env.HOME ?? '/root',
    '.nvm/versions/node/v24.14.0/lib/node_modules/openclaw/skills',
  );
}

export const OPENCLAW_SKILLS_PATH = resolveOpenClawSkillsPath();

/**
 * syncSkillDirs — create `.claude/skills/<name>` symlinks in workingDirectory
 * for each skill assigned to the job template.
 *
 * Steps:
 *   1. Ensure {workingDirectory}/.claude/skills/ directory exists (mkdirSync recursive).
 *   2. For each skill name, resolve the source dir in OPENCLAW_SKILLS_PATH.
 *   3. If the source dir does not exist, log a warning and skip.
 *   4. If a symlink already exists and points to the correct target, skip (idempotent).
 *   5. If a symlink exists but points elsewhere, replace it.
 *   6. Create the symlink.
 *
 * No error is thrown for an empty skillNames array — it is a valid no-op.
 */
export function syncSkillDirs(params: {
  workingDirectory: string;
  skillNames: string[];
  skillsBasePath?: string;
}): void {
  const { workingDirectory, skillNames, skillsBasePath = OPENCLAW_SKILLS_PATH } = params;

  if (skillNames.length === 0) return;

  const skillsDir = path.join(workingDirectory, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  for (const name of skillNames) {
    const source = path.join(skillsBasePath, name);

    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
      console.warn(`[dispatcher] syncSkillDirs: skill "${name}" not found at ${source} — skipping`);
      continue;
    }

    const link = path.join(skillsDir, name);

    // lstat (not stat) so we see the symlink itself, not its target.
    let lstat: ReturnType<typeof fs.lstatSync> | null = null;
    try { lstat = fs.lstatSync(link); } catch { /* not present */ }

    if (lstat) {
      if (lstat.isSymbolicLink()) {
        const existing = fs.readlinkSync(link);
        if (existing === source) {
          // Already correct — idempotent skip
          continue;
        }
      }
      // Stale symlink or unexpected file — remove it
      fs.unlinkSync(link);
    }

    fs.symlinkSync(source, link);
    console.log(`[dispatcher] syncSkillDirs: linked ${link} → ${source}`);
  }
}

// ── End CLAUDE.md generator / skill sync ─────────────────────────────────────

/**
 * fireAgentRun — dispatch an isolated agent run via the resolved AgentRuntime.
 *
 * The runtime is resolved from job.runtime_type / job.runtime_config so the
 * dispatcher remains backend-agnostic. All OpenClaw-specific logic lives in
 * OpenClawRuntime; future backends (ClaudeCodeRuntime, etc.) plug in here.
 */
async function fireAgentRun(
  db: Database.Database,
  job: JobRow,
  message: string,
  instanceId: number,
  agentSlug: string,
  taskStatusAtDispatch: string,
  taskId?: number | null,
  storyPoints?: number | null,
  worktreePath?: string | null,
): Promise<void> {
  const timeoutSec = job.timeout_seconds || 900;
  const sessionKey = buildSessionKey(instanceId);

  // Store the deterministic session key on the instance BEFORE dispatch
  // so it's always available for transcript lookups even if dispatch fails.
  db.prepare(`UPDATE job_instances SET session_key = ? WHERE id = ?`).run(
    sessionKey, instanceId
  );

  // Model precedence (highest wins):
  //   1. story_point_model_routing (provider-aware: preferred_provider > NULL-provider)
  //   2. job_template.model
  //   3. agent.model
  //   4. gateway default (null → omit from payload)
  //
  // Custom agents manage their own model selection — skip resolution so
  // CustomAgentRuntime falls through to its DEFAULT_VERI_MODEL.
  const isCustomRuntime = job.runtime_type === 'veri';
  const preferredProvider = job.preferred_provider ?? null;
  const spModel = isCustomRuntime ? null : resolveModelFromStoryPoints(db, storyPoints ?? null, preferredProvider);
  const model = isCustomRuntime ? null : (spModel?.model || job.model || job.agent_model || null);
  if (spModel) {
    console.log(
      `[dispatcher] Story points=${storyPoints} preferred_provider=${preferredProvider ?? 'null'} → model=${spModel.model} (rule: ${spModel.label ?? 'unnamed'})`
    );
  }
  console.log(
    `[dispatcher] Model resolution — instance #${instanceId} job="${job.title}"` +
    ` preferred_provider=${preferredProvider ?? 'null'} sp_model=${spModel?.model ?? 'null'} job.model=${job.model ?? 'null'} agent.model=${job.agent_model ?? 'null'}` +
    ` effective=${model ?? 'gateway-default'}`
  );

  // Persist the resolved effective_model on the instance so it's visible in the UI/audit log.
  if (model) {
    db.prepare(`UPDATE job_instances SET effective_model = ? WHERE id = ?`).run(model, instanceId);
  }

  // Resolve the correct runtime for this agent (openclaw, claude-code, etc.)
  const runtime = resolveRuntime({
    runtime_type: job.runtime_type,
    runtime_config: job.runtime_config,
  });

  // ── Runtime-aware skill materialization (task #644) ──────────────────────
  // Atlas owns the canonical skill assignments. Before dispatching, materialize
  // skills into the correct runtime artifacts (symlinks, CLAUDE.md sections,
  // prompt context, etc.) via the adapter for this agent's runtime_type.
  //
  // Replaces the previous claude-code-only `generateClaudeMd` + `syncSkillDirs`
  // block. All runtime types now go through the adapter factory so OpenClaw,
  // Custom, Webhook agents each receive the correct materialization behavior
  // without requiring runtime-specific conditionals here.
  {
    // Resolve the working directory (same logic as before, now shared across runtimes)
    let workingDirectory: string | null = null;
    if (worktreePath) {
      workingDirectory = worktreePath;
    } else if (typeof job.runtime_config === 'string') {
      try {
        const cfg = JSON.parse(job.runtime_config) as Record<string, unknown>;
        if (typeof cfg.workingDirectory === 'string') workingDirectory = cfg.workingDirectory;
      } catch { /* ignore */ }
    } else if (job.runtime_config && typeof job.runtime_config === 'object') {
      const cfg = job.runtime_config as Record<string, unknown>;
      if (typeof cfg.workingDirectory === 'string') workingDirectory = cfg.workingDirectory;
    }
    if (!workingDirectory && job.workspace_path) {
      workingDirectory = job.workspace_path;
    }

    // Parse skill names from the canonical agent/job record
    let skillNames: string[] = [];
    if (job.skill_names) {
      try {
        const parsed = JSON.parse(job.skill_names);
        if (Array.isArray(parsed)) skillNames = parsed.filter((s): s is string => typeof s === 'string');
      } catch { /* ignore */ }
    }

    if (workingDirectory) {
      const adapter = getSkillMaterializationAdapter(job.runtime_type);
      try {
        const materializeResult = adapter.materialize({
          workingDirectory,
          skillNames,
          skillsBasePath: OPENCLAW_SKILLS_PATH,
          hooksUrl: job.agent_hooks_url,
          db,
        });
        for (const warn of materializeResult.warnings) {
          console.warn(`[dispatcher] ${warn}`);
        }
        if (!materializeResult.ok && materializeResult.error) {
          console.warn(`[dispatcher] skill materialization error for instance #${instanceId}: ${materializeResult.error}`);
        } else if (materializeResult.count > 0) {
          console.log(
            `[dispatcher] skill materialization (${adapter.adapterName}): ${materializeResult.count} skill(s) for instance #${instanceId}`,
          );
        }
      } catch (matErr) {
        console.warn(`[dispatcher] skill materialization failed for instance #${instanceId}:`, matErr);
      }
    }
  }

  // ── Runtime-aware MCP materialization ────────────────────────────────────
  // OpenClaw agents consume assigned MCP servers through workspace extension
  // bundles. Atlas owns the canonical assignment in the DB, so write the
  // effective assigned server set into the working directory before dispatch.
  if ((job.runtime_type ?? 'openclaw') === 'openclaw') {
    const effectiveMcpDir: string | null = worktreePath ?? job.workspace_path ?? null;
    if (effectiveMcpDir) {
      try {
        const mcpResult = syncAssignedMcpForAgent({
          db,
          agentId: job.agent_id,
          workingDirectory: effectiveMcpDir,
        });
        for (const warn of mcpResult.warnings) {
          console.warn(`[dispatcher] ${warn}`);
        }
        if (!mcpResult.ok && mcpResult.error) {
          console.warn(
            `[dispatcher] MCP materialization error for instance #${instanceId}: ${mcpResult.error}`,
          );
        } else if (mcpResult.count > 0) {
          console.log(
            `[dispatcher] MCP materialization: ${mcpResult.count} server(s) for instance #${instanceId}`,
          );
        }
      } catch (mcpErr) {
        console.warn(`[dispatcher] MCP materialization failed for instance #${instanceId}:`, mcpErr);
      }
    }
  }

  // ── Write .atlas-run-context.json (task #466) ──────────────────────────
  // Resolve the effective workspace directory for context file injection.
  // This covers all runtimes (OpenClaw, claude-code, etc.) — the file is
  // written to the agent's working directory before dispatch so the
  // atlas-callback CLI can auto-discover instance/task/session context.
  const effectiveWorkDir: string | null = worktreePath ?? job.workspace_path ?? null;
  if (effectiveWorkDir && taskId != null) {
    try {
      writeRunContext({
        workingDirectory: effectiveWorkDir,
        instanceId,
        taskId,
        sessionKey,
        agentSlug,
      });
    } catch (ctxErr) {
      console.warn(`[dispatcher] writeRunContext failed for instance #${instanceId}:`, ctxErr);
    }
  }

  try {
    // Dispatching should be a function of the runtime interface.
    // Do not bypass AgentRuntime with direct /hooks/agent calls here.

    // Build runtimeConfig override from story-point rule (max_turns / max_budget_usd)
    // and worktree path (task #365)
    let runtimeConfigOverride: Record<string, unknown> = {};
    if (spModel) {
      if (spModel.max_turns != null) runtimeConfigOverride.maxTurns = spModel.max_turns;
      if (spModel.max_budget_usd != null) runtimeConfigOverride.maxBudgetUsd = spModel.max_budget_usd;
    }
    // Override workingDirectory with worktree path when available (task #365)
    if (worktreePath) {
      runtimeConfigOverride.workingDirectory = worktreePath;
    }

    const { runId } = await runtime.dispatch({
      message,
      agentSlug,
      sessionKey,
      timeoutSeconds: timeoutSec,
      name: `Atlas HQ: ${job.title}`,
      model,
      // Extra context for runtimes that manage their own session lifecycle (e.g. ClaudeCodeRuntime)
      instanceId,
      taskId: taskId ?? null,
      db,
      // Workspace boundary (task #364): pass the agent's workspace root so the
      // runtime can set cwd and expose ATLAS_WORKSPACE_ROOT to the agent process.
      workspaceRoot: job.workspace_path ?? null,
      runtimeConfig: Object.keys(runtimeConfigOverride).length > 0
        ? { ...(typeof job.runtime_config === 'string' ? JSON.parse(job.runtime_config) : (job.runtime_config ?? {})), ...runtimeConfigOverride }
        : job.runtime_config,
      hooksUrl: job.agent_hooks_url ?? null,
      hooksAuthHeader: job.agent_hooks_auth_header ?? null,
    } as Parameters<typeof runtime.dispatch>[0]);

    console.log(
      `[dispatcher] Instance #${instanceId} dispatched via ${job.runtime_type ?? 'openclaw'} runtime` +
      ` — sessionKey=${sessionKey} model=${model ?? 'gateway-default'}${runId ? ` runId=${runId}` : ''}`
    );

    // Store run handle for audit / future abort
    db.prepare(`UPDATE job_instances SET response = ? WHERE id = ?`)
      .run(JSON.stringify({ runId }), instanceId);

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[dispatcher] Instance #${instanceId} dispatch failed — ${errorMsg}`);

    // Clean up run context file on dispatch failure (task #466)
    if (effectiveWorkDir) {
      cleanupRunContext(effectiveWorkDir);
      // Clean up GitHub credential files on dispatch failure (task #613)
      cleanupGitHubCredentials(effectiveWorkDir);
    }

    db.prepare(`
      UPDATE job_instances
      SET status = 'failed', error = ?, completed_at = datetime('now')
      WHERE id = ? AND status IN ('dispatched', 'running')
    `).run(errorMsg, instanceId);

    // Reset linked task back to the correct workflow lane, but apply retry backoff
    // to prevent a spin-loop when the gateway/API is persistently down.
    //
    // Strategy (Option 1 from task #355):
    //  - Increment retry_count on each dispatch failure.
    //  - If retry_count >= max_retries → mark task failed (stop flooding the DB).
    //  - Otherwise → reset to fallback status AND set dispatched_at = now so the
    //    dispatcher's eligibility gate (dispatched_at + backoff check) prevents
    //    immediate re-dispatch on the next reconciler tick.
    const taskRow = db.prepare(
      `SELECT retry_count, max_retries FROM tasks WHERE active_instance_id = ?`
    ).get(instanceId) as { retry_count: number; max_retries: number } | undefined;

    const newRetryCount = (taskRow?.retry_count ?? 0) + 1;
    const maxRetries = taskRow?.max_retries ?? 3;

    if (newRetryCount >= maxRetries) {
      // Too many dispatch failures — mark the task failed to stop the spin-loop.
      console.error(
        `[dispatcher] Task (active_instance_id=${instanceId}) exhausted dispatch retries` +
        ` (retry_count=${newRetryCount}, max_retries=${maxRetries}) — marking failed.`
      );
      db.prepare(`
        UPDATE tasks
        SET status = 'failed',
            retry_count = ?,
            active_instance_id = NULL,
            claimed_at = NULL,
            dispatched_at = NULL,
            updated_at = datetime('now')
        WHERE active_instance_id = ?
      `).run(newRetryCount, instanceId);
      if (taskId != null) {
        writeTaskStatusChange(db, taskId, 'dispatcher', taskStatusAtDispatch, 'failed');
      }
    } else {
      // Increment retry_count and keep dispatched_at = now as the backoff timestamp.
      // The dispatcher's eligibility gate will skip this task until the backoff window
      // has elapsed (see DISPATCH_FAILURE_BACKOFF_SECONDS filter in query helpers).
      const fallbackStatus = deriveDispatchFailureFallbackStatus(taskStatusAtDispatch);
      console.warn(
        `[dispatcher] Task (active_instance_id=${instanceId}) dispatch failure` +
        ` — retry_count=${newRetryCount}/${maxRetries}, resetting to ${fallbackStatus} with backoff.`
      );
      db.prepare(`
        UPDATE tasks
        SET status = ?,
            retry_count = ?,
            active_instance_id = NULL,
            claimed_at = NULL,
            dispatched_at = datetime('now'),
            updated_at = datetime('now')
        WHERE active_instance_id = ?
      `).run(fallbackStatus, newRetryCount, instanceId);
      if (taskId != null && fallbackStatus !== taskStatusAtDispatch) {
        writeTaskStatusChange(db, taskId, 'dispatcher', taskStatusAtDispatch, fallbackStatus);
      }
    }
  }
}

/**
 * dispatchTaskToJob — shared helper that fires a single task to a single job.
 * Used by both the new task-first path and the legacy per-job fallback.
 * Returns true if dispatch succeeded.
 */
function dispatchTaskToJob(
  db: Database.Database,
  job: JobRow,
  task: CandidateTask,
  candidateCount: number,
  ruleLabel?: string,
): boolean {
  const routingReason = [
    `Priority: ${task.priority}`,
    task.blocking_count > 0 ? `Blocking ${task.blocking_count} task(s)` : null,
    `Created: ${task.created_at}`,
    ruleLabel ?? `Selected from ${candidateCount} candidate(s)`,
  ].filter(Boolean).join(' | ');

  const agentSlug = resolveRuntimeAgentSlug({
    openclaw_agent_id: job.openclaw_agent_id ?? null,
    session_key: job.agent_session_key,
    name: job.agent_name ?? null,
  }) ?? String(job.agent_id);

  // ── Worktree isolation (task #365, #377) ─────────────────────────────────
  // If the agent has a repo_path, create an isolated worktree for this task.
  // The worktree becomes the agent's working directory instead of workspace_path.
  // When os_user is set (task #377), worktrees go under /Users/<os_user>/workspaces/
  // instead of the agent's workspace_path, ensuring per-user filesystem isolation.
  let worktreePath: string | null = null;
  if (job.repo_path && job.workspace_path) {
    const basePath = job.os_user
      ? `/Users/${job.os_user}/workspaces`
      : job.workspace_path;
    const wtResult = createTaskWorktree({
      repoPath: job.repo_path,
      basePath,
      taskId: task.id,
      taskTitle: task.title,
      agentSlug,
    });
    if (wtResult.created || !wtResult.error) {
      worktreePath = wtResult.worktreePath;
      console.log(`[dispatcher] Worktree for task #${task.id}: ${worktreePath} (branch: ${wtResult.branch})`);
    } else {
      console.warn(`[dispatcher] Worktree creation failed for task #${task.id}: ${wtResult.error} — falling back to workspace_path`);
    }
  }

  const instanceResult = db.prepare(`
    INSERT INTO job_instances (agent_id, status, dispatched_at, payload_sent, task_id, worktree_path)
    VALUES (?, 'dispatched', datetime('now'), ?, ?, ?)
  `).run(
    job.agent_id,
    JSON.stringify({ mode: 'runtime-dispatch', transport: 'ws.send', agentSlug }),
    task.id,
    worktreePath,
  );
  const instanceId = instanceResult.lastInsertRowid as number;
  const sessionKey = buildSessionKey(instanceId);
  const taskNotesSection = buildDispatchTaskNotesSection(getDispatchTaskNotesContext(db, {
    taskId: task.id,
    agentId: job.agent_id,
    currentInstanceId: instanceId,
  }));
  const baseMessage = [buildTaskMessage(job, task), taskNotesSection].filter(Boolean).join('\n\n');

  const nextTaskStatus = deriveDispatchTaskStatus(task.status);
  const hasFirstDispatchedAt = tableHasColumn(db, 'tasks', 'first_dispatched_at');
  const hasTotalDispatchCount = tableHasColumn(db, 'tasks', 'total_dispatch_count');

  const firstDispatchClause = hasFirstDispatchedAt
    ? "first_dispatched_at = COALESCE(first_dispatched_at, datetime('now')),"
    : '';
  const dispatchCountClause = hasTotalDispatchCount
    ? 'total_dispatch_count = total_dispatch_count + 1,'
    : '';

  db.prepare(`
    UPDATE tasks
    SET status = ?,
        agent_id = ?,
        dispatched_at = datetime('now'),
        claimed_at = NULL,
        active_instance_id = ?,
        routing_reason = ?,
        ${firstDispatchClause}
        ${dispatchCountClause}
        updated_at = datetime('now')
    WHERE id = ?
  `).run(nextTaskStatus, job.agent_id, instanceId, routingReason, task.id);

  if (nextTaskStatus !== task.status) {
    writeTaskStatusChange(db, task.id, 'dispatcher', task.status, nextTaskStatus, {
      instanceId,
      reason: routingReason ?? null,
    });
  }

  // Remote agents (Custom) need the external Tailscale URL; local agents use localhost.
  const callbackBaseUrl = job.runtime_type === 'veri'
    ? getAgentHqBaseUrl()
    : undefined; // undefined → default Agent HQ base URL / localhost

  // ── GitHub identity injection (task #613) ────────────────────────────────
  // Resolve and inject per-agent GitHub credentials so routed agents can
  // operate under distinct GitHub identities for PR open/approve/merge.
  const effectiveWorkDir = worktreePath ?? job.workspace_path ?? null;
  const ghIdentity = resolveGitHubIdentity(db, job.agent_id);
  if (ghIdentity && effectiveWorkDir) {
    injectGitHubCredentials(effectiveWorkDir, ghIdentity.identity);
  }
  const ghIdentityContext = buildGitHubIdentityContext(ghIdentity, effectiveWorkDir ?? '');

  // Resolve transport mode from agent runtime type and config (task #632)
  const transportMode = resolveTransportMode({
    runtimeType: job.runtime_type,
    runtimeConfig: job.runtime_config,
    hooksUrl: job.agent_hooks_url,
  });

  const fullMessage = appendInstanceInstructions(
    baseMessage, instanceId, task.id, task.status, agentSlug, sessionKey,
    callbackBaseUrl, task.task_type, task.sprint_type, transportMode,
  ) + ghIdentityContext;

  fireAgentRun(db, job, fullMessage, instanceId, agentSlug, task.status, task.id, task.story_points ?? null, worktreePath).catch((err) => {
    console.error(`[dispatcher] Unhandled error in fireAgentRun for instance #${instanceId}:`, err);
  });

  db.prepare(`
    INSERT INTO dispatch_log (task_id, agent_id, routing_reason, candidate_count, candidates_skipped)
    VALUES (?, ?, ?, ?, ?)
  `).run(task.id, job.agent_id, routingReason, candidateCount, JSON.stringify([]));

  console.log(`[dispatcher] Dispatched Task #${task.id} → ${job.title} (${job.agent_name ?? job.agent_id}) — instance #${instanceId}`);
  notifyTaskStatusChange(db, {
    taskId: task.id,
    fromStatus: task.status,
    toStatus: nextTaskStatus,
    source: job.agent_name ?? job.title,
  });
  return true;
}

export function runDispatcher(db: Database.Database, projectId?: number): DispatchResult {
  const result: DispatchResult = { dispatched: 0, skipped: 0, errors: [] };

  // ── Phase 1: Task-first routing (universal multi-agent fallback) ──────────
  //
  // Get all dispatchable tasks across all projects (or the filtered project).
  // For each task, find all matching routing rules ordered by priority, then
  // try each rule's agent until one is free. This allows any role to have
  // multiple agents and the dispatcher will always pick the first available one.

  const allTasks = getAllDispatchableTasks(db, projectId ?? null);

  // Track which task IDs were handled by the routing-rules path so the
  // legacy fallback path doesn't double-dispatch them.
  const handledTaskIds = new Set<number>();
  // Track which job IDs were used by the routing-rules path so the legacy
  // fallback path doesn't double-dispatch to the same job.
  const handledJobIds = new Set<number>();

  for (const task of allTasks) {
    try {
      // Skip if task already got an instance earlier in this loop
      if (hasTaskLiveInstance(db, task.id)) {
        result.skipped++;
        continue;
      }

      const rules = getMatchingRoutingRules(db, task);
      if (rules.length === 0) {
        // No routing rules → will be handled by legacy per-job fallback below
        continue;
      }

      let dispatched = false;
      for (const rule of rules) {
        // Skip if this rule's job agent already has an active run
        if (hasActiveInstance(db, rule.agent_id)) continue;

        // Race condition guard: re-check task is still free
        if (hasTaskLiveInstance(db, task.id)) break;

        // Build a JobRow-compatible object from the joined rule columns
        const jobForDispatch: JobRow = {
          id: rule.agent_id,
          title: rule.job_title,
          agent_id: rule.agent_id,
          project_id: task.project_id,
          pre_instructions: rule.pre_instructions,
          enabled: rule.enabled,
          timeout_seconds: rule.timeout_seconds,
          agent_session_key: rule.agent_session_key,
          agent_name: rule.agent_name,
          model: rule.model,
          agent_model: rule.agent_model,
          runtime_type: rule.runtime_type,
          runtime_config: rule.runtime_config,
          agent_hooks_url: rule.agent_hooks_url ?? null,
          agent_hooks_auth_header: rule.agent_hooks_auth_header ?? null,
          workspace_path: rule.workspace_path ?? null,
          skill_names: rule.skill_names ?? null,
          preferred_provider: rule.preferred_provider ?? null,
          repo_path: rule.repo_path ?? null,
          os_user: rule.os_user ?? null,
        };

        const ok = dispatchTaskToJob(
          db,
          jobForDispatch,
          task,
          allTasks.length,
          `Rule: ${rule.job_title} (agent #${rule.agent_id})`,
        );
        if (ok) {
          result.dispatched++;
          dispatched = true;
          handledTaskIds.add(task.id);
          handledJobIds.add(rule.agent_id);
          break;
        }
      }

      if (!dispatched) result.skipped++;
    } catch (err) {
      const msg = `Task ${task.id}: ${String(err)}`;
      result.errors.push(msg);
      console.error(`[dispatcher] Error (routing-rules path):`, msg);
    }
  }

  // ── Phase 2: Legacy per-job fallback ─────────────────────────────────────
  //
  // For jobs that have tasks NOT covered by routing rules (i.e. tasks with
  // explicit job_id assignments but no routing rule entry), use the original
  // per-job loop so existing behaviour is fully preserved.

  let jobSql = `
    SELECT a.id as id,
           a.job_title as title, a.id as agent_id, a.project_id,
           a.pre_instructions, a.enabled, a.timeout_seconds, a.model,
           a.skill_names,
           a.session_key as agent_session_key, a.name as agent_name, a.model as agent_model,
           a.runtime_type, a.runtime_config, a.hooks_url as agent_hooks_url,
           a.hooks_auth_header as agent_hooks_auth_header,
           a.workspace_path, a.preferred_provider, a.repo_path, a.os_user
    FROM agents a
    WHERE a.enabled = 1
  `;
  const jobParams: unknown[] = [];

  if (projectId != null) {
    jobSql += ` AND a.project_id = ?`;
    jobParams.push(projectId);
  }

  const jobs = db.prepare(jobSql).all(...jobParams) as JobRow[];

  for (const job of jobs) {
    // Skip jobs already dispatched by the routing-rules path this cycle
    if (handledJobIds.has(job.id)) continue;

    try {
      // 1. Active instance guard
      if (hasActiveInstance(db, job.id)) {
        result.skipped++;
        continue;
      }

      // 2. Query + sort candidates (respecting per-job routing_config sort_rules)
      //    Exclude tasks already dispatched by the routing-rules path.
      const allCandidates = getCandidates(db, job.agent_id, null, job.project_id);
      const candidates = allCandidates.filter(c => !handledTaskIds.has(c.id));
      if (candidates.length === 0) {
        result.skipped++;
        continue;
      }

      const routingConfig = getAgentRoutingConfig(db, job.agent_id);
      const sorted = sortCandidates(candidates, routingConfig.sort_rules);
      const picked = sorted[0];

      const ok = dispatchTaskToJob(db, job, picked, candidates.length);
      if (ok) {
        result.dispatched++;
        handledTaskIds.add(picked.id);
      }
    } catch (err) {
      const msg = `Job ${job.id} (${job.title}): ${String(err)}`;
      result.errors.push(msg);
      console.error(`[dispatcher] Error (legacy path):`, msg);
    }
  }

  return result;
}

// ── Unified dispatch helpers (task #64) ────────────────────────────────────
//
// buildDispatchMessage() assembles the prompt text from discrete fields.
// dispatchInstance() wraps resolveRuntime() + runtime.dispatch() with all
// the DB lifecycle writes that callers previously duplicated.

/**
 * buildDispatchMessage — assemble an agent dispatch message from component parts.
 *
 * Pure function, no side effects. Callers (scheduler, reconciler, sprints)
 * pass the relevant fields; the function concatenates them in the canonical
 * order that agents expect.
 */
export function buildDispatchMessage(params: {
  sprintGoal?: string | null;
  projectName?: string | null;
  projectContext?: string | null;
  preInstructions?: string;
  skillName?: string | null;
  summaryRequest?: string | null;
  taskNotesSection?: string | null;
}): string {
  let message = '';
  if (params.sprintGoal) {
    message += `[Sprint Goal: ${params.sprintGoal}]\n\n`;
  }
  if (params.projectName && params.projectContext) {
    message += `--- Project Context: ${params.projectName} ---\n${params.projectContext}\n--- End Project Context ---\n\n`;
  }
  if (params.preInstructions) {
    message += params.preInstructions + '\n\n';
  }
  if (params.skillName) {
    message += `Run skill: ${params.skillName}\n\n`;
  }
  if (params.taskNotesSection) {
    message += params.taskNotesSection + '\n\n';
  }
  if (params.summaryRequest) {
    message += params.summaryRequest + '\n\n';
  }
  return message.trimEnd();
}

export interface DispatchInstanceParams {
  instanceId: number;
  agentId: number;
  jobTitle: string;
  /** Agent's main session key (used for slug resolution). */
  sessionKey: string;
  /** Pre-built message (caller assembles via buildDispatchMessage + contract). */
  message: string;
  model?: string | null;
  timeoutSeconds?: number;
  hooksUrl?: string | null;
  hooksAuthHeader?: string | null;
  runtimeType?: string | null;
  runtimeConfig?: unknown;
  storyPoints?: number | null;
}

/**
 * dispatchInstance — unified dispatch orchestrator.
 *
 * All dispatch paths (scheduler, reconciler, sprint summaries) call this
 * instead of the legacy dispatchJob(). It:
 *   1. Builds a deterministic session key
 *   2. Resolves the agent slug
 *   3. Resolves model from story points (if applicable)
 *   4. Marks the instance as 'dispatched' with payload_sent
 *   5. Calls resolveRuntime() → runtime.dispatch()
 *   6. On success: marks 'running', logs
 *   7. On failure: marks 'failed', logs, re-throws
 */
export async function dispatchInstance(params: DispatchInstanceParams): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  const runSessionKey = buildSessionKey(params.instanceId);
  const agentSlug = resolveRuntimeAgentSlug({
    session_key: params.sessionKey,
    name: params.jobTitle,
  }) ?? params.sessionKey.replace(/[^a-z0-9-]/gi, '-').toLowerCase();

  // Model precedence: story_points → caller-provided → gateway default
  const spModel = resolveModelFromStoryPoints(db, params.storyPoints ?? null);
  const effectiveModel = spModel?.model || params.model || null;
  if (spModel) {
    console.log(
      `[dispatchInstance] Story points=${params.storyPoints} → model=${spModel.model} (rule: ${spModel.label ?? 'unnamed'})`
    );
  }
  console.log(
    `[dispatchInstance] Model for instance #${params.instanceId} job="${params.jobTitle}"` +
    ` sp_model=${spModel?.model ?? 'null'} caller_model=${params.model ?? 'null'}` +
    ` effective=${effectiveModel ?? 'gateway-default'}`
  );

  // Mark as dispatched
  db.prepare(`
    UPDATE job_instances
    SET status = 'dispatched', dispatched_at = ?, payload_sent = ?, session_key = ?
    WHERE id = ?
  `).run(now, JSON.stringify({ mode: 'runtime-dispatch', agentSlug, sessionKey: runSessionKey }), runSessionKey, params.instanceId);

  db.prepare(`
    INSERT INTO logs (instance_id, agent_id, job_title, level, message)
    VALUES (?, ?, ?, 'info', ?)
  `).run(
    params.instanceId,
    params.agentId,
    params.jobTitle,
    `Dispatching job "${params.jobTitle}" via AgentRuntime (sessionKey=${runSessionKey})`
  );

  const runtime = resolveRuntime({
    runtime_type: params.runtimeType ?? 'openclaw',
    runtime_config: params.runtimeConfig,
  });

  try {
    const { runId } = await runtime.dispatch({
      message: params.message,
      agentSlug,
      sessionKey: runSessionKey,
      timeoutSeconds: params.timeoutSeconds ?? 900,
      name: `Atlas HQ: ${params.jobTitle}`,
      model: effectiveModel,
      instanceId: params.instanceId,
      taskId: null,
      db,
      hooksUrl: params.hooksUrl,
      hooksAuthHeader: params.hooksAuthHeader,
    });

    db.prepare(`
      UPDATE job_instances
      SET status = 'running',
          response = ?,
          run_id = COALESCE(?, run_id)
      WHERE id = ?
    `).run(JSON.stringify({ runId }), runId, params.instanceId);

    db.prepare(`
      INSERT INTO logs (instance_id, agent_id, job_title, level, message)
      VALUES (?, ?, ?, 'info', ?)
    `).run(
      params.instanceId,
      params.agentId,
      params.jobTitle,
      `Job dispatched via AgentRuntime. sessionKey=${runSessionKey}${runId ? ` runId=${runId}` : ''}`
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    db.prepare(`
      UPDATE job_instances
      SET status = 'failed', error = ?, completed_at = ?
      WHERE id = ?
    `).run(errorMsg, new Date().toISOString(), params.instanceId);

    db.prepare(`
      INSERT INTO logs (instance_id, agent_id, job_title, level, message)
      VALUES (?, ?, ?, 'error', ?)
    `).run(
      params.instanceId,
      params.agentId,
      params.jobTitle,
      `Failed to dispatch job: ${errorMsg}`
    );

    throw err;
  }
}
