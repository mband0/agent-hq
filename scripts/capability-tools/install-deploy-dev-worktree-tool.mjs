#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const requireFromApi = createRequire(path.join(repoRoot, 'api', 'package.json'));
const Database = requireFromApi('better-sqlite3');

const dbPath = process.env.AGENT_HQ_DB_PATH ?? path.join(repoRoot, 'agent-hq.db');
const bodyPath = path.join(scriptDir, 'deploy_dev_worktree.sh');
const implementationBody = fs.readFileSync(bodyPath, 'utf8');

const inputSchema = {
  type: 'object',
  properties: {
    repo_path: {
      type: 'string',
      description: 'Absolute path to the Agent HQ git checkout/worktree containing the committed source code to promote.',
    },
    dev_repo_path: {
      type: 'string',
      description: 'Persistent Agent HQ dev checkout to promote into. Defaults to /Users/nordini/agent-hq-dev.',
    },
    services: {
      type: 'string',
      enum: ['api', 'ui', 'both', 'api,ui'],
      description: 'Which dev services to rebuild/restart from the persistent dev checkout.',
    },
    health_check: {
      type: 'boolean',
      description: 'Whether to verify the dev API/UI after restart.',
    },
  },
  required: ['repo_path'],
};

const db = new Database(dbPath);
db.prepare(`
  INSERT INTO tools (name, slug, description, implementation_type, implementation_body, input_schema, permissions, tags, enabled)
  VALUES (@name, @slug, @description, @implementation_type, @implementation_body, @input_schema, @permissions, @tags, 1)
  ON CONFLICT(slug) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    implementation_type = excluded.implementation_type,
    implementation_body = excluded.implementation_body,
    input_schema = excluded.input_schema,
    permissions = excluded.permissions,
    tags = excluded.tags,
    enabled = excluded.enabled,
    updated_at = datetime('now')
`).run({
  name: 'Deploy Dev Worktree',
  slug: 'deploy_dev_worktree',
  description: 'Promote a committed Agent HQ workspace/worktree HEAD into the persistent dev checkout, then build and restart the dev PM2 services from that checkout.',
  implementation_type: 'shell',
  implementation_body: implementationBody,
  input_schema: JSON.stringify(inputSchema),
  permissions: 'exec',
  tags: JSON.stringify(['deployment', 'pm2', 'dev-environment', 'git-promotion']),
});

const row = db.prepare(`SELECT id, slug, updated_at FROM tools WHERE slug = ?`).get('deploy_dev_worktree');
console.log(JSON.stringify({ ok: true, dbPath, tool: row }, null, 2));
