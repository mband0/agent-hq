import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import tasksRouter from './tasks';

let tempDir: string;
let dbPath: string;

function resetDb(): void {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-qa-evidence-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.AGENT_HQ_DB_PATH = dbPath;

  const db = getDb();
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE sprints (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sprint_type TEXT NOT NULL DEFAULT 'generic'
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      task_type TEXT,
      sprint_id INTEGER,
      project_id INTEGER,
      agent_id INTEGER,
      origin_task_id INTEGER,
      review_commit TEXT,
      qa_verified_commit TEXT,
      qa_tested_url TEXT,
      active_instance_id INTEGER,
      updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      changed_by TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER,
      uploaded_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE instance_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER,
      task_id INTEGER,
      kind TEXT,
      label TEXT,
      value TEXT,
      current_stage TEXT,
      last_agent_heartbeat_at TEXT,
      last_meaningful_output_at TEXT,
      latest_commit_hash TEXT,
      branch_name TEXT,
      changed_files_json TEXT,
      changed_files_count INTEGER,
      summary TEXT,
      blocker_reason TEXT,
      outcome TEXT,
      stale INTEGER,
      stale_at TEXT,
      updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_outcome_metrics (
      task_id INTEGER PRIMARY KEY,
      spawned_defects INTEGER DEFAULT 0,
      last_outcome TEXT,
      last_outcome_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE task_defects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_dependencies (
      blocker_id INTEGER NOT NULL,
      blocked_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (blocker_id, blocked_id)
    );
    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      task_id INTEGER,
      agent_id INTEGER,
      status TEXT,
      session_key TEXT,
      task_outcome TEXT,
      lifecycle_outcome_posted_at TEXT,
      response TEXT,
      dispatched_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      runtime_ended_at TEXT,
      runtime_end_success INTEGER,
      runtime_end_error TEXT,
      runtime_end_source TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY,
      agent_id INTEGER
    );
    CREATE TABLE task_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER,
      status_key TEXT,
      label TEXT,
      color TEXT,
      terminal INTEGER DEFAULT 0,
      is_system INTEGER DEFAULT 0,
      allowed_transitions_json TEXT DEFAULT '[]',
      stage_order INTEGER DEFAULT 0,
      is_default_entry INTEGER DEFAULT 0,
      metadata_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_task_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER,
      task_type TEXT,
      from_status TEXT NOT NULL,
      outcome TEXT NOT NULL,
      to_status TEXT NOT NULL,
      lane TEXT NOT NULL DEFAULT 'default',
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      is_protected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_task_transition_requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      task_type TEXT,
      outcome TEXT NOT NULL,
      field_name TEXT NOT NULL,
      requirement_type TEXT NOT NULL DEFAULT 'required',
      match_field TEXT,
      severity TEXT NOT NULL DEFAULT 'block',
      message TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_types (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_field_schemas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key TEXT NOT NULL,
      task_type TEXT,
      schema_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.prepare(`INSERT INTO projects (id, name) VALUES (1, 'Agent HQ')`).run();
  db.prepare(`INSERT INTO sprint_types (key, name, is_system) VALUES ('generic', 'Generic', 1)`).run();
  db.prepare(`INSERT INTO sprints (id, project_id, name, sprint_type) VALUES (10, 1, 'Bugs', 'generic')`).run();
  db.prepare(`INSERT INTO agents (id, name, enabled) VALUES (7, 'Talon', 1)`).run();
  db.prepare(`INSERT INTO tasks (id, title, status, task_type, sprint_id, project_id, agent_id, review_commit, active_instance_id) VALUES (383, 'Task 383', 'review', 'backend', 10, 1, 7, '6d614b3b104ae36d1dd75210b9f9fb0342673329', 1784)`).run();
  db.prepare(`INSERT INTO job_instances (id, task_id, agent_id, status, dispatched_at) VALUES (1784, 383, 7, 'running', datetime('now'))`).run();
  db.prepare(`INSERT INTO instance_artifacts (instance_id, task_id, current_stage, stale, updated_at) VALUES (1784, 383, 'progress', 0, datetime('now'))`).run();
  db.prepare(`INSERT INTO task_outcome_metrics (task_id, spawned_defects, updated_at) VALUES (383, 0, datetime('now'))`).run();
}

async function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/tasks', tasksRouter);
  const server = await new Promise<Server>((resolve) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('tasks qa-evidence aliases', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-qa-evidence-'));
    dbPath = path.join(tempDir, 'agent-hq-test.db');
    resetDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.AGENT_HQ_DB_PATH;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('accepts canonical qa_tested_url on qa-evidence writes', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/tasks/383/qa-evidence`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          qa_verified_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329',
          qa_tested_url: 'http://localhost:3501/api/v1/tasks/383',
          summary: 'QA verification of task 383 provider-limit false-live handling.',
          changed_by: 'talon-qa',
          instance_id: 1784,
        }),
      });
      const body = await response.json() as { qa_tested_url?: string | null; error?: string };

      if (response.status !== 200) {
        throw new Error(`Expected 200, received ${response.status}: ${JSON.stringify(body)}`);
      }
      expect(body.qa_tested_url).toBe('http://localhost:3501/api/v1/tasks/383');

      const db = getDb();
      const row = db.prepare(`SELECT qa_tested_url FROM tasks WHERE id = ?`).get(383) as { qa_tested_url: string | null };
      expect(row.qa_tested_url).toBe('http://localhost:3501/api/v1/tasks/383');
    } finally {
      await stopTestServer(server);
    }
  });

  it('still accepts legacy tested_url alias on qa-evidence writes', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/tasks/383/qa-evidence`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          qa_verified_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329',
          tested_url: 'http://localhost:3501/api/v1/tasks/383?legacy=1',
          changed_by: 'talon-qa',
          instance_id: 1784,
        }),
      });
      const body = await response.json() as { qa_tested_url?: string | null; error?: string };

      if (response.status !== 200) {
        throw new Error(`Expected 200, received ${response.status}: ${JSON.stringify(body)}`);
      }
      expect(body.qa_tested_url).toBe('http://localhost:3501/api/v1/tasks/383?legacy=1');
    } finally {
      await stopTestServer(server);
    }
  });
});
