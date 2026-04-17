/**
 * worktreeManager.ts — Git worktree isolation for dispatched tasks.
 *
 * Ensures agents never operate in the main/production git checkout.
 * Each dispatched task gets an isolated worktree that is cleaned up
 * after the instance completes (or by the watchdog for orphans).
 *
 * Worktree lifecycle:
 *   1. createTaskWorktree()  — called by dispatcher before dispatch
 *   2. removeTaskWorktree()  — called on instance completion/failure
 *   3. pruneOrphanedWorktrees() — watchdog cleanup for stale worktrees
 */

import { execFileSync, type ExecFileSyncOptions } from 'child_process';
import fs from 'fs';
import path from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

export interface WorktreeCreateResult {
  worktreePath: string;
  branch: string;
  created: boolean;
  error?: string;
}

export interface WorktreeRemoveResult {
  removed: boolean;
  worktreePath: string;
  error?: string;
}

export interface WorktreePruneResult {
  pruned: string[];
  errors: string[];
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Default max age (in hours) before a worktree is considered orphaned. */
export const DEFAULT_ORPHAN_MAX_AGE_HOURS = 24;

// ── Helpers ──────────────────────────────────────────────────────────────────

function gitExec(args: string[], cwd: string): string {
  const opts: ExecFileSyncOptions = {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  return execFileSync('git', args, opts) as unknown as string;
}

/**
 * slugify — convert a task title into a short, branch-safe slug.
 * Strips non-alphanumeric chars, lowercases, truncates to 40 chars.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * resolveWorktreeBasePath — determine the base directory for worktrees.
 *
 * When an agent has a dedicated os_user (task #377), worktrees are placed
 * under /Users/<os_user>/workspaces/ for filesystem isolation.
 * Otherwise, falls back to the agent's workspace_path.
 */
export function resolveWorktreeBasePath(params: {
  osUser?: string | null;
  workspacePath: string;
}): string {
  const { osUser, workspacePath } = params;
  if (osUser) {
    return path.join('/Users', osUser, 'workspaces');
  }
  return workspacePath;
}

// ── Core operations ──────────────────────────────────────────────────────────

/**
 * createTaskWorktree — creates a git worktree for a dispatched task.
 *
 * 1. Fetches latest from origin in the canonical repo.
 * 2. Creates a new branch and worktree at `{basePath}/atlas-hq-task-{taskId}`.
 * 3. If a worktree already exists at that path, reuses it (idempotent).
 *
 * @param repoPath  — canonical git checkout (e.g. /home/user/atlas-hq)
 * @param basePath  — base directory for worktrees (e.g. agent workspace_path)
 * @param taskId    — task ID for path and branch naming
 * @param taskTitle — task title for branch slug
 * @param agentSlug — agent identifier for branch prefix (e.g. "forge")
 * @param baseBranch — branch to base worktree on (default: "main")
 */
export function createTaskWorktree(params: {
  repoPath: string;
  basePath: string;
  taskId: number;
  taskTitle: string;
  agentSlug: string;
  baseBranch?: string;
}): WorktreeCreateResult {
  const { repoPath, basePath, taskId, taskTitle, agentSlug, baseBranch = 'main' } = params;
  const slug = slugify(taskTitle);
  const branch = `${agentSlug}/task-${taskId}-${slug}`;
  const worktreePath = path.join(basePath, `atlas-hq-task-${taskId}`);

  try {
    // If worktree path already exists and is valid, reuse it
    if (fs.existsSync(worktreePath)) {
      try {
        // Verify it's a valid git worktree
        gitExec(['rev-parse', '--is-inside-work-tree'], worktreePath);
        console.log(`[worktreeManager] Reusing existing worktree at ${worktreePath}`);
        return { worktreePath, branch, created: false };
      } catch {
        // Path exists but isn't a valid worktree — remove and recreate
        console.warn(`[worktreeManager] Stale path at ${worktreePath} — removing and recreating`);
        try {
          gitExec(['worktree', 'remove', worktreePath, '--force'], repoPath);
        } catch {
          // If git worktree remove fails, try plain fs removal
          fs.rmSync(worktreePath, { recursive: true, force: true });
        }
      }
    }

    // Fetch latest from origin (non-fatal if it fails)
    try {
      gitExec(['fetch', 'origin', '--prune'], repoPath);
    } catch (fetchErr) {
      console.warn(`[worktreeManager] git fetch failed (non-fatal):`, fetchErr);
    }

    // Check if branch already exists locally
    let branchExists = false;
    try {
      gitExec(['rev-parse', '--verify', branch], repoPath);
      branchExists = true;
    } catch {
      // Branch doesn't exist — will be created by `worktree add -b`
    }

    // Ensure parent directory exists
    fs.mkdirSync(basePath, { recursive: true });

    if (branchExists) {
      // Add worktree using existing branch
      gitExec(['worktree', 'add', worktreePath, branch], repoPath);
    } else {
      // Create new branch and worktree in one step, based on origin/{baseBranch}
      const startPoint = `origin/${baseBranch}`;
      gitExec(['worktree', 'add', '-b', branch, worktreePath, startPoint], repoPath);
    }

    console.log(`[worktreeManager] Created worktree at ${worktreePath} (branch: ${branch})`);
    return { worktreePath, branch, created: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[worktreeManager] Failed to create worktree for task #${taskId}:`, errorMsg);
    return { worktreePath, branch, created: false, error: errorMsg };
  }
}

/**
 * removeTaskWorktree — removes a worktree after task completion.
 *
 * Uses `git worktree remove --force` from the canonical repo.
 * Non-fatal if the worktree is already gone.
 */
export function removeTaskWorktree(params: {
  repoPath: string;
  worktreePath: string;
}): WorktreeRemoveResult {
  const { repoPath, worktreePath } = params;

  try {
    if (!fs.existsSync(worktreePath)) {
      console.log(`[worktreeManager] Worktree already removed: ${worktreePath}`);
      return { removed: true, worktreePath };
    }

    gitExec(['worktree', 'remove', worktreePath, '--force'], repoPath);

    // Prune stale worktree references
    try {
      gitExec(['worktree', 'prune'], repoPath);
    } catch {
      // Non-fatal
    }

    console.log(`[worktreeManager] Removed worktree: ${worktreePath}`);
    return { removed: true, worktreePath };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[worktreeManager] Failed to remove worktree ${worktreePath}:`, errorMsg);

    // Last resort: force-remove the directory
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      gitExec(['worktree', 'prune'], repoPath);
      console.log(`[worktreeManager] Force-removed worktree directory: ${worktreePath}`);
      return { removed: true, worktreePath };
    } catch (fsErr) {
      return { removed: false, worktreePath, error: errorMsg };
    }
  }
}

/**
 * pruneOrphanedWorktrees — scans for stale task worktrees and removes them.
 *
 * A worktree is considered orphaned if:
 *   1. Its directory name matches `atlas-hq-task-{id}`
 *   2. It was last modified more than `maxAgeHours` ago
 *   3. It has no active instance in the database (checked via callback)
 *
 * @param repoPath       — canonical git checkout
 * @param basePath       — base directory containing worktrees
 * @param maxAgeHours    — max age before considering orphaned (default: 24)
 * @param isActiveCheck  — callback that returns true if a task ID has a live instance
 */
export function pruneOrphanedWorktrees(params: {
  repoPath: string;
  basePath: string;
  maxAgeHours?: number;
  isActiveCheck?: (taskId: number) => boolean;
}): WorktreePruneResult {
  const { repoPath, basePath, maxAgeHours = DEFAULT_ORPHAN_MAX_AGE_HOURS, isActiveCheck } = params;
  const result: WorktreePruneResult = { pruned: [], errors: [] };

  try {
    if (!fs.existsSync(basePath)) return result;

    const entries = fs.readdirSync(basePath, { withFileTypes: true });
    const now = Date.now();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const worktreePattern = /^atlas-hq-task-(\d+)$/;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const match = entry.name.match(worktreePattern);
      if (!match) continue;

      const taskId = parseInt(match[1], 10);
      const worktreePath = path.join(basePath, entry.name);

      // Check age
      try {
        const stat = fs.statSync(worktreePath);
        const ageMs = now - stat.mtimeMs;
        if (ageMs < maxAgeMs) continue; // Not old enough
      } catch {
        continue; // Can't stat — skip
      }

      // Check if task still has a live instance
      if (isActiveCheck && isActiveCheck(taskId)) {
        continue; // Task still active — don't prune
      }

      // Prune this worktree
      const removeResult = removeTaskWorktree({ repoPath, worktreePath });
      if (removeResult.removed) {
        result.pruned.push(worktreePath);
      } else {
        result.errors.push(`${worktreePath}: ${removeResult.error ?? 'unknown error'}`);
      }
    }

    // Run git worktree prune to clean up stale references
    try {
      gitExec(['worktree', 'prune'], repoPath);
    } catch {
      // Non-fatal
    }
  } catch (err) {
    result.errors.push(`Scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (result.pruned.length > 0) {
    console.log(`[worktreeManager] Pruned ${result.pruned.length} orphaned worktree(s)`);
  }
  if (result.errors.length > 0) {
    console.warn(`[worktreeManager] Prune errors:`, result.errors);
  }

  return result;
}

/**
 * listWorktrees — returns active git worktrees from the canonical repo.
 * Useful for debugging and the watchdog.
 */
export function listWorktrees(repoPath: string): string[] {
  try {
    const output = gitExec(['worktree', 'list', '--porcelain'], repoPath);
    const paths: string[] = [];
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        paths.push(line.slice('worktree '.length));
      }
    }
    return paths;
  } catch {
    return [];
  }
}
