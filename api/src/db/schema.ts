import Database from 'better-sqlite3';
import fs from 'fs';
import { getDb } from './client';
import { NODE_BIN_DIR } from '../config';
import { RELEASE_TASK_STATUSES, taskStatusesSqlList } from '../lib/taskStatuses';
import { extractTokenUsage } from '../lib/tokenUsage';
import { VALID_TASK_TYPES } from '../lib/taskTypes';
import os from 'os';
import path from 'path';
import {
  ATLAS_AGENT_NAME,
  ATLAS_AGENT_SLUG,
  ATLAS_SESSION_KEY,
  ATLAS_SYSTEM_ROLE,
  ATLAS_TELEGRAM_PREFIX,
  ATLAS_WORKSPACE_PATH,
  LEGACY_ATLAS_SESSION_KEY,
  LEGACY_ATLAS_TELEGRAM_PREFIX,
  LEGACY_MAIN_WORKSPACE_PATH,
  getAtlasAgentRecord,
} from '../lib/atlasAgent';
import {
  buildCanonicalAgentMainSessionKey,
  normalizeAgentRoleLabel,
  resolveRuntimeAgentSlug,
  slugifySessionKeyPart,
} from '../lib/sessionKeys';
import {
  STARTER_FIELD_SCHEMA_SEEDS,
  STARTER_SPRINT_TYPE_SEEDS,
  STARTER_SPRINT_TYPE_TASK_TYPE_SEEDS,
  STARTER_SPRINT_WORKFLOW_TEMPLATE_SEEDS,
} from '../lib/starterCatalog';
import { backfillAllSprintTaskPolicies } from '../lib/sprintTaskPolicy';

const HOME = process.env.HOME ?? os.homedir();
const OPENCLAW_DIR = process.env.WORKSPACE_PARENT ?? `${HOME}/.openclaw`;
const ATLAS_MIGRATION_SETTING_KEY = 'migration.task25.atlas_cutover.completed';

/**
 * ensureRoutingLegacyConfigTable — NO-OP (Task #596).
 * The routing_config_legacy table has been removed. This function is kept as a
 * stub so that existing callers don't break during the transition.
 */
export function ensureRoutingLegacyConfigTable(_db?: Database.Database): void {
  // No-op: routing_config_legacy table has been dropped (task #596)
}

function migrateAgentSessionKeysToCanonical(db: Database.Database): void {
  const agentColumns = new Set(
    (db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>).map((col) => col.name),
  );
  const hasProjectId = agentColumns.has('project_id');
  const hasOpenclawAgentId = agentColumns.has('openclaw_agent_id');
  const hasSystemRole = agentColumns.has('system_role');

  const query = hasProjectId
    ? `
      SELECT a.id, a.name, a.role, a.session_key,
             ${hasOpenclawAgentId ? 'a.openclaw_agent_id' : 'NULL AS openclaw_agent_id'},
             ${hasSystemRole ? 'a.system_role' : 'NULL AS system_role'},
             p.name AS project_name
      FROM agents a
      LEFT JOIN projects p ON p.id = a.project_id
      ORDER BY a.id ASC
    `
    : `
      SELECT a.id, a.name, a.role, a.session_key,
             ${hasOpenclawAgentId ? 'a.openclaw_agent_id' : 'NULL AS openclaw_agent_id'},
             ${hasSystemRole ? 'a.system_role' : 'NULL AS system_role'},
             NULL AS project_name
      FROM agents a
      ORDER BY a.id ASC
    `;

  const rows = db.prepare(query).all() as Array<{
    id: number;
    name: string | null;
    role: string | null;
    session_key: string | null;
    openclaw_agent_id: string | null;
    system_role: string | null;
    project_name: string | null;
  }>;

  const update = db.prepare(`
    UPDATE agents
    SET role = ?, session_key = ?, openclaw_agent_id = ?
    WHERE id = ?
  `);
  const sessionKeyOwner = db.prepare(`
    SELECT id FROM agents WHERE session_key = ? AND id != ? LIMIT 1
  `);

  for (const row of rows) {
    const nextRole = normalizeAgentRoleLabel(
      row.role,
      row.system_role === ATLAS_SYSTEM_ROLE ? 'General Assistant' : 'Agent',
    );

    const nextRuntimeSlug = resolveRuntimeAgentSlug({
      openclaw_agent_id: row.openclaw_agent_id,
      session_key: row.session_key,
      name: row.name,
    });
    let nextSessionKey = row.session_key;
    if (row.system_role !== ATLAS_SYSTEM_ROLE) {
      nextSessionKey = buildCanonicalAgentMainSessionKey({
        projectName: row.project_name,
        agentName: row.name,
        role: nextRole,
      });
      const collision = sessionKeyOwner.get(nextSessionKey, row.id) as { id: number } | undefined;
      if (collision) {
        nextSessionKey = buildCanonicalAgentMainSessionKey({
          projectName: row.project_name,
          agentNameSlug: `${slugifySessionKeyPart(row.name, 'agent')}-${row.id}`,
          role: nextRole,
        });
      }
    }

    const needsRoleUpdate = row.role !== nextRole;
    const needsSessionUpdate = row.system_role !== ATLAS_SYSTEM_ROLE && row.session_key !== nextSessionKey;
    const needsSlugUpdate = !row.openclaw_agent_id && !!nextRuntimeSlug;
    if (!needsRoleUpdate && !needsSessionUpdate && !needsSlugUpdate) continue;

    update.run(
      needsRoleUpdate ? nextRole : row.role,
      needsSessionUpdate ? nextSessionKey : row.session_key,
      nextRuntimeSlug ?? row.openclaw_agent_id,
      row.id,
    );
  }
}

