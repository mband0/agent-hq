import 'dotenv/config';
// Load supplementary secrets (e.g. Veri API key) from ~/.openclaw/secrets/
import { config as dotenvConfig } from 'dotenv';
import os from 'os';
import path from 'path';
const SECRETS_DIR = path.join(process.env.HOME ?? os.homedir(), '.openclaw', 'secrets');
dotenvConfig({ path: path.join(SECRETS_DIR, 'veri.env'), override: false });

// Must be set after dotenv loads but before any fetch/TLS calls.
// dotenv/config is synchronous, so process.env is populated by now.
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  // Re-affirm for Node's TLS stack (some runtimes cache this early)
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
import express from 'express';
import cors from 'cors';
import { initSchema } from './db/schema';
import agentsRouter from './routes/agents';
import skillsRouter from './routes/skills';
import logsRouter from './routes/logs';
import projectsRouter from './routes/projects';
import artifactsRouter from './routes/artifacts';
import chatRouter, { setupChatProxy } from './routes/chat';
import tasksRouter from './routes/tasks';
import instancesRouter from './routes/instances';
import sprintsRouter, { checkSprintCompletion } from './routes/sprints';
import { WebSocketServer } from 'ws';
import * as http from 'http';
import { startScheduler } from './scheduler';
import { startSprintScheduler } from './scheduler/sprintScheduler';
import { startWatchdog } from './scheduler/watchdog';
import { startReconciler } from './scheduler/reconciler';
import projectFilesRouter from './routes/project-files';
import telemetryRouter from './routes/telemetry';
import routingRouter, { ensureRoutingMetadata } from './routes/routing';
import dispatchRouter from './routes/dispatch';
import modelRoutingRouter from './routes/model-routing';
import browserRouter from './routes/browser';
import setupRouter from './routes/setup';
import settingsRouter from './routes/settings';
import toolsRouter, { agentToolsRouter } from './routes/tools';
import mcpServersRouter, { agentMcpServersRouter } from './routes/mcp-servers';
import providersRouter from './routes/providers';
import githubIdentitiesRouter from './routes/github-identities';
import sessionsRouter from './routes/sessions';
import { shutdownPool as shutdownBrowserPool } from './services/browserPool';

const app = express();
const PORT = process.env.PORT ?? 3501;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'Atlas HQ API', ts: new Date().toISOString() });
});

// API routes
app.use('/api/v1/agents', agentsRouter);
app.use('/api/v1/skills', skillsRouter);
app.use('/api/v1/logs', logsRouter);
app.use('/api/v1/projects', projectsRouter);
app.use('/api/v1/artifacts', artifactsRouter);
app.use('/api/v1/chat', chatRouter);
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/instances', instancesRouter);
app.use('/api/v1/sprints', sprintsRouter);
app.get('/api/v1/workflow-templates', (req, res) => {
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(307, `/api/v1/sprints/workflow-templates${query}`);
});
app.get('/api/v1/sprint-types', (_req, res) => {
  res.redirect(307, '/api/v1/sprints/types/list');
});
app.use('/api/v1/projects/:id/files', projectFilesRouter);
app.use('/api/v1/telemetry', telemetryRouter);
app.use('/api/v1/routing', routingRouter);
app.use('/api/v1/dispatch', dispatchRouter);
app.use('/api/v1/model-routing', modelRoutingRouter);
app.use('/api/v1/browser', browserRouter);
app.use('/api/v1/setup', setupRouter);
app.use('/api/v1/settings', settingsRouter);
app.use('/api/v1/tools', toolsRouter);
app.use('/api/v1/agents/:id/tools', agentToolsRouter);
app.use('/api/v1/mcp-servers', mcpServersRouter);
app.use('/api/v1/agents/:id/mcp-servers', agentMcpServersRouter);
app.use('/api/v1/providers', providersRouter);
app.use('/api/v1/github-identities', githubIdentitiesRouter);
app.use('/api/v1/sessions', sessionsRouter);

