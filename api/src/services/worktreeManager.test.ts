import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pruneOrphanedWorktrees } from './worktreeManager';

describe('pruneOrphanedWorktrees', () => {
  let tempRoot: string;
  let repoPath: string;
  let basePath: string;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-worktrees-'));
    repoPath = path.join(tempRoot, 'repo');
    basePath = path.join(tempRoot, 'workspaces');
    fs.mkdirSync(repoPath, { recursive: true });
    fs.mkdirSync(basePath, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' });
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function makeOldDirectory(name: string): string {
    const dir = path.join(basePath, name);
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(dir, old, old);
    return dir;
  }

  it('prunes stale worktrees with both current and legacy task folder names', () => {
    const current = makeOldDirectory('task-101');
    const legacy = makeOldDirectory('atlas-hq-task-102');
    const active = makeOldDirectory('task-103');
    makeOldDirectory('not-a-task');

    const result = pruneOrphanedWorktrees({
      repoPath,
      basePath,
      maxAgeHours: 1,
      isActiveCheck: (taskId) => taskId === 103,
    });

    expect(result.errors).toEqual([]);
    expect(result.pruned.sort()).toEqual([current, legacy].sort());
    expect(fs.existsSync(current)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(active)).toBe(true);
    expect(fs.existsSync(path.join(basePath, 'not-a-task'))).toBe(true);
  });
});