export function initSchema(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      context_md   TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT '',
      session_key TEXT NOT NULL UNIQUE,
      workspace_path TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','running','blocked')),
      last_active TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- job_templates table removed (Task #579 — jobs→agents unification)

    CREATE TABLE IF NOT EXISTS job_instances (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id                  INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      task_id                   INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      status                    TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','dispatched','running','done','failed','cancelled')),
      session_key               TEXT,
      created_at                TEXT NOT NULL DEFAULT (datetime('now')),
      dispatched_at             TEXT,
      started_at                TEXT,
      completed_at              TEXT,
      payload_sent              TEXT,
      response                  TEXT,
      error                     TEXT,
      run_id                    TEXT,
      abort_attempted_at        TEXT,
      abort_status              TEXT,
      abort_error               TEXT,
      runtime_ended_at          TEXT,
      runtime_end_success       INTEGER,
      runtime_end_error         TEXT,
      runtime_end_source        TEXT,
      lifecycle_outcome_posted_at TEXT,
      token_input               INTEGER,
      token_output              INTEGER,
      token_total               INTEGER
    );

    CREATE TABLE IF NOT EXISTS logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER REFERENCES job_instances(id) ON DELETE SET NULL,
      agent_id    INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      job_title   TEXT NOT NULL DEFAULT '',
      level       TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('info','warn','error','debug')),
      message     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_logs_agent ON logs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_logs_instance ON logs(instance_id);
    CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_instances_agent ON job_instances(agent_id);
    CREATE INDEX IF NOT EXISTS idx_instances_status ON job_instances(status);
  `);

  // Legacy job_templates migrations removed — Task #579 (table dropped)

  // Safe migration: add model column to agents
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN model TEXT`);
    console.log('[schema] Migrated: added model to agents');
  } catch { /* already exists */ }

  // Safe migration: add openclaw_agent_id column to agents
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN openclaw_agent_id TEXT`);
    console.log('[schema] Migrated: added openclaw_agent_id to agents');
  } catch (_) { /* column already exists */ }

  // Safe migration: add runtime_type and runtime_config to agents
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN runtime_type TEXT NOT NULL DEFAULT 'openclaw'`);
    console.log('[schema] Migrated: added runtime_type to agents');
  } catch (_) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN runtime_config JSON`);
    console.log('[schema] Migrated: added runtime_config to agents');
  } catch (_) { /* column already exists */ }

  // Safe migration: add hooks_url column to agents (task #288)
  // Used for Docker/container routing — when set, the dispatcher POSTs to
  // <hooks_url>/hooks/agent instead of the host gateway. Null = host gateway.
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN hooks_url TEXT`);
    console.log('[schema] Migrated: added hooks_url to agents');
  } catch (_) { /* column already exists */ }

  // Safe migration: add hooks_auth_header column to agents (task #431)
  // Per-agent Authorization header for hooks_url dispatch.
  // When set, dispatcher uses this instead of the global HOOKS_TOKEN.
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN hooks_auth_header TEXT`);
    console.log('[schema] Migrated: added hooks_auth_header to agents');
  } catch (_) { /* column already exists */ }

  // Canonical session/transcript store (task #599)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      external_key  TEXT NOT NULL UNIQUE,
      runtime       TEXT NOT NULL,
      agent_id      INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      instance_id   INTEGER REFERENCES job_instances(id) ON DELETE SET NULL,
      project_id    INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','failed','abandoned')),
      title         TEXT NOT NULL DEFAULT '',
      started_at    TEXT,
      ended_at      TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      token_input   INTEGER,
      token_output  INTEGER,
      metadata      TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_instance ON sessions(instance_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_runtime_status ON sessions(runtime, status, started_at DESC);

    CREATE TABLE IF NOT EXISTS session_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      ordinal     INTEGER NOT NULL,
      role        TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
      event_type  TEXT NOT NULL DEFAULT 'text',
      content     TEXT NOT NULL DEFAULT '',
      event_meta  TEXT NOT NULL DEFAULT '{}',
      raw_payload TEXT,
      timestamp   TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_id, ordinal)
    );

    CREATE INDEX IF NOT EXISTS idx_session_messages_session_ts ON session_messages(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_session_messages_event_type ON session_messages(event_type);
  `);

  // Safe migration: create chat_messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id          TEXT PRIMARY KEY,
      agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      role        TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
      content     TEXT NOT NULL DEFAULT '',
      timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
      session_key TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_agent ON chat_messages(agent_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp);
  `);

  // Canonical current direct-chat session per agent/channel so all UI clients
  // converge on the same conversation and New Chat can rotate one shared key.
  db.exec(`
    CREATE TABLE IF NOT EXISTS canonical_chat_sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      channel     TEXT NOT NULL,
      session_key TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent_id, channel)
    );

    CREATE INDEX IF NOT EXISTS idx_canonical_chat_sessions_agent_channel
      ON canonical_chat_sessions(agent_id, channel);
  `);

  // Safe migration: add event_type column to chat_messages (task #532)
  // Valid event_type values: 'text' | 'thought' | 'tool_call' | 'tool_result' | 'turn_start' | 'system' | 'error'
  try {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN event_type TEXT NOT NULL DEFAULT 'text'`);
    console.log('[schema] Migrated: added event_type to chat_messages');
  } catch (_) { /* column already exists */ }

  // Safe migration: add event_meta column to chat_messages (task #532)
  // JSON blob for structured attributes (tool name, args, output, turn number, etc.)
  try {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN event_meta TEXT NOT NULL DEFAULT '{}'`);
    console.log('[schema] Migrated: added event_meta to chat_messages');
  } catch (_) { /* column already exists */ }

  // Safe migration: add instance_id column to chat_messages (task #468)
  // Links chat messages to a specific job instance for per-run transcript views.
  try {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN instance_id INTEGER REFERENCES job_instances(id) ON DELETE SET NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_instance ON chat_messages(instance_id)`);
    console.log('[schema] Migrated: added instance_id to chat_messages');
  } catch (_) { /* column already exists */ }

  // Safe migration: expand chat_messages.role CHECK to support structured transcript rows.
  // OpenClaw/Custom transcript capture can emit tool/system events, and older DBs with
  // role IN ('user','assistant') reject those rows during history import/live capture.
  // IMPORTANT: live DBs have drifted over time (for example an older session_key column).
  // Rebuild from the current sqlite_master DDL so we preserve every existing column
  // instead of assuming a hardcoded table shape.
  try {
    const chatMessagesDdl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_messages'`
    ).get() as { sql: string } | undefined)?.sql ?? '';
    if (chatMessagesDdl && !chatMessagesDdl.includes("'tool'")) {
      const cols = (db.prepare(`PRAGMA table_info(chat_messages)`).all() as { name: string }[]).map(c => c.name);
      const colList = cols.join(', ');
      const rebuiltDdl = chatMessagesDdl
        .replace(/CREATE TABLE\s+"?chat_messages"?/, 'CREATE TABLE chat_messages_new')
        .replace(
          /CHECK\s*\(\s*role\s+IN\s*\([^)]*\)\s*\)/,
          "CHECK(role IN ('user','assistant','system','tool'))"
        );

      db.pragma('foreign_keys = OFF');
      const migrate = db.transaction(() => {
        db.prepare(rebuiltDdl).run();
        db.prepare(`INSERT INTO chat_messages_new (${colList}) SELECT ${colList} FROM chat_messages`).run();
        db.prepare(`DROP TABLE chat_messages`).run();
        db.prepare(`ALTER TABLE chat_messages_new RENAME TO chat_messages`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_agent ON chat_messages(agent_id)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp)`).run();
        if (cols.includes('instance_id')) {
          db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_instance ON chat_messages(instance_id)`).run();
        }
      });
      migrate();
      db.pragma('foreign_keys = ON');
      console.log('[schema] Migrated: expanded chat_messages.role CHECK to include system/tool');
    }
  } catch (err) {
    db.pragma('foreign_keys = ON');
    console.error('[schema] Failed to migrate chat_messages role constraint:', err);
  }

  // Safe migration: create tasks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'todo' CHECK(status IN (${taskStatusesSqlList()})),
      priority     TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
      project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      agent_id     INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      dispatched_at TEXT,
      active_instance_id INTEGER REFERENCES job_instances(id) ON DELETE SET NULL,
      task_type    TEXT,
      story_points INTEGER,
      custom_fields_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id);
  `);

  // Safe migration: add recurring column to tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN recurring INTEGER NOT NULL DEFAULT 0`);
    console.log('[schema] Migrated: added recurring to tasks');
  } catch (_) { /* column already exists */ }

  // Safe migration: add dispatched_at to tasks for legacy/minimal DBs.
  // Background dispatch/watchdog code still reads this timestamp.
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN dispatched_at TEXT`);
    console.log('[schema] Migrated: added dispatched_at to tasks');
  } catch (_) { /* column already exists */ }

  // Safe migration: add task_type column to tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN task_type TEXT`);
    console.log('[schema] Migrated: added task_type to tasks');
  } catch (_) { /* column already exists */ }

  // Safe migration: add story_points column to tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN story_points INTEGER`);
    console.log('[schema] Migrated: added story_points to tasks');
  } catch (_) { /* column already exists */ }

  // Safe migration: sprints table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sprints (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      goal         TEXT NOT NULL DEFAULT '',
      sprint_type  TEXT NOT NULL DEFAULT 'generic',
      workflow_template_key TEXT,
      status       TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning','active','paused','complete','closed')),
      length_kind  TEXT NOT NULL DEFAULT 'time' CHECK(length_kind IN ('time','runs')),
      length_value TEXT NOT NULL DEFAULT '',
      started_at   TEXT,
      ended_at     TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sprints_project ON sprints(project_id);
    CREATE INDEX IF NOT EXISTS idx_sprints_status ON sprints(status);
  `);

  // Safe migration: ensure sprints includes sprint_type and closed status.
  // SQLite requires table rebuild to alter CHECK constraints or add missing columns safely
  // while preserving existing rows.
  try {
    const sprintsDdl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='sprints'`
    ).get() as { sql: string } | undefined)?.sql ?? '';
    const sprintCols = (db.prepare(`PRAGMA table_info(sprints)`).all() as {name:string}[]).map(c => c.name);
    const needsSprintsRebuild = Boolean(sprintsDdl) && (!sprintsDdl.includes("'closed'") || !sprintCols.includes('sprint_type') || !sprintCols.includes('workflow_template_key'));
    if (needsSprintsRebuild) {
      db.pragma('foreign_keys = OFF');
      const migrate = db.transaction(() => {
        db.prepare(`
          CREATE TABLE sprints_new (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            goal         TEXT NOT NULL DEFAULT '',
            sprint_type  TEXT NOT NULL DEFAULT 'generic',
            workflow_template_key TEXT,
            status       TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning','active','paused','complete','closed')),
            length_kind  TEXT NOT NULL DEFAULT 'time' CHECK(length_kind IN ('time','runs')),
            length_value TEXT NOT NULL DEFAULT '',
            started_at   TEXT,
            ended_at     TEXT,
            created_at   TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `).run();

        const hasSprintType = sprintCols.includes('sprint_type');
        const hasWorkflowTemplateKey = sprintCols.includes('workflow_template_key');
        const selectCols = sprintCols.join(', ');
        const extraInsertCols = [
          ...(hasSprintType ? [] : ['sprint_type']),
          ...(hasWorkflowTemplateKey ? [] : ['workflow_template_key']),
        ];
        const insertCols = extraInsertCols.length > 0 ? `${selectCols}, ${extraInsertCols.join(', ')}` : selectCols;
        const extraSelectExpr = [
          ...(hasSprintType ? [] : [`'generic' AS sprint_type`]),
          ...(hasWorkflowTemplateKey ? [] : ['NULL AS workflow_template_key']),
        ];
        const selectExpr = extraSelectExpr.length > 0 ? `${selectCols}, ${extraSelectExpr.join(', ')}` : selectCols;

        db.prepare(`INSERT INTO sprints_new (${insertCols}) SELECT ${selectExpr} FROM sprints`).run();
        db.prepare(`DROP TABLE sprints`).run();
        db.prepare(`ALTER TABLE sprints_new RENAME TO sprints`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_sprints_project ON sprints(project_id)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_sprints_status ON sprints(status)`).run();
      });
      migrate();
      db.pragma('foreign_keys = ON');
      console.log('[schema] Migrated: sprints schema updated with sprint_type + closed status support');
    }
  } catch (err) {
    db.pragma('foreign_keys = ON');
    console.warn('[schema] Sprints constraint migration skipped:', err);
  }

  // Sprint type registry + baseline field schema templates (task #2)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sprint_types (
      key         TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_system   INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_types_system ON sprint_types(is_system);

    CREATE TABLE IF NOT EXISTS task_field_schemas (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key  TEXT NOT NULL REFERENCES sprint_types(key) ON DELETE CASCADE,
      task_type        TEXT,
      schema_json      TEXT NOT NULL DEFAULT '{}',
      is_system        INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sprint_type_key, task_type)
    );
    CREATE INDEX IF NOT EXISTS idx_task_field_schemas_lookup ON task_field_schemas(sprint_type_key, task_type);

    CREATE TABLE IF NOT EXISTS sprint_type_task_types (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key  TEXT NOT NULL REFERENCES sprint_types(key) ON DELETE CASCADE,
      task_type        TEXT NOT NULL,
      is_system        INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sprint_type_key, task_type)
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_type_task_types_lookup ON sprint_type_task_types(sprint_type_key, task_type);

    CREATE TABLE IF NOT EXISTS sprint_workflow_templates (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key  TEXT NOT NULL REFERENCES sprint_types(key) ON DELETE CASCADE,
      key              TEXT NOT NULL,
      name             TEXT NOT NULL,
      description      TEXT NOT NULL DEFAULT '',
      is_default       INTEGER NOT NULL DEFAULT 1,
      is_system        INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sprint_type_key, key)
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_workflow_templates_lookup ON sprint_workflow_templates(sprint_type_key, is_default);

    CREATE TABLE IF NOT EXISTS sprint_workflow_statuses (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id      INTEGER NOT NULL REFERENCES sprint_workflow_templates(id) ON DELETE CASCADE,
      status_key       TEXT NOT NULL,
      label            TEXT NOT NULL,
      color            TEXT NOT NULL DEFAULT 'slate',
      stage_order      INTEGER NOT NULL DEFAULT 0,
      terminal         INTEGER NOT NULL DEFAULT 0,
      is_default_entry INTEGER NOT NULL DEFAULT 0,
      metadata_json    TEXT NOT NULL DEFAULT '{}',
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(template_id, status_key)
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_workflow_statuses_template_order ON sprint_workflow_statuses(template_id, stage_order);

    CREATE TABLE IF NOT EXISTS sprint_workflow_transitions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id      INTEGER NOT NULL REFERENCES sprint_workflow_templates(id) ON DELETE CASCADE,
      from_status_key  TEXT NOT NULL,
      to_status_key    TEXT NOT NULL,
      transition_key   TEXT NOT NULL,
      label            TEXT NOT NULL,
      outcome          TEXT,
      stage_order      INTEGER NOT NULL DEFAULT 0,
      is_system        INTEGER NOT NULL DEFAULT 1,
      metadata_json    TEXT NOT NULL DEFAULT '{}',
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(template_id, transition_key),
      UNIQUE(template_id, from_status_key, to_status_key)
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_workflow_transitions_template_from ON sprint_workflow_transitions(template_id, from_status_key, stage_order);
  `);

  const ensureColumn = (table: string, column: string, ddl: string): void => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some(col => col.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };

  ensureColumn('task_field_schemas', 'is_system', `is_system INTEGER NOT NULL DEFAULT 1`);
  ensureColumn('task_field_schemas', 'updated_at', `updated_at TEXT`);
  db.exec(`UPDATE task_field_schemas SET updated_at = COALESCE(updated_at, datetime('now'))`);
  const duplicateBaseSchemaSprintTypes = db.prepare(`
    SELECT sprint_type_key
    FROM task_field_schemas
    WHERE task_type IS NULL
    GROUP BY sprint_type_key
    HAVING COUNT(*) > 1
  `).all() as Array<{ sprint_type_key: string }>;
  if (duplicateBaseSchemaSprintTypes.length > 0) {
    const selectBaseSchemaRows = db.prepare(`
      SELECT id
      FROM task_field_schemas
      WHERE sprint_type_key = ? AND task_type IS NULL
      ORDER BY COALESCE(updated_at, created_at, datetime('now')) DESC, id DESC
    `);
    const deleteFieldSchema = db.prepare(`DELETE FROM task_field_schemas WHERE id = ?`);
    const dedupeBaseFieldSchemas = db.transaction(() => {
      for (const { sprint_type_key } of duplicateBaseSchemaSprintTypes) {
        const rows = selectBaseSchemaRows.all(sprint_type_key) as Array<{ id: number }>;
        for (const row of rows.slice(1)) {
          deleteFieldSchema.run(row.id);
        }
      }
    });
    dedupeBaseFieldSchemas();
    console.log(`[schema] Deduplicated task_field_schemas base rows for ${duplicateBaseSchemaSprintTypes.length} sprint type(s)`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_field_schemas_base_unique
    ON task_field_schemas(sprint_type_key)
    WHERE task_type IS NULL
  `);
  ensureColumn('sprint_type_task_types', 'is_system', `is_system INTEGER NOT NULL DEFAULT 1`);
  ensureColumn('sprint_type_task_types', 'updated_at', `updated_at TEXT`);
  db.exec(`UPDATE sprint_type_task_types SET updated_at = COALESCE(updated_at, datetime('now'))`);
  ensureColumn('sprint_workflow_templates', 'is_system', `is_system INTEGER NOT NULL DEFAULT 1`);
  ensureColumn('sprint_workflow_templates', 'updated_at', `updated_at TEXT`);
  db.exec(`UPDATE sprint_workflow_templates SET updated_at = COALESCE(updated_at, datetime('now'))`);

  const upsertSprintType = db.prepare(`
    INSERT INTO sprint_types (key, name, description, is_system)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      is_system = 1,
      updated_at = datetime('now')
  `);

  const updateBaseFieldSchema = db.prepare(`
    UPDATE task_field_schemas
    SET schema_json = ?, is_system = 1, updated_at = datetime('now')
    WHERE sprint_type_key = ? AND task_type IS NULL
  `);
  const insertBaseFieldSchema = db.prepare(`
    INSERT INTO task_field_schemas (sprint_type_key, task_type, schema_json, is_system)
    VALUES (?, NULL, ?, 1)
  `);
  const upsertBaseFieldSchema = (sprintTypeKey: string, schemaJson: string): void => {
    const result = updateBaseFieldSchema.run(schemaJson, sprintTypeKey);
    if (result.changes === 0) {
      insertBaseFieldSchema.run(sprintTypeKey, schemaJson);
    }
  };

  const upsertSprintTypeTaskType = db.prepare(`
    INSERT INTO sprint_type_task_types (sprint_type_key, task_type, is_system)
    VALUES (?, ?, 1)
    ON CONFLICT(sprint_type_key, task_type) DO UPDATE SET
      is_system = 1,
      updated_at = datetime('now')
  `);

  const upsertSprintWorkflowTemplate = db.prepare(`
    INSERT INTO sprint_workflow_templates (sprint_type_key, key, name, description, is_default, is_system)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(sprint_type_key, key) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      is_default = excluded.is_default,
      is_system = 1,
      updated_at = datetime('now')
  `);

  const upsertSprintWorkflowStatus = db.prepare(`
    INSERT INTO sprint_workflow_statuses (template_id, status_key, label, color, stage_order, terminal, is_default_entry, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(template_id, status_key) DO UPDATE SET
      label = excluded.label,
      color = excluded.color,
      stage_order = excluded.stage_order,
      terminal = excluded.terminal,
      is_default_entry = excluded.is_default_entry,
      metadata_json = excluded.metadata_json,
      updated_at = datetime('now')
  `);

  const upsertSprintWorkflowTransition = db.prepare(`
    INSERT INTO sprint_workflow_transitions (template_id, from_status_key, to_status_key, transition_key, label, outcome, stage_order, is_system, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(template_id, transition_key) DO UPDATE SET
      from_status_key = excluded.from_status_key,
      to_status_key = excluded.to_status_key,
      label = excluded.label,
      outcome = excluded.outcome,
      stage_order = excluded.stage_order,
      is_system = 1,
      metadata_json = excluded.metadata_json,
      updated_at = datetime('now')
  `);

  const sprintTypeSeeds = STARTER_SPRINT_TYPE_SEEDS;
  const fieldSchemaSeeds = STARTER_FIELD_SCHEMA_SEEDS;
  const sprintTypeTaskTypeSeeds = STARTER_SPRINT_TYPE_TASK_TYPE_SEEDS;
  const sprintWorkflowTemplateSeeds = STARTER_SPRINT_WORKFLOW_TEMPLATE_SEEDS;

  const sprintTypeSeedTx = db.transaction(() => {
    for (const sprintType of sprintTypeSeeds) {
      upsertSprintType.run(sprintType.key, sprintType.name, sprintType.description);
    }
    for (const seed of sprintTypeTaskTypeSeeds) {
      for (const taskType of seed.taskTypes) {
        upsertSprintTypeTaskType.run(seed.sprintType, taskType);
      }
    }
    for (const template of fieldSchemaSeeds) {
      upsertBaseFieldSchema(template.sprintType, JSON.stringify(template.schema));
    }
    for (const template of sprintWorkflowTemplateSeeds) {
      upsertSprintWorkflowTemplate.run(template.sprintType, template.key, template.name, template.description, template.isDefault);
      const templateRow = db.prepare(`SELECT id FROM sprint_workflow_templates WHERE sprint_type_key = ? AND key = ? LIMIT 1`).get(template.sprintType, template.key) as { id: number } | undefined;
      if (!templateRow) continue;
      for (const status of template.statuses) {
        upsertSprintWorkflowStatus.run(
          templateRow.id,
          status.status_key,
          status.label,
          status.color,
          status.stage_order,
          status.terminal ?? 0,
          status.is_default_entry ?? 0,
          JSON.stringify(status.metadata ?? {}),
        );
      }
      for (const transition of template.transitions) {
        upsertSprintWorkflowTransition.run(
          templateRow.id,
          transition.from_status_key,
          transition.to_status_key,
          transition.transition_key,
          transition.label,
          transition.outcome ?? null,
          transition.stage_order,
          JSON.stringify(transition.metadata ?? {}),
        );
      }
    }

    db.prepare(`
      UPDATE sprints
      SET workflow_template_key = COALESCE(
        (
          SELECT swt.key
          FROM sprint_workflow_templates swt
          WHERE swt.sprint_type_key = sprints.sprint_type AND swt.is_default = 1
          ORDER BY swt.id ASC
          LIMIT 1
        ),
        (
          SELECT swt.key
          FROM sprint_workflow_templates swt
          WHERE swt.sprint_type_key = sprints.sprint_type
          ORDER BY swt.is_default DESC, swt.id ASC
          LIMIT 1
        )
      )
      WHERE workflow_template_key IS NULL OR trim(workflow_template_key) = ''
    `).run();
  });
  sprintTypeSeedTx();

  // sprint_job_schedules, sprint_job_assignments, and job_templates sprint_id removed — Task #579 (tables dropped)

  // Safe migration: add sprint_id to tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN sprint_id INTEGER REFERENCES sprints(id) ON DELETE SET NULL`);
    console.log('[schema] Migrated: added sprint_id to tasks');
  } catch (_) { /* column already exists */ }

  // Legacy sprint scheduling tables were removed in task #596.
  // Do not recreate sprint_schedule_fires here, especially on older/minimal DBs,
  // because it references sprint_job_schedules, which no longer exists.

  // Task dependencies (blocker → blocked)
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_dependencies (
      blocker_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      blocked_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (blocker_id, blocked_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_deps_blocker ON task_dependencies(blocker_id);
    CREATE INDEX IF NOT EXISTS idx_task_deps_blocked ON task_dependencies(blocked_id);
  `);

  // Safe migration: add branch_url to tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN branch_url TEXT`);
    console.log('[schema] Migrated: added branch_url to tasks');
  } catch (_) { /* column already exists */ }

  // Safe migration: add custom_fields_json to tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN custom_fields_json TEXT NOT NULL DEFAULT '{}'`);
    console.log('[schema] Migrated: added custom_fields_json to tasks');
  } catch (_) { /* column already exists */ }

  const taskEvidenceColumns: Array<{ name: string; sql: string; log: string }> = [
    { name: 'review_branch', sql: `ALTER TABLE tasks ADD COLUMN review_branch TEXT`, log: 'review_branch' },
    { name: 'review_commit', sql: `ALTER TABLE tasks ADD COLUMN review_commit TEXT`, log: 'review_commit' },
    { name: 'review_url', sql: `ALTER TABLE tasks ADD COLUMN review_url TEXT`, log: 'review_url' },
    { name: 'qa_verified_commit', sql: `ALTER TABLE tasks ADD COLUMN qa_verified_commit TEXT`, log: 'qa_verified_commit' },
    { name: 'qa_tested_url', sql: `ALTER TABLE tasks ADD COLUMN qa_tested_url TEXT`, log: 'qa_tested_url' },
    { name: 'merged_commit', sql: `ALTER TABLE tasks ADD COLUMN merged_commit TEXT`, log: 'merged_commit' },
    { name: 'deployed_commit', sql: `ALTER TABLE tasks ADD COLUMN deployed_commit TEXT`, log: 'deployed_commit' },
    { name: 'deployed_at', sql: `ALTER TABLE tasks ADD COLUMN deployed_at TEXT`, log: 'deployed_at' },
    { name: 'live_verified_at', sql: `ALTER TABLE tasks ADD COLUMN live_verified_at TEXT`, log: 'live_verified_at' },
    { name: 'live_verified_by', sql: `ALTER TABLE tasks ADD COLUMN live_verified_by TEXT`, log: 'live_verified_by' },
    { name: 'deploy_target', sql: `ALTER TABLE tasks ADD COLUMN deploy_target TEXT`, log: 'deploy_target' },
    { name: 'evidence_json', sql: `ALTER TABLE tasks ADD COLUMN evidence_json TEXT`, log: 'evidence_json' },
  ];

  for (const column of taskEvidenceColumns) {
    try {
      db.exec(column.sql);
      console.log(`[schema] Migrated: added ${column.log} to tasks`);
    } catch (_) { /* column already exists */ }
  }

  // Project files table
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_files (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      filename     TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type    TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes   INTEGER NOT NULL DEFAULT 0,
      file_path    TEXT NOT NULL,
      uploaded_by  TEXT NOT NULL DEFAULT 'manual',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_id);
  `);

  // Task history / audit log
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      changed_by TEXT NOT NULL DEFAULT 'system',
      field      TEXT NOT NULL,
      old_value  TEXT,
      new_value  TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_history_task ON task_history(task_id);
  `);

  // Task notes
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      author     TEXT NOT NULL DEFAULT 'system',
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes(task_id);
  `);

  // Structured run observability artifacts
  db.exec(`
    CREATE TABLE IF NOT EXISTS instance_artifacts (
      instance_id                INTEGER PRIMARY KEY REFERENCES job_instances(id) ON DELETE CASCADE,
      task_id                    INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      current_stage              TEXT NOT NULL DEFAULT 'dispatch' CHECK(current_stage IN ('dispatch','start','heartbeat','progress','blocker','completion')),
      summary                    TEXT,
      latest_commit_hash         TEXT,
      branch_name                TEXT,
      changed_files_json         TEXT NOT NULL DEFAULT '[]',
      changed_files_count        INTEGER,
      blocker_reason             TEXT,
      outcome                    TEXT,
      last_agent_heartbeat_at    TEXT,
      last_meaningful_output_at  TEXT,
      started_at                 TEXT,
      completed_at               TEXT,
      stale                      INTEGER NOT NULL DEFAULT 0,
      stale_at                   TEXT,
      session_key                TEXT,
      last_note_at               TEXT,
      updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_instance_artifacts_task ON instance_artifacts(task_id);
    CREATE INDEX IF NOT EXISTS idx_instance_artifacts_stale ON instance_artifacts(stale, updated_at);
  `);

  // Task attachments
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_attachments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      filename     TEXT NOT NULL,
      filepath     TEXT NOT NULL,
      mime_type    TEXT NOT NULL DEFAULT '',
      size         INTEGER NOT NULL DEFAULT 0,
      uploaded_by  TEXT NOT NULL DEFAULT 'system',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments(task_id);
  `);

  // Chat attachments (task #658)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_attachments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id  INTEGER REFERENCES job_instances(id) ON DELETE CASCADE,
      agent_id     INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      filename     TEXT NOT NULL,
      filepath     TEXT NOT NULL,
      mime_type    TEXT NOT NULL DEFAULT 'application/octet-stream',
      size         INTEGER NOT NULL DEFAULT 0,
      uploaded_by  TEXT NOT NULL DEFAULT 'user',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_attachments_instance ON chat_attachments(instance_id);
  `);

  // job_templates timeout_seconds migration removed — Task #579 (table dropped)

  // Safe migrations: observability columns for instances/tasks
  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN session_key TEXT`);
    console.log('[schema] Migrated: added session_key to job_instances');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL`);
    console.log('[schema] Migrated: added task_id to job_instances');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN started_at TEXT`);
    console.log('[schema] Migrated: added started_at to job_instances');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN run_id TEXT`);
    console.log('[schema] Migrated: added run_id to job_instances');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN abort_attempted_at TEXT`);
    console.log('[schema] Migrated: added abort_attempted_at to job_instances');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN abort_status TEXT`);
    console.log('[schema] Migrated: added abort_status to job_instances');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN abort_error TEXT`);
    console.log('[schema] Migrated: added abort_error to job_instances');
  } catch (_) { /* column already exists */ }

  for (const column of [
    { name: 'runtime_ended_at', sql: `ALTER TABLE job_instances ADD COLUMN runtime_ended_at TEXT` },
    { name: 'runtime_end_success', sql: `ALTER TABLE job_instances ADD COLUMN runtime_end_success INTEGER` },
    { name: 'runtime_end_error', sql: `ALTER TABLE job_instances ADD COLUMN runtime_end_error TEXT` },
    { name: 'runtime_end_source', sql: `ALTER TABLE job_instances ADD COLUMN runtime_end_source TEXT` },
    { name: 'lifecycle_outcome_posted_at', sql: `ALTER TABLE job_instances ADD COLUMN lifecycle_outcome_posted_at TEXT` },
    { name: 'token_input', sql: `ALTER TABLE job_instances ADD COLUMN token_input INTEGER` },
    { name: 'token_output', sql: `ALTER TABLE job_instances ADD COLUMN token_output INTEGER` },
    { name: 'token_total', sql: `ALTER TABLE job_instances ADD COLUMN token_total INTEGER` },
  ]) {
    try {
      db.exec(column.sql);
      console.log(`[schema] Migrated: added ${column.name} to job_instances`);
    } catch (_) { /* column already exists */ }
  }

  // Safe migration: add task_outcome column to job_instances
  // Separates the task workflow outcome (qa_fail, blocked, completed_for_review, etc.)
  // from the execution status (done/failed). A run can complete execution cleanly (done)
  // while reporting a task outcome of qa_fail or blocked — these are not runtime failures.
  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN task_outcome TEXT`);
    console.log('[schema] Migrated: added task_outcome to job_instances');
  } catch (_) { /* column already exists */ }

  for (const column of [
    { name: 'runtime_ended_at', sql: `ALTER TABLE job_instances ADD COLUMN runtime_ended_at TEXT` },
    { name: 'runtime_end_success', sql: `ALTER TABLE job_instances ADD COLUMN runtime_end_success INTEGER` },
    { name: 'runtime_end_error', sql: `ALTER TABLE job_instances ADD COLUMN runtime_end_error TEXT` },
    { name: 'runtime_end_source', sql: `ALTER TABLE job_instances ADD COLUMN runtime_end_source TEXT` },
    { name: 'lifecycle_outcome_posted_at', sql: `ALTER TABLE job_instances ADD COLUMN lifecycle_outcome_posted_at TEXT` },
  ]) {
    try {
      db.exec(column.sql);
      console.log(`[schema] Migrated: added ${column.name} to job_instances`);
    } catch (_) { /* column already exists */ }
  }

  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN active_instance_id INTEGER REFERENCES job_instances(id) ON DELETE SET NULL`);
    console.log('[schema] Migrated: added active_instance_id to tasks');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN review_owner_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL`);
    console.log('[schema] Migrated: added review_owner_agent_id to tasks');
  } catch (_) { /* column already exists */ }

  // Safe migration: expand tasks.status CHECK to include 'cancelled'
  try {
    const tasksDdl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`
    ).get() as { sql: string } | undefined)?.sql ?? '';
    if (tasksDdl && !tasksDdl.includes("'cancelled'")) {
      const cols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map(c => c.name);
      const colList = cols.join(', ');
      const rebuiltDdl = tasksDdl
        .replace(/CREATE TABLE\s+"?tasks"?/, 'CREATE TABLE tasks_new')
        .replace(
          /CHECK\s*\(\s*status\s+IN\s*\([^)]*\)\s*\)/,
          "CHECK(status IN ('todo','in_progress','review','done','cancelled'))"
        );
      // Disable FK enforcement, run migration, re-enable
      db.pragma('foreign_keys = OFF');
      const migrate = db.transaction(() => {
        db.prepare(rebuiltDdl).run();
        db.prepare(`INSERT INTO tasks_new (${colList}) SELECT ${colList} FROM tasks`).run();
        db.prepare(`DROP TABLE tasks`).run();
        db.prepare(`ALTER TABLE tasks_new RENAME TO tasks`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`).run();

        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id)`).run();
      });
      migrate();
      db.pragma('foreign_keys = ON');
      console.log('[schema] Migrated: added cancelled to tasks.status CHECK constraint');
    }
  } catch (err) {
    console.error('[schema] Failed to migrate tasks status constraint:', err);
  }

  // Telemetry: task_creation_events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_creation_events (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id           INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      sprint_id         INTEGER REFERENCES sprints(id) ON DELETE SET NULL,
      -- Creation metadata
      source            TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','skill','agent','api','import')),
      routing           TEXT NOT NULL DEFAULT '',        -- intended agent/job routing
      confidence        TEXT NOT NULL DEFAULT '' CHECK(confidence IN ('','low','medium','high')),
      scope_size        TEXT NOT NULL DEFAULT '' CHECK(scope_size IN ('','xs','small','medium','large','xl')),
      assumptions       TEXT NOT NULL DEFAULT '',        -- free text or JSON array
      open_questions    TEXT NOT NULL DEFAULT '',        -- free text or JSON array
      needs_split       INTEGER NOT NULL DEFAULT 0,      -- 0=false, 1=true
      expected_artifact TEXT NOT NULL DEFAULT '',        -- e.g. "API endpoint", "migration", "UI component"
      success_mode      TEXT NOT NULL DEFAULT '',        -- e.g. "tests pass", "manual verify", "deployed"
      raw_input         TEXT NOT NULL DEFAULT '',        -- original user/agent request text
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tce_task      ON task_creation_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_tce_project   ON task_creation_events(project_id);
    CREATE INDEX IF NOT EXISTS idx_tce_sprint    ON task_creation_events(sprint_id);
    CREATE INDEX IF NOT EXISTS idx_tce_source    ON task_creation_events(source);
    CREATE INDEX IF NOT EXISTS idx_tce_created   ON task_creation_events(created_at);
  `);

  // Telemetry: task_outcome_metrics table
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_outcome_metrics (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id                 INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
      project_id              INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      sprint_id               INTEGER REFERENCES sprints(id) ON DELETE SET NULL,
      -- Outcome signals
      first_pass_qa           INTEGER NOT NULL DEFAULT 0,   -- 1 = passed review on first submission
      reopened_count          INTEGER NOT NULL DEFAULT 0,
      rerouted_count          INTEGER NOT NULL DEFAULT 0,
      split_after_creation    INTEGER NOT NULL DEFAULT 0,   -- 1 = was split into subtasks after creation
      blocked_after_creation  INTEGER NOT NULL DEFAULT 0,   -- 1 = became blocked after work started
      clarification_count     INTEGER NOT NULL DEFAULT 0,   -- number of clarification exchanges needed
      notes_count             INTEGER NOT NULL DEFAULT 0,   -- total notes on the task at completion
      cycle_time_hours        REAL,                         -- wall-clock hours from todo → done
      outcome_quality         TEXT NOT NULL DEFAULT '' CHECK(outcome_quality IN ('','good','acceptable','poor')),
      failure_reasons         TEXT NOT NULL DEFAULT '[]',   -- JSON array using taxonomy: misrouted|underspecified|too_large|hidden_dependency|wrong_priority|wrong_sprint|env_issue|execution_issue
      outcome_summary         TEXT NOT NULL DEFAULT '',     -- free-text post-mortem note
      recorded_at             TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tom_task      ON task_outcome_metrics(task_id);
    CREATE INDEX IF NOT EXISTS idx_tom_project   ON task_outcome_metrics(project_id);
    CREATE INDEX IF NOT EXISTS idx_tom_sprint    ON task_outcome_metrics(sprint_id);
    CREATE INDEX IF NOT EXISTS idx_tom_quality   ON task_outcome_metrics(outcome_quality);
    CREATE INDEX IF NOT EXISTS idx_tom_recorded  ON task_outcome_metrics(recorded_at);
  `);

  // Safe migration: expand tasks.status CHECK to include lifecycle + release-truth statuses
  try {
    const tasksDdl2 = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`
    ).get() as { sql: string } | undefined)?.sql ?? '';
    if (tasksDdl2 && !tasksDdl2.includes("'qa_pass'")) {
      const cols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map(c => c.name);
      const colList = cols.join(', ');
      const rebuiltDdl = tasksDdl2
        .replace(/CREATE TABLE\s+"?tasks"?/, 'CREATE TABLE tasks_new2')
        .replace(
          /CHECK\s*\(\s*status\s+IN\s*\([^)]*\)\s*\)/,
          `CHECK(status IN (${taskStatusesSqlList(RELEASE_TASK_STATUSES.filter(status => status !== 'blocked'))}))`
        );
      db.pragma('foreign_keys = OFF');
      const migrate = db.transaction(() => {
        db.prepare(rebuiltDdl).run();
        db.prepare(`INSERT INTO tasks_new2 (${colList}) SELECT ${colList} FROM tasks`).run();
        db.prepare(`DROP TABLE tasks`).run();
        db.prepare(`ALTER TABLE tasks_new2 RENAME TO tasks`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`).run();

        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id)`).run();
      });
      migrate();
      db.pragma('foreign_keys = ON');
      console.log('[schema] Migrated: added release-truth statuses to tasks.status CHECK constraint');
    }
  } catch (err) {
    console.error('[schema] Failed to migrate tasks status v2 constraint:', err);
  }

  // Safe migration: sync tasks.status CHECK constraint to the canonical release list.
  // Some DBs were migrated far enough to include 'blocked' but still missed
  // 'needs_attention', which caused raw SQLite CHECK failures on refused outcomes.
  // Uses dynamic DDL to mirror all existing columns (avoids hardcoded column drift).
  try {
    const tasksDdl3 = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`
    ).get() as { sql: string } | undefined)?.sql ?? '';
    const missingCanonicalTaskStatus = tasksDdl3
      && tasksDdl3.includes("'failed'")
      && (!tasksDdl3.includes("'blocked'") || !tasksDdl3.includes("'needs_attention'"));
    if (missingCanonicalTaskStatus) {
      const cols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map(c => c.name);
      const colList = cols.join(', ');
      db.pragma('foreign_keys = OFF');
      const migrate = db.transaction(() => {
        const newDdl = tasksDdl3
          .replace(
            /CHECK\(status IN \([^)]*\)\)/,
            `CHECK(status IN (${taskStatusesSqlList(RELEASE_TASK_STATUSES)}))`
          )
          .replace(/CREATE TABLE\s+"?tasks"?/, 'CREATE TABLE tasks_status_fix');
        db.prepare(newDdl).run();
        db.prepare(`INSERT INTO tasks_status_fix (${colList}) SELECT ${colList} FROM tasks`).run();
        db.prepare(`DROP TABLE tasks`).run();
        db.prepare(`ALTER TABLE tasks_status_fix RENAME TO tasks`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`).run();

        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id)`).run();
      });
      migrate();
      db.pragma('foreign_keys = ON');
      console.log('[schema] Migrated: synced tasks.status CHECK constraint to canonical release statuses');
    }
  } catch (err) {
    console.error('[schema] Failed to migrate tasks status v3 constraint sync:', err);
  }

  // Routing config v2: state-machine transitions table
  // Migrate from old routing_config (job-level config) to new (state transitions)
  try {
    const rcCols = (db.prepare(`PRAGMA table_info(routing_config)`).all() as { name: string }[]).map(c => c.name);
    if (rcCols.includes('job_id') && !rcCols.includes('from_status')) {
      // Old schema — rename and recreate
      db.exec(`ALTER TABLE routing_config RENAME TO routing_config_legacy`);
      console.log('[schema] Renamed old routing_config to routing_config_legacy');
    }
  } catch (_) { /* table may not exist at all */ }

  ensureRoutingLegacyConfigTable(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS routing_config (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      from_status TEXT NOT NULL,
      outcome     TEXT NOT NULL,
      to_status   TEXT NOT NULL,
      lane        TEXT NOT NULL DEFAULT 'default',
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_routing_config_project ON routing_config(project_id);
    CREATE INDEX IF NOT EXISTS idx_routing_config_from ON routing_config(from_status, outcome);

    CREATE TABLE IF NOT EXISTS task_routing_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_type   TEXT NOT NULL,
      status      TEXT NOT NULL,
      agent_id    INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      priority    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_trr_project ON task_routing_rules(project_id);
    CREATE INDEX IF NOT EXISTS idx_trr_lookup ON task_routing_rules(project_id, task_type, status);

    CREATE TABLE IF NOT EXISTS sprint_task_statuses (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id                INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
      status_key               TEXT NOT NULL,
      label                    TEXT NOT NULL,
      color                    TEXT NOT NULL DEFAULT 'slate',
      terminal                 INTEGER NOT NULL DEFAULT 0,
      is_system                INTEGER NOT NULL DEFAULT 0,
      allowed_transitions_json TEXT NOT NULL DEFAULT '[]',
      stage_order              INTEGER NOT NULL DEFAULT 0,
      is_default_entry         INTEGER NOT NULL DEFAULT 0,
      metadata_json            TEXT NOT NULL DEFAULT '{}',
      created_at               TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sprint_id, status_key)
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_task_statuses_lookup ON sprint_task_statuses(sprint_id, stage_order);

    CREATE TABLE IF NOT EXISTS sprint_task_transitions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id    INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
      task_type    TEXT,
      from_status  TEXT NOT NULL,
      outcome      TEXT NOT NULL,
      to_status    TEXT NOT NULL,
      lane         TEXT NOT NULL DEFAULT 'default',
      enabled      INTEGER NOT NULL DEFAULT 1,
      priority     INTEGER NOT NULL DEFAULT 0,
      is_protected INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_task_transitions_lookup
      ON sprint_task_transitions(sprint_id, from_status, outcome, task_type);

    CREATE TABLE IF NOT EXISTS sprint_task_transition_requirements (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id        INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
      task_type        TEXT,
      outcome          TEXT NOT NULL,
      field_name       TEXT NOT NULL,
      requirement_type TEXT NOT NULL DEFAULT 'required'
                       CHECK(requirement_type IN ('required','match','from_status')),
      match_field      TEXT,
      severity         TEXT NOT NULL DEFAULT 'block'
                       CHECK(severity IN ('block','warn')),
      message          TEXT NOT NULL DEFAULT '',
      enabled          INTEGER NOT NULL DEFAULT 1,
      priority         INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_task_transition_requirements_lookup
      ON sprint_task_transition_requirements(sprint_id, outcome, task_type);

    CREATE TABLE IF NOT EXISTS sprint_task_routing_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id   INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
      task_type   TEXT NOT NULL,
      status      TEXT NOT NULL,
      agent_id    INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      priority    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_task_routing_rules_lookup
      ON sprint_task_routing_rules(sprint_id, task_type, status);
  `);
  ensureColumn('sprint_task_routing_rules', 'is_system', `is_system INTEGER NOT NULL DEFAULT 0`);

  const upsertRoutingConfig = db.prepare(`
    INSERT INTO routing_config (project_id, from_status, outcome, to_status, lane, enabled)
    VALUES (NULL, ?, ?, ?, ?, 1)
  `);
  const updateRoutingConfig = db.prepare(`
    UPDATE routing_config
    SET to_status = ?, lane = ?, enabled = 1
    WHERE id = ?
  `);
  const findRoutingConfig = db.prepare(`
    SELECT id
    FROM routing_config
    WHERE project_id IS NULL AND from_status = ? AND outcome = ?
    LIMIT 1
  `);

  const defaults = [
    { from: 'in_progress', outcome: 'completed_for_review', to: 'review', lane: 'default' },
    { from: 'in_progress', outcome: 'blocked', to: 'stalled', lane: 'default' },
    { from: 'in_progress', outcome: 'failed', to: 'failed', lane: 'default' },
    { from: 'review', outcome: 'qa_pass', to: 'qa_pass', lane: 'default' },
    { from: 'review', outcome: 'qa_fail', to: 'ready', lane: 'default' },
    { from: 'review', outcome: 'blocked', to: 'stalled', lane: 'default' },
    { from: 'review', outcome: 'failed', to: 'failed', lane: 'default' },
    { from: 'qa_pass', outcome: 'approved_for_merge', to: 'ready_to_merge', lane: 'default' },
    { from: 'qa_pass', outcome: 'qa_fail', to: 'ready', lane: 'default' },
    { from: 'qa_pass', outcome: 'failed', to: 'failed', lane: 'default' },
    { from: 'ready_to_merge', outcome: 'deployed_live', to: 'deployed', lane: 'default' },
    { from: 'ready_to_merge', outcome: 'qa_fail', to: 'ready', lane: 'default' },
    { from: 'ready_to_merge', outcome: 'failed', to: 'failed', lane: 'default' },
    { from: 'deployed', outcome: 'live_verified', to: 'done', lane: 'default' },
    { from: 'deployed', outcome: 'failed', to: 'failed', lane: 'default' },
    { from: 'deployed', outcome: 'qa_fail', to: 'ready', lane: 'default' },
    { from: 'stalled', outcome: 'retry', to: 'ready', lane: 'default' },
  ];
  for (const d of defaults) {
    const existing = findRoutingConfig.get(d.from, d.outcome) as { id: number } | undefined;
    if (existing) updateRoutingConfig.run(d.to, d.lane, existing.id);
    else upsertRoutingConfig.run(d.from, d.outcome, d.to, d.lane);
  }

  const validStatusesSql = taskStatusesSqlList(RELEASE_TASK_STATUSES);
  const disabledRoutingResult = db.prepare(`
    UPDATE routing_config
    SET enabled = 0
    WHERE enabled = 1
      AND (
        from_status NOT IN (${validStatusesSql})
        OR to_status NOT IN (${validStatusesSql})
        OR (from_status = 'review' AND outcome = 'qa_pass' AND to_status = 'done')
        OR (from_status = 'in_progress' AND outcome = 'completed_done')
      )
  `).run();
  if (disabledRoutingResult.changes > 0) {
    console.log(`[schema] Disabled ${disabledRoutingResult.changes} obsolete routing_config transition(s)`);
  }

  ensureSystemPolicies();
  ensureAgencyDevOpsReleaseLane();
  backfillJobInstanceTokenUsage();

  // Deterministic task routing metadata
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN task_type TEXT`);
    console.log('[schema] Migrated: added task_type to tasks');
  } catch (_) { /* already exists */ }

  // Second task_routing_rules CREATE removed — table already created above without job_id
  // Note: alignAgencyReleaseJobInstructions() requires agents.pre_instructions (added in Task #459 Phase 0
  // migration below), so it is called after that migration block rather than here.
  ensureSecurityEventsTable();
  ensureProjectAuditLogTable();
  ensureAppSettingsTable();
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN system_role TEXT`);
    console.log('[schema] Migrated: added system_role to agents');
  } catch (_) { /* column already exists */ }
  ensureDefectTrackingColumns();
  ensureToolRegistryTables();
  ensureProviderConfigTable();
  ensureGitHubIdentitiesTable();
  ensureFailureClassColumns();
  seedInitialData();
  ensureMcpRegistryTables();
  ensureLifecycleRulesTable();
  ensureDataMigration593();
  ensurePipelineIntelligenceTelemetry();

  // Safe migration: expand job_instances.status CHECK to include 'cancelled'
  // Instances aborted via task cancel/stop should show as 'cancelled', not 'done'.
  try {
    const instancesDdl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='job_instances'`
    ).get() as { sql: string } | undefined)?.sql ?? '';
    if (instancesDdl && !instancesDdl.includes("'cancelled'")) {
      const cols = (db.prepare(`PRAGMA table_info(job_instances)`).all() as { name: string }[]).map(c => c.name);
      const colList = cols.join(', ');
      const rebuiltDdl = instancesDdl
        .replace(/CREATE TABLE\s+"?job_instances"?/, 'CREATE TABLE job_instances_new')
        .replace(
          /CHECK\s*\(\s*status\s+IN\s*\([^)]*\)\s*\)/,
          "CHECK(status IN ('queued','dispatched','running','done','failed','cancelled'))"
        );
      db.pragma('foreign_keys = OFF');
      const migrate = db.transaction(() => {
        db.prepare(rebuiltDdl).run();
        db.prepare(`INSERT INTO job_instances_new (${colList}) SELECT ${colList} FROM job_instances`).run();
        db.prepare(`DROP TABLE job_instances`).run();
        db.prepare(`ALTER TABLE job_instances_new RENAME TO job_instances`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_instances_status ON job_instances(status)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_instances_task ON job_instances(task_id)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_instances_agent ON job_instances(agent_id)`).run();
      });
      migrate();
      db.pragma('foreign_keys = ON');
      console.log('[schema] Migrated: added cancelled to job_instances.status CHECK constraint');
    }
  } catch (err) {
    console.error('[schema] Failed to migrate job_instances status constraint:', err);
  }

  // Safe migration: add preferred_provider to agents
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN preferred_provider TEXT NOT NULL DEFAULT 'anthropic'`);
    console.log('[schema] Migrated: added preferred_provider to agents');
  } catch (_) { /* column already exists */ }

  // Safe migration: add agent-native routing config columns (Task #594/596)
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN stall_threshold_min INTEGER NOT NULL DEFAULT 30`);
    console.log('[schema] Migrated: added stall_threshold_min to agents');
  } catch (_) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3`);
    console.log('[schema] Migrated: added max_retries to agents');
  } catch (_) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN sort_rules TEXT NOT NULL DEFAULT '[]'`);
    console.log('[schema] Migrated: added sort_rules to agents');
  } catch (_) { /* column already exists */ }

  // Safe migration: add os_user column to agents (task #377)
  // Stores the dedicated macOS OS user for this agent (e.g. "agent-forge").
  // When set, the agent process runs as this OS user for filesystem isolation.
  // Null = no OS-level isolation (legacy behaviour).
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN os_user TEXT`);
    console.log('[schema] Migrated: added os_user to agents');
  } catch (_) { /* column already exists */ }

  // Backfill os_user on known agents (must run after os_user column exists)
  backfillAgentOsUsers();
  migrateAtlasToDedicatedAgent();

  // Safe migration: add effective_model to job_instances
  // Stores the model actually used (or selected at dispatch time) for that run.
  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN effective_model TEXT`);
    console.log('[schema] Migrated: added effective_model to job_instances');
  } catch (_) { /* column already exists */ }

  // Safe migration: add worktree_path to job_instances (task #365)
  // Stores the git worktree path used by the agent for this run.
  // Enables cleanup on completion and orphan detection by the watchdog.
  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN worktree_path TEXT`);
    console.log('[schema] Migrated: added worktree_path to job_instances');
  } catch (_) { /* column already exists */ }

  // Safe migration: add repo_path to agents (task #365)
  // The canonical git repository path used for worktree operations.
  // When set, the dispatcher creates per-task worktrees instead of
  // using the workspace_path directly.
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN repo_path TEXT`);
    console.log('[schema] Migrated: added repo_path to agents');
  } catch (_) { /* column already exists */ }

  // Create story_point_model_routing table
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_point_model_routing (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      max_points      INTEGER NOT NULL,
      provider        TEXT NOT NULL DEFAULT 'anthropic',
      model           TEXT NOT NULL,
      fallback_model  TEXT,
      max_turns       INTEGER,
      max_budget_usd  REAL,
      label           TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_spmr_provider_points ON story_point_model_routing(provider, max_points);
  `);

  // Seed default model routing rules (idempotent)
  const existingRoutes = (db.prepare(`SELECT COUNT(*) as n FROM story_point_model_routing`).get() as { n: number }).n;
  if (existingRoutes === 0) {
    const insertRoute = db.prepare(`
      INSERT INTO story_point_model_routing (max_points, provider, model, fallback_model, label)
      VALUES (?, ?, ?, ?, ?)
    `);
    const seedTx = db.transaction(() => {
      insertRoute.run(2, 'anthropic', 'anthropic/claude-haiku-4', 'openai/gpt-4.1-mini', 'Trivial/Small');
      insertRoute.run(4, 'anthropic', 'anthropic/claude-sonnet-4-6', 'openai/gpt-4.1', 'Medium');
      insertRoute.run(8, 'anthropic', 'anthropic/claude-opus-4-6', 'openai/gpt-5', 'Large/Epic');
    });
    seedTx();
    console.log('[schema] Seeded default story_point_model_routing rules');
  }

  // ── Task #459: Merge job templates into agents (Phase 0) ──────────────
  // Add job-template columns to agents table so each agent IS its own
  // execution lane. Backfill from existing job_templates rows.
  const phase0Columns: Array<{ name: string; sql: string }> = [
    { name: 'job_title',         sql: `ALTER TABLE agents ADD COLUMN job_title TEXT NOT NULL DEFAULT ''` },
    { name: 'project_id',       sql: `ALTER TABLE agents ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL` },
    { name: 'sprint_id',        sql: `ALTER TABLE agents ADD COLUMN sprint_id INTEGER REFERENCES sprints(id) ON DELETE SET NULL` },
    { name: 'schedule',         sql: `ALTER TABLE agents ADD COLUMN schedule TEXT NOT NULL DEFAULT ''` },
    { name: 'dispatch_mode',    sql: `ALTER TABLE agents ADD COLUMN dispatch_mode TEXT NOT NULL DEFAULT 'agentTurn'` },
    { name: 'pre_instructions', sql: `ALTER TABLE agents ADD COLUMN pre_instructions TEXT NOT NULL DEFAULT ''` },
    { name: 'skill_name',       sql: `ALTER TABLE agents ADD COLUMN skill_name TEXT` },
    { name: 'skill_names',      sql: `ALTER TABLE agents ADD COLUMN skill_names TEXT NOT NULL DEFAULT '[]'` },
    { name: 'enabled',          sql: `ALTER TABLE agents ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1` },
    { name: 'timeout_seconds',  sql: `ALTER TABLE agents ADD COLUMN timeout_seconds INTEGER NOT NULL DEFAULT 900` },
  ];
  let phase0Added = 0;
  for (const col of phase0Columns) {
    try {
      db.exec(col.sql);
      phase0Added++;
    } catch { /* column already exists */ }
  }
  if (phase0Added > 0) {
    console.log(`[schema] Task #459 Phase 0: added ${phase0Added} job-template columns to agents`);
  }

  // Now that agents.pre_instructions exists (added in phase0 above), align instructions.
  alignAgencyReleaseJobInstructions();

  // Task #459 Phase 0 backfill from job_templates removed — Task #579 (table dropped).
  // Agent rows already have their job-template fields populated from prior migrations.

  // ── Task #459 Phase 3: Redirect FK columns from job_templates → agents ──
  // All backfills from job_templates removed — Task #579 (table dropped).
  // agent_id columns on these tables were already populated by prior Phase 3 runs.

  // 3b. Ensure agent_id column exists on task_routing_rules (safe if already present)
  try {
    db.exec(`ALTER TABLE task_routing_rules ADD COLUMN agent_id INTEGER REFERENCES agents(id)`);
    console.log(`[schema] Task #459 Phase 3: added agent_id to task_routing_rules`);
  } catch { /* column already exists */ }

  // 3e. Ensure agent_id column exists on task_creation_events
  try {
    db.exec(`ALTER TABLE task_creation_events ADD COLUMN agent_id INTEGER REFERENCES agents(id)`);
    console.log(`[schema] Task #459 Phase 3: added agent_id to task_creation_events`);
  } catch { /* column already exists */ }

  // 3f. Ensure agent_id column exists on task_outcome_metrics
  try {
    db.exec(`ALTER TABLE task_outcome_metrics ADD COLUMN agent_id INTEGER REFERENCES agents(id)`);
    console.log(`[schema] Task #459 Phase 3: added agent_id to task_outcome_metrics`);
  } catch { /* column already exists */ }

  // 3g. Ensure agent_id column exists on dispatch_log
  try {
    db.exec(`ALTER TABLE dispatch_log ADD COLUMN agent_id INTEGER REFERENCES agents(id)`);
    console.log(`[schema] Task #459 Phase 3: added agent_id to dispatch_log`);
  } catch { /* column already exists */ }
}

