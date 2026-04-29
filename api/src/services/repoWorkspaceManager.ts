import { execFileSync, type ExecFileSyncOptions } from 'child_process';
import fs from 'fs';
import path from 'path';

export type RepoAccessMode = 'worktree' | 'clone';

export interface RepoWorkspacePrepareResult {
  mode: RepoAccessMode;
  workspacePath: string;
  branch: string;
  created: boolean;
  error?: string;
  reusedExisting?: boolean;
}

export interface RepoWorkspaceCleanupResult {
  removed: boolean;
  workspacePath?: string;
  worktreePath?: string;
  error?: string;
}

function gitExec(args: string[], cwd: string): string {
  const opts: ExecFileSyncOptions = {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  return execFileSync('git', args, opts) as unknown as string;
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function buildTaskBranchName(params: {
  agentSlug: string;
  taskId: number;
  taskTitle: string;
}): string {
  const slug = slugify(params.taskTitle);
  return `${params.agentSlug}/task-${params.taskId}-${slug}`;
}

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

export function createTaskWorktree(params: {
  repoPath: string;
  basePath: string;
  taskId: number;
  taskTitle: string;
  agentSlug: string;
  baseBranch?: string;
}): RepoWorkspacePrepareResult {
  const { repoPath, basePath, taskId, taskTitle, agentSlug, baseBranch = 'main' } = params;
  const branch = buildTaskBranchName({ agentSlug, taskId, taskTitle });
  const workspacePath = path.join(basePath, `task-${taskId}`);

  try {
    if (fs.existsSync(workspacePath)) {
      try {
        gitExec(['rev-parse', '--is-inside-work-tree'], workspacePath);
        console.log(`[repoWorkspaceManager] Reusing existing worktree at ${workspacePath}`);
        return { mode: 'worktree', workspacePath, branch, created: false, reusedExisting: true };
      } catch {
        console.warn(`[repoWorkspaceManager] Stale path at ${workspacePath}, removing and recreating worktree`);
        try {
          gitExec(['worktree', 'remove', workspacePath, '--force'], repoPath);
        } catch {
          fs.rmSync(workspacePath, { recursive: true, force: true });
        }
      }
    }

    try {
      gitExec(['fetch', 'origin', '--prune'], repoPath);
    } catch (fetchErr) {
      console.warn('[repoWorkspaceManager] git fetch failed (non-fatal):', fetchErr);
    }

    let branchExists = false;
    try {
      gitExec(['rev-parse', '--verify', branch], repoPath);
      branchExists = true;
    } catch {
      // branch created below
    }

    fs.mkdirSync(basePath, { recursive: true });

    if (branchExists) {
      gitExec(['worktree', 'add', workspacePath, branch], repoPath);
    } else {
      gitExec(['worktree', 'add', '-b', branch, workspacePath, `origin/${baseBranch}`], repoPath);
    }

    console.log(`[repoWorkspaceManager] Created worktree at ${workspacePath} (branch: ${branch})`);
    return { mode: 'worktree', workspacePath, branch, created: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[repoWorkspaceManager] Failed to create worktree for task #${taskId}:`, errorMsg);
    return { mode: 'worktree', workspacePath, branch, created: false, error: errorMsg };
  }
}

export function removeTaskWorktree(params: {
  repoPath: string;
  worktreePath: string;
}): RepoWorkspaceCleanupResult {
  const { repoPath, worktreePath } = params;

  try {
    if (!fs.existsSync(worktreePath)) {
      return { removed: true, workspacePath: worktreePath, worktreePath };
    }

    gitExec(['worktree', 'remove', worktreePath, '--force'], repoPath);
    try {
      gitExec(['worktree', 'prune'], repoPath);
    } catch {
      // non-fatal
    }

    return { removed: true, workspacePath: worktreePath, worktreePath };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      gitExec(['worktree', 'prune'], repoPath);
      return { removed: true, workspacePath: worktreePath, worktreePath };
    } catch {
      return { removed: false, workspacePath: worktreePath, worktreePath, error: errorMsg };
    }
  }
}

export function ensureTaskClone(params: {
  repoUrl: string;
  workspaceRoot: string;
  taskId: number;
  taskTitle: string;
  agentSlug: string;
  baseBranch?: string;
}): RepoWorkspacePrepareResult {
  const { repoUrl, workspaceRoot, taskId, taskTitle, agentSlug, baseBranch = 'main' } = params;
  const branch = buildTaskBranchName({ agentSlug, taskId, taskTitle });
  const workspacePath = path.join(workspaceRoot, `task-${taskId}`);

  try {
    const cloneAlreadyExisted = fs.existsSync(workspacePath);
    fs.mkdirSync(workspaceRoot, { recursive: true });

    if (!cloneAlreadyExisted) {
      execFileSync('git', ['clone', repoUrl, workspacePath], {
        encoding: 'utf-8',
        timeout: 60_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      gitExec(['rev-parse', '--is-inside-work-tree'], workspacePath);
      const remoteUrl = gitExec(['remote', 'get-url', 'origin'], workspacePath).trim();
      if (remoteUrl !== repoUrl) {
        throw new Error(`existing clone origin mismatch at ${workspacePath}: expected ${repoUrl}, got ${remoteUrl}`);
      }
    }

    try {
      gitExec(['fetch', 'origin', '--prune'], workspacePath);
    } catch (fetchErr) {
      console.warn('[repoWorkspaceManager] git fetch failed for clone (non-fatal):', fetchErr);
    }

    let branchExists = false;
    try {
      gitExec(['rev-parse', '--verify', branch], workspacePath);
      branchExists = true;
    } catch {
      // create below
    }

    if (branchExists) {
      gitExec(['checkout', branch], workspacePath);
    } else {
      gitExec(['checkout', '-b', branch, `origin/${baseBranch}`], workspacePath);
    }

    console.log(`[repoWorkspaceManager] Prepared clone at ${workspacePath} (branch: ${branch})`);
    return { mode: 'clone', workspacePath, branch, created: !cloneAlreadyExisted, reusedExisting: cloneAlreadyExisted };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[repoWorkspaceManager] Failed to prepare clone for task #${taskId}:`, errorMsg);
    return { mode: 'clone', workspacePath, branch, created: false, error: errorMsg };
  }
}

export function removeTaskClone(params: { workspacePath: string }): RepoWorkspaceCleanupResult {
  const { workspacePath } = params;
  try {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    return { removed: true, workspacePath };
  } catch (err) {
    return { removed: false, workspacePath, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface WorktreePruneResult {
  pruned: string[];
  errors: string[];
}

export function pruneOrphanedWorktrees(params: {
  repoPath: string;
  basePath: string;
  maxAgeHours?: number;
  isActiveCheck: (taskId: number) => boolean;
}): WorktreePruneResult {
  const { repoPath, basePath, maxAgeHours = 24, isActiveCheck } = params;
  const pruned: string[] = [];
  const errors: string[] = [];
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

  if (!fs.existsSync(basePath)) return { pruned, errors };

  for (const entry of fs.readdirSync(basePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/(?:^task-|^atlas-hq-task-)(\d+)$/);
    if (!match) continue;

    const taskId = Number(match[1]);
    if (!Number.isFinite(taskId) || isActiveCheck(taskId)) continue;

    const fullPath = path.join(basePath, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < maxAgeMs) continue;
      const result = removeTaskWorktree({ repoPath, worktreePath: fullPath });
      if (result.removed) pruned.push(fullPath);
      else if (result.error) errors.push(`${fullPath}: ${result.error}`);
    } catch (err) {
      errors.push(`${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { pruned, errors };
}
