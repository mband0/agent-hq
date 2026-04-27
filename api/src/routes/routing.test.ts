import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import routingRouter from './routing';

let tempDir: string;
let dbPath: string;

function resetDb(): void {
  closeDb();
  jest.resetModules();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-rules-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.AGENT_HQ_DB_PATH = dbPath;
  process.env.AGENT_CONTRACT_ROOT = path.join(tempDir, 'agent-contracts');
  fs.mkdirSync(process.env.AGENT_CONTRACT_ROOT, { recursive: true });

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
    CREATE TABLE sprint_types (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      job_title TEXT,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE sprint_task_routing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL,
      agent_id INTEGER,
      priority INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_task_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      status_key TEXT NOT NULL,
      label TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'slate',
      terminal INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      allowed_transitions_json TEXT NOT NULL DEFAULT '[]',
      stage_order INTEGER NOT NULL DEFAULT 0,
      is_default_entry INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_task_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
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
  `);

  db.prepare(`INSERT INTO projects (id, name) VALUES (1, 'Agent HQ')`).run();
  db.prepare(`INSERT INTO sprint_types (key, name, is_system) VALUES ('generic', 'Generic', 1), ('bugs', 'Bugs', 1), ('enhancements', 'Enhancements', 1)`).run();
  db.prepare(`INSERT INTO sprints (id, project_id, name, sprint_type) VALUES (10, 1, 'Bugs', 'bugs')`).run();
  db.prepare(`INSERT INTO agents (id, name, job_title, enabled) VALUES (7, 'Cinder', 'Backend Engineer', 1)`).run();
}

function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/routing', routingRouter);

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('routing rules API', () => {
  beforeEach(() => {
    tempDir = '';
    dbPath = '';
    resetDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.AGENT_HQ_DB_PATH;
    delete process.env.AGENT_CONTRACT_ROOT;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects creating a routing rule without sprint_id', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_type: 'backend', status: 'ready', agent_id: 7, project_id: 1 }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'sprint_id is required' });
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects creating a routing rule for an unknown sprint agent', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sprint_id: 10, task_type: 'backend', status: 'ready', agent_id: 999, priority: 5 }),
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'Agent 999 not found' });
    } finally {
      await stopTestServer(server);
    }
  });

  it('accepts canonical task_status alias when creating a routing rule', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sprint_id: 10, task_type: 'backend', task_status: 'ready', agent_id: 7, priority: 5 }),
      });

      const body = await response.json();
      if (response.status !== 201) {
        throw new Error(`Expected 201, received ${response.status}: ${JSON.stringify(body)}`);
      }
      expect(body).toEqual(expect.objectContaining({ sprint_id: 10, agent_id: 7, task_type: 'backend', status: 'ready' }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('creates, reads, and resolves sprint-scoped routing rules only', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const createResponse = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sprint_id: 10, task_type: 'backend', status: 'ready', agent_id: 7, priority: 5 }),
      });

      const createBody = await createResponse.json();
      if (createResponse.status !== 201) {
        throw new Error(`Expected 201, received ${createResponse.status}: ${JSON.stringify(createBody)}`);
      }
      const created = createBody as { sprint_id: number; agent_id: number; task_type: string; status: string };
      expect(created).toEqual(expect.objectContaining({ sprint_id: 10, agent_id: 7, task_type: 'backend', status: 'ready' }));

      const readResponse = await fetch(`${baseUrl}/api/v1/routing/rules?sprint_id=10`);
      expect(readResponse.status).toBe(200);
      const body = await readResponse.json() as { rules: Array<{ sprint_id: number; agent_id: number }> };
      expect(body.rules).toEqual([
        expect.objectContaining({ sprint_id: 10, agent_id: 7 }),
      ]);

      const resolveResponse = await fetch(`${baseUrl}/api/v1/routing/rules/resolve?sprint_id=10&task_type=backend&status=ready`);
      expect(resolveResponse.status).toBe(200);
      const resolveBody = await resolveResponse.json() as { matched: boolean; rule: { sprint_id: number; agent_id: number } };
      expect(resolveBody).toEqual({
        matched: true,
        rule: expect.objectContaining({ sprint_id: 10, agent_id: 7 }),
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('reads and writes sprint-type-specific contract templates with fallback', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const genericResponse = await fetch(`${baseUrl}/api/v1/routing/agent-contract?sprint_type=generic`);
      expect(genericResponse.status).toBe(200);
      const genericBody = await genericResponse.json() as { sprint_type: string; content: string; inherited_from: string | null };
      expect(genericBody.sprint_type).toBe('generic');
      expect(genericBody.inherited_from).toBeNull();
      expect(genericBody.content).toContain('Sprint type: {{sprintType}}');

      const sprintSpecificResponse = await fetch(`${baseUrl}/api/v1/routing/agent-contract?sprint_type=enhancements`);
      expect(sprintSpecificResponse.status).toBe(200);
      const sprintSpecificBody = await sprintSpecificResponse.json() as { sprint_type: string; content: string; inherited_from: string | null };
      expect(sprintSpecificBody.sprint_type).toBe('enhancements');
      expect(sprintSpecificBody.inherited_from).toBeNull();
      expect(sprintSpecificBody.content).toContain('## Atlas HQ enhancement contract for this dispatched instance');

      const saveResponse = await fetch(`${baseUrl}/api/v1/routing/agent-contract`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sprint_type: 'enhancements', content: 'enhancements only {{taskId}}' }),
      });
      expect(saveResponse.status).toBe(200);

      const directResponse = await fetch(`${baseUrl}/api/v1/routing/agent-contract?sprint_type=enhancements`);
      expect(directResponse.status).toBe(200);
      await expect(directResponse.json()).resolves.toEqual(expect.objectContaining({
        sprint_type: 'enhancements',
        content: 'enhancements only {{taskId}}',
        inherited_from: null,
      }));
    } finally {
      await stopTestServer(server);
    }
  });
});