/**
 * ensureSystemPolicies — creates and seeds the system_policies table.
 *
 * system_policies is the authoritative registry for backend-enforced lifecycle
 * transitions that are NOT driven by routing_config. Every hidden-by-default
 * transition is surfaced here so:
 *   - the routing UI can display them (read-only, labelled as system-managed)
 *   - admins can tune numeric thresholds without editing source code
 *   - no surprise transitions exist outside routing config OR this table
 *
 * Classification column values:
 *   protected_system  — required for correctness; cannot be disabled via UI
 *   configurable      — default-on; threshold/behaviour can be adjusted via API
 *   deprecated        — left in code but should be removed
 */
function ensureSystemPolicies(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS system_policies (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_key    TEXT    NOT NULL UNIQUE,
      from_status   TEXT    NOT NULL,
      to_status     TEXT    NOT NULL,
      trigger_event TEXT    NOT NULL,
      classification TEXT   NOT NULL DEFAULT 'configurable',
      enabled       INTEGER NOT NULL DEFAULT 1,
      threshold_seconds INTEGER,
      description   TEXT    NOT NULL DEFAULT '',
      source_file   TEXT    NOT NULL DEFAULT '',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_system_policies_key ON system_policies(policy_key);
  `);

  const policies: Array<{
    policy_key: string;
    from_status: string;
    to_status: string;
    trigger_event: string;
    classification: 'protected_system' | 'configurable';
    enabled: number;
    threshold_seconds: number | null;
    description: string;
    source_file: string;
  }> = [
    {
      policy_key:        'dispatched_unclaim',
      from_status:       'dispatched',
      to_status:         'ready',
      trigger_event:     'no_claim_within_threshold',
      classification:    'configurable',
      enabled:           1,
      threshold_seconds: 300, // 5 minutes — configurable via PUT /routing/system-policies/:key
      description:       'If a dispatched task is not claimed by an agent within threshold_seconds, revert it to ready for re-dispatch.',
      source_file:       'api/src/services/eligibility.ts',
    },
    {
      policy_key:        'in_progress_stall',
      from_status:       'in_progress',
      to_status:         'stalled',
      trigger_event:     'no_healthy_instance_within_stall_threshold',
      classification:    'configurable',
      enabled:           1,
      threshold_seconds: 1800, // 30 minutes default — overridden per-agent via agents table
      description:       'If an in_progress task has no healthy linked instance and the stall threshold has elapsed, mark it stalled.',
      source_file:       'api/src/services/eligibility.ts',
    },
    {
      policy_key:        'stalled_manual_recovery',
      from_status:       'stalled',
      to_status:         'ready',
      trigger_event:     'human_directed_retry',
      classification:    'configurable',
      enabled:           1,
      threshold_seconds: null,
      description:       'Stalled tasks stay stalled until a human explicitly moves them, for example by applying the stalled:retry transition manually.',
      source_file:       'api/src/routes/tasks.ts',
    },
    {
      policy_key:        'stalled_fail_on_max_retries',
      from_status:       'stalled',
      to_status:         'failed',
      trigger_event:     'retry_count_at_or_over_max',
      classification:    'protected_system',
      enabled:           1,
      threshold_seconds: null,
      description:       'Stalled tasks that have exceeded max_retries are permanently marked failed to prevent infinite retry loops.',
      source_file:       'api/src/services/eligibility.ts',
    },
    {
      policy_key:        'ready_blocked_demotion',
      from_status:       'ready',
      to_status:         'todo',
      trigger_event:     'unresolved_blocker_detected',
      classification:    'protected_system',
      enabled:           1,
      threshold_seconds: null,
      description:       'Ready tasks that have gained unresolved blockers are demoted to todo to prevent them entering the dispatch queue in a blocked state.',
      source_file:       'api/src/services/eligibility.ts',
    },
    {
      policy_key:        'qa_pass_auto_merge_handoff',
      from_status:       'qa_pass',
      to_status:         'ready_to_merge',
      trigger_event:     'approved_for_merge_evidence_present',
      classification:    'protected_system',
      enabled:           1,
      threshold_seconds: null,
      description:       'QA-passed tasks that already carry approved_for_merge evidence are automatically advanced to ready_to_merge by the eligibility pass.',
      source_file:       'api/src/services/eligibility.ts (autoPromoteQaPassTasks)',
    },
    {
      policy_key:        'cancel_direct',
      from_status:       '*',
      to_status:         'cancelled',
      trigger_event:     'user_cancel_request',
      classification:    'protected_system',
      enabled:           1,
      threshold_seconds: null,
      description:       'Any non-terminal task can be cancelled directly by a user or Atlas via POST /tasks/:id/cancel. This is intentionally outside routing_config to prevent accidental disabling.',
      source_file:       'api/src/routes/tasks.ts (POST /tasks/:id/cancel)',
    },
    {
      policy_key:        'watchdog_instance_fail',
      from_status:       '*',
      to_status:         '(instance: failed)',
      trigger_event:     'instance_timeout_exceeded',
      classification:    'protected_system',
      enabled:           1,
      threshold_seconds: 1200, // 20-minute default; overridden per job via timeout_seconds
      description:       'The watchdog auto-fails job instances that exceed timeout_seconds with no completion signal. This clears active_instance_id on the linked task, allowing eligibility to detect and stall it on the next pass. The watchdog operates at instance level; task-level transition flows through in_progress_stall policy.',
      source_file:       'api/src/scheduler/watchdog.ts',
    },
    {
      policy_key:        'release_pipeline_outcome_gate',
      from_status:       'in_progress|review|qa_pass|ready_to_merge|deployed',
      to_status:         '(varies by outcome)',
      trigger_event:     'outcome_callback',
      classification:    'protected_system',
      enabled:           1,
      threshold_seconds: null,
      description:       'The release pipeline (in_progress→review→qa_pass→ready_to_merge→deployed→done) is an explicitly protected system pipeline enforced by canonicalOutcomeRoute() and requireReleaseGate(). These transitions are intentionally not overridable via routing_config to maintain evidence/integrity guarantees.',
      source_file:       'api/src/lib/taskRelease.ts (canonicalOutcomeRoute, requireReleaseGate)',
    },
    {
      policy_key:        'lifecycle_linkage_cleanup',
      from_status:       '*',
      to_status:         '(no status change — clears active_instance_id only)',
      trigger_event:     'reconciler_tick',
      classification:    'protected_system',
      enabled:           1,
      threshold_seconds: null,
      description:       'On every reconciler tick, tasks with active_instance_id pointing at a non-live instance get their linkage cleared. This is a correctness guard, not a status transition. Statuses that may have live linked instances: dispatched, in_progress, stalled, review, ready_to_merge, deployed.',
      source_file:       'api/src/lib/taskLifecycle.ts (cleanupImpossibleTaskLifecycleStates)',
    },
    {
      policy_key:        'review_qa_routing',
      from_status:       'review',
      to_status:         'review',
      trigger_event:     'no_live_instance_for_review_task',
      classification:    'configurable',
      enabled:           1,
      threshold_seconds: null,
      description:       'Review tasks without a live instance are automatically re-dispatched to the configured QA agent for the task type/project (via task_routing_rules). agent_id and review_owner_agent_id are updated if routing changes.',
      source_file:       'api/src/scheduler/reconciler.ts (reconcileReviewQaRouting)',
    },
    {
      policy_key:        'qa_fail_reset',
      from_status:       'review',
      to_status:         'ready|failed',
      trigger_event:     'qa_fail_outcome',
      classification:    'protected_system',
      enabled:           1,
      threshold_seconds: null,
      description:       'QA failure resets the task: increments retry_count, sets status to ready (or failed if max_retries exceeded), and restores the original implementation job_id. Invoked via resetFromQAFail() or the /outcome endpoint.',
      source_file:       'api/src/services/eligibility.ts (resetFromQAFail)',
    },
    {
      policy_key:        'dispatch_failure_backoff',
      from_status:       'ready|ready_to_merge',
      to_status:         'ready|ready_to_merge (no change — backoff hold only)',
      trigger_event:     'dispatch_failure',
      classification:    'configurable',
      enabled:           1,
      threshold_seconds: 120, // 2-minute backoff; overridable via DISPATCH_FAILURE_BACKOFF_SECONDS env var
      description:       'After a dispatch failure (gateway/API down), the task is reset to its eligible status with dispatched_at=now and retry_count incremented. The dispatcher skips tasks where dispatched_at is within the last threshold_seconds to prevent a spin-loop. At max_retries the task is marked failed. See DISPATCH_FAILURE_BACKOFF_SECONDS env var to override at runtime.',
      source_file:       'api/src/services/dispatcher.ts (fireAgentRun catch block)',
    },
  ];

  const upsert = db.prepare(`
    INSERT INTO system_policies
      (policy_key, from_status, to_status, trigger_event, classification, enabled, threshold_seconds, description, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(policy_key) DO UPDATE SET
      from_status   = excluded.from_status,
      to_status     = excluded.to_status,
      trigger_event = excluded.trigger_event,
      classification = excluded.classification,
      description   = excluded.description,
      source_file   = excluded.source_file,
      updated_at    = datetime('now')
  `);

  const upsertTx = db.transaction(() => {
    for (const p of policies) {
      upsert.run(
        p.policy_key,
        p.from_status,
        p.to_status,
        p.trigger_event,
        p.classification,
        p.enabled,
        p.threshold_seconds ?? null,
        p.description,
        p.source_file,
      );
    }
  });
  upsertTx();
}

/**
 * ensureAgencyDevOpsReleaseLane — NO-OP (Task #579).
 * The job_templates table has been dropped. The Harbor (DevOps) agent and
 * routing rules are now managed directly via the agents table.
 */
function ensureAgencyDevOpsReleaseLane(): void {
  // No-op: job_templates table has been dropped (task #579)
}

function backfillJobInstanceTokenUsage(): void {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, response, payload_sent, error
    FROM job_instances
    WHERE token_input IS NULL AND token_output IS NULL AND token_total IS NULL
  `).all() as Array<{ id: number; response: string | null; payload_sent: string | null; error: string | null }>;

  const update = db.prepare(`
    UPDATE job_instances
    SET token_input = ?, token_output = ?, token_total = ?
    WHERE id = ?
  `);

  let backfilled = 0;
  for (const row of rows) {
    const parsedSources = [row.response, row.payload_sent, row.error]
      .map(value => {
        if (!value) return null;
        try { return JSON.parse(value); } catch { return null; }
      })
      .filter(Boolean);

    for (const source of parsedSources) {
      const usage = extractTokenUsage(source);
      if (!usage) continue;
      update.run(usage.input, usage.output, usage.total, row.id);
      backfilled += 1;
      break;
    }
  }

  if (backfilled > 0) {
    console.log(`[schema] Backfilled token usage for ${backfilled} job instance(s)`);
  }
}

/**
 * Rewrites any legacy hardcoded /Users/<username>/.openclaw/ references that
 * may exist in DB rows from earlier schema versions. The rawInstructionsByTitle
 * templates now use OPENCLAW_DIR directly, so this is a safety-net for
 * existing DB data migrated from older installs.
 */
function rewriteInstructionPaths(text: string): string {
  // Replace any /Users/<any-user>/.openclaw/ prefix with the runtime path
  return text.replace(/\/Users\/[^/]+\/\.openclaw\//g, `${OPENCLAW_DIR}/`);
}

function alignAgencyReleaseJobInstructions(): void {
  const db = getDb();
  const rawInstructionsByTitle: Record<string, string> = {
    'Agency — Frontend': `You are Pixel, the Agency Frontend Engineer. Your session is starting because a frontend task has been assigned.

STARTUP SEQUENCE:
1. Read ${OPENCLAW_DIR}/workspace-agency-frontend/SOUL.md
2. Read ${OPENCLAW_DIR}/workspace-agency-frontend/AGENTS.md
3. Read ${OPENCLAW_DIR}/workspace-agency-frontend/TOOLS.md — your design toolkit

## Your assigned task
The dispatcher has already attached the specific task context above these instructions and Atlas HQ already claimed the task for you. Do not change the task status with the generic PUT /tasks/:id endpoint.
Do not scan the task queue — the dispatcher handles task selection.

## Atlas HQ environment discipline
- Atlas HQ Dev is the default development, implementation, and QA/review environment on UI/API ports 3510/3511 for Atlas HQ internal tasks.
- Atlas HQ production is the live system on UI/API ports 3500/3501. Production is only for deployed or live-verified work, never normal feature development.
- The separate Atlas HQ QA environment on UI/API ports 3520/3521 is deprecated for Atlas HQ internal tasks.
- Before starting an Atlas HQ task, pull latest origin and create or switch to a feature branch/worktree. Do normal feature work on that branch/worktree, not directly on main.
- For Atlas HQ tasks, work in ${OPENCLAW_DIR}/workspace-agency-frontend/atlas-hq.
- Start by running: git -C ${OPENCLAW_DIR}/workspace-agency-frontend/atlas-hq fetch origin --prune && git -C ${OPENCLAW_DIR}/workspace-agency-frontend/atlas-hq pull --ff-only origin main
- Validate and record review evidence against Dev with branch name, commit SHA, and a non-production Dev URL. Do not use main or a production URL as normal feature-review proof.

## Completion workflow
When implementation is ready for QA:
- record structured review evidence with PUT /api/v1/tasks/:id/review-evidence
- then report POST /api/v1/tasks/:id/outcome with outcome=completed_for_review (this is the ONE AND ONLY exit step — posting this outcome automatically closes the instance)`,
    'Agency — Backend': `You are Forge, the Agency Backend Engineer. Your session is starting because a backend task has been assigned.

STARTUP SEQUENCE:
1. Read ${OPENCLAW_DIR}/workspace-agency-backend/SOUL.md
2. Read ${OPENCLAW_DIR}/workspace-agency-backend/AGENTS.md

## Your assigned task
The dispatcher has already attached the specific task context above these instructions and Atlas HQ already claimed the task for you. Do not change the task status with the generic PUT /tasks/:id endpoint.
Do not scan the task queue — the dispatcher handles task selection.

## Atlas HQ environment discipline
- Atlas HQ Dev is the default development, implementation, and QA/review environment on UI/API ports 3510/3511 for Atlas HQ internal tasks.
- Atlas HQ production is the live system on UI/API ports 3500/3501. Production is only for deployed or live-verified work, never normal feature development.
- The separate Atlas HQ QA environment on UI/API ports 3520/3521 is deprecated for Atlas HQ internal tasks.
- Before starting an Atlas HQ task, pull latest origin and create or switch to a feature branch/worktree. Do normal feature work on that branch/worktree, not directly on main.
- For Atlas HQ tasks, work in ${OPENCLAW_DIR}/workspace-agency-backend/atlas-hq.
- Start by running: git -C ${OPENCLAW_DIR}/workspace-agency-backend/atlas-hq fetch origin --prune && git -C ${OPENCLAW_DIR}/workspace-agency-backend/atlas-hq pull --ff-only origin main
- Implement, validate, and record review evidence against Dev with branch name, commit SHA, and a non-production Dev URL. Do not use main or a production URL as normal feature-review proof.

## Completion workflow
When implementation is ready for QA:
- record structured review evidence with PUT /api/v1/tasks/:id/review-evidence
- then report POST /api/v1/tasks/:id/outcome with outcome=completed_for_review (this is the ONE AND ONLY exit step — posting this outcome automatically closes the instance)`,
    'Agency — QA': `You are Scout, the Agency QA Engineer. Your session is starting because a review-lane task has been assigned.

STARTUP SEQUENCE:
1. Read ${OPENCLAW_DIR}/workspace-agency-qa/SOUL.md
2. Read ${OPENCLAW_DIR}/workspace-agency-qa/AGENTS.md

## Your assigned task
The dispatcher has already attached the specific review task context above these instructions.
Keep the task in review while you test it. Do not use the generic PUT /tasks/:id endpoint to mark the task done or in_progress.

## Atlas HQ environment discipline
- Atlas HQ Dev is the implementation and QA/review environment on UI/API ports 3510/3511 for Atlas HQ internal tasks. Use Dev for QA evidence on Atlas HQ internal work.
- The separate Atlas HQ QA environment on UI/API ports 3520/3521 is deprecated for Atlas HQ internal tasks.
- Atlas HQ production is the live system on UI/API ports 3500/3501. Production is only for deployed or live-verified work, not normal QA proof.
- QA should validate the reviewed branch/commit in Dev for Atlas HQ internal tasks, not main on production.
- If review evidence points to main or a production URL, flag it and fail the handoff unless the task is explicitly a production verification task.

## QA workflow
On PASS:
- record QA evidence with PUT /api/v1/tasks/:id/qa-evidence using the tested QA URL and verified commit SHA
- report POST /api/v1/tasks/:id/outcome with outcome=qa_pass (this is the ONE AND ONLY exit step — posting this outcome automatically closes the instance)

On FAIL:
- add a precise task note with repro steps, expected vs actual, severity, tested URL, and verified branch/commit
- report POST /api/v1/tasks/:id/outcome with outcome=qa_fail (this is the ONE AND ONLY exit step — posting this outcome automatically closes the instance)

Never mark a QA pass as done directly. Atlas HQ now routes in_progress -> review -> qa_pass -> ready_to_merge -> deployed -> done. QA stops at qa_pass.

## How to test
- For Atlas HQ internal tasks, prefer the Dev environment first.
- Only use production for explicit live verification after deployment ownership has moved to DevOps / Release.
- Confirm the commit under test matches review evidence before passing the task.`,
    'Agency — DevOps / Release': `You are Harbor, the Agency DevOps / Release engineer. Your session is starting because a ready_to_merge Atlas HQ task has been assigned.

STARTUP SEQUENCE:
1. Read ${OPENCLAW_DIR}/workspace-agency-devops/SOUL.md
2. Read ${OPENCLAW_DIR}/workspace-agency-devops/AGENTS.md

## Your assigned task
The dispatcher has already attached the specific task context above these instructions and Atlas HQ already claimed the task for you. Do not do normal feature implementation in this lane.
Do not scan the task queue — the dispatcher handles task selection.

## Release ownership
You own the release leg only: ready_to_merge -> deployed -> done.
Before release, treat the backend deterministic gate model as the source of truth.
Do not infer QA requirements from status alone.
Instead, confirm the task satisfies its configured transition requirements for release, including:
- review branch evidence
- review commit evidence
- any task-type-specific evidence required by the deterministic gate for approved_for_merge / deployed_live
- a clear merge/deploy summary
PM-family tasks ('pm', 'pm_analysis', 'pm_operational') intentionally skip QA evidence when their configured transition requirements do not require it.

## Atlas HQ environment discipline
- Dev = UI/API ports 3510/3511. For Atlas HQ internal tasks, Dev is the implementation and QA/review target.
- QA = UI/API ports 3520/3521. The separate QA environment is deprecated for Atlas HQ internal tasks.
- Production = UI/API ports 3500/3501. Production runs main and is only for deployed/live-verified work.
- Merge reviewed work into main, deploy to production, record deploy evidence, then perform live verification.

## Release workflow
1. Customfy the ticket is truly ready_to_merge.
2. Merge the reviewed branch into main.
3. Deploy to production.
4. Record deploy evidence with PUT /api/v1/tasks/:id/deploy-evidence including merged commit, deployed commit, deploy target, and deployed timestamp.
5. POST /api/v1/tasks/:id/outcome with outcome=deployed_live. (deployed_live is NOT terminal — your session stays open for live verification)
6. Perform live verification against production.
7. POST /api/v1/tasks/:id/outcome with outcome=live_verified. (this is the FINAL exit step — posting live_verified automatically closes the instance and terminates your session)

NOTE: PUT /instances/:id/complete is no longer required. Posting the final outcome is the only exit step.
If merge or deploy fails, add a precise task note, report the appropriate failed/blocked outcome (which automatically closes the instance), and do not mark the task done.`,
    'Agency — PM': `You are Wren, the Agency Product Manager / spec lead. Your session is starting because a PM/spec task has been assigned.

STARTUP SEQUENCE:
1. Read ${OPENCLAW_DIR}/workspace-agency-pm/SOUL.md
2. Read ${OPENCLAW_DIR}/workspace-agency-pm/AGENTS.md

## Your assigned task
The dispatcher has already attached the specific task context above these instructions and Atlas HQ has already claimed the task for you. Do not scan the task queue — the dispatcher handles task selection.

## What good output looks like
Your job is to turn ambiguity into decisions. For PM/spec tasks, inspect the current product behavior, relevant docs, and nearby task history before finalizing your answer. Produce implementation-ready scope, dependencies, edge cases, and acceptance criteria.

## Typical deliverables
- product/spec notes added back to the task
- clarified implementation plan or ticket split
- explicit edge cases and acceptance criteria
- recommendations on sequencing, dependencies, and tradeoffs

## Completion workflow
When your PM/spec work is complete:
1. Add a concise task note capturing the finished spec / decisions / open questions
   POST http://localhost:3501/api/v1/tasks/{task_id}/notes
   {"author":"wren-pm","content":"<spec summary / decisions / edge cases / dependencies>"}
2. Post outcome — PM/spec tasks skip QA and go directly to ready_to_merge:
   POST http://localhost:3501/api/v1/tasks/{task_id}/outcome
   {"outcome":"approved_for_merge","summary":"PM/spec completed","changed_by":"wren-pm","instance_id":{instance_id}}

NOTE: Use outcome=approved_for_merge (NOT completed_for_review) for pm_analysis and pm_operational tasks.
This triggers the skip-QA path: review → ready_to_merge directly.

## Blocker escalation
If blocked by missing product direction or unclear constraints:
1. POST http://localhost:3501/api/v1/tasks/{task_id}/notes {"author":"wren-pm","content":"BLOCKED: [reason]"}
2. POST http://localhost:3501/api/v1/tasks/{task_id}/outcome {"outcome":"blocked","summary":"BLOCKED: [reason]","changed_by":"wren-pm","instance_id":{instance_id}}
3. openclaw system event --text "BLOCKED: Wren Task #{task_id} — [reason]. Needs Atlas." --mode now

## Safety rules
- Do not invent provider/auth capabilities that have not been verified
- Prefer narrower, shippable v1 recommendations over sprawling speculative scope
- Keep implementation and review paths clear enough that frontend/backend agents can execute without guessing`
  };

  // Rewrite any hardcoded /Users/<user>/.openclaw/ paths to the runtime home dir
  const instructionsByTitle: Record<string, string> = Object.fromEntries(
    Object.entries(rawInstructionsByTitle).map(([title, text]) => [title, rewriteInstructionPaths(text)])
  );

  // Task #579: job_templates dropped — update agents.pre_instructions directly.
  // Match agents by job_title (which was backfilled from job_templates.title in Phase 0).
  const update = db.prepare(`
    UPDATE agents
    SET pre_instructions = ?
    WHERE job_title = ? AND pre_instructions != ?
  `);

  let changed = 0;
  for (const [title, instructions] of Object.entries(instructionsByTitle)) {
    changed += update.run(instructions, title, instructions).changes;
  }

  if (changed > 0) {
    console.log(`[schema] Updated ${changed} Agency release-pipeline job instruction template(s)`);
  }
}

/**
 * ensureSecurityEventsTable — create the security_events table if it does not
 * exist (task #364 — workspace path boundary enforcement).
 *
 * This table is the Atlas HQ audit log for workspace boundary violations.
 * Every time an agent (or any code using the workspaceBoundary utility) attempts
 * to access a path outside its assigned workspace, a row is inserted here.
 *
 * Fields:
 *   event_type  — 'workspace_boundary_violation' (extensible for future events)
 *   agent_id    — FK to agents.id (nullable: violations may occur before dispatch)
 *   instance_id — FK to job_instances.id (nullable)
 *   task_id     — FK to tasks.id (nullable)
 *   details     — JSON blob with attempted_path, resolved_path, workspace_root, detail
 */
function ensureSecurityEventsTable(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS security_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type  TEXT NOT NULL DEFAULT 'workspace_boundary_violation',
      agent_id    INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      instance_id INTEGER REFERENCES job_instances(id) ON DELETE SET NULL,
      task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      details     TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_security_events_agent ON security_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_security_events_instance ON security_events(instance_id);
    CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type, created_at);
  `);

  console.log('[schema] security_events table ensured');
}

/**
 * backfillAgentOsUsers — set os_user on agents based on their session_key slug.
 *
 * Convention: agents with session_key "agent:<slug>:main" get os_user "agent-<name>"
 * where <name> is the human-friendly slug derived from the agent's name.
 *
 * Known mapping (task #377):
 *   agency-backend  → agent-forge
 *   agency-frontend → agent-pixel
 *   agency-qa       → agent-scout
 *   agency-qa2      → agent-rook
 *   agency-devops   → agent-harbor
 *   agency-pm       → agent-wren
 *   software-engineer → agent-kai
 *   trader          → agent-rex
 *   pulse           → agent-pulse
 *
 * Only sets os_user where it is currently NULL (idempotent, respects manual overrides).
 */
function backfillAgentOsUsers(): void {
  const db = getDb();

  const mapping: Record<string, string> = {
    'agent:agency-backend:main':    'agent-forge',
    'agent:agency-frontend:main':   'agent-pixel',
    'agent:agency-qa:main':         'agent-scout',
    'agent:agency-qa2:main':        'agent-rook',
    'agent:agency-devops:main':     'agent-harbor',
    'agent:agency-pm:main':         'agent-wren',
    'agent:software-engineer:main': 'agent-kai',
    'agent:trader:main':            'agent-rex',
    'agent:pulse:main':             'agent-pulse',
  };

  const update = db.prepare(`
    UPDATE agents SET os_user = ? WHERE session_key = ? AND os_user IS NULL
  `);

  let updated = 0;
  for (const [sessionKey, osUser] of Object.entries(mapping)) {
    updated += update.run(osUser, sessionKey).changes;
  }

  if (updated > 0) {
    console.log(`[schema] Backfilled os_user on ${updated} agent(s)`);
  }
}

/**
 * ensureProjectAuditLogTable — create the project_audit_log table if it does
 * not exist (task #457 — project-level audit history).
 *
 * Records audit events for projects, sprints, and job templates so that
 * every structural change to the project hierarchy is traceable.
 *
 * Fields:
 *   project_id  — FK to projects.id (the owning project)
 *   entity_type — 'project' | 'sprint' | 'job_template'
 *   entity_id   — PK of the entity that was changed
 *   action      — 'created' | 'updated' | 'deleted'
 *   actor       — who made the change (user, agent slug, 'system', 'api')
 *   changes     — JSON blob with field-level diffs ({ field: { old, new } })
 */
function ensureProjectAuditLogTable(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS project_audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('project', 'sprint', 'job_template')),
      entity_id   INTEGER NOT NULL,
      action      TEXT NOT NULL CHECK(action IN ('created', 'updated', 'deleted')),
      actor       TEXT NOT NULL DEFAULT 'system',
      changes     TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_project_audit_log_project ON project_audit_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_audit_log_entity ON project_audit_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_project_audit_log_created ON project_audit_log(created_at);
  `);
}

