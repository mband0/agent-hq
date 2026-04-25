import 'dotenv/config';

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
const HOST = process.env.HOST ?? '0.0.0.0';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function dispatchToSprintsAlias(req: express.Request, res: express.Response, targetUrl: string): void {
  const originalUrl = req.url;
  req.url = targetUrl;
  sprintsRouter(req, res, () => {
    req.url = originalUrl;
  });
}

function resolveSprintTypeKey(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'Agent HQ API', ts: new Date().toISOString() });
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
app.get('/api/v1/workflow-templates', (req, res, next) => {
  req.url = `/workflow-templates${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  sprintsRouter(req, res, next);
});
app.get('/api/v1/workflow-templates/:templateId', (req, res, next) => {
  req.url = `/workflow-templates/${encodeURIComponent(req.params.templateId)}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  sprintsRouter(req, res, next);
});
app.get('/api/v1/sprints/workflow-templates', (req, res, next) => {
  req.url = `/workflow-templates${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  sprintsRouter(req, res, next);
});
app.get('/api/v1/sprints/workflow-templates/:templateId', (req, res, next) => {
  req.url = `/workflow-templates/${encodeURIComponent(req.params.templateId)}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  sprintsRouter(req, res, next);
});
app.get('/api/v1/sprint-types', (_req, res) => {
  res.redirect(307, '/api/v1/sprints/types/list');
});
app.post('/api/v1/sprint-types', (_req, res) => {
  res.redirect(307, '/api/v1/sprints/types');
});
app.get('/api/v1/sprint-types/:key', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}`);
});
app.put('/api/v1/sprint-types/:key', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}`);
});
app.delete('/api/v1/sprint-types/:key', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}`);
});
app.get('/api/v1/sprint-types/:key/task-types', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/task-types`);
});
app.put('/api/v1/sprint-types/:key/task-types', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/task-types`);
});
app.get('/api/v1/sprint-types/:key/field-schemas', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas`);
});
app.post('/api/v1/sprint-types/:key/field-schemas', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas`);
});
app.get('/api/v1/sprint-types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.put('/api/v1/sprint-types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.delete('/api/v1/sprint-types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.get('/api/v1/sprint-types/:key/workflow-templates', (req, res, next) => {
  req.url = `/types/${encodeURIComponent(req.params.key)}/workflow-templates${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  sprintsRouter(req, res, next);
});
app.post('/api/v1/sprint-types/:key/workflow-templates', (req, res, next) => {
  req.url = `/types/${encodeURIComponent(req.params.key)}/workflow-templates${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  sprintsRouter(req, res, next);
});
app.get('/api/v1/sprint-types/:key/workflow-templates/:templateId', (req, res, next) => {
  req.url = `/types/${encodeURIComponent(req.params.key)}/workflow-templates/${encodeURIComponent(req.params.templateId)}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  sprintsRouter(req, res, next);
});
app.put('/api/v1/sprint-types/:key/workflow-templates/:templateId', (req, res, next) => {
  req.url = `/types/${encodeURIComponent(req.params.key)}/workflow-templates/${encodeURIComponent(req.params.templateId)}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  sprintsRouter(req, res, next);
});
app.delete('/api/v1/sprint-types/:key/workflow-templates/:templateId', (req, res, next) => {
  req.url = `/types/${encodeURIComponent(req.params.key)}/workflow-templates/${encodeURIComponent(req.params.templateId)}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  sprintsRouter(req, res, next);
});
app.get('/api/v1/task-definitions', (_req, res) => {
  res.redirect(307, '/api/v1/sprints/config');
});
app.get('/api/v1/task-definitions/config', (_req, res) => {
  res.redirect(307, '/api/v1/sprints/config');
});
app.get('/api/v1/task-definitions/sprint-types', (_req, res) => {
  res.redirect(307, '/api/v1/sprints/types/list');
});
app.post('/api/v1/task-definitions/sprint-types', (_req, res) => {
  res.redirect(307, '/api/v1/sprints/types');
});
app.get('/api/v1/task-definitions/sprint-types/:key', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}`);
});
app.put('/api/v1/task-definitions/sprint-types/:key', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}`);
});
app.delete('/api/v1/task-definitions/sprint-types/:key', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}`);
});
app.get('/api/v1/task-definitions/sprint-types/:key/task-types', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/task-types`);
});
app.put('/api/v1/task-definitions/sprint-types/:key/task-types', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/task-types`);
});
app.get('/api/v1/task-definitions/sprint-types/:key/field-schemas', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas`);
});
app.post('/api/v1/task-definitions/sprint-types/:key/field-schemas', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas`);
});
app.get('/api/v1/task-definitions/sprint-types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.put('/api/v1/task-definitions/sprint-types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.delete('/api/v1/task-definitions/sprint-types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.get('/api/v1/task-field-schemas', (req, res) => {
  const sprintTypeKey = typeof req.query.sprint_type_key === 'string'
    ? req.query.sprint_type_key
    : typeof req.query.sprint_type === 'string'
      ? req.query.sprint_type
      : '';
  if (!sprintTypeKey.trim()) {
    return res.status(400).json({
      error: 'sprint_type_key is required',
      supported_query_params: ['sprint_type_key', 'sprint_type'],
      canonical_path_template: '/api/v1/sprints/types/:key/field-schemas',
    });
  }
  dispatchToSprintsAlias(req, res, `/types/${encodeURIComponent(sprintTypeKey)}/field-schemas`);
});
app.post('/api/v1/task-field-schemas', (req, res) => {
  const sprintTypeKey = typeof req.body?.sprint_type_key === 'string'
    ? req.body.sprint_type_key
    : typeof req.body?.sprint_type === 'string'
      ? req.body.sprint_type
      : '';
  if (!sprintTypeKey.trim()) {
    return res.status(400).json({
      error: 'sprint_type_key is required',
      supported_body_fields: ['sprint_type_key', 'sprint_type', 'task_type', 'schema'],
      canonical_path_template: '/api/v1/sprints/types/:key/field-schemas',
    });
  }
  req.url = `/types/${encodeURIComponent(sprintTypeKey)}/field-schemas`;
  sprintsRouter(req, res, () => undefined);
});
app.get('/api/v1/task-field-schemas/:schemaId', (req, res) => {
  const sprintTypeKey = typeof req.query.sprint_type_key === 'string'
    ? req.query.sprint_type_key
    : typeof req.query.sprint_type === 'string'
      ? req.query.sprint_type
      : '';
  if (!sprintTypeKey.trim()) {
    return res.status(400).json({
      error: 'sprint_type_key is required',
      supported_query_params: ['sprint_type_key', 'sprint_type'],
      canonical_path_template: '/api/v1/sprints/types/:key/field-schemas/:schemaId',
    });
  }
  dispatchToSprintsAlias(req, res, `/types/${encodeURIComponent(sprintTypeKey)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.put('/api/v1/task-field-schemas/:schemaId', (req, res) => {
  const sprintTypeKey = typeof req.body?.sprint_type_key === 'string'
    ? req.body.sprint_type_key
    : typeof req.body?.sprint_type === 'string'
      ? req.body.sprint_type
      : typeof req.query.sprint_type_key === 'string'
        ? req.query.sprint_type_key
        : typeof req.query.sprint_type === 'string'
          ? req.query.sprint_type
          : '';
  if (!sprintTypeKey.trim()) {
    return res.status(400).json({
      error: 'sprint_type_key is required',
      supported_fields: ['sprint_type_key', 'sprint_type', 'task_type', 'schema'],
      canonical_path_template: '/api/v1/sprints/types/:key/field-schemas/:schemaId',
    });
  }
  req.url = `/types/${encodeURIComponent(sprintTypeKey)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`;
  sprintsRouter(req, res, () => undefined);
});
app.delete('/api/v1/task-field-schemas/:schemaId', (req, res) => {
  const sprintTypeKey = typeof req.body?.sprint_type_key === 'string'
    ? req.body.sprint_type_key
    : typeof req.body?.sprint_type === 'string'
      ? req.body.sprint_type
      : typeof req.query.sprint_type_key === 'string'
        ? req.query.sprint_type_key
        : typeof req.query.sprint_type === 'string'
          ? req.query.sprint_type
          : '';
  if (!sprintTypeKey.trim()) {
    return res.status(400).json({
      error: 'sprint_type_key is required',
      supported_fields: ['sprint_type_key', 'sprint_type'],
      canonical_path_template: '/api/v1/sprints/types/:key/field-schemas/:schemaId',
    });
  }
  req.url = `/types/${encodeURIComponent(sprintTypeKey)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`;
  sprintsRouter(req, res, () => undefined);
});
app.get('/api/v1/task-field-definitions', (req, res) => {
  const sprintTypeKey = resolveSprintTypeKey(req.query.sprint_type_key)
    || resolveSprintTypeKey(req.query.sprint_type);
  if (!sprintTypeKey) {
    return res.status(400).json({
      error: 'sprint_type_key is required',
      supported_query_params: ['sprint_type_key', 'sprint_type'],
      canonical_path_template: '/api/v1/sprints/types/:key/field-schemas',
      alias_of: '/api/v1/task-field-schemas',
    });
  }
  dispatchToSprintsAlias(req, res, `/types/${encodeURIComponent(sprintTypeKey)}/field-schemas`);
});
app.post('/api/v1/task-field-definitions', (req, res) => {
  req.url = `/task-field-schemas`;
  app._router.handle(req, res, () => undefined);
});
app.get('/api/v1/task-field-definitions/:schemaId', (req, res) => {
  const sprintTypeKey = resolveSprintTypeKey(req.query.sprint_type_key)
    || resolveSprintTypeKey(req.query.sprint_type);
  if (!sprintTypeKey) {
    return res.status(400).json({
      error: 'sprint_type_key is required',
      supported_query_params: ['sprint_type_key', 'sprint_type'],
      canonical_path_template: '/api/v1/sprints/types/:key/field-schemas/:schemaId',
      alias_of: '/api/v1/task-field-schemas/:schemaId',
    });
  }
  dispatchToSprintsAlias(req, res, `/types/${encodeURIComponent(sprintTypeKey)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.put('/api/v1/task-field-definitions/:schemaId', (req, res) => {
  req.url = `/task-field-schemas/${encodeURIComponent(req.params.schemaId)}`;
  app._router.handle(req, res, () => undefined);
});
app.delete('/api/v1/task-field-definitions/:schemaId', (req, res) => {
  req.url = `/task-field-schemas/${encodeURIComponent(req.params.schemaId)}`;
  app._router.handle(req, res, () => undefined);
});
app.get('/api/v1/task-definitions/sprint-types/:key/workflow-templates', (req, res, next) => {
  req.url = `/types/${encodeURIComponent(req.params.key)}/workflow-templates${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  sprintsRouter(req, res, next);
});
app.post('/api/v1/task-definitions/sprint-types/:key/workflow-templates', (req, res, next) => {
  req.url = `/types/${encodeURIComponent(req.params.key)}/workflow-templates${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  sprintsRouter(req, res, next);
});
app.get('/api/v1/task-definitions/sprint-types/:key/workflow-templates/:templateId', (req, res, next) => {
  req.url = `/types/${encodeURIComponent(req.params.key)}/workflow-templates/${encodeURIComponent(req.params.templateId)}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  sprintsRouter(req, res, next);
});
app.put('/api/v1/task-definitions/sprint-types/:key/workflow-templates/:templateId', (req, res, next) => {
  req.url = `/types/${encodeURIComponent(req.params.key)}/workflow-templates/${encodeURIComponent(req.params.templateId)}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  sprintsRouter(req, res, next);
});
app.delete('/api/v1/task-definitions/sprint-types/:key/workflow-templates/:templateId', (req, res, next) => {
  req.url = `/types/${encodeURIComponent(req.params.key)}/workflow-templates/${encodeURIComponent(req.params.templateId)}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  sprintsRouter(req, res, next);
});
app.get('/api/v1/routing-rules', (req, res, next) => {
  req.url = `/rules${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  routingRouter(req, res, next);
});
app.post('/api/v1/routing-rules', (req, res, next) => {
  req.url = `/rules${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  routingRouter(req, res, next);
});
app.get('/api/v1/routing-rules/:id', (req, res, next) => {
  req.url = `/rules/${encodeURIComponent(req.params.id)}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  routingRouter(req, res, next);
});
app.put('/api/v1/routing-rules/:id', (req, res, next) => {
  req.url = `/rules/${encodeURIComponent(req.params.id)}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  routingRouter(req, res, next);
});
app.delete('/api/v1/routing-rules/:id', (req, res, next) => {
  req.url = `/rules/${encodeURIComponent(req.params.id)}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  routingRouter(req, res, next);
});
app.use('/api/v1/projects/:id/files', projectFilesRouter);
app.use('/api/v1/telemetry', telemetryRouter);
app.use('/api/v1/routing', routingRouter);
app.use('/api/v1/dispatch', dispatchRouter);
app.use('/api/v1/model-routing', modelRoutingRouter);
app.use('/api/v1/story-point-routing', modelRoutingRouter);
app.use('/api/v1/model-routing-rules', modelRoutingRouter);
app.use('/api/v1/routing/model-routing', modelRoutingRouter);
app.use('/api/v1/routing/story-point-routing', modelRoutingRouter);
app.use('/api/v1/routing/model-routing-rules', modelRoutingRouter);
app.use('/api/v1/routing/model-routes', modelRoutingRouter);
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

console.log('[boot] http server created', { port: Number(PORT), host: HOST });

// WebSocket proxy for chat (bridges browser → Gateway wss://)
console.log('[boot] creating chat websocket server', { path: '/api/v1/chat/ws' });
const wss = new WebSocketServer({ server, path: '/api/v1/chat/ws' });
console.log('[boot] calling setupChatProxy');
setupChatProxy(wss);
console.log('[boot] setupChatProxy returned');

console.log('[boot] about to server.listen', { port: Number(PORT), host: HOST });
server.listen(Number(PORT), HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  console.log(`Agent HQ API running on http://${displayHost}:${PORT}`);
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
