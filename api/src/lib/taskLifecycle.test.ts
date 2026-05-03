import Database from 'better-sqlite3';
import { cleanupTaskExecutionLinkageForStatus } from './taskLifecycle';
import { removeTaskWorktree } from '../services/worktreeManager';
import { removeTaskClone } from '../services/repoWorkspaceManager';

jest.mock('../services/worktreeManager', () => ({
  removeTaskWorktree: jest.fn(({ worktreePath }: { worktreePath: string }) => ({ removed: true, worktreePath })),
}));

jest.mock('../services/repoWorkspaceManager', () => ({
  removeTaskClone: jest.fn(({ workspacePath }: { workspacePath: string }) => ({ removed: true, workspacePath })),
}));

const mockedRemoveTaskWorktree = removeTaskWorktree as jest.MockedFunction<typeof removeTaskWorktree>;
const mockedRemoveTaskClone = removeTaskClone as jest.MockedFunction<typeof removeTaskClone>;

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT,
      job_title TEXT,
      repo_path TEXT,
      repo_access_mode TEXT
    );

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      agent_id INTEGER,
      active_instance_id INTEGER,
      updated_at TEXT
    );

    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      agent_id INTEGER,
      task_id INTEGER,
      status TEXT NOT NULL,
      session_key TEXT,
      worktree_path TEXT,
      abort_attempted_at TEXT,
      abort_status TEXT,
      abort_error TEXT,
      error TEXT,
      completed_at TEXT
    );
  `);
  return db;
}

function seedLinkedTask(db: Database.Database, params: {
  taskStatus?: string;
  nextAgentTitle?: string;
  instanceStatus?: string;
  activeInstanceId?: number | null;
  worktreePath?: string | null;
} = {}): void {
  const {
    taskStatus = 'in_progress',
    nextAgentTitle = 'Builder',
    instanceStatus = 'running',
    activeInstanceId = 10,
    worktreePath = '/tmp/workspaces/task-1',
  } = params;

  db.prepare(`INSERT INTO agents (id, name, job_title, repo_path, repo_access_mode) VALUES (1, 'Agent', ?, '/repo', 'worktree')`).run(nextAgentTitle);
  db.prepare(`INSERT INTO tasks (id, status, agent_id, active_instance_id) VALUES (1, ?, 1, ?)`).run(taskStatus, activeInstanceId);
  db.prepare(`
    INSERT INTO job_instances (id, agent_id, task_id, status, session_key, worktree_path)
    VALUES (10, 1, 1, ?, NULL, ?)
  `).run(instanceStatus, worktreePath);
}

describe('task lifecycle worktree cleanup', () => {
  let db: Database.Database;

  beforeEach(() => {
    mockedRemoveTaskWorktree.mockClear();
    mockedRemoveTaskWorktree.mockImplementation(({ worktreePath }) => ({ removed: true, worktreePath }));
    mockedRemoveTaskClone.mockClear();
    mockedRemoveTaskClone.mockImplementation(({ workspacePath }) => ({ removed: true, workspacePath }));
    db = createDb();
  });

  afterEach(() => {
    db.close();
  });

  it.each(['failed', 'cancelled', 'ready', 'qa_pass'])('keeps the worktree when a task moves to %s', (status) => {
    seedLinkedTask(db, { instanceStatus: 'done' });

    cleanupTaskExecutionLinkageForStatus(db, 1, status);

    expect(mockedRemoveTaskWorktree).not.toHaveBeenCalled();
  });

  it.each([
    ['review', 'QA Engineer'],
    ['ready_to_merge', 'Release Engineer'],
    ['deployed', 'Release Engineer'],
  ])('keeps the worktree during %s handoff with a live instance', (status, agentTitle) => {
    seedLinkedTask(db, { nextAgentTitle: agentTitle, instanceStatus: 'running' });

    cleanupTaskExecutionLinkageForStatus(db, 1, status);

    expect(mockedRemoveTaskWorktree).not.toHaveBeenCalled();
  });

  it('keeps the worktree during qa_pass handoff even when execution linkage is cleared', () => {
    seedLinkedTask(db, { instanceStatus: 'done' });

    cleanupTaskExecutionLinkageForStatus(db, 1, 'qa_pass');

    expect(mockedRemoveTaskWorktree).not.toHaveBeenCalled();
    const task = db.prepare(`SELECT active_instance_id FROM tasks WHERE id = 1`).get() as { active_instance_id: number | null };
    expect(task.active_instance_id).toBeNull();
  });

  it('removes all known repo task workspaces when the task becomes done', () => {
    db.prepare(`INSERT INTO agents (id, name, job_title, repo_path, repo_access_mode) VALUES (1, 'Agent', 'Builder', '/repo', 'worktree')`).run();
    db.prepare(`INSERT INTO agents (id, name, job_title, repo_path, repo_access_mode) VALUES (2, 'Agent 2', 'Builder', NULL, 'clone')`).run();
    db.prepare(`INSERT INTO tasks (id, status, agent_id, active_instance_id) VALUES (1, 'deployed', 1, NULL)`).run();
    db.prepare(`
      INSERT INTO job_instances (id, agent_id, task_id, status, worktree_path)
      VALUES
        (10, 1, 1, 'done', '/tmp/workspaces/task-1'),
        (11, 1, 1, 'failed', '/tmp/workspaces/task-1'),
        (12, 1, 1, 'done', '/tmp/workspaces/task-1-retry'),
        (13, 2, 1, 'done', '/tmp/workspaces/no-repo'),
        (14, 1, NULL, 'failed', '/tmp/workspaces/agent-hq-task-1')
    `).run();

    cleanupTaskExecutionLinkageForStatus(db, 1, 'done');

    expect(mockedRemoveTaskWorktree).toHaveBeenCalledTimes(3);
    expect(mockedRemoveTaskWorktree).toHaveBeenCalledWith({ repoPath: '/repo', worktreePath: '/tmp/workspaces/task-1' });
    expect(mockedRemoveTaskWorktree).toHaveBeenCalledWith({ repoPath: '/repo', worktreePath: '/tmp/workspaces/task-1-retry' });
    expect(mockedRemoveTaskWorktree).toHaveBeenCalledWith({ repoPath: '/repo', worktreePath: '/tmp/workspaces/agent-hq-task-1' });
    expect(mockedRemoveTaskClone).toHaveBeenCalledWith({ workspacePath: '/tmp/workspaces/no-repo' });
  });

  it('removes clone-backed task workspaces with removeTaskClone', () => {
    db.prepare(`INSERT INTO agents (id, name, job_title, repo_path, repo_access_mode) VALUES (3, 'Clone Agent', 'Builder', NULL, 'clone')`).run();
    db.prepare(`INSERT INTO tasks (id, status, agent_id, active_instance_id) VALUES (77, 'done', 3, NULL)`).run();
    db.prepare(`INSERT INTO job_instances (id, agent_id, task_id, status, worktree_path) VALUES (77, 3, 77, 'done', '/tmp/task-77')`).run();

    cleanupTaskExecutionLinkageForStatus(db, 77, 'done');

    expect(mockedRemoveTaskClone).toHaveBeenCalledWith({ workspacePath: '/tmp/task-77' });
  });

  it('keeps repeated done cleanup calls harmless', () => {
    seedLinkedTask(db, { taskStatus: 'done', activeInstanceId: null, instanceStatus: 'done' });

    expect(() => cleanupTaskExecutionLinkageForStatus(db, 1, 'done')).not.toThrow();
    expect(() => cleanupTaskExecutionLinkageForStatus(db, 1, 'done')).not.toThrow();

    expect(mockedRemoveTaskWorktree).toHaveBeenCalledTimes(2);
  });
});