/**
 * ensureDefectTrackingColumns — Task #535: add origin_task_id + defect_type
 * to tasks, spawned_defects to task_outcome_metrics, and backfill task #534.
 */
function ensureDefectTrackingColumns(): void {
  const db = getDb();

  // 1. Add origin_task_id to tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN origin_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_origin ON tasks(origin_task_id)`);
    console.log('[schema] Migrated: added origin_task_id to tasks');
  } catch (_) { /* column already exists */ }

  // 2. Add defect_type to tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN defect_type TEXT DEFAULT NULL`);
    console.log('[schema] Migrated: added defect_type to tasks');
  } catch (_) { /* column already exists */ }

  // 3. Add spawned_defects to task_outcome_metrics
  try {
    db.exec(`ALTER TABLE task_outcome_metrics ADD COLUMN spawned_defects INTEGER NOT NULL DEFAULT 0`);
    console.log('[schema] Migrated: added spawned_defects to task_outcome_metrics');
  } catch (_) { /* column already exists */ }

  // Ensure index exists (idempotent)
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_origin ON tasks(origin_task_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_defect_type ON tasks(defect_type)`);
  } catch (_) { /* already exists */ }

  // 4. Backfill task #534 → origin_task_id=532, defect_type=qa_miss
  try {
    const task534 = db.prepare(`SELECT id, origin_task_id FROM tasks WHERE id = 534`).get() as { id: number; origin_task_id: number | null } | undefined;
    if (task534 && task534.origin_task_id === null) {
      // Check task 532 exists
      const task532 = db.prepare(`SELECT id FROM tasks WHERE id = 532`).get() as { id: number } | undefined;
      if (task532) {
        db.prepare(`UPDATE tasks SET origin_task_id = 532, defect_type = 'qa_miss' WHERE id = 534`).run();
        // Upsert spawned_defects on task 532's outcome metrics
        const existingMetrics = db.prepare(`SELECT id FROM task_outcome_metrics WHERE task_id = 532`).get() as { id: number } | undefined;
        if (existingMetrics) {
          db.prepare(`UPDATE task_outcome_metrics SET spawned_defects = spawned_defects + 1 WHERE task_id = 532`).run();
        } else {
          db.prepare(`
            INSERT INTO task_outcome_metrics (task_id, spawned_defects)
            VALUES (532, 1)
          `).run();
        }
        console.log('[schema] Backfilled: task #534 origin_task_id=532, defect_type=qa_miss');
      }
    }
  } catch (err) {
    console.warn('[schema] Defect backfill skipped:', err);
  }
}

function ensureAppSettingsTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * ensureToolRegistryTables — Task #557: tools + agent_tool_assignments tables
 * and seed example tools.
 */
export function ensureToolRegistryTables(): void {
  const db = getDb();

  const tableExists = (name: string): boolean => {
    const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
    return Boolean(row);
  };
  const getTableSql = (name: string): string => {
    return (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as { sql?: string } | undefined)?.sql ?? '';
  };
  const getColumns = (name: string): string[] => {
    return (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map((col) => col.name);
  };
  const createToolsTableSql = `
    CREATE TABLE IF NOT EXISTS tools (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      name                 TEXT NOT NULL,
      slug                 TEXT NOT NULL UNIQUE,
      description          TEXT NOT NULL DEFAULT '',
      implementation_type  TEXT NOT NULL DEFAULT 'bash' CHECK(implementation_type IN ('bash','shell','script','mcp','function','http')),
      implementation_body  TEXT NOT NULL DEFAULT '',
      input_schema         TEXT NOT NULL DEFAULT '{}',
      permissions          TEXT NOT NULL DEFAULT 'read_only' CHECK(permissions IN ('read_only','read_write','exec','network')),
      tags                 TEXT NOT NULL DEFAULT '[]',
      enabled              INTEGER NOT NULL DEFAULT 1,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tools_slug ON tools(slug);
    CREATE INDEX IF NOT EXISTS idx_tools_enabled ON tools(enabled);
  `;

  const rebuildToolsTable = (): void => {
    const sourceColumns = new Set(getColumns('tools'));
    const tempTable = `tools_rebuild_${Date.now()}`;
    const targetColumns = [
      'id',
      'name',
      'slug',
      'description',
      'implementation_type',
      'implementation_body',
      'input_schema',
      'permissions',
      'tags',
      'enabled',
      'created_at',
      'updated_at',
    ];
    const selectExpressionByColumn: Record<string, string> = {
      id: sourceColumns.has('id') ? 'id' : 'NULL AS id',
      name: sourceColumns.has('name') && sourceColumns.has('slug')
        ? 'COALESCE(name, slug, \'Tool \' || id) AS name'
        : sourceColumns.has('name')
          ? 'COALESCE(name, \'Tool \' || id) AS name'
          : sourceColumns.has('slug')
            ? 'slug AS name'
            : "'Tool ' || id AS name",
      slug: sourceColumns.has('slug')
        ? 'COALESCE(slug, \'tool-\' || id) AS slug'
        : "'tool-' || id AS slug",
      description: sourceColumns.has('description') ? 'COALESCE(description, \'\') AS description' : "'' AS description",
      implementation_type: sourceColumns.has('implementation_type')
        ? `
          CASE implementation_type
            WHEN 'bash' THEN 'bash'
            WHEN 'shell' THEN 'shell'
            WHEN 'script' THEN 'script'
            WHEN 'mcp' THEN 'mcp'
            WHEN 'function' THEN 'function'
            WHEN 'http' THEN 'http'
            ELSE 'bash'
          END AS implementation_type
        `
        : "'bash' AS implementation_type",
      implementation_body: sourceColumns.has('implementation_body') ? 'COALESCE(implementation_body, \'\') AS implementation_body' : "'' AS implementation_body",
      input_schema: sourceColumns.has('input_schema') ? 'COALESCE(input_schema, \'{}\') AS input_schema' : "'{}' AS input_schema",
      permissions: sourceColumns.has('permissions')
        ? `
          CASE permissions
            WHEN 'read_only' THEN 'read_only'
            WHEN 'read_write' THEN 'read_write'
            WHEN 'exec' THEN 'exec'
            WHEN 'network' THEN 'network'
            ELSE 'read_only'
          END AS permissions
        `
        : "'read_only' AS permissions",
      tags: sourceColumns.has('tags') ? 'COALESCE(tags, \'[]\') AS tags' : "'[]' AS tags",
      enabled: sourceColumns.has('enabled') ? 'COALESCE(enabled, 1) AS enabled' : '1 AS enabled',
      created_at: sourceColumns.has('created_at') ? 'COALESCE(created_at, datetime(\'now\')) AS created_at' : "datetime('now') AS created_at",
      updated_at: sourceColumns.has('updated_at') ? 'COALESCE(updated_at, datetime(\'now\')) AS updated_at' : "datetime('now') AS updated_at",
    };

    db.pragma('foreign_keys = OFF');
    const rebuild = db.transaction(() => {
      db.prepare(`ALTER TABLE tools RENAME TO ${tempTable}`).run();
      db.exec(`
      CREATE TABLE tools (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        name                 TEXT NOT NULL,
        slug                 TEXT NOT NULL UNIQUE,
        description          TEXT NOT NULL DEFAULT '',
        implementation_type  TEXT NOT NULL DEFAULT 'bash' CHECK(implementation_type IN ('bash','shell','script','mcp','function','http')),
        implementation_body  TEXT NOT NULL DEFAULT '',
        input_schema         TEXT NOT NULL DEFAULT '{}',
        permissions          TEXT NOT NULL DEFAULT 'read_only' CHECK(permissions IN ('read_only','read_write','exec','network')),
        tags                 TEXT NOT NULL DEFAULT '[]',
        enabled              INTEGER NOT NULL DEFAULT 1,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
      `);
      db.prepare(`
        INSERT INTO tools (id, name, slug, description, implementation_type, implementation_body, input_schema, permissions, tags, enabled, created_at, updated_at)
        SELECT ${targetColumns.map((column) => selectExpressionByColumn[column]).join(', ')}
        FROM ${tempTable}
      `).run();
      db.prepare(`DROP TABLE ${tempTable}`).run();
    });
    try {
      rebuild();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tools_slug ON tools(slug);
      CREATE INDEX IF NOT EXISTS idx_tools_enabled ON tools(enabled);
    `);
    console.log('[schema] Migrated: rebuilt tools table for current capability execution types');
  };

  if (!tableExists('tools')) {
    db.exec(createToolsTableSql);
  } else {
    const toolsTableSql = getTableSql('tools');
    const toolColumns = new Set(getColumns('tools'));
    const requiredColumns = [
      'id',
      'name',
      'slug',
      'description',
      'implementation_type',
      'implementation_body',
      'input_schema',
      'permissions',
      'tags',
      'enabled',
      'created_at',
      'updated_at',
    ];
    const missingRequiredColumn = requiredColumns.some((column) => !toolColumns.has(column));
    const legacyImplementationCheck = Boolean(toolsTableSql) && (!toolsTableSql.includes("'shell'") || !toolsTableSql.includes("'script'"));
    if (missingRequiredColumn || legacyImplementationCheck) {
      rebuildToolsTable();
    } else {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tools_slug ON tools(slug);
        CREATE INDEX IF NOT EXISTS idx_tools_enabled ON tools(enabled);
      `);
    }
  }

  // agent_tool_assignments table
  const createAgentToolAssignmentsSql = `
    CREATE TABLE IF NOT EXISTS agent_tool_assignments (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id  INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      tool_id   INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
      overrides TEXT NOT NULL DEFAULT '{}',
      enabled   INTEGER NOT NULL DEFAULT 1,
      UNIQUE(agent_id, tool_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ata_agent ON agent_tool_assignments(agent_id);
    CREATE INDEX IF NOT EXISTS idx_ata_tool ON agent_tool_assignments(tool_id);
  `;
  const rebuildAgentToolAssignmentsTable = (): void => {
    const sourceColumns = new Set(getColumns('agent_tool_assignments'));
    const tempTable = `agent_tool_assignments_rebuild_${Date.now()}`;
    const targetColumns = ['id', 'agent_id', 'tool_id', 'overrides', 'enabled'];
    const selectExpressionByColumn: Record<string, string> = {
      id: sourceColumns.has('id') ? 'id' : 'NULL AS id',
      agent_id: sourceColumns.has('agent_id') ? 'agent_id' : 'NULL AS agent_id',
      tool_id: sourceColumns.has('tool_id') ? 'tool_id' : 'NULL AS tool_id',
      overrides: sourceColumns.has('overrides') ? 'COALESCE(overrides, \'{}\') AS overrides' : "'{}' AS overrides",
      enabled: sourceColumns.has('enabled') ? 'COALESCE(enabled, 1) AS enabled' : '1 AS enabled',
    };

    db.pragma('foreign_keys = OFF');
    const rebuild = db.transaction(() => {
      db.prepare(`ALTER TABLE agent_tool_assignments RENAME TO ${tempTable}`).run();
      db.exec(`
        CREATE TABLE agent_tool_assignments (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id  INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          tool_id   INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
          overrides TEXT NOT NULL DEFAULT '{}',
          enabled   INTEGER NOT NULL DEFAULT 1,
          UNIQUE(agent_id, tool_id)
        );
      `);
      if (sourceColumns.has('agent_id') && sourceColumns.has('tool_id')) {
        db.prepare(`
          INSERT OR IGNORE INTO agent_tool_assignments (id, agent_id, tool_id, overrides, enabled)
          SELECT ${targetColumns.map((column) => selectExpressionByColumn[column]).join(', ')}
          FROM ${tempTable}
          WHERE agent_id IS NOT NULL AND tool_id IS NOT NULL
        `).run();
      }
      db.prepare(`DROP TABLE ${tempTable}`).run();
    });
    try {
      rebuild();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ata_agent ON agent_tool_assignments(agent_id);
      CREATE INDEX IF NOT EXISTS idx_ata_tool ON agent_tool_assignments(tool_id);
    `);
    console.log('[schema] Migrated: rebuilt agent_tool_assignments with current tools foreign key');
  };

  if (!tableExists('agent_tool_assignments')) {
    db.exec(createAgentToolAssignmentsSql);
  } else {
    const assignmentSql = getTableSql('agent_tool_assignments');
    const assignmentColumns = new Set(getColumns('agent_tool_assignments'));
    const missingAssignmentColumn = ['id', 'agent_id', 'tool_id', 'overrides', 'enabled'].some((column) => !assignmentColumns.has(column));
    if (missingAssignmentColumn || assignmentSql.includes('tools_legacy_capability_exec')) {
      rebuildAgentToolAssignmentsTable();
    } else {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_ata_agent ON agent_tool_assignments(agent_id);
        CREATE INDEX IF NOT EXISTS idx_ata_tool ON agent_tool_assignments(tool_id);
      `);
    }
  }

  // Seed tool registry defaults and keep them up to date for existing DBs.
  const upsertTool = db.prepare(`
    INSERT INTO tools (name, slug, description, implementation_type, implementation_body, input_schema, permissions, tags, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      implementation_type = excluded.implementation_type,
      implementation_body = excluded.implementation_body,
      input_schema = excluded.input_schema,
      permissions = excluded.permissions,
      tags = excluded.tags,
      enabled = 1,
      updated_at = datetime('now')
  `);
  const assignToolToAgentByName = db.prepare(`
    INSERT INTO agent_tool_assignments (agent_id, tool_id, overrides, enabled)
    SELECT a.id, t.id, '{}', 1
    FROM agents a
    JOIN tools t ON t.slug = ?
    WHERE lower(a.name) = lower(?)
      AND NOT EXISTS (
        SELECT 1 FROM agent_tool_assignments ata
        WHERE ata.agent_id = a.id AND ata.tool_id = t.id
      )
  `);

  const structuredExploreCodebaseScript = `set -euo pipefail
ROOT="\${WORKSPACE:-\${PWD}}"
FOCUS="\${FOCUS:-}"
DEPTH="\${DEPTH:-2}"
SEARCH_ROOT="$ROOT"

if [ -n "$FOCUS" ]; then
  if [ -e "$ROOT/$FOCUS" ]; then
    SEARCH_ROOT="$ROOT/$FOCUS"
  else
    MATCH="$(find "$ROOT" -path "*/node_modules" -prune -o -path "*/.git" -prune -o -iname "*\${FOCUS}*" -print | head -n 1)"
    if [ -n "$MATCH" ]; then
      SEARCH_ROOT="$MATCH"
    fi
  fi
fi

if [ ! -e "$SEARCH_ROOT" ]; then
  printf '{"root":%s,"focus":%s,"depth":%s,"error":"focus target not found"}\n' \
    "$(printf '%s' "$ROOT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    "$(printf '%s' "$FOCUS" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    "$(printf '%s' "$DEPTH" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  exit 0
fi

python3 - "$ROOT" "$SEARCH_ROOT" "$FOCUS" "$DEPTH" <<'PY'
import json, os, re, subprocess, sys
root, search_root, focus, depth_raw = sys.argv[1:5]
try:
    depth = max(1, int(float(depth_raw)))
except Exception:
    depth = 2
ignore = {'.git', 'node_modules', 'dist', 'build', '.next', 'coverage'}
entry_names = {'package.json','tsconfig.json','README.md','src','api','ui','app','server','index.ts','index.js','main.ts','main.js'}
entry_points, key_files = [], []
for current_root, dirs, files in os.walk(search_root):
    rel_depth = os.path.relpath(current_root, search_root).count(os.sep)
    dirs[:] = [d for d in dirs if d not in ignore]
    if rel_depth >= depth:
      dirs[:] = []
    for name in files:
        rel = os.path.relpath(os.path.join(current_root, name), root)
        if name in entry_names or name.endswith(('.ts','.tsx','.js','.mjs','.cjs','.py','.sh')):
            if len(entry_points) < 20:
                entry_points.append(rel)
        if focus and focus.lower() in rel.lower() and len(key_files) < 20:
            key_files.append(rel)
for current_root, dirs, files in os.walk(search_root):
    dirs[:] = [d for d in dirs if d not in ignore]
    for name in files:
        rel = os.path.relpath(os.path.join(current_root, name), root)
        if rel not in key_files and len(key_files) < 20 and name.endswith(('.ts','.tsx','.js','.mjs','.cjs','.py','.sh','.json','.md')):
            key_files.append(rel)
imports = {}
patterns_re = [
    re.compile(r"^import .* from ['\\\"]([^'\\\"]+)['\\\"]", re.M),
    re.compile(r"^export .* from ['\\\"]([^'\\\"]+)['\\\"]", re.M),
    re.compile(r"require\(['\\\"]([^'\\\"]+)['\\\"]\)"),
]
for rel in key_files[:8]:
    full = os.path.join(root, rel)
    try:
        text = open(full, 'r', encoding='utf-8').read()
    except Exception:
        continue
    matches = []
    for pattern in patterns_re:
        matches.extend(pattern.findall(text))
    if matches:
        imports[rel] = matches[:20]
patterns = []
if focus:
    try:
        proc = subprocess.run(['grep','-RIn',focus,search_root,'--exclude-dir=.git','--exclude-dir=node_modules'], capture_output=True, text=True, check=False)
        patterns = [line for line in proc.stdout.splitlines()[:20] if line]
    except Exception:
        patterns = []
print(json.dumps({
    'root': root,
    'search_root': search_root,
    'focus': focus or None,
    'depth': depth,
    'entry_points': sorted(dict.fromkeys(entry_points))[:20],
    'key_files': sorted(dict.fromkeys(key_files))[:20],
    'imports_map': imports,
    'relevant_patterns': patterns,
}, indent=2))
PY`;

  const seedTx = db.transaction(() => {
    upsertTool.run(
      'Explore Codebase',
      'explore_codebase',
      'Explore the codebase structure before making changes. Call this at the start of any task to understand entry points, key files, and the call chain relevant to your work. Returns a structured map.',
      'bash',
      structuredExploreCodebaseScript,
      JSON.stringify({
        type: 'object',
        properties: {
          focus: { type: 'string', description: 'Area of codebase to focus on (file path, module name, or feature)' },
          depth: { type: 'number', description: 'How many levels deep to explore (default 2)' },
        },
        required: [],
      }),
      'read_only',
      JSON.stringify(['filesystem', 'exploration', 'devtools']),
    );
    upsertTool.run(
      'Bash',
      'bash',
      'Execute an arbitrary bash command. Use for build steps, tests, git operations, and general automation.',
      'bash',
      '${COMMAND}',
      JSON.stringify({ type: 'object', properties: { command: { type: 'string', description: 'The bash command to execute' } }, required: ['command'] }),
      'exec',
      JSON.stringify(['shell', 'automation']),
    );
    upsertTool.run(
      'File Edit',
      'file_edit',
      'Read, create, or edit a file at a given path. Supports full-file writes and patch-style edits.',
      'function',
      'file_edit_handler',
      JSON.stringify({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path' },
          content: { type: 'string', description: 'New file content (full replace) or patch' },
          mode: { type: 'string', enum: ['write', 'patch', 'read'], description: 'Operation mode' },
        },
        required: ['path'],
      }),
      'read_write',
      JSON.stringify(['filesystem', 'editing']),
    );
    upsertTool.run(
      'Git Worktree Enter',
      'git_worktree_enter',
      'Create an isolated git worktree for the task and return the created worktree path.',
      'bash',
      'set -euo pipefail\nBRANCH="${BRANCH:?branch is required}"\nBASE="${BASE:-main}"\nREPO="${REPO_PATH:-${WORKSPACE:-${PWD}}}"\nmkdir -p "$REPO/../worktrees"\nWT_PATH="$REPO/../worktrees/$BRANCH"\ngit -C "$REPO" worktree add "$WT_PATH" -b "$BRANCH" "$BASE"\nprintf "branch=%s\\nbase=%s\\nworktree_path=%s\\n" "$BRANCH" "$BASE" "$WT_PATH"',
      JSON.stringify({
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'Branch name to create/checkout in the worktree' },
          base: { type: 'string', description: 'Base branch to branch from (default: main)' },
        },
        required: ['branch'],
      }),
      'exec',
      JSON.stringify(['git', 'worktree', 'devtools']),
    );
    upsertTool.run(
      'Git Worktree Exit',
      'git_worktree_exit',
      'Remove an isolated git worktree after task completion.',
      'bash',
      'set -euo pipefail\nBRANCH="${BRANCH:?branch is required}"\nREPO="${REPO_PATH:-${WORKSPACE:-${PWD}}}"\nWT_PATH="$REPO/../worktrees/$BRANCH"\ngit -C "$REPO" worktree remove "$WT_PATH" --force\nprintf "branch=%s\\nworktree_path=%s\\nremoved=true\\n" "$BRANCH" "$WT_PATH"',
      JSON.stringify({
        type: 'object',
        properties: {
          branch: { type: 'string' },
        },
        required: ['branch'],
      }),
      'exec',
      JSON.stringify(['git', 'worktree', 'devtools']),
    );

    for (const agentName of ['Forge', 'Kai']) {
      assignToolToAgentByName.run('explore_codebase', agentName);
      assignToolToAgentByName.run('git_worktree_enter', agentName);
      assignToolToAgentByName.run('git_worktree_exit', agentName);
    }
  });
  seedTx();
  console.log('[schema] Ensured tool registry defaults (explore_codebase, bash, file_edit, git_worktree_enter, git_worktree_exit)');
}

function ensureMcpRegistryTables(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      slug          TEXT NOT NULL UNIQUE,
      description   TEXT NOT NULL DEFAULT '',
      transport     TEXT NOT NULL DEFAULT 'stdio' CHECK(transport IN ('stdio')),
      command       TEXT NOT NULL,
      args          TEXT NOT NULL DEFAULT '[]',
      env           TEXT NOT NULL DEFAULT '{}',
      cwd           TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_slug ON mcp_servers(slug);
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled);

    CREATE TABLE IF NOT EXISTS agent_mcp_assignments (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id       INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      mcp_server_id  INTEGER NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      overrides      TEXT NOT NULL DEFAULT '{}',
      enabled        INTEGER NOT NULL DEFAULT 1,
      UNIQUE(agent_id, mcp_server_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_mcp_assignments_agent ON agent_mcp_assignments(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_mcp_assignments_server ON agent_mcp_assignments(mcp_server_id);
  `);

  const serverEntryScript = path.join(path.resolve(__dirname, '../..'), 'dist', 'mcp', 'server.js');
  const nodeExecutable = path.join(NODE_BIN_DIR, 'node');

  db.prepare(`
    INSERT INTO mcp_servers (name, slug, description, transport, command, args, env, cwd, enabled)
    VALUES (?, ?, ?, 'stdio', ?, ?, ?, ?, 1)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      transport = excluded.transport,
      command = excluded.command,
      args = excluded.args,
      env = excluded.env,
      cwd = excluded.cwd,
      enabled = 1,
      updated_at = datetime('now')
  `).run(
    'Agent HQ MCP Server',
    'agent-hq',
    'Local stdio MCP server exposing Agent HQ projects, sprints, tasks, and agents.',
    nodeExecutable,
    JSON.stringify([serverEntryScript]),
    JSON.stringify({ AGENT_HQ_API_URL: 'http://127.0.0.1:3501' }),
    path.resolve(__dirname, '../..'),
  );

  db.prepare(`
    INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id, overrides, enabled)
    SELECT a.id, s.id, '{}', 1
    FROM agents a
    JOIN mcp_servers s ON s.slug = 'agent-hq'
    WHERE (
      a.system_role = ?
      OR a.openclaw_agent_id = ?
      OR a.session_key = ?
      OR a.name = ?
    )
      AND NOT EXISTS (
        SELECT 1 FROM agent_mcp_assignments ama
        WHERE ama.agent_id = a.id AND ama.mcp_server_id = s.id
      )
  `).run(ATLAS_SYSTEM_ROLE, ATLAS_AGENT_SLUG, ATLAS_SESSION_KEY, ATLAS_AGENT_NAME);

  console.log('[schema] Ensured MCP registry defaults (agent-hq)');
}

function seedInitialData(): void {
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number };
  if (existing.count === 0) {
    db.prepare(`
      INSERT INTO agents (name, role, session_key, workspace_path, status, openclaw_agent_id, system_role)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      ATLAS_AGENT_NAME,
      'Built-in assistant — task routing, coordination, and chat',
      ATLAS_SESSION_KEY,
      ATLAS_WORKSPACE_PATH,
      'idle',
      ATLAS_AGENT_SLUG,
      ATLAS_SYSTEM_ROLE,
    );
    console.log('[schema] Seeded initial Atlas agent');
  }
}

function getAppSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setAppSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

function pathExists(target: string): boolean {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function looksLikeAtlasWorkspace(root: string): boolean {
  if (!isDirectory(root)) return false;
  return ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'MEMORY.md', 'TOOLS.md']
    .some(file => pathExists(path.join(root, file)));
}

function mergeMoveIntoAtlasWorkspace(sourcePath: string, targetPath: string): number {
  if (!pathExists(sourcePath)) return 0;

  if (!pathExists(targetPath)) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.renameSync(sourcePath, targetPath);
    return 1;
  }

  const sourceIsDir = isDirectory(sourcePath);
  const targetIsDir = isDirectory(targetPath);
  if (!sourceIsDir || !targetIsDir) return 0;

  let moved = 0;
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    if (entry.name === '.trash') continue;
    moved += mergeMoveIntoAtlasWorkspace(
      path.join(sourcePath, entry.name),
      path.join(targetPath, entry.name),
    );
  }

  try {
    if (fs.readdirSync(sourcePath).length === 0) {
      fs.rmdirSync(sourcePath);
    }
  } catch {
    // Leave non-empty/in-use directories alone.
  }

  return moved;
}

function migrateAtlasWorkspace(sourceRoot: string, targetRoot: string): number {
  if (sourceRoot === targetRoot) return 0;
  if (!looksLikeAtlasWorkspace(sourceRoot)) return 0;

  fs.mkdirSync(targetRoot, { recursive: true });
  let moved = 0;

  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === '.trash') continue;
    moved += mergeMoveIntoAtlasWorkspace(
      path.join(sourceRoot, entry.name),
      path.join(targetRoot, entry.name),
    );
  }

  return moved;
}

function replaceTextInFile(filePath: string, searchValue: string, replaceValue: string): boolean {
  if (!pathExists(filePath) || !fs.statSync(filePath).isFile()) return false;
  const original = fs.readFileSync(filePath, 'utf-8');
  if (!original.includes(searchValue)) return false;
  fs.writeFileSync(filePath, original.split(searchValue).join(replaceValue), 'utf-8');
  return true;
}

function migrateOpenClawConfigForAtlas(telegramChatId: string | null): boolean {
  const configPath = path.join(OPENCLAW_DIR, 'openclaw.json');
  if (!pathExists(configPath)) return false;

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      agents?: { list?: Array<Record<string, unknown>> };
      bindings?: Array<Record<string, unknown>>;
    };

    let changed = false;
    const agentList = Array.isArray(parsed.agents?.list) ? parsed.agents?.list : [];
    const mainEntry = agentList.find(entry => entry.id === 'main');
    let atlasEntry = agentList.find(entry => entry.id === ATLAS_AGENT_SLUG);

    if (!atlasEntry && mainEntry) {
      atlasEntry = {
        ...mainEntry,
        id: ATLAS_AGENT_SLUG,
        name: ATLAS_AGENT_NAME,
        workspace: ATLAS_WORKSPACE_PATH,
        agentDir: path.join(OPENCLAW_DIR, 'agents', ATLAS_AGENT_SLUG, 'agent'),
        default: true,
      };
      agentList.push(atlasEntry);
      changed = true;
    }

    if (atlasEntry) {
      if (atlasEntry.name !== ATLAS_AGENT_NAME) {
        atlasEntry.name = ATLAS_AGENT_NAME;
        changed = true;
      }
      if (atlasEntry.workspace !== ATLAS_WORKSPACE_PATH) {
        atlasEntry.workspace = ATLAS_WORKSPACE_PATH;
        changed = true;
      }
      const expectedAgentDir = path.join(OPENCLAW_DIR, 'agents', ATLAS_AGENT_SLUG, 'agent');
      if (atlasEntry.agentDir !== expectedAgentDir) {
        atlasEntry.agentDir = expectedAgentDir;
        changed = true;
      }
      if (atlasEntry.default !== true) {
        atlasEntry.default = true;
        changed = true;
      }
      if (telegramChatId) {
        const heartbeat = typeof atlasEntry.heartbeat === 'object' && atlasEntry.heartbeat !== null
          ? atlasEntry.heartbeat as Record<string, unknown>
          : {};
        if (heartbeat.to !== telegramChatId) {
          heartbeat.to = telegramChatId;
          atlasEntry.heartbeat = heartbeat;
          changed = true;
        }
      }
    }

    if (mainEntry && mainEntry.default !== false) {
      mainEntry.default = false;
      changed = true;
    }

    const bindings = Array.isArray(parsed.bindings) ? parsed.bindings : [];
    let telegramBound = false;
    for (const binding of bindings) {
      const match = binding.match as Record<string, unknown> | undefined;
      const peer = match?.peer as Record<string, unknown> | undefined;
      const isTelegramDirect = match?.channel === 'telegram'
        && peer?.kind === 'direct'
        && typeof peer.id === 'string';
      if (!isTelegramDirect) continue;
      telegramBound = telegramBound || binding.agentId === ATLAS_AGENT_SLUG;
      if (binding.agentId === 'main') {
        binding.agentId = ATLAS_AGENT_SLUG;
        telegramBound = true;
        changed = true;
      }
    }

    if (!telegramBound && telegramChatId) {
      bindings.push({
        type: 'route',
        agentId: ATLAS_AGENT_SLUG,
        match: {
          channel: 'telegram',
          peer: { kind: 'direct', id: telegramChatId },
        },
      });
      parsed.bindings = bindings;
      changed = true;
    }

    if (!changed) return false;
    fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
    return true;
  } catch (err) {
    console.warn('[schema] Task #25: failed to migrate openclaw.json:', err);
    return false;
  }
}

function migrateAtlasToDedicatedAgent(): void {
  if (getAppSetting(ATLAS_MIGRATION_SETTING_KEY) === 'true') return;

  const db = getDb();
  const skipExternalMigration = process.env.JEST_WORKER_ID !== undefined || process.env.NODE_ENV === 'test';
  const atlas = getAtlasAgentRecord();
  const hasLegacyWorkspace = looksLikeAtlasWorkspace(LEGACY_MAIN_WORKSPACE_PATH);
  if (!atlas && !hasLegacyWorkspace) return;

  let changed = false;
  let movedEntries = 0;

  if (atlas) {
    const atlasId = Number(atlas.id);
    const previousSessionKey = String(atlas.session_key ?? '');
    const previousWorkspace = String(atlas.workspace_path ?? '');
    const previousOpenClawId = typeof atlas.openclaw_agent_id === 'string' ? atlas.openclaw_agent_id : '';

    db.prepare(`
      UPDATE agents
      SET system_role = ?,
          session_key = ?,
          workspace_path = ?,
          openclaw_agent_id = ?,
          role = CASE
            WHEN role = '' OR role = 'main' OR role = 'General assistant — main session'
              THEN 'Built-in assistant — task routing, coordination, and chat'
            ELSE role
          END
      WHERE id = ?
    `).run(
      ATLAS_SYSTEM_ROLE,
      ATLAS_SESSION_KEY,
      ATLAS_WORKSPACE_PATH,
      ATLAS_AGENT_SLUG,
      atlasId,
    );

    if (
      previousSessionKey === 'main'
      || previousSessionKey === LEGACY_ATLAS_SESSION_KEY
      || previousWorkspace === LEGACY_MAIN_WORKSPACE_PATH
      || previousOpenClawId === 'main'
      || atlas.system_role !== ATLAS_SYSTEM_ROLE
    ) {
      changed = true;
    }

    if (previousSessionKey && previousSessionKey !== ATLAS_SESSION_KEY) {
      db.prepare(`UPDATE job_instances SET session_key = ? WHERE session_key = ?`).run(ATLAS_SESSION_KEY, previousSessionKey);
      db.prepare(`UPDATE chat_messages SET session_key = ? WHERE session_key = ?`).run(ATLAS_SESSION_KEY, previousSessionKey);
      db.prepare(`UPDATE sessions SET external_key = ? WHERE external_key = ?`).run(ATLAS_SESSION_KEY, previousSessionKey);
    }
  }

  const remapTables: Array<[string, string]> = [
    ['chat_messages', 'session_key'],
    ['sessions', 'external_key'],
    ['job_instances', 'session_key'],
  ];
  for (const [tableName, columnName] of remapTables) {
    db.prepare(`
      UPDATE ${tableName}
      SET ${columnName} = REPLACE(${columnName}, ?, ?)
      WHERE ${columnName} LIKE ?
    `).run(LEGACY_ATLAS_TELEGRAM_PREFIX, ATLAS_TELEGRAM_PREFIX, `${LEGACY_ATLAS_TELEGRAM_PREFIX}%`);
  }

  if (!skipExternalMigration) {
    movedEntries = migrateAtlasWorkspace(LEGACY_MAIN_WORKSPACE_PATH, ATLAS_WORKSPACE_PATH);
    if (movedEntries > 0) changed = true;

    const telegramChatId = getAppSetting('telegram_chat_id');
    if (migrateOpenClawConfigForAtlas(telegramChatId)) changed = true;

    if (replaceTextInFile(
      path.join(OPENCLAW_DIR, 'subagents', 'runs.json'),
      LEGACY_ATLAS_TELEGRAM_PREFIX,
      ATLAS_TELEGRAM_PREFIX,
    )) {
      changed = true;
    }
  }

  setAppSetting(ATLAS_MIGRATION_SETTING_KEY, 'true');
  if (changed) {
    console.log(`[schema] Task #25: migrated Atlas to dedicated agent (workspace entries moved: ${movedEntries})`);
  } else {
    console.log('[schema] Task #25: Atlas migration already satisfied');
  }
}

// ── Task #612: Data-driven lifecycle rules ────────────────────────────────────
// lifecycle_rules replaces the hardcoded canonicalOutcomeRoute map.
// transition_requirements replaces the hardcoded requireReleaseGate checks.
export function ensureLifecycleRulesTable(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS lifecycle_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_type   TEXT,
      from_status TEXT NOT NULL,
      outcome     TEXT NOT NULL,
      to_status   TEXT NOT NULL,
      lane        TEXT NOT NULL DEFAULT 'default',
      enabled     INTEGER NOT NULL DEFAULT 1,
      priority    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_lifecycle_rules_lookup
      ON lifecycle_rules(task_type, from_status, outcome);
    CREATE INDEX IF NOT EXISTS idx_lifecycle_rules_type
      ON lifecycle_rules(task_type);

    CREATE TABLE IF NOT EXISTS transition_requirements (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      task_type        TEXT,
      outcome          TEXT NOT NULL,
      field_name       TEXT NOT NULL,
      requirement_type TEXT NOT NULL DEFAULT 'required'
                       CHECK(requirement_type IN ('required','match','from_status')),
      match_field      TEXT,
      severity         TEXT NOT NULL DEFAULT 'block'
                       CHECK(severity IN ('block','warn')),
      message          TEXT NOT NULL DEFAULT '',
      enabled          INTEGER NOT NULL DEFAULT 1,
      priority         INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_transition_req_lookup
      ON transition_requirements(task_type, outcome);
    CREATE INDEX IF NOT EXISTS idx_transition_req_type
      ON transition_requirements(task_type);
  `);

  // Seed lifecycle_rules from the hardcoded canonicalOutcomeRoute map (idempotent)
  const existingRules = (db.prepare(`SELECT COUNT(*) as n FROM lifecycle_rules`).get() as { n: number }).n;
  if (existingRules === 0) {
    const insertRule = db.prepare(`
      INSERT INTO lifecycle_rules (task_type, from_status, outcome, to_status, lane, priority)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const seedRulesTx = db.transaction(() => {
      // Default rules (task_type = NULL → apply to all types)
      const defaults: Array<[null, string, string, string, string, number]> = [
        [null, 'in_progress', 'completed_for_review', 'review', 'default', 0],
        [null, 'review', 'qa_pass', 'qa_pass', 'default', 0],
        [null, 'review', 'qa_fail', 'ready', 'default', 0],
        [null, 'review', 'blocked', 'stalled', 'default', 0],
        [null, 'review', 'failed', 'failed', 'default', 0],
        [null, 'qa_pass', 'approved_for_merge', 'ready_to_merge', 'default', 0],
        [null, 'qa_pass', 'qa_fail', 'ready', 'default', 0],
        [null, 'qa_pass', 'failed', 'failed', 'default', 0],
        [null, 'ready_to_merge', 'deployed_live', 'deployed', 'default', 0],
        [null, 'ready_to_merge', 'qa_fail', 'ready', 'default', 0],
        [null, 'ready_to_merge', 'failed', 'failed', 'default', 0],
        [null, 'deployed', 'live_verified', 'done', 'default', 0],
        [null, 'deployed', 'failed', 'failed', 'default', 0],
        [null, 'deployed', 'qa_fail', 'ready', 'default', 0],
        [null, 'stalled', 'retry', 'ready', 'default', 0],
      ];

      for (const row of defaults) insertRule.run(...row);

      // Task-type overrides: PM family (pm, pm_analysis, pm_operational) skip qa_pass.
      // in_progress:approved_for_merge → ready_to_merge  (primary terminal exit from implementation)
      // review:approved_for_merge → ready_to_merge        (fallback if task was dispatched via review)
      for (const taskType of ['pm', 'pm_analysis', 'pm_operational']) {
        insertRule.run(taskType, 'in_progress', 'approved_for_merge', 'ready_to_merge', 'default', 10);
        insertRule.run(taskType, 'review',      'approved_for_merge', 'ready_to_merge', 'default', 10);
      }
    });
    seedRulesTx();
    console.log('[schema] Seeded lifecycle_rules from canonicalOutcomeRoute defaults');
  }

  // Seed transition_requirements from the hardcoded requireReleaseGate checks (idempotent)
  const existingReqs = (db.prepare(`SELECT COUNT(*) as n FROM transition_requirements`).get() as { n: number }).n;
  if (existingReqs === 0) {
    const insertReq = db.prepare(`
      INSERT INTO transition_requirements (task_type, outcome, field_name, requirement_type, match_field, severity, message, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const seedReqsTx = db.transaction(() => {
      // completed_for_review requirements
      insertReq.run(null, 'completed_for_review', 'review_branch', 'required', null, 'block', 'completed_for_review requires review_branch', 0);
      insertReq.run(null, 'completed_for_review', 'review_commit', 'required', null, 'block', 'completed_for_review requires review_commit', 0);

      // qa_pass requirements
      insertReq.run(null, 'qa_pass', 'status', 'from_status', 'review', 'block', 'qa_pass requires task status review', 0);
      insertReq.run(null, 'qa_pass', 'qa_verified_commit', 'required', null, 'block', 'qa_pass requires qa_verified_commit', 0);
      insertReq.run(null, 'qa_pass', 'review_commit', 'required', null, 'block', 'qa_pass requires review_commit', 0);
      insertReq.run(null, 'qa_pass', 'qa_verified_commit', 'match', 'review_commit', 'block', 'qa_pass requires qa_verified_commit to match review_commit', 0);

      // approved_for_merge requirements
      insertReq.run(null, 'approved_for_merge', 'status', 'from_status', 'qa_pass', 'block', 'approved_for_merge requires task status qa_pass', 0);
      insertReq.run(null, 'approved_for_merge', 'qa_verified_commit', 'required', null, 'block', 'approved_for_merge requires qa_verified_commit', 0);
      insertReq.run(null, 'approved_for_merge', 'review_commit', 'required', null, 'block', 'approved_for_merge requires review_commit', 0);
      insertReq.run(null, 'approved_for_merge', 'qa_verified_commit', 'match', 'review_commit', 'block', 'approved_for_merge requires qa_verified_commit to match review_commit', 0);

      // deployed_live requirements
      insertReq.run(null, 'deployed_live', 'status', 'from_status', 'ready_to_merge', 'block', 'deployed_live requires task status ready_to_merge', 0);
      // merged_commit uses special OR logic: merged_commit OR deployed_commit satisfies
      insertReq.run(null, 'deployed_live', 'merged_commit', 'required', null, 'block', 'deployed_live requires merged_commit or deployed_commit', 0);
      insertReq.run(null, 'deployed_live', 'deploy_target', 'required', null, 'block', 'deployed_live requires deploy_target', 0);
      insertReq.run(null, 'deployed_live', 'deployed_at', 'required', null, 'block', 'deployed_live requires deployed_at', 0);

      // live_verified requirements
      insertReq.run(null, 'live_verified', 'status', 'from_status', 'deployed', 'block', 'live_verified requires task status deployed', 0);
      insertReq.run(null, 'live_verified', 'deployed_commit', 'required', null, 'block', 'live_verified requires deployed_commit', 0);
      insertReq.run(null, 'live_verified', 'live_verified_by', 'required', null, 'block', 'live_verified requires live_verified_by', 0);
      insertReq.run(null, 'live_verified', 'live_verified_at', 'required', null, 'block', 'live_verified requires live_verified_at', 0);

      // PM family overrides: approved_for_merge skips qa_pass requirement.
      // Accepts in_progress OR review as valid from_status (two rows per type).
      // Use severity=warn so that either status passes; the routing_transitions
      // table enforces the actual allowed transitions.
      for (const taskType of ['pm', 'pm_analysis', 'pm_operational']) {
        insertReq.run(taskType, 'approved_for_merge', 'id', 'required', null, 'warn', `${taskType} task: no QA evidence required for approved_for_merge`, 10);
      }
    });
    seedReqsTx();
    console.log('[schema] Seeded transition_requirements from requireReleaseGate defaults');
  }

  // Backfill: ensure deployed_live has a merged_commit requirement (missed in initial seed)
  try {
    const hasMergedCommitReq = db.prepare(`
      SELECT id FROM transition_requirements
      WHERE task_type IS NULL AND outcome = 'deployed_live' AND field_name = 'merged_commit'
      LIMIT 1
    `).get();
    if (!hasMergedCommitReq) {
      db.prepare(`
        INSERT INTO transition_requirements (task_type, outcome, field_name, requirement_type, match_field, severity, message, priority)
        VALUES (NULL, 'deployed_live', 'merged_commit', 'required', NULL, 'block', 'deployed_live requires merged_commit or deployed_commit', 0)
      `).run();
      console.log('[schema] Backfilled: deployed_live merged_commit requirement');
    }
  } catch { /* table may not exist yet */ }

  // Backfill (task #631): PM family lifecycle contracts
  // Ensures lifecycle_rules and transition_requirements are correct for
  // pm, pm_analysis, pm_operational — all skip QA and emit approved_for_merge
  // from in_progress (not just from review).
  try {
    for (const pmType of ['pm', 'pm_analysis', 'pm_operational']) {
      // lifecycle_rules: in_progress → approved_for_merge → ready_to_merge
      for (const fromStatus of ['in_progress', 'review']) {
        const hasRT = db.prepare(`
          SELECT id FROM lifecycle_rules
          WHERE task_type = ? AND from_status = ? AND outcome = 'approved_for_merge'
          LIMIT 1
        `).get(pmType, fromStatus);
        if (!hasRT) {
          db.prepare(`
            INSERT INTO lifecycle_rules (task_type, from_status, outcome, to_status, lane, enabled, priority)
            VALUES (?, ?, 'approved_for_merge', 'ready_to_merge', 'default', 1, 10)
          `).run(pmType, fromStatus);
          console.log(`[schema] Backfilled lifecycle_rule: ${pmType} ${fromStatus}:approved_for_merge → ready_to_merge`);
        }
      }

      // transition_requirements: approved_for_merge for PM types should be warn-only.
      // Prior seedings may have inserted a from_status='review' block requirement —
      // downgrade those to warn so in_progress→approved_for_merge is not blocked.
      db.prepare(`
        UPDATE transition_requirements
        SET severity = 'warn',
            message  = ?,
            updated_at = datetime('now')
        WHERE task_type = ?
          AND outcome   = 'approved_for_merge'
          AND severity  = 'block'
      `).run(`${pmType} task: approved_for_merge allowed from in_progress or review (no QA required)`, pmType);

      // Ensure at least one warn row exists (idempotent insert)
      const hasReq = db.prepare(`
        SELECT id FROM transition_requirements
        WHERE task_type = ? AND outcome = 'approved_for_merge'
        LIMIT 1
      `).get(pmType);
      if (!hasReq) {
        db.prepare(`
          INSERT INTO transition_requirements (task_type, outcome, field_name, requirement_type, match_field, severity, message, priority)
          VALUES (?, 'approved_for_merge', 'id', 'required', NULL, 'warn', ?, 10)
        `).run(pmType, `${pmType} task: no QA evidence required for approved_for_merge`);
        console.log(`[schema] Backfilled transition_requirement: ${pmType} approved_for_merge (warn-only)`);
      }
    }
  } catch (err) {
    console.warn('[schema] Backfill task #631 PM contracts skipped:', err);
  }

  try {
    backfillAllSprintTaskPolicies(db);
  } catch (err) {
    console.warn('[schema] sprint task policy backfill skipped:', err);
  }
}

/**
 * ensureProviderConfigTable — Task #573: provider configuration for onboarding.
 * Stores API keys / connection details for Anthropic, OpenAI, Google, Ollama.
 */
function ensureProviderConfigTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_config (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      slug              TEXT NOT NULL UNIQUE CHECK(slug IN ('anthropic','openai','google','ollama','openai-codex','mlx-studio','minimax')),
      display_name      TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','connected','failed')),
      config            TEXT NOT NULL DEFAULT '{}',
      last_validated_at TEXT,
      validation_error  TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_provider_config_slug ON provider_config(slug);
    CREATE INDEX IF NOT EXISTS idx_provider_config_status ON provider_config(status);
  `);

  // Safe migration: expand provider_config.slug CHECK to include new slugs.
  // Runs when the live DDL is missing a slug that the code now supports.
  try {
    const providerDdl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_config'`
    ).get() as { sql: string } | undefined)?.sql ?? '';
    if (providerDdl && !providerDdl.includes("'minimax'")) {
      const cols = (db.prepare(`PRAGMA table_info(provider_config)`).all() as { name: string }[]).map(c => c.name);
      const colList = cols.join(', ');
      db.pragma('foreign_keys = OFF');
      const migrate = db.transaction(() => {
        db.prepare(`
          CREATE TABLE provider_config_new (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            slug              TEXT NOT NULL UNIQUE CHECK(slug IN ('anthropic','openai','google','ollama','openai-codex','mlx-studio','minimax')),
            display_name      TEXT NOT NULL DEFAULT '',
            status            TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','connected','failed')),
            config            TEXT NOT NULL DEFAULT '{}',
            last_validated_at TEXT,
            validation_error  TEXT,
            created_at        TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `).run();
        db.prepare(`INSERT INTO provider_config_new (${colList}) SELECT ${colList} FROM provider_config`).run();
        db.prepare(`DROP TABLE provider_config`).run();
        db.prepare(`ALTER TABLE provider_config_new RENAME TO provider_config`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_provider_config_slug ON provider_config(slug)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_provider_config_status ON provider_config(status)`).run();
      });
      migrate();
      db.pragma('foreign_keys = ON');
      console.log('[schema] Migrated: expanded provider_config.slug CHECK to include minimax');
    }
  } catch (err) {
    console.error('[schema] Failed to migrate provider_config slug constraint:', err);
  }
}

/**
 * ensureGitHubIdentitiesTable — Task #613: per-agent GitHub identity/credential storage.
 *
 * Each row represents a distinct GitHub account (bot user or service account)
 * that an Atlas HQ agent lane can use for git operations (PR create, approve,
 * merge). Agents reference this table via agents.github_identity_id.
 *
 * Credential model: fine-grained PATs stored in the `token` column.
 * For production hardening, consider encrypting at rest or using a secrets manager.
 *
 * Lane labels (informational): dev, qa, release, shared.
 */
function ensureGitHubIdentitiesTable(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS github_identities (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      github_username   TEXT NOT NULL UNIQUE,
      token             TEXT NOT NULL DEFAULT '',
      git_author_name   TEXT NOT NULL DEFAULT '',
      git_author_email  TEXT NOT NULL DEFAULT '',
      lane              TEXT NOT NULL DEFAULT 'shared' CHECK(lane IN ('dev','qa','release','shared')),
      notes             TEXT NOT NULL DEFAULT '',
      enabled           INTEGER NOT NULL DEFAULT 1,
      last_validated_at TEXT,
      validation_status TEXT DEFAULT NULL CHECK(validation_status IN (NULL,'valid','failed')),
      validation_error  TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_github_identities_username ON github_identities(github_username);
    CREATE INDEX IF NOT EXISTS idx_github_identities_lane ON github_identities(lane);
    CREATE INDEX IF NOT EXISTS idx_github_identities_enabled ON github_identities(enabled);
  `);

  // Add github_identity_id FK to agents table
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN github_identity_id INTEGER REFERENCES github_identities(id) ON DELETE SET NULL`);
    console.log('[schema] Migrated: added github_identity_id to agents');
  } catch (_) { /* column already exists */ }
}

/**
 * ensureFailureClassColumns — Task #634: typed failure classification.
 * Adds failure_class and failure_detail to tasks so the system can distinguish
 * workflow/pipeline failures from genuine code/QA failures and apply recovery.
 */
function ensureFailureClassColumns(): void {
  const db = getDb();

  // Add failure_class to tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN failure_class TEXT DEFAULT NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_failure_class ON tasks(failure_class)`);
    console.log('[schema] Migrated: added failure_class to tasks');
  } catch (_) { /* column already exists */ }

  // Add failure_detail to tasks (human-readable explanation)
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN failure_detail TEXT DEFAULT NULL`);
    console.log('[schema] Migrated: added failure_detail to tasks');
  } catch (_) { /* column already exists */ }

  // Add failure_class to job_instances for per-run tracking
  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN failure_class TEXT DEFAULT NULL`);
    console.log('[schema] Migrated: added failure_class to job_instances');
  } catch (_) { /* column already exists */ }

  // Seed failure-class-aware routing transitions.
  // Auto-recoverable failure classes route to 'ready' instead of 'failed'.
  // These use higher priority so they override the default failed→failed routes.
  const recoverableClasses = [
    'evidence_failure',
    'release_conflict',
    'runtime_contract_failure',
    'routing_failure',
    'env_failure',
    'timeout_failure',
  ];

  const fromStatuses = ['in_progress', 'review', 'qa_pass', 'ready_to_merge', 'deployed'];

  for (const failureClass of recoverableClasses) {
    for (const fromStatus of fromStatuses) {
      const outcome = `failed:${failureClass}`;
      try {
        const existing = db.prepare(`
          SELECT id FROM routing_transitions
          WHERE from_status = ? AND outcome = ? AND task_type IS NULL AND project_id IS NULL
          LIMIT 1
        `).get(fromStatus, outcome) as { id: number } | undefined;

        if (!existing) {
          db.prepare(`
            INSERT INTO routing_transitions (project_id, from_status, outcome, to_status, lane, task_type, priority)
            VALUES (NULL, ?, ?, 'ready', 'default', NULL, 10)
          `).run(fromStatus, outcome);
        }
      } catch { /* ignore duplicate / missing table */ }
    }
  }

  // Evidence failure from in_progress goes to in_progress (same owner refreshes evidence)
  try {
    db.prepare(`
      UPDATE routing_transitions
      SET to_status = 'in_progress'
      WHERE from_status = 'in_progress' AND outcome = 'failed:evidence_failure'
        AND task_type IS NULL AND project_id IS NULL
    `).run();
  } catch { /* ignore */ }

  console.log('[schema] Seeded failure-class recovery routing transitions');

  // ── Task #660: Task Pause — paused_at and pause_reason columns ──────────────
  // paused_at: when the task was paused (NULL = not paused)
  // pause_reason: optional human note explaining why the task is paused
  // Paused tasks are excluded from routing, dispatch, and lifecycle transitions.
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN paused_at TEXT DEFAULT NULL`);
    console.log('[schema] Migrated: added paused_at to tasks (task #660)');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN pause_reason TEXT DEFAULT NULL`);
    console.log('[schema] Migrated: added pause_reason to tasks (task #660)');
  } catch (_) { /* column already exists */ }

  // ── Task #681: Per-agent watchdog timeout overrides ───────────────────────
  // startup_grace_seconds — overrides START_CHECKIN_GRACE_MS for this agent
  // heartbeat_stale_seconds — overrides HEARTBEAT_STALE_MS for this agent
  // NULL = use global defaults
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN startup_grace_seconds INTEGER DEFAULT NULL`);
    console.log('[schema] Migrated: added startup_grace_seconds to agents (task #681)');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE agents ADD COLUMN heartbeat_stale_seconds INTEGER DEFAULT NULL`);
    console.log('[schema] Migrated: added heartbeat_stale_seconds to agents (task #681)');
  } catch (_) { /* column already exists */ }

  // ── Task #30: Lane-agnostic retries — previous_status tracking ─────────────
  // previous_status: the status the task was in before transitioning to failed or stalled.
  // Used by retry/reopen logic to restore the task to its original position in
  // the workflow instead of always resetting to 'ready'.
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN previous_status TEXT DEFAULT NULL`);
    console.log('[schema] Migrated: added previous_status to tasks (task #30)');
  } catch (_) { /* column already exists */ }
}

/**
 * ensureDataMigration593 — Task #593: Backfill job-owned metadata into agents
 * and update routing/project/sprint relationships.
 *
 * This is the data-integrity pass that fills the gaps left after:
 *   - Phase 0 (Task #459): job columns added to agents, backfilled
 *   - Phase 3 (Task #459): agent_id FK columns added to join tables, partially backfilled
 *   - Phase 4 (Task #592): dispatcher now reads agent_id from routing rules (with job_template fallback)
 *
 * What this migration does:
 *   1. Backfill task_routing_rules.agent_id for rows where agent_id IS NULL but
 *      the referenced job_template still exists (18 rows).
 *   2. Assign orphaned routing rules for defunct/deleted job_templates to the
 *      project's primary backend agent. These rows have no valid job_template
 *      to derive agent_id from (16 orphan rows, project 14 / Custom Agent).
 *   3. Backfill legacy task ownership columns so old job-owned rows populate
 *      tasks.agent_id and tasks.review_owner_agent_id from job_templates.agent_id
 *      before any runtime authority check relies on agent ownership.
 *   4. Make job_instances.template_id nullable via a safe table rebuild.
 *      This is required before any new instance can be created without a
 *      job_templates row (which will be the case after Phase 5 cleanup).
 *   5. Log a validation summary of all pre-conditions for Phase 5 (safe drop).
 */
export function ensureDataMigration593(): void {
  const db = getDb();

  // ── Step 1: Backfill task_routing_rules.agent_id (no-op after job_id column dropped) ──
  // Previously backfilled agent_id from job_templates.job_id — column no longer exists.

  // ── Step 2: Assign orphan routing rules (no agent_id) to project's primary agent ──
  try {
    const orphanRules = db.prepare(`
      SELECT trr.id, trr.project_id
      FROM task_routing_rules trr
      WHERE trr.agent_id IS NULL
    `).all() as Array<{ id: number; project_id: number }>;

    if (orphanRules.length > 0) {
      const updateStmt = db.prepare(`
        UPDATE task_routing_rules
        SET agent_id = (
          SELECT a.id FROM agents a
          WHERE a.project_id = ?
            AND a.enabled = 1
          ORDER BY a.id ASC
          LIMIT 1
        )
        WHERE id = ?
      `);

      const tx = db.transaction(() => {
        let updated = 0;
        for (const rule of orphanRules) {
          const r = updateStmt.run(rule.project_id, rule.id);
          updated += r.changes;
        }
        return updated;
      });

      const updated = tx();
      console.log(`[schema] Task #593: assigned ${updated} orphan routing rule(s) to project's primary agent`);
    }
  } catch (err) {
    console.error('[schema] Task #593: step 2 orphan routing rules backfill failed:', err);
  }

  // ── Step 3: Backfill legacy task ownership onto agent-owned columns ──
  // We explicitly migrate old job-owned rows instead of teaching runtime
  // authority checks to fall back to legacy job_id/review_owner_job_id.
  try {
    const taskCols = new Set(
      (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((col) => col.name),
    );
    const hasLegacyJobId = taskCols.has('job_id');
    const hasLegacyReviewOwnerJobId = taskCols.has('review_owner_job_id');

    if (hasLegacyJobId) {
      const backfillAgentOwnership = db.prepare(`
        UPDATE tasks
        SET agent_id = (
          SELECT jt.agent_id
          FROM job_templates jt
          WHERE jt.id = tasks.job_id
          LIMIT 1
        )
        WHERE agent_id IS NULL
          AND job_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM job_templates jt
            WHERE jt.id = tasks.job_id
              AND jt.agent_id IS NOT NULL
          )
      `).run();
      if (backfillAgentOwnership.changes > 0) {
        console.log(`[schema] Task #593: backfilled agent_id on ${backfillAgentOwnership.changes} legacy job-owned task(s)`);
      }
    }

    if (hasLegacyReviewOwnerJobId) {
      const backfillReviewOwnership = db.prepare(`
        UPDATE tasks
        SET review_owner_agent_id = (
          SELECT jt.agent_id
          FROM job_templates jt
          WHERE jt.id = tasks.review_owner_job_id
          LIMIT 1
        )
        WHERE review_owner_agent_id IS NULL
          AND review_owner_job_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM job_templates jt
            WHERE jt.id = tasks.review_owner_job_id
              AND jt.agent_id IS NOT NULL
          )
      `).run();
      if (backfillReviewOwnership.changes > 0) {
        console.log(`[schema] Task #593: backfilled review_owner_agent_id on ${backfillReviewOwnership.changes} legacy review-owned task(s)`);
      }
    }

    const agentCols = new Set(
      (db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>).map((col) => col.name),
    );

    if (agentCols.has('project_id') && agentCols.has('enabled')) {
      const viaProject = db.prepare(`
        UPDATE tasks
        SET agent_id = (
          SELECT a.id FROM agents a
          WHERE a.project_id = tasks.project_id
            AND a.enabled = 1
          ORDER BY a.id ASC
          LIMIT 1
        )
        WHERE agent_id IS NULL
          AND status IN ('done', 'cancelled', 'failed')
      `).run();
      if (viaProject.changes > 0) {
        console.log(`[schema] Task #593: backfilled agent_id on ${viaProject.changes} terminal task(s) via project fallback`);
      }
    } else {
      console.log('[schema] Task #593: skipped terminal task agent_id backfill until agents.project_id/enabled exist');
    }
  } catch (err) {
    console.error('[schema] Task #593: step 3 task ownership backfill failed:', err);
  }

  // ── Step 4: Make job_instances.template_id nullable ──
  // NO-OP: Task #579 Phase 5 migration now drops template_id entirely.
  // This step was only needed as a bridge between Phase 3 and Phase 5.

  // ── Task #643: Atlas-owned skills table ──
  // Skills are now first-class Atlas HQ records. The filesystem (workspace/system dirs)
  // becomes a secondary/read-only surface; product-managed skills live here.
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL UNIQUE,
      description  TEXT NOT NULL DEFAULT '',
      content      TEXT NOT NULL DEFAULT '',
      source       TEXT NOT NULL DEFAULT 'atlas' CHECK(source IN ('atlas','workspace','system')),
      fs_path      TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
    CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source);
  `);

  // ── Step 5: Validation — log Phase 5 pre-condition status ──
  try {
    const checks = [
      ...((db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).some(col => col.name === 'job_id') ? [{
        label: 'legacy tasks with job_id but no agent_id (non-terminal)',
        sql: `SELECT COUNT(*) as n FROM tasks WHERE job_id IS NOT NULL AND agent_id IS NULL AND status NOT IN ('done','cancelled','failed')`,
        wantZero: true,
      }] : []),
      {
        label: 'task_routing_rules with no agent_id',
        sql: `SELECT COUNT(*) as n FROM task_routing_rules WHERE agent_id IS NULL`,
        wantZero: true,
      },
      {
        label: 'job_instances with no agent_id',
        sql: `SELECT COUNT(*) as n FROM job_instances WHERE agent_id IS NULL`,
        wantZero: true,
      },
    ];

    let allPassed = true;
    for (const check of checks) {
      try {
        const row = db.prepare(check.sql).get() as { n: number } | undefined;
        const n = row?.n ?? 0;
        const passed = check.wantZero ? n === 0 : n > 0;
        if (!passed) {
          allPassed = false;
          console.warn(`[schema] Task #593 validation FAIL — ${check.label}: ${n}`);
        }
      } catch { /* table may not exist */ }
    }

    if (allPassed) {
      console.log('[schema] Task #593 validation PASSED — all Phase 5 pre-conditions met');
    } else {
      console.warn('[schema] Task #593 validation: some pre-conditions not yet met (see above)');
    }
  } catch (err) {
    console.error('[schema] Task #593: step 5 validation failed:', err);
  }
}

