import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  buildTaskBranchName,
  ensureTaskClone,
  removeTaskClone,
  resolveWorktreeBasePath,
} from './repoWorkspaceManager';

describe('repoWorkspaceManager clone mode', () => {
  let tempRoot: string;
  let remotePath: string;
  let seedPath: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-clone-mode-'));
    remotePath = path.join(tempRoot, 'remote.git');
    seedPath = path.join(tempRoot, 'seed');
    workspaceRoot = path.join(tempRoot, 'workspaces');

    fs.mkdirSync(seedPath, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: seedPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: seedPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: seedPath, stdio: 'ignore' });
    fs.writeFileSync(path.join(seedPath, 'README.md'), '# test\n');
    execFileSync('git', ['add', 'README.md'], { cwd: seedPath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: seedPath, stdio: 'ignore' });
    execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: seedPath, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: seedPath, stdio: 'ignore' });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('clones into the task workspace and creates a task branch', () => {
    const result = ensureTaskClone({
      repoUrl: remotePath,
      workspaceRoot,
      taskId: 373,
      taskTitle: 'Agent repo source modes',
      agentSlug: 'cinder-backend',
    });

    expect(result.error).toBeUndefined();
    expect(result.mode).toBe('clone');
    expect(result.workspacePath).toBe(path.join(workspaceRoot, 'task-373'));
    expect(fs.existsSync(path.join(result.workspacePath, '.git'))).toBe(true);
    expect(result.branch).toBe(buildTaskBranchName({
      agentSlug: 'cinder-backend',
      taskId: 373,
      taskTitle: 'Agent repo source modes',
    }));
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: result.workspacePath, encoding: 'utf-8' }).trim()).toBe(result.branch);
    expect(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: result.workspacePath, encoding: 'utf-8' }).trim()).toBe(remotePath);
  });

  it('reuses an existing task clone with the same origin', () => {
    const first = ensureTaskClone({
      repoUrl: remotePath,
      workspaceRoot,
      taskId: 373,
      taskTitle: 'Agent repo source modes',
      agentSlug: 'cinder-backend',
    });
    const second = ensureTaskClone({
      repoUrl: remotePath,
      workspaceRoot,
      taskId: 373,
      taskTitle: 'Agent repo source modes',
      agentSlug: 'cinder-backend',
    });

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(second.workspacePath).toBe(first.workspacePath);
    expect(second.reusedExisting).toBe(true);
  });

  it('fails truthfully when an existing task clone points at a different origin', () => {
    const otherRemotePath = path.join(tempRoot, 'other.git');
    execFileSync('git', ['init', '--bare', otherRemotePath], { stdio: 'ignore' });

    const first = ensureTaskClone({
      repoUrl: remotePath,
      workspaceRoot,
      taskId: 373,
      taskTitle: 'Agent repo source modes',
      agentSlug: 'cinder-backend',
    });
    expect(first.error).toBeUndefined();

    const second = ensureTaskClone({
      repoUrl: otherRemotePath,
      workspaceRoot,
      taskId: 373,
      taskTitle: 'Agent repo source modes',
      agentSlug: 'cinder-backend',
    });

    expect(second.created).toBe(false);
    expect(second.error).toContain('origin mismatch');
  });

  it('removes clone workspaces during cleanup', () => {
    const result = ensureTaskClone({
      repoUrl: remotePath,
      workspaceRoot,
      taskId: 373,
      taskTitle: 'Agent repo source modes',
      agentSlug: 'cinder-backend',
    });

    const cleanup = removeTaskClone({ workspacePath: result.workspacePath });
    expect(cleanup.removed).toBe(true);
    expect(fs.existsSync(result.workspacePath)).toBe(false);
  });
});

describe('resolveWorktreeBasePath', () => {
  it('uses the os user workspace root when provided', () => {
    expect(resolveWorktreeBasePath({ osUser: 'cinder', workspacePath: '/tmp/fallback' })).toBe('/Users/cinder/workspaces');
  });

  it('falls back to workspacePath when no os user is provided', () => {
    expect(resolveWorktreeBasePath({ workspacePath: '/tmp/fallback' })).toBe('/tmp/fallback');
  });
});
