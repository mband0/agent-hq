import type Database from 'better-sqlite3';
import { getDb } from '../db/client';
import { resolveTranscriptProvider } from './transcriptProvider';
import {
  resolveSessionAdapterForKey,
  resolveSessionAdapter,
  type IngestResult,
  type AdapterSource,
} from './sessionAdapters';

export type CanonicalSessionStatus = 'active' | 'completed' | 'failed' | 'abandoned';

export interface CanonicalSessionRow {
  id: number;
  external_key: string;
  runtime: string;
  agent_id: number | null;
  task_id: number | null;
  instance_id: number | null;
  project_id: number | null;
  status: CanonicalSessionStatus;
  title: string;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  token_input: number | null;
  token_output: number | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

interface InstanceContextRow {
  id: number;
  session_key: string | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  dispatched_at: string | null;
  created_at: string;
  run_id: string | null;
  token_input: number | null;
  token_output: number | null;
  agent_id: number | null;
  task_id: number | null;
  project_id: number | null;
  task_title: string | null;
  agent_name: string | null;
  agent_session_key: string | null;
  runtime_type: string | null;
}

function mapInstanceStatus(status: string | null | undefined): CanonicalSessionStatus {
  switch (status) {
    case 'done':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'queued':
    case 'dispatched':
    case 'running':
    default:
      return 'active';
  }
}

function inferRuntime(sessionKey: string | null, runtimeType: string | null): string {
  if (sessionKey?.startsWith('claude-code:')) return 'claude-code';
  if (sessionKey?.startsWith('cron:')) return 'cron';
  if (runtimeType === 'veri') return 'veri';
  if (runtimeType === 'webhook') return 'webhook';
  if (runtimeType === 'claude-code') return 'claude-code';
  if (runtimeType === 'openclaw') return 'openclaw';
  if (sessionKey?.includes('hook:atlas:jobrun:')) return 'openclaw';
  return runtimeType || 'unknown';
}

function deriveTitle(row: InstanceContextRow): string {
  if (row.task_title?.trim()) return row.task_title.trim();
  if (row.agent_name?.trim()) return `${row.agent_name.trim()} session`;
  return `Session ${row.id}`;
}

function buildMetadata(row: InstanceContextRow): string {
  return JSON.stringify({
    run_id: row.run_id ?? null,
    runtime_type: row.runtime_type ?? null,
    agent_session_key: row.agent_session_key ?? null,
  });
}

function getInstanceContext(db: Database.Database, instanceId: number): InstanceContextRow | undefined {
  return db.prepare(`
    SELECT
      ji.id,
      ji.session_key,
      ji.status,
      ji.started_at,
      ji.completed_at,
      ji.dispatched_at,
      ji.created_at,
      ji.run_id,
      ji.token_input,
      ji.token_output,
      ji.agent_id,
      ji.task_id,
      COALESCE(t.project_id, NULL) AS project_id,
      t.title AS task_title,
      a.name AS agent_name,
      a.session_key AS agent_session_key,
      a.runtime_type
    FROM job_instances ji
    LEFT JOIN tasks t ON t.id = ji.task_id
    LEFT JOIN agents a ON a.id = ji.agent_id
    WHERE ji.id = ?
  `).get(instanceId) as InstanceContextRow | undefined;
}

function syncSessionMessageCount(db: Database.Database, sessionId: number): void {
  db.prepare(`
    UPDATE sessions
    SET message_count = (
      SELECT COUNT(*) FROM session_messages WHERE session_id = ?
    ), updated_at = datetime('now')
    WHERE id = ?
  `).run(sessionId, sessionId);
}


function backfillSessionMessagesFromChatMessages(db: Database.Database, sessionId: number, instanceId: number): number {
  const rows = db.prepare(`
    SELECT id, role, event_type, content, timestamp
      FROM chat_messages
     WHERE instance_id = ?
     ORDER BY timestamp ASC, id ASC
  `).all(instanceId) as Array<{
    id: number;
    role: string | null;
    event_type: string | null;
    content: string | null;
    timestamp: string | null;
  }>;

  if (!rows.length) return 0;

  const insert = db.prepare(`
    INSERT INTO session_messages (
      session_id, ordinal, role, event_type, content, event_meta, raw_payload, timestamp, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(session_id, ordinal) DO UPDATE SET
      role = excluded.role,
      event_type = excluded.event_type,
      content = excluded.content,
      event_meta = excluded.event_meta,
      raw_payload = COALESCE(excluded.raw_payload, session_messages.raw_payload),
      timestamp = excluded.timestamp
  `);

  const tx = db.transaction(() => {
    rows.forEach((row, idx) => {
      insert.run(
        sessionId,
        idx,
        row.role ?? 'system',
        row.event_type ?? 'text',
        row.content ?? '',
        JSON.stringify({ source: 'chat_messages_backfill', chat_message_id: row.id, instance_id: instanceId }),
        null,
        row.timestamp,
      );
    });
  });

  tx();
  syncSessionMessageCount(db, sessionId);
  return rows.length;
}

export function upsertCanonicalSessionForInstance(
  db: Database.Database,
  instanceId: number,
  sessionKeyOverride?: string | null,
): CanonicalSessionRow | null {
  const row = getInstanceContext(db, instanceId);
  if (!row) return null;

  const externalKey = sessionKeyOverride?.trim() || row.session_key?.trim();
  if (!externalKey) return null;

  const runtime = inferRuntime(externalKey, row.runtime_type);
  const status = mapInstanceStatus(row.status);
  const startedAt = row.started_at ?? row.dispatched_at ?? row.created_at;
  const endedAt = status === 'completed' || status === 'failed' || status === 'abandoned'
    ? (row.completed_at ?? null)
    : null;

  db.prepare(`
    INSERT INTO sessions (
      external_key, runtime, agent_id, task_id, instance_id, project_id,
      status, title, started_at, ended_at, token_input, token_output,
      metadata, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(external_key) DO UPDATE SET
      runtime = excluded.runtime,
      agent_id = COALESCE(excluded.agent_id, sessions.agent_id),
      task_id = COALESCE(excluded.task_id, sessions.task_id),
      instance_id = COALESCE(excluded.instance_id, sessions.instance_id),
      project_id = COALESCE(excluded.project_id, sessions.project_id),
      status = excluded.status,
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE sessions.title END,
      started_at = COALESCE(excluded.started_at, sessions.started_at),
      ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
      token_input = COALESCE(excluded.token_input, sessions.token_input),
      token_output = COALESCE(excluded.token_output, sessions.token_output),
      metadata = CASE WHEN excluded.metadata != '{}' THEN excluded.metadata ELSE sessions.metadata END,
      updated_at = datetime('now')
  `).run(
    externalKey,
    runtime,
    row.agent_id,
    row.task_id,
    row.id,
    row.project_id,
    status,
    deriveTitle(row),
    startedAt,
    endedAt,
    row.token_input,
    row.token_output,
    buildMetadata(row),
  );

  const session = db.prepare(`SELECT * FROM sessions WHERE external_key = ?`).get(externalKey) as CanonicalSessionRow | undefined;
  return session ?? null;
}

export async function ensureCanonicalSessionForInstance(
  instanceId: number,
  opts: { forceIngest?: boolean; sessionKey?: string | null } = {},
): Promise<CanonicalSessionRow | null> {
  const db = getDb();
  const session = upsertCanonicalSessionForInstance(db, instanceId, opts.sessionKey ?? null);
  if (!session) return null;

  const existingCount = (db.prepare('SELECT COUNT(*) as n FROM session_messages WHERE session_id = ?').get(session.id) as { n: number }).n;
  if (!opts.forceIngest && existingCount > 0) {
    syncSessionMessageCount(db, session.id);
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id) as CanonicalSessionRow;
  }