// ── Task #586: Pipeline Intelligence Telemetry — Event Model ─────────────────
export function ensurePipelineIntelligenceTelemetry(): void {
  const db = getDb();

  // 1. task_events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      sprint_id   INTEGER,
      agent_id    INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      from_status TEXT,
      to_status   TEXT NOT NULL,
      moved_by    TEXT NOT NULL DEFAULT 'system',
      move_type   TEXT NOT NULL DEFAULT 'automatic'
        CHECK(move_type IN ('automatic','outcome','manual','rescue','dispatch')),
      instance_id INTEGER REFERENCES job_instances(id) ON DELETE SET NULL,
      reason      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_events_task      ON task_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_events_project   ON task_events(project_id);
    CREATE INDEX IF NOT EXISTS idx_task_events_agent     ON task_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_task_events_to_status ON task_events(to_status);
    CREATE INDEX IF NOT EXISTS idx_task_events_created   ON task_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_task_events_move_type ON task_events(move_type);
  `);
  console.log('[schema] Task #586: task_events table ensured');

  // 2. integrity_events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS integrity_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      agent_id     INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      instance_id  INTEGER REFERENCES job_instances(id) ON DELETE SET NULL,
      anomaly_type TEXT NOT NULL
        CHECK(anomaly_type IN (
          'missing_review_evidence',
          'missing_qa_evidence',
          'commit_mismatch',
          'deployed_not_verified',
          'stale_outcome_write',
          'branch_missing_on_origin',
          'evidence_placeholder'
        )),
      detail       TEXT,
      resolved     INTEGER NOT NULL DEFAULT 0,
      resolved_at  TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_integrity_events_task         ON integrity_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_integrity_events_project      ON integrity_events(project_id);
    CREATE INDEX IF NOT EXISTS idx_integrity_events_agent        ON integrity_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_integrity_events_anomaly_type ON integrity_events(anomaly_type);
    CREATE INDEX IF NOT EXISTS idx_integrity_events_created      ON integrity_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_integrity_events_resolved     ON integrity_events(resolved);
  `);
  console.log('[schema] Task #586: integrity_events table ensured');

  // 3. job_instances: failure_stage column
  try {
    const cols = db.prepare(`PRAGMA table_info(job_instances)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'failure_stage')) {
      db.exec(`ALTER TABLE job_instances ADD COLUMN failure_stage TEXT DEFAULT NULL`);
      console.log('[schema] Task #586: added failure_stage to job_instances');
    }
  } catch (err) {
    console.error('[schema] Task #586: failed to add failure_stage:', err);
  }

  // 4. agents: pre_instructions tracking
  try {
    const agentCols = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
    if (!agentCols.some(c => c.name === 'pre_instructions_updated_at')) {
      db.exec(`ALTER TABLE agents ADD COLUMN pre_instructions_updated_at TEXT DEFAULT NULL`);
      console.log('[schema] Task #586: added pre_instructions_updated_at to agents');
    }
    if (!agentCols.some(c => c.name === 'instructions_version')) {
      db.exec(`ALTER TABLE agents ADD COLUMN instructions_version INTEGER NOT NULL DEFAULT 0`);
      console.log('[schema] Task #586: added instructions_version to agents');
    }
  } catch (err) {
    console.error('[schema] Task #586: agent column migration failed:', err);
  }

  // 5. tasks: dispatch tracking + manual intervention counter
  try {
    const taskCols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
    if (!taskCols.some(c => c.name === 'first_dispatched_at')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN first_dispatched_at TEXT DEFAULT NULL`);
      console.log('[schema] Task #586: added first_dispatched_at to tasks');
    }
    if (!taskCols.some(c => c.name === 'total_dispatch_count')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN total_dispatch_count INTEGER NOT NULL DEFAULT 0`);
      console.log('[schema] Task #586: added total_dispatch_count to tasks');
    }
    if (!taskCols.some(c => c.name === 'manual_intervention_count')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN manual_intervention_count INTEGER NOT NULL DEFAULT 0`);
      console.log('[schema] Task #586: added manual_intervention_count to tasks');
    }
  } catch (err) {
    console.error('[schema] Task #586: task column migration failed:', err);
  }

  // ── Task #596: Remove legacy jobs infrastructure ────────────────────────────
  // Drop tables that are no longer referenced. sprint_job_schedules has an FK
  // from sprint_schedule_fires, so drop the dependent table first.
  try {
    db.exec(`DROP TABLE IF EXISTS sprint_schedule_fires`);
    db.exec(`DROP TABLE IF EXISTS routing_config_legacy`);
    db.exec(`DROP TABLE IF EXISTS sprint_job_schedules`);
    db.exec(`DROP TABLE IF EXISTS sprint_job_assignments`);
    console.log('[schema] Task #596: dropped legacy tables (routing_config_legacy, sprint_job_schedules, sprint_job_assignments, sprint_schedule_fires)');
  } catch (err) {
    console.error('[schema] Task #596: drop legacy tables failed:', err);
  }

  // Make job_id nullable on task_routing_rules.
  // SQLite doesn't support ALTER COLUMN, so we recreate the table.
  try {
    const trrCols = db.prepare(`PRAGMA table_info(task_routing_rules)`).all() as Array<{ name: string }>;
    const hasJobId = trrCols.some(c => c.name === 'job_id');
    if (hasJobId) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_routing_rules_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_type TEXT NOT NULL,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          agent_id INTEGER REFERENCES agents(id)
        );
        INSERT INTO task_routing_rules_new (id, project_id, task_type, status, priority, created_at, updated_at, agent_id)
          SELECT id, project_id, task_type, status, priority, created_at, updated_at, agent_id FROM task_routing_rules;
        DROP TABLE task_routing_rules;
        ALTER TABLE task_routing_rules_new RENAME TO task_routing_rules;
        CREATE INDEX IF NOT EXISTS idx_trr_project ON task_routing_rules(project_id);
        CREATE INDEX IF NOT EXISTS idx_trr_lookup ON task_routing_rules(project_id, task_type, status);
      `);
      console.log('[schema] Task #596: dropped job_id column from task_routing_rules');
    }
  } catch (err) {
    console.error('[schema] Task #596: task_routing_rules migration failed:', err);
  }

  // ── Task #53: Drop job_template_id FK column from agents ───────────────────
  // The job_templates table was dropped in Task #596, but agents.job_template_id
  // still carried a REFERENCES job_templates(id) FK. With foreign_keys = ON,
  // any write operation touching agents (including DELETE) causes SQLite to
  // validate the FK against the now-missing table, crashing with:
  //   SqliteError: no such table: main.job_templates
  // Fix: drop the stale column. SQLite >= 3.35.0 supports ALTER TABLE ... DROP COLUMN
  // when the column has no dependencies (indexes, triggers, generated columns).
  // The FK constraint is stored only in the column definition, so DROP COLUMN works.
  try {
    const agentCols53 = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
    if (agentCols53.some(c => c.name === 'job_template_id')) {
      db.exec(`ALTER TABLE agents DROP COLUMN job_template_id`);
      console.log('[schema] Task #53: dropped stale job_template_id column from agents');
    }
  } catch (err) {
    console.error('[schema] Task #53: failed to drop job_template_id from agents:', err);
  }

  // ── Task #56: Drop stale job_templates FK from task_creation_events and task_outcome_metrics ──
  // After Task #579 dropped job_templates, the original DDL stored in sqlite_master for
  // task_creation_events and task_outcome_metrics still contains:
  //   job_id INTEGER REFERENCES job_templates(id) ON DELETE SET NULL
  // With foreign_keys = ON, any CASCADE DELETE from tasks (or direct delete on these tables)
  // causes SQLite to validate this FK against the now-missing job_templates table, producing:
  //   SqliteError: no such table: main.job_templates
  // SQLite does not support dropping a column that has an index on it, so we do a
  // full table rebuild (rename → recreate → copy → drop old).
  try {
    const tceDdl56 = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='task_creation_events'`
    ).get() as { sql: string } | undefined)?.sql ?? '';

    if (tceDdl56.includes('job_templates')) {
      db.pragma('foreign_keys = OFF');
      db.exec(`
        ALTER TABLE task_creation_events RENAME TO task_creation_events_old;

        CREATE TABLE task_creation_events (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id           INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
          sprint_id         INTEGER REFERENCES sprints(id) ON DELETE SET NULL,
          job_id            INTEGER,
          source            TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','skill','agent','api','import')),
          routing           TEXT NOT NULL DEFAULT '',
          confidence        TEXT NOT NULL DEFAULT '' CHECK(confidence IN ('','low','medium','high')),
          scope_size        TEXT NOT NULL DEFAULT '' CHECK(scope_size IN ('','xs','small','medium','large','xl')),
          assumptions       TEXT NOT NULL DEFAULT '',
          open_questions    TEXT NOT NULL DEFAULT '',
          needs_split       INTEGER NOT NULL DEFAULT 0,
          expected_artifact TEXT NOT NULL DEFAULT '',
          success_mode      TEXT NOT NULL DEFAULT '',
          raw_input         TEXT NOT NULL DEFAULT '',
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          agent_id          INTEGER REFERENCES agents(id)
        );

        INSERT INTO task_creation_events
          SELECT id, task_id, project_id, sprint_id, job_id, source, routing, confidence,
                 scope_size, assumptions, open_questions, needs_split, expected_artifact,
                 success_mode, raw_input, created_at, agent_id
          FROM task_creation_events_old;

        DROP TABLE task_creation_events_old;

        CREATE INDEX IF NOT EXISTS idx_tce_task      ON task_creation_events(task_id);
        CREATE INDEX IF NOT EXISTS idx_tce_project   ON task_creation_events(project_id);
        CREATE INDEX IF NOT EXISTS idx_tce_sprint    ON task_creation_events(sprint_id);
        CREATE INDEX IF NOT EXISTS idx_tce_job       ON task_creation_events(job_id);
        CREATE INDEX IF NOT EXISTS idx_tce_source    ON task_creation_events(source);
        CREATE INDEX IF NOT EXISTS idx_tce_created   ON task_creation_events(created_at);
      `);
      db.pragma('foreign_keys = ON');
      console.log('[schema] Task #56: rebuilt task_creation_events without stale job_templates FK');
    }
  } catch (err) {
    db.pragma('foreign_keys = ON');
    console.error('[schema] Task #56: task_creation_events rebuild failed:', err);
  }

  try {
    const tomDdl56 = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='task_outcome_metrics'`
    ).get() as { sql: string } | undefined)?.sql ?? '';

    if (tomDdl56.includes('job_templates')) {
      db.pragma('foreign_keys = OFF');
      db.exec(`
        ALTER TABLE task_outcome_metrics RENAME TO task_outcome_metrics_old;

        CREATE TABLE task_outcome_metrics (
          id                      INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id                 INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
          project_id              INTEGER REFERENCES projects(id) ON DELETE SET NULL,
          sprint_id               INTEGER REFERENCES sprints(id) ON DELETE SET NULL,
          job_id                  INTEGER,
          first_pass_qa           INTEGER NOT NULL DEFAULT 0,
          reopened_count          INTEGER NOT NULL DEFAULT 0,
          rerouted_count          INTEGER NOT NULL DEFAULT 0,
          split_after_creation    INTEGER NOT NULL DEFAULT 0,
          blocked_after_creation  INTEGER NOT NULL DEFAULT 0,
          clarification_count     INTEGER NOT NULL DEFAULT 0,
          notes_count             INTEGER NOT NULL DEFAULT 0,
          cycle_time_hours        REAL,
          outcome_quality         TEXT NOT NULL DEFAULT '' CHECK(outcome_quality IN ('','good','acceptable','poor')),
          failure_reasons         TEXT NOT NULL DEFAULT '[]',
          outcome_summary         TEXT NOT NULL DEFAULT '',
          recorded_at             TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
          agent_id                INTEGER REFERENCES agents(id),
          spawned_defects         INTEGER NOT NULL DEFAULT 0
        );

        INSERT INTO task_outcome_metrics
          SELECT id, task_id, project_id, sprint_id, job_id, first_pass_qa, reopened_count,
                 rerouted_count, split_after_creation, blocked_after_creation, clarification_count,
                 notes_count, cycle_time_hours, outcome_quality, failure_reasons, outcome_summary,
                 recorded_at, updated_at, agent_id, spawned_defects
          FROM task_outcome_metrics_old;

        DROP TABLE task_outcome_metrics_old;

        CREATE INDEX IF NOT EXISTS idx_tom_task      ON task_outcome_metrics(task_id);
        CREATE INDEX IF NOT EXISTS idx_tom_project   ON task_outcome_metrics(project_id);
        CREATE INDEX IF NOT EXISTS idx_tom_sprint    ON task_outcome_metrics(sprint_id);
        CREATE INDEX IF NOT EXISTS idx_tom_job       ON task_outcome_metrics(job_id);
        CREATE INDEX IF NOT EXISTS idx_tom_quality   ON task_outcome_metrics(outcome_quality);
        CREATE INDEX IF NOT EXISTS idx_tom_recorded  ON task_outcome_metrics(recorded_at);
      `);
      db.pragma('foreign_keys = ON');
      console.log('[schema] Task #56: rebuilt task_outcome_metrics without stale job_templates FK');
    }
  } catch (err) {
    db.pragma('foreign_keys = ON');
    console.error('[schema] Task #56: task_outcome_metrics rebuild failed:', err);
  }

  try {
    migrateAgentSessionKeysToCanonical(db);
  } catch (err) {
    console.error('[schema] Task #91/92: agent session key migration failed:', err);
  }
}