// Instances route (shortcut for Kanban)
app.get('/api/v1/instances', (_req, res) => {
  try {
    const { getDb } = require('./db/client');
    const db = getDb();
    const instances = db.prepare(`
      SELECT ji.*, a.job_title as job_title, a.name as agent_name, a.session_key as agent_session_key,
             t.title as task_title, t.status as task_status
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id
      LEFT JOIN tasks t ON t.id = ji.task_id
      ORDER BY ji.created_at DESC
      LIMIT 200
    `).all();
    res.json(instances);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Dashboard stats
app.get('/api/v1/stats', (_req, res) => {
  try {
    const { getDb } = require('./db/client');
    const db = getDb();

    const totalAgents = (db.prepare('SELECT COUNT(*) as n FROM agents').get() as { n: number }).n;
    const activeJobs = (db.prepare("SELECT COUNT(*) as n FROM job_instances WHERE status IN ('queued','dispatched','running')").get() as { n: number }).n;
    const runningJobs = (db.prepare("SELECT COUNT(*) as n FROM job_instances WHERE status = 'running'").get() as { n: number }).n;
    const pendingJobs = (db.prepare("SELECT COUNT(*) as n FROM job_instances WHERE status IN ('queued','dispatched')").get() as { n: number }).n;
    const recentRuns = (db.prepare("SELECT COUNT(*) as n FROM job_instances WHERE created_at >= datetime('now', '-24 hours')").get() as { n: number }).n;
    const failedRecent = (db.prepare("SELECT COUNT(*) as n FROM job_instances WHERE status = 'failed' AND created_at >= datetime('now', '-24 hours')").get() as { n: number }).n;
    const doneRecent = (db.prepare("SELECT COUNT(*) as n FROM job_instances WHERE status = 'done' AND created_at >= datetime('now', '-24 hours')").get() as { n: number }).n;
    const enabledTemplates = (db.prepare('SELECT COUNT(*) as n FROM agents WHERE enabled = 1').get() as { n: number }).n;
    // created_at is stored as UTC. We compare against UTC start of the current local calendar day.
    // strftime('%Y-%m-%d', 'now', 'localtime') gives today's local date; appending ' 00:00:00'
    // yields the UTC midnight of the local day so the comparison is timezone-correct.
    const todayTokenUsage = (db.prepare(`
      SELECT COALESCE(SUM(COALESCE(token_total, COALESCE(token_input, 0) + COALESCE(token_output, 0))), 0) as n
      FROM job_instances
      WHERE created_at >= strftime('%Y-%m-%d', 'now', 'localtime') || ' 00:00:00'
    `).get() as { n: number }).n;

    const recentFailed = db.prepare(`
      SELECT ji.*, a.job_title as job_title, a.name as agent_name
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id
      WHERE ji.status = 'failed' AND ji.created_at >= datetime('now', '-24 hours')
      ORDER BY ji.created_at DESC
      LIMIT 5
    `).all();

    res.json({
      totalAgents,
      activeJobs,
      runningJobs,
      pendingJobs,
      recentRuns,
      failedRecent,
      doneRecent,
      enabledTemplates,
      todayTokenUsage,
      recentFailed,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Init DB and start
initSchema();
ensureRoutingMetadata();
startScheduler();
startSprintScheduler();
startWatchdog();
startReconciler();

// Sprint heartbeat: check every 5 min for time/run-limit exceeded sprints
setInterval(() => {
  try { checkSprintCompletion(); } catch (err) { console.error('[sprints] Heartbeat error:', err); }
}, 5 * 60 * 1000);

const server = http.createServer(app);

// WebSocket proxy for chat (bridges browser → Gateway wss://)
const wss = new WebSocketServer({ server, path: '/api/v1/chat/ws' });
setupChatProxy(wss);

server.listen(PORT, () => {
  console.log(`Atlas HQ API running on http://localhost:${PORT}`);
});

// Graceful shutdown: close browser pool
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.log(`[shutdown] Received ${sig}, shutting down browser pool...`);
    await shutdownBrowserPool();
    process.exit(0);
  });
}

export default app;
