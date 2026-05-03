import express from 'express';
import type { Server } from 'http';
import { closeDb, getDb } from '../db/client';
import { initSchema } from '../db/schema';
import { authenticateMcpApiKeyIfPresent, issueMcpApiKeyForAgent } from '../lib/mcpApiAuth';
import tasksRouter from '../routes/tasks';
import { AgentHqApiClient } from './apiClient';

async function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', authenticateMcpApiKeyIfPresent);
  app.use('/api/v1/tasks', tasksRouter);
  const server = await new Promise<Server>((resolve, reject) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
    bound.on('error', reject);
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

function seedAtlasTask(): { agentId: number; taskId: number } {
  const db = getDb();
  const atlas = db.prepare(`
    SELECT id FROM agents
    WHERE system_role = 'atlas' OR openclaw_agent_id = 'atlas' OR name = 'Atlas'
    ORDER BY id ASC
    LIMIT 1
  `).get() as { id: number } | undefined;
  if (!atlas) throw new Error('Atlas seed agent missing');

  db.prepare(`INSERT INTO projects (id, name, description, context_md) VALUES (9101, 'MCP Auth Test', '', '')`).run();
  db.prepare(`
    INSERT INTO tasks (id, title, description, status, priority, project_id, agent_id, task_type, custom_fields_json)
    VALUES (9102, 'MCP auth task', '', 'todo', 'medium', 9101, ?, 'backend', '{}')
  `).run(atlas.id);

  return { agentId: atlas.id, taskId: 9102 };
}

describe('Agent HQ MCP API identity propagation', () => {
  beforeEach(() => {
    closeDb();
    initSchema();
  });

  afterEach(() => {
    closeDb();
  });

  it('allows an MCP task status update when the API key maps to Atlas and audits the resolved agent', async () => {
    const { agentId, taskId } = seedAtlasTask();
    const { apiKey } = issueMcpApiKeyForAgent(getDb(), agentId, 'test atlas key');
    const { server, baseUrl } = await startTestServer();

    try {
      const client = new AgentHqApiClient(baseUrl, apiKey);
      await client.moveTask(taskId, { status: 'ready' });

      const task = getDb().prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string };
      const history = getDb().prepare(`
        SELECT changed_by, field, old_value, new_value
        FROM task_history
        WHERE task_id = ? AND field = 'status'
        ORDER BY id DESC
        LIMIT 1
      `).get(taskId) as { changed_by: string; field: string; old_value: string; new_value: string };

      expect(task.status).toBe('ready');
      expect(history).toMatchObject({
        changed_by: 'atlas',
        field: 'status',
        old_value: 'todo',
        new_value: 'ready',
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects an MCP task status update with an invalid or unmapped API key', async () => {
    const { taskId } = seedAtlasTask();
    const { server, baseUrl } = await startTestServer();

    try {
      const client = new AgentHqApiClient(baseUrl, 'ahq_mcp_invalid');
      await expect(client.moveTask(taskId, { status: 'ready' })).rejects.toThrow('Invalid MCP API key');

      const task = getDb().prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string };
      expect(task.status).toBe('todo');
    } finally {
      await stopTestServer(server);
    }
  });
});
