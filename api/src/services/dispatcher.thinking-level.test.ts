import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

jest.mock('../runtimes', () => ({
  resolveRuntime: jest.fn(),
}));

jest.mock('./worktreeManager', () => ({
  createTaskWorktree: jest.fn(() => ({ created: false, worktreePath: null, branch: null, error: null })),
}));

jest.mock('../lib/taskNotifications', () => ({
  notifyTaskStatusChange: jest.fn(),
}));

jest.mock('../lib/taskHistory', () => ({
  writeTaskStatusChange: jest.fn(),
}));

jest.mock('../runtimes/skillMaterialization', () => ({
  getSkillMaterializationAdapter: jest.fn(() => ({
    adapterName: 'test',
    materialize: jest.fn(() => ({ ok: true, count: 0, warnings: [] })),
  })),
}));

jest.mock('../runtimes/mcpMaterialization', () => ({
  syncAssignedMcpForAgent: jest.fn(() => ({ ok: true, count: 0, warnings: [] })),
}));

jest.mock('../lib/githubIdentity', () => ({
  resolveGitHubIdentity: jest.fn(() => null),
  injectGitHubCredentials: jest.fn(),
  cleanupGitHubCredentials: jest.fn(),
  buildGitHubIdentityContext: jest.fn(() => ''),
}));

jest.mock('../lib/agentHqBaseUrl', () => ({
  getAgentHqBaseUrl: jest.fn(() => 'http://localhost:3501'),
}));

import { resolveRuntime } from '../runtimes';
import { dispatchInstance, resolveModelFromStoryPoints, runDispatcher } from './dispatcher';

const mockedResolveRuntime = resolveRuntime as jest.MockedFunction<typeof resolveRuntime>;

