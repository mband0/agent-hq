import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import modelRoutingRouter from './model-routing';
import { closeDb, getDb } from '../db/client';

let tempDir: string;
let dbPath: string;

function resetDb(): void {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-routing-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.AGENT_HQ_DB_PATH = dbPath;

  const db = getDb();
  db.exec(`
    CREATE TABLE story_point_model_routing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      max_points INTEGER NOT NULL,
      provider TEXT,
      model TEXT NOT NULL,
      fallback_model TEXT,
      max_turns INTEGER,
      max_budget_usd REAL,
      label TEXT,
      updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

async function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/model-routing', modelRoutingRouter);
  const server = await new Promise<Server>((resolve) => {
    const bound = app.listen(0, () => resolve(bound));
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind test server');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('model-routing aliases', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-routing-'));
    dbPath = path.join(tempDir, 'agent-hq-test.db');
    resetDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.AGENT_HQ_DB_PATH;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('accepts max_story_points alias on create and returns canonical story point fields', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/model-routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ min_story_points: 1, max_story_points: 2, provider: 'openai', model: 'gpt-5.4', priority: 5 }),
      });
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body).toEqual(expect.objectContaining({ max_points: 2, max_story_points: 2, min_story_points: 1, provider: 'openai', model: 'gpt-5.4' }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('lists serialized story point aliases for existing rules', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO story_point_model_routing (max_points, provider, model, fallback_model, label)
      VALUES (3, 'anthropic', 'claude-sonnet-4-5', NULL, 'small')
    `).run();

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/model-routing`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toEqual([
        expect.objectContaining({ max_points: 3, max_story_points: 3, min_story_points: 1, provider: 'anthropic' }),
      ]);
    } finally {
      await stopTestServer(server);
    }
  });
});
