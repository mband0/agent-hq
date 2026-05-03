/**
 * seed-dev.ts — Seed the Dev database with representative data.
 *
 * Usage:
 *   AGENT_HQ_DB_PATH=/path/to/agent-hq-dev.db \
 *   npx tsx src/db/seed-dev.ts
 *
 * This script is safe to re-run — it checks for existing rows before inserting.
 * It does NOT touch the production DB (agent-hq.db).
 */

import os from 'os';
import { initSchema } from './schema';
import { getDb } from './client';

const HOME = process.env.HOME ?? os.homedir();
const OPENCLAW_DIR = process.env.WORKSPACE_PARENT ?? `${HOME}/.openclaw`;

console.log(`[seed-dev] DB path: ${process.env.AGENT_HQ_DB_PATH ?? '(default)'}`);

// Initialize schema first (idempotent)
initSchema();

const db = getDb();

function seedIfEmpty(table: string, checkSql: string, insertFn: () => void): void {
  const row = db.prepare(checkSql).get() as { cnt: number } | undefined;
  if (!row || row.cnt === 0) {
    insertFn();
    console.log(`[seed-dev] Seeded table: ${table}`);
  } else {
    console.log(`[seed-dev] Skipped (already seeded): ${table}`);
  }
}

// ── Projects ──────────────────────────────────────────────────────────────────
seedIfEmpty(
  'projects',
  'SELECT COUNT(*) AS cnt FROM projects',
  () => {
    db.prepare(`
      INSERT INTO projects (name, description, context_md) VALUES
        ('Agency', 'Dev sandbox: General IT agency work bucket', '## Agency (dev)\nDev environment — safe to mutate.'),
        ('Agent HQ', 'Dev sandbox: Agent HQ internal platform project', '## Agent HQ (dev)\nDev environment — safe to mutate.')
    `).run();
  }
);

// ── Agents ────────────────────────────────────────────────────────────────────
// Insert missing dev agents by session_key — safe to run multiple times
// Pixel claude-code runtime config (task #306 migration)
const pixelRuntimeConfig = JSON.stringify({
  workingDirectory: `${OPENCLAW_DIR}/workspace-agency-frontend`,
  model: 'claude-sonnet-4-6',
  effort: 'high',
  allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  maxTurns: 150,
  maxBudgetUsd: 5.00,
});

// Forge claude-code runtime config (task #305 migration)
const forgeRuntimeConfig = JSON.stringify({
  workingDirectory: `${OPENCLAW_DIR}/workspace-agency-backend`,
  model: 'claude-sonnet-4-6',
  effort: 'high',
  allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
  maxTurns: 150,
  maxBudgetUsd: 5.00,
});

const devAgents = [
  { name: 'Atlas',          role: 'Built-in assistant — dev session',       session_key: 'agent:atlas:main',            workspace_path: `${OPENCLAW_DIR}/workspace-atlas`,            openclaw_agent_id: 'atlas',           runtime_type: 'openclaw',    runtime_config: null, system_role: 'atlas' },
  { name: 'Forge',          role: 'Senior Backend Engineer — dev session',   session_key: 'agent:agency-backend:main',   workspace_path: `${OPENCLAW_DIR}/workspace-agency-backend`,  openclaw_agent_id: 'agency-backend',  runtime_type: 'claude-code', runtime_config: forgeRuntimeConfig },
  { name: 'Kai',            role: 'Developer Tools Engineer — dev session',  session_key: 'agent:agency-tools:main',     workspace_path: `${OPENCLAW_DIR}/workspace-agency-tools`,    openclaw_agent_id: null,              runtime_type: 'claude-code', runtime_config: forgeRuntimeConfig },
  { name: 'Pixel',          role: 'Senior Frontend Engineer — dev session',  session_key: 'agent:agency-frontend:main',  workspace_path: `${OPENCLAW_DIR}/workspace-agency-frontend`, openclaw_agent_id: null,              runtime_type: 'claude-code', runtime_config: pixelRuntimeConfig },
  { name: 'Harbor (DevOps)',role: 'Release engineer / DevOps — dev session', session_key: 'agent:agency-devops:main',    workspace_path: `${OPENCLAW_DIR}/workspace-agency-devops`,   openclaw_agent_id: null,              runtime_type: 'openclaw',    runtime_config: null },
  { name: 'Vera',           role: 'QA Engineer — dev session',               session_key: 'agent:agency-qa:main',        workspace_path: `${OPENCLAW_DIR}/workspace-agency-qa`,       openclaw_agent_id: 'agency-qa',       runtime_type: 'openclaw',    runtime_config: null },
];