describe('runDispatcher thinking-level routing', () => {
  it('resolveModelFromStoryPoints returns configured thinking_level', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE story_point_model_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        max_points INTEGER NOT NULL,
        provider TEXT,
        model TEXT NOT NULL,
        fallback_model TEXT,
        max_turns INTEGER,
        max_budget_usd REAL,
        thinking_level TEXT,
        label TEXT
      );
    `);

    db.prepare(`
      INSERT INTO story_point_model_routing (max_points, provider, model, thinking_level, label)
      VALUES (5, 'anthropic', 'anthropic/claude-sonnet-4-6', 'medium', 'default route')
    `).run();

    expect(resolveModelFromStoryPoints(db, 3, 'anthropic')).toEqual({
      model: 'anthropic/claude-sonnet-4-6',
      max_turns: null,
      max_budget_usd: null,
      thinking_level: 'medium',
      label: 'default route',
    });

    db.close();
  });

  it('passes routed thinking_level into runtime dispatch and persists resolved output', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        job_title TEXT NOT NULL,
        project_id INTEGER,
        pre_instructions TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        timeout_seconds INTEGER NOT NULL,
        model TEXT,
        skill_names TEXT,
        session_key TEXT NOT NULL,
        name TEXT,
        runtime_type TEXT,
        runtime_config TEXT,
        hooks_url TEXT,
        hooks_auth_header TEXT,
        workspace_path TEXT,
        preferred_provider TEXT,
        repo_path TEXT,
        os_user TEXT,
        openclaw_agent_id TEXT,
        sort_rules TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        agent_id INTEGER,
        project_id INTEGER,
        task_type TEXT,
        sprint_id INTEGER,
        created_at TEXT NOT NULL,
        story_points INTEGER,
        active_instance_id INTEGER,
        paused_at TEXT,
        dispatched_at TEXT,
        claimed_at TEXT,
        routing_reason TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        updated_at TEXT
      );

      CREATE TABLE sprints (
        id INTEGER PRIMARY KEY,
        name TEXT,
        sprint_type TEXT,
        status TEXT
      );

      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        task_id INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        dispatched_at TEXT,
        payload_sent TEXT,
        worktree_path TEXT,
        session_key TEXT,
        response TEXT,
        error TEXT,
        completed_at TEXT,
        effective_model TEXT,
        effective_thinking_level TEXT
      );

      CREATE TABLE story_point_model_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        max_points INTEGER NOT NULL,
        provider TEXT,
        model TEXT NOT NULL,
        fallback_model TEXT,
        max_turns INTEGER,
        max_budget_usd REAL,
        thinking_level TEXT,
        label TEXT
      );

      CREATE TABLE dispatch_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        agent_id INTEGER,
        routing_reason TEXT,
        candidate_count INTEGER,
        candidates_skipped TEXT
      );

      CREATE TABLE task_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        blocker_id INTEGER,
        blocked_id INTEGER
      );

      CREATE TABLE task_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        author TEXT,
        content TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id INTEGER,
        agent_id INTEGER,
        job_title TEXT,
        level TEXT,
        message TEXT
      );
    `);

    db.prepare(`
      INSERT INTO agents (id, job_title, project_id, pre_instructions, enabled, timeout_seconds, model, skill_names, session_key, name, runtime_type, runtime_config, workspace_path, preferred_provider, sort_rules)
      VALUES (1, 'Backend Engineer', 86, 'Do the task', 1, 900, 'anthropic/claude-sonnet-4-6', '[]', 'agent:backend:main', 'Cinder', 'openclaw', '{}', '/tmp', 'anthropic', '[]')
    `).run();

    db.prepare(`
      INSERT INTO tasks (id, title, description, status, priority, agent_id, project_id, task_type, sprint_id, created_at, story_points, updated_at)
      VALUES (382, 'Add thinking routing', 'Implement support', 'ready', 'medium', 1, 86, 'backend', NULL, '2026-04-28T20:00:00.000Z', 4, '2026-04-28T20:00:00.000Z')
    `).run();

    db.prepare(`
      INSERT INTO story_point_model_routing (max_points, provider, model, thinking_level, label)
      VALUES (4, 'anthropic', 'anthropic/claude-sonnet-4-6', 'high', 'Medium deep thinking')
    `).run();

    const dispatchMock = jest.fn().mockResolvedValue({ runId: 'run-123' });
    mockedResolveRuntime.mockReturnValue({
      dispatch: dispatchMock,
      abort: jest.fn().mockResolvedValue(undefined),
    });

    const result = runDispatcher(db, 86);
    expect(result.dispatched).toBe(1);

    await new Promise((resolve) => setImmediate(resolve));

    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'anthropic/claude-sonnet-4-6',
      thinking: 'high',
      workspaceRoot: '/tmp',
      activeRepoRoot: '/tmp',
      runtimeConfig: expect.objectContaining({ workingDirectory: '/tmp' }),
    }));

    const instance = db.prepare(`SELECT effective_model, effective_thinking_level FROM job_instances LIMIT 1`).get() as { effective_model: string | null; effective_thinking_level: string | null };
    expect(instance).toEqual({
      effective_model: 'anthropic/claude-sonnet-4-6',
      effective_thinking_level: 'high',
    });

    db.close();
  });

  it('makes task worktree authoritative for runtime cwd and repo-root metadata', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        job_title TEXT NOT NULL,
        project_id INTEGER,
        pre_instructions TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        timeout_seconds INTEGER NOT NULL,
        model TEXT,
        skill_names TEXT,
        session_key TEXT NOT NULL,
        name TEXT,
        runtime_type TEXT,
        runtime_config TEXT,
        hooks_url TEXT,
        hooks_auth_header TEXT,
        workspace_path TEXT,
        preferred_provider TEXT,
        repo_path TEXT,
        os_user TEXT,
        openclaw_agent_id TEXT,
        sort_rules TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        agent_id INTEGER,
        project_id INTEGER,
        task_type TEXT,
        sprint_id INTEGER,
        created_at TEXT NOT NULL,
        story_points INTEGER,
        active_instance_id INTEGER,
        paused_at TEXT,
        dispatched_at TEXT,
        claimed_at TEXT,
        routing_reason TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        updated_at TEXT
      );

      CREATE TABLE sprints (
        id INTEGER PRIMARY KEY,
        name TEXT,
        sprint_type TEXT,
        status TEXT
      );

      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        task_id INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        dispatched_at TEXT,
        payload_sent TEXT,
        worktree_path TEXT,
        session_key TEXT,
        response TEXT,
        error TEXT,
        completed_at TEXT,
        effective_model TEXT,
        effective_thinking_level TEXT
      );

      CREATE TABLE dispatch_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        agent_id INTEGER,
        routing_reason TEXT,
        candidate_count INTEGER,
        candidates_skipped TEXT
      );

      CREATE TABLE task_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        blocker_id INTEGER,
        blocked_id INTEGER
      );

      CREATE TABLE task_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        author TEXT,
        content TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id INTEGER,
        agent_id INTEGER,
        job_title TEXT,
        level TEXT,
        message TEXT
      );
    `);

    db.prepare(`
      INSERT INTO agents (id, job_title, project_id, pre_instructions, enabled, timeout_seconds, model, skill_names, session_key, name, runtime_type, runtime_config, workspace_path, preferred_provider, repo_path, sort_rules)
      VALUES (1, 'Backend Engineer', 86, 'Do the task', 1, 900, 'anthropic/claude-sonnet-4-6', '[]', 'agent:backend:main', 'Cinder', 'claude-code', '{"workingDirectory":"/parent/workspace"}', '/parent/workspace', 'anthropic', '/repos/agent-hq', '[]')
    `).run();

    db.prepare(`
      INSERT INTO tasks (id, title, description, status, priority, agent_id, project_id, task_type, sprint_id, created_at, story_points, updated_at)
      VALUES (375, 'Fix worktree root handoff', 'Make worktree repo root authoritative', 'ready', 'high', 1, 86, 'backend', NULL, '2026-04-28T20:00:00.000Z', 3, '2026-04-28T20:00:00.000Z')
    `).run();

    const dispatchMock = jest.fn().mockResolvedValue({ runId: 'run-375' });
    mockedResolveRuntime.mockReturnValue({
      dispatch: dispatchMock,
      abort: jest.fn().mockResolvedValue(undefined),
    });

    const { createTaskWorktree } = jest.requireMock('./worktreeManager') as { createTaskWorktree: jest.Mock };
    createTaskWorktree.mockReturnValue({
      created: true,
      worktreePath: '/Users/test/workspaces/task-375',
      branch: 'task-375-fix',
      error: null,
    });

    const result = runDispatcher(db, 86);
    expect(result.dispatched).toBe(1);

    await new Promise((resolve) => setImmediate(resolve));

    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: '/parent/workspace',
      activeRepoRoot: '/Users/test/workspaces/task-375',
      runtimeConfig: expect.objectContaining({ workingDirectory: '/Users/test/workspaces/task-375' }),
    }));

    const payloadSent = db.prepare(`SELECT payload_sent FROM job_instances LIMIT 1`).get() as { payload_sent: string | null };
    expect(JSON.parse(payloadSent.payload_sent ?? '{}')).toEqual(expect.objectContaining({
      mode: 'runtime-dispatch',
      transport: 'ws.send',
    }));

    const instance = db.prepare(`SELECT worktree_path FROM job_instances LIMIT 1`).get() as { worktree_path: string | null };
    expect(instance.worktree_path).toBe('/Users/test/workspaces/task-375');

    db.close();
  });

  it('writes run context into the active worktree with consistent repo-root metadata', async () => {
    const db = new Database(':memory:');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-worktree-'));
    const workspaceRoot = path.join(tempRoot, 'workspace-root');
    const worktreeRoot = path.join(workspaceRoot, 'task-375');
    fs.mkdirSync(worktreeRoot, { recursive: true });

    try {
      db.exec(`
        CREATE TABLE agents (
          id INTEGER PRIMARY KEY,
          job_title TEXT NOT NULL,
          project_id INTEGER,
          pre_instructions TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          timeout_seconds INTEGER NOT NULL,
          model TEXT,
          skill_names TEXT,
          session_key TEXT NOT NULL,
          name TEXT,
          runtime_type TEXT,
          runtime_config TEXT,
          hooks_url TEXT,
          hooks_auth_header TEXT,
          workspace_path TEXT,
          preferred_provider TEXT,
          repo_path TEXT,
          os_user TEXT,
          openclaw_agent_id TEXT,
          sort_rules TEXT NOT NULL DEFAULT '[]'
        );

        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL,
          priority TEXT NOT NULL,
          agent_id INTEGER,
          project_id INTEGER,
          task_type TEXT,
          sprint_id INTEGER,
          created_at TEXT NOT NULL,
          story_points INTEGER,
          active_instance_id INTEGER,
          paused_at TEXT,
          dispatched_at TEXT,
          claimed_at TEXT,
          routing_reason TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 3,
          updated_at TEXT
        );

        CREATE TABLE sprints (
          id INTEGER PRIMARY KEY,
          name TEXT,
          sprint_type TEXT,
          status TEXT
        );

        CREATE TABLE job_instances (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id INTEGER NOT NULL,
          task_id INTEGER,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          dispatched_at TEXT,
          payload_sent TEXT,
          worktree_path TEXT,
          session_key TEXT,
          response TEXT,
          error TEXT,
          completed_at TEXT,
          effective_model TEXT,
          effective_thinking_level TEXT
        );

        CREATE TABLE dispatch_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER,
          agent_id INTEGER,
          routing_reason TEXT,
          candidate_count INTEGER,
          candidates_skipped TEXT
        );

        CREATE TABLE task_dependencies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          blocker_id INTEGER,
          blocked_id INTEGER
        );

        CREATE TABLE task_notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER,
          author TEXT,
          content TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id INTEGER,
          agent_id INTEGER,
          job_title TEXT,
          level TEXT,
          message TEXT
        );
      `);

      db.prepare(`
        INSERT INTO agents (id, job_title, project_id, pre_instructions, enabled, timeout_seconds, model, skill_names, session_key, name, runtime_type, runtime_config, workspace_path, preferred_provider, repo_path, sort_rules)
        VALUES (1, 'Backend Engineer', 86, 'Do the task', 1, 900, 'anthropic/claude-sonnet-4-6', '[]', 'agent:backend:main', 'Cinder', 'claude-code', '{"workingDirectory":"/stale/root"}', ?, 'anthropic', '/repos/agent-hq', '[]')
      `).run(workspaceRoot);

      db.prepare(`
        INSERT INTO tasks (id, title, description, status, priority, agent_id, project_id, task_type, sprint_id, created_at, story_points, updated_at)
        VALUES (375, 'Fix worktree root handoff', 'Make worktree repo root authoritative', 'ready', 'high', 1, 86, 'backend', NULL, '2026-04-28T20:00:00.000Z', 3, '2026-04-28T20:00:00.000Z')
      `).run();

      const dispatchMock = jest.fn().mockResolvedValue({ runId: 'run-375' });
      mockedResolveRuntime.mockReturnValue({
        dispatch: dispatchMock,
        abort: jest.fn().mockResolvedValue(undefined),
      });

      const { createTaskWorktree } = jest.requireMock('./worktreeManager') as { createTaskWorktree: jest.Mock };
      createTaskWorktree.mockReturnValue({
        created: true,
        worktreePath: worktreeRoot,
        branch: 'task-375-fix',
        error: null,
      });

      const result = runDispatcher(db, 86);
      expect(result.dispatched).toBeGreaterThanOrEqual(0);
      expect(result.errors).toEqual([]);

      await new Promise((resolve) => setImmediate(resolve));

      const runContextPath = path.join(worktreeRoot, '.atlas-run-context.json');
      const runContext = JSON.parse(fs.readFileSync(runContextPath, 'utf-8')) as {
        workspace_root: string | null;
        active_repo_root: string | null;
        worktree_root: string | null;
      };

      expect(runContext).toEqual(expect.objectContaining({
        workspace_root: workspaceRoot,
        active_repo_root: worktreeRoot,
        worktree_root: worktreeRoot,
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      db.close();
    }
  });

  it('dispatchInstance passes routed thinking_level into runtime dispatch', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        task_id INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        dispatched_at TEXT,
        payload_sent TEXT,
        session_key TEXT,
        response TEXT,
        error TEXT,
        completed_at TEXT,
        run_id TEXT
      );

      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id INTEGER,
        agent_id INTEGER,
        job_title TEXT,
        level TEXT,
        message TEXT
      );

      CREATE TABLE story_point_model_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        max_points INTEGER NOT NULL,
        provider TEXT,
        model TEXT NOT NULL,
        fallback_model TEXT,
        max_turns INTEGER,
        max_budget_usd REAL,
        thinking_level TEXT,
        label TEXT
      );
    `);

    db.prepare(`
      INSERT INTO job_instances (id, agent_id, task_id, status, created_at)
      VALUES (11, 1, 382, 'queued', '2026-04-28T20:00:00.000Z')
    `).run();

    db.prepare(`
      INSERT INTO story_point_model_routing (max_points, provider, model, thinking_level, label)
      VALUES (8, NULL, 'openai-codex/gpt-5.4', 'adaptive', 'deeper route')
    `).run();

    const dispatchMock = jest.fn().mockResolvedValue({ runId: 'run-456' });
    mockedResolveRuntime.mockReturnValue({
      dispatch: dispatchMock,
      abort: jest.fn().mockResolvedValue(undefined),
    });

    const dispatcherModule = jest.requireActual('./dispatcher') as typeof import('./dispatcher');
    const getDbSpy = jest.spyOn(require('../db/client'), 'getDb').mockReturnValue(db);

    try {
      await dispatchInstance({
        instanceId: 11,
        agentId: 1,
        sessionKey: 'hook:atlas:jobrun:11',
        jobTitle: 'Backend Engineer',
        message: 'Run the task',
        storyPoints: 6,
        model: null,
        timeoutSeconds: 900,
        runtimeType: 'openclaw',
        runtimeConfig: '{}',
      });
    } finally {
      getDbSpy.mockRestore();
    }

    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openai-codex/gpt-5.4',
      thinking: 'adaptive',
    }));

    db.close();
  });
});
