/**
 * runtimes/types.ts — AgentRuntime interface and shared dispatch types.
 *
 * Shared runtime end-event contracts live in runtimeEvents.ts.
 * The dispatcher calls AgentRuntime.dispatch() and AgentRuntime.abort()
 * without knowing which runtime backend (OpenClaw, Claude Code, etc.) is
 * in use. Each backend provides a concrete implementation.
 */

import type Database from 'better-sqlite3';
import type { RuntimeEndEvent, RuntimeEndEventType, RuntimeEventCallbacks } from './runtimeEvents';

export type { RuntimeEndEvent, RuntimeEndEventType, RuntimeEventCallbacks } from './runtimeEvents';

export interface DispatchParams extends RuntimeEventCallbacks {
  message: string;
  agentSlug: string;
  sessionKey: string;
  timeoutSeconds: number;
  name: string;
  model?: string | null;
  thinking?: string | null;
  /** Instance ID — required by runtimes that need to persist run state (e.g. ClaudeCodeRuntime). */
  instanceId?: number;
  /** Task ID — forwarded to runtimes that expose it to agents via env vars. */
  taskId?: number | null;
  /** Database handle — required by runtimes that write directly to the DB (e.g. ClaudeCodeRuntime). */
  db?: Database.Database;
  /**
   * Parent workspace container root for this agent (normally agents.workspace_path).
   * This remains the broader allowed container boundary when the active repo is a
   * task worktree nested under a larger workspace.
   * Never treat this value as the repo cwd when activeRepoRoot is present.
   */
  workspaceRoot?: string | null;
  /**
   * Authoritative active repo root for this dispatched run.
   * When a task worktree exists, this must point at the worktree repo root so the
   * runtime cwd, prompt context, metadata, and any repo-file assumptions all agree
   * on the same path.
   */
  activeRepoRoot?: string | null;
  /**
   * Optional dispatch metadata describing how the active repo root and workspace
   * boundary were resolved. This is for observability only and must not be used
   * to override activeRepoRoot/workspaceRoot semantics.
   */
  pathMetadata?: {
    pathMode?: 'worktree' | 'runtime-config' | 'workspace';
    repoRootSource?: 'worktree' | 'runtime-config' | 'workspace' | 'none';
    workspaceRootSource?: 'workspace' | 'active-repo-root' | 'none';
    worktreeRoot?: string | null;
    runtimeConfigWorkingDirectory?: string | null;
  } | null;
  /**
   * Legacy container hook metadata.
   * OpenClawRuntime ignores hook transport and dispatches via the runtime WS path.
   * Kept here for compatibility with existing dispatcher/job records.
   */
  hooksUrl?: string | null;
  /** Legacy per-agent hook auth header; retained for compatibility only. */
  hooksAuthHeader?: string | null;
}

export interface AgentRuntime {
  /**
   * dispatch — fire an isolated agent run and return a handle that can be
   * used to abort the run if needed.
   */
  dispatch(params: DispatchParams): Promise<{ runId: string }>;

  /**
   * abort — request cancellation of a running agent turn.
   * Implementations should treat "already gone" as a success.
   */
  abort(runId: string, sessionKey: string): Promise<void>;
}