const insertAgent = db.prepare(`
  INSERT INTO agents (name, role, session_key, workspace_path, openclaw_agent_id, runtime_type, runtime_config, status, system_role)
  SELECT ?, ?, ?, ?, ?, ?, ?, 'idle', ?
  WHERE NOT EXISTS (SELECT 1 FROM agents WHERE session_key = ?)
`);
let agentsAdded = 0;
for (const agent of devAgents) {
  const res = insertAgent.run(agent.name, agent.role, agent.session_key, agent.workspace_path, agent.openclaw_agent_id, agent.runtime_type, agent.runtime_config, agent.system_role ?? null, agent.session_key);
  agentsAdded += Number(res.changes);
}
console.log(`[seed-dev] Agents: ${agentsAdded} added (existing skipped).`);

// ── Sprints ───────────────────────────────────────────────────────────────────
seedIfEmpty(
  'sprints',
  'SELECT COUNT(*) AS cnt FROM sprints',
  () => {
    // We need a project id — get first agency project
    const agencyProject = db.prepare(`SELECT id FROM projects WHERE name = 'Agency' LIMIT 1`).get() as { id: number } | undefined;
    const atlasProject  = db.prepare(`SELECT id FROM projects WHERE name = 'Agent HQ' LIMIT 1`).get() as { id: number } | undefined;

    if (agencyProject) {
      db.prepare(`
        INSERT INTO sprints (project_id, name, goal, sprint_type, status, length_kind, length_value) VALUES
          (?, 'Dev Sprint 1', 'Validate dev environment isolation and seed data', 'dev', 'active', 'time', '2w')
      `).run(agencyProject.id);
    }
    if (atlasProject) {
      db.prepare(`
        INSERT INTO sprints (project_id, name, goal, sprint_type, status, length_kind, length_value) VALUES
          (?, 'Agent HQ Enhancements (dev)', 'Test Agent HQ feature work in isolation', 'dev', 'active', 'time', '2w')
      `).run(atlasProject.id);
    }
  }
);

// ── Job Templates (removed — Task #579) ──────────────────────────────────────
// job_templates table has been dropped. Agent lanes are now configured directly
// on the agents table via job_title, pre_instructions, schedule, etc.

// ── Routing: task statuses ────────────────────────────────────────────────────
// (Routing rules are inserted by initSchema/migrations if they exist, so we skip here)

// ── Sample Tasks ──────────────────────────────────────────────────────────────
seedIfEmpty(
  'tasks',
  'SELECT COUNT(*) AS cnt FROM tasks',
  () => {
    const agencyProject = db.prepare(`SELECT id FROM projects WHERE name = 'Agency' LIMIT 1`).get() as { id: number } | undefined;
    const sprint = db.prepare(`SELECT id FROM sprints WHERE name = 'Dev Sprint 1' LIMIT 1`).get() as { id: number } | undefined;
    const forgeAgent = db.prepare(`SELECT id FROM agents WHERE session_key = 'agent:agency-backend:main' LIMIT 1`).get() as { id: number } | undefined;

    if (agencyProject) {
      db.prepare(`
        INSERT INTO tasks (title, description, status, priority, project_id, sprint_id, agent_id) VALUES
          ('Sample dev task — todo', 'A representative task in todo state for dev/test use', 'todo', 'medium', ?, ?, ?),
          ('Sample dev task — in_progress', 'A representative task in in_progress state for dev/test use', 'in_progress', 'high', ?, ?, ?),
          ('Sample dev task — review', 'A representative task in review state for dev/test use', 'review', 'low', ?, ?, ?)
      `).run(
        agencyProject.id, sprint?.id ?? null, forgeAgent?.id ?? null,
        agencyProject.id, sprint?.id ?? null, forgeAgent?.id ?? null,
        agencyProject.id, sprint?.id ?? null, forgeAgent?.id ?? null
      );
    }
  }
);

// ── Routing config (minimal) ──────────────────────────────────────────────────
// Only seed if routing_configs table exists and is empty
try {
  const routingCount = db.prepare(`SELECT COUNT(*) AS cnt FROM routing_configs`).get() as { cnt: number } | undefined;
  if (routingCount && routingCount.cnt === 0) {
    const agencyProject = db.prepare(`SELECT id FROM projects WHERE name = 'Agency' LIMIT 1`).get() as { id: number } | undefined;
    if (agencyProject) {
      db.prepare(`
        INSERT INTO routing_configs (project_id, from_status, outcome, to_status, lane, enabled) VALUES
          (?, 'in_progress', 'completed_for_review', 'review', 'dev', 1),
          (?, 'review', 'qa_pass', 'done', 'dev', 1),
          (?, 'review', 'qa_fail', 'in_progress', 'dev', 1)
      `).run(agencyProject.id, agencyProject.id, agencyProject.id);
      console.log('[seed-dev] Seeded table: routing_configs');
    }
  }
} catch {
  // routing_configs table may not exist in older schemas — skip
}

console.log('[seed-dev] Done.');