  const provider = resolveTranscriptProvider(instanceId);
  const transcript = await provider.getTranscript(instanceId);
  if (!transcript.messages.length) {
    const inserted = backfillSessionMessagesFromChatMessages(db, session.id, instanceId);
    if (inserted > 0) {
      return db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id) as CanonicalSessionRow;
    }
  }

  const insert = db.prepare(`
    INSERT INTO session_messages (
      session_id, ordinal, role, event_type, content, event_meta, raw_payload, timestamp, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(session_id, ordinal) DO UPDATE SET
      role = excluded.role,
      event_type = excluded.event_type,
      content = excluded.content,
      event_meta = excluded.event_meta,
      raw_payload = COALESCE(excluded.raw_payload, session_messages.raw_payload),
      timestamp = excluded.timestamp
  `);

  const tx = db.transaction(() => {
    transcript.messages.forEach((message, idx) => {
      insert.run(
        session.id,
        idx,
        message.role,
        message.event_type ?? 'text',
        message.content,
        JSON.stringify(message.event_meta ?? {}),
        null,
        message.timestamp,
      );
    });

    db.prepare(`
      UPDATE sessions
      SET message_count = (
            SELECT COUNT(*) FROM session_messages WHERE session_id = ?
          ),
          status = CASE
            WHEN ? = 1 THEN 'active'
            ELSE status
          END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(session.id, transcript.in_progress ? 1 : 0, session.id);
  });

  tx();

  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id) as CanonicalSessionRow;
}

export async function ensureCanonicalSessionByExternalKey(externalKey: string): Promise<CanonicalSessionRow | null> {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM sessions WHERE external_key = ?').get(externalKey) as CanonicalSessionRow | undefined;
  if (existing) return existing;

  // Instance-linked path — direct match or hook:atlas:jobrun:<id> pattern
  const directInstance = db.prepare('SELECT id FROM job_instances WHERE session_key = ? LIMIT 1').get(externalKey) as { id: number } | undefined;
  if (directInstance) return ensureCanonicalSessionForInstance(directInstance.id);

  const runIdMatch = externalKey.match(/hook:atlas:jobrun:(\d+)$/);
  if (runIdMatch) {
    return ensureCanonicalSessionForInstance(Number(runIdMatch[1]));
  }

  // Adapter-based pull ingestion (cron runs, claude-code JSONL, etc.)
  const adapter = resolveSessionAdapterForKey(externalKey);
  const source: AdapterSource = { externalKey };
  const result = await adapter.ingest(source);
  if (result) {
    return writeIngestResult(db, result);
  }

  return null;
}

/**
 * writeIngestResult — persist an IngestResult (session upsert + messages) to the DB.
 *
 * Handles upsert conflicts on external_key and ordinal so it's safe to call
 * repeatedly (idempotent ingestion).
 */
export function writeIngestResult(db: Database.Database, result: IngestResult): CanonicalSessionRow | null {
  const { session, messages } = result;

  // Upsert the session row
  db.prepare(`
    INSERT INTO sessions (
      external_key, runtime, agent_id, task_id, instance_id, project_id,
      status, title, started_at, ended_at, token_input, token_output,
      metadata, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(external_key) DO UPDATE SET
      runtime = excluded.runtime,
      agent_id = COALESCE(excluded.agent_id, sessions.agent_id),
      task_id = COALESCE(excluded.task_id, sessions.task_id),
      instance_id = COALESCE(excluded.instance_id, sessions.instance_id),
      project_id = COALESCE(excluded.project_id, sessions.project_id),
      status = excluded.status,
      title = CASE WHEN excluded.title IS NOT NULL AND excluded.title != '' THEN excluded.title ELSE sessions.title END,
      started_at = COALESCE(excluded.started_at, sessions.started_at),
      ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
      token_input = COALESCE(excluded.token_input, sessions.token_input),
      token_output = COALESCE(excluded.token_output, sessions.token_output),
      metadata = CASE WHEN excluded.metadata IS NOT NULL AND excluded.metadata != '{}' THEN excluded.metadata ELSE sessions.metadata END,
      updated_at = datetime('now')
  `).run(
    session.externalKey,
    session.runtime,
    session.agentId ?? null,
    session.taskId ?? null,
    session.instanceId ?? null,
    session.projectId ?? null,
    session.status,
    session.title ?? '',
    session.startedAt ?? null,
    session.endedAt ?? null,
    session.tokenInput ?? null,
    session.tokenOutput ?? null,
    session.metadata ? JSON.stringify(session.metadata) : '{}',
  );

  const sessionRow = db.prepare('SELECT * FROM sessions WHERE external_key = ?').get(session.externalKey) as CanonicalSessionRow | undefined;
  if (!sessionRow) return null;

  if (messages.length > 0) {
    const insertMsg = db.prepare(`
      INSERT INTO session_messages (
        session_id, ordinal, role, event_type, content, event_meta, raw_payload, timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(session_id, ordinal) DO UPDATE SET
        role = excluded.role,
        event_type = excluded.event_type,
        content = excluded.content,
        event_meta = excluded.event_meta,
        raw_payload = COALESCE(excluded.raw_payload, session_messages.raw_payload),
        timestamp = excluded.timestamp
    `);

    const tx = db.transaction(() => {
      for (const msg of messages) {
        insertMsg.run(
          sessionRow.id,
          msg.ordinal,
          msg.role,
          msg.eventType,
          msg.content,
          JSON.stringify(msg.eventMeta ?? {}),
          msg.rawPayload ?? null,
          msg.timestamp,
        );
      }
    });
    tx();

    syncSessionMessageCount(db, sessionRow.id);
  }

  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionRow.id) as CanonicalSessionRow;
}

/**
 * ingestSessionByExternalKey — ingest a session using the appropriate adapter.
 * Unlike ensureCanonicalSessionByExternalKey, this always re-runs the adapter
 * (useful for forced refresh after a run completes).
 *
 * @param externalKey  The runtime session key to ingest.
 * @param source       Optional additional context (instanceId, agentId, etc.).
 * @param runtime      Optional explicit runtime (skips key-based inference).
 */
export async function ingestSessionByExternalKey(
  externalKey: string,
  source: Partial<AdapterSource> = {},
  runtime?: string,
): Promise<CanonicalSessionRow | null> {
  const db = getDb();
  const adapter = runtime
    ? (resolveSessionAdapter(runtime) ?? resolveSessionAdapterForKey(externalKey))
    : resolveSessionAdapterForKey(externalKey);

  const fullSource: AdapterSource = { externalKey, ...source };
  const result = await adapter.ingest(fullSource);
  if (!result) return null;

  return writeIngestResult(db, result);
}
