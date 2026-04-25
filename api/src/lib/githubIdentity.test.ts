import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { injectGitHubCredentials, type GitHubIdentity } from './githubIdentity';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as string;
}

const identity: GitHubIdentity = {
  id: 11,
  github_username: 'cinder-agent',
  token: 'gho_testtoken',
  git_author_name: 'Cinder',
  git_author_email: 'cinder@atlashq',
  lane: 'dev',
  enabled: 1,
};

describe('GitHub identity injection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-gh-identity-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes credential files and configures worktree-local git author identity', () => {
    git(['init'], tempDir);

    expect(injectGitHubCredentials(tempDir, identity)).toBe(true);

    expect(fs.readFileSync(path.join(tempDir, '.atlas-gh-token'), 'utf-8')).toBe(identity.token);
    expect(fs.readFileSync(path.join(tempDir, '.atlas-gh-identity.env'), 'utf-8')).toContain('GIT_AUTHOR_NAME="Cinder"');
    expect(git(['config', '--local', 'user.name'], tempDir).trim()).toBe('Cinder');
    expect(git(['config', '--local', 'user.email'], tempDir).trim()).toBe('cinder@atlashq');
  });

  it('still writes credential files when the target is not a git worktree', () => {
    expect(injectGitHubCredentials(tempDir, identity)).toBe(true);

    expect(fs.existsSync(path.join(tempDir, '.atlas-gh-token'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, '.atlas-gh-identity.env'))).toBe(true);
  });
});
