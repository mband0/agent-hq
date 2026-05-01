import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { CONTRACT_PLACEHOLDER_DEFINITIONS, getAvailableContractPlaceholders } from '../services/contracts';
import fs from 'fs';
import path from 'path';
import { VALID_TASK_TYPES, isValidTaskType } from '../lib/taskTypes';
import { getNeedsAttentionEligibleStatuses, setNeedsAttentionEligibleStatuses } from '../lib/reconcilerConfig';
import {
  listSprintTaskRoutingRules,
  listSprintTaskStatuses,
  listSprintTaskTransitionRequirements,
  listSprintTaskTransitions,
  seedSprintTaskPolicy,
} from '../lib/sprintTaskPolicy';

const router = Router();

function parseSprintId(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function requireSprint(db: ReturnType<typeof getDb>, sprintId: number | null): { id: number; name: string } {
  if (!sprintId) throw new Error('sprint_id is required');
  const sprint = db.prepare(`SELECT id, name FROM sprints WHERE id = ?`).get(sprintId) as { id: number; name: string } | undefined;
  if (!sprint) throw new Error(`Sprint ${sprintId} not found`);
  return sprint;
}

function upsertGlobalTransition(
  tableName: 'routing_transitions',
  row: { from_status: string; outcome: string; to_status: string; lane?: string; enabled?: number },
): void {
  const db = getDb();
  const existing = db.prepare(`
    SELECT id
    FROM ${tableName}
    WHERE project_id IS NULL AND from_status = ? AND outcome = ?
    LIMIT 1
  `).get(row.from_status, row.outcome) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE ${tableName}
      SET to_status = ?, lane = ?, enabled = ?
      WHERE id = ?
    `).run(row.to_status, row.lane ?? 'default', row.enabled ?? 1, existing.id);
    return;
  }

  db.prepare(`
    INSERT INTO ${tableName} (project_id, from_status, outcome, to_status, lane, enabled)
    VALUES (NULL, ?, ?, ?, ?, ?)
  `).run(row.from_status, row.outcome, row.to_status, row.lane ?? 'default', row.enabled ?? 1);
}

// ── task_statuses + release-pipeline routing migrations (idempotent) ─────────
function ensureRoutingMetadata(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_statuses (
      name                TEXT PRIMARY KEY,
      label               TEXT NOT NULL,
      color               TEXT NOT NULL DEFAULT 'slate',
      terminal            INTEGER NOT NULL DEFAULT 0,
      is_system           INTEGER NOT NULL DEFAULT 0,
      allowed_transitions TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS routing_transitions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      from_status  TEXT NOT NULL,
      outcome      TEXT NOT NULL,
      to_status    TEXT NOT NULL,
      lane         TEXT NOT NULL DEFAULT 'default',
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_routing_transitions_project ON routing_transitions(project_id);
    CREATE INDEX IF NOT EXISTS idx_routing_transitions_from ON routing_transitions(from_status, outcome);
  `);

  const statuses: Array<{ name: string; label: string; color: string; terminal: number; is_system: number; allowed_transitions: string[] }> = [
    { name: 'todo', label: 'To Do', color: 'slate', terminal: 0, is_system: 1, allowed_transitions: ['ready', 'cancelled'] },
    { name: 'ready', label: 'Ready', color: 'blue', terminal: 0, is_system: 1, allowed_transitions: ['dispatched', 'in_progress', 'cancelled'] },
    { name: 'dispatched', label: 'Dispatched', color: 'indigo', terminal: 0, is_system: 1, allowed_transitions: ['in_progress', 'ready'] },
    { name: 'in_progress', label: 'In Progress', color: 'yellow', terminal: 0, is_system: 1, allowed_transitions: ['review', 'stalled', 'cancelled'] },
    { name: 'review', label: 'Review', color: 'purple', terminal: 0, is_system: 1, allowed_transitions: ['qa_pass', 'ready', 'stalled', 'failed', 'cancelled'] },
    { name: 'qa_pass', label: 'QA Pass', color: 'emerald', terminal: 0, is_system: 1, allowed_transitions: ['ready_to_merge', 'ready', 'failed'] },
    { name: 'ready_to_merge', label: 'Ready to Merge', color: 'cyan', terminal: 0, is_system: 1, allowed_transitions: ['deployed', 'ready', 'failed'] },
    { name: 'deployed', label: 'Deployed', color: 'green', terminal: 0, is_system: 1, allowed_transitions: ['done', 'ready', 'failed'] },
    { name: 'stalled', label: 'Stalled', color: 'orange', terminal: 0, is_system: 1, allowed_transitions: ['ready', 'cancelled'] },
    { name: 'needs_attention', label: 'Needs Attention', color: 'amber', terminal: 0, is_system: 1, allowed_transitions: ['todo', 'ready', 'dispatched', 'in_progress', 'review', 'qa_pass', 'ready_to_merge', 'deployed', 'done', 'cancelled', 'failed', 'stalled', 'blocked'] },
    { name: 'done', label: 'Done', color: 'green', terminal: 1, is_system: 1, allowed_transitions: ['todo'] },
    { name: 'cancelled', label: 'Cancelled', color: 'red', terminal: 1, is_system: 1, allowed_transitions: ['todo'] },
    { name: 'failed', label: 'Failed', color: 'red', terminal: 1, is_system: 1, allowed_transitions: ['todo', 'ready'] },
  ];

  const seedTx = db.transaction(() => {
    for (const status of statuses) {
      db.prepare(`
        INSERT INTO task_statuses (name, label, color, terminal, is_system, allowed_transitions)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          label = excluded.label,
          color = excluded.color,
          terminal = excluded.terminal,
          is_system = excluded.is_system,
          allowed_transitions = excluded.allowed_transitions
      `).run(
        status.name,
        status.label,
        status.color,
        status.terminal,
        status.is_system,
        JSON.stringify(status.allowed_transitions),
      );
    }

    const transitions = [
      { from_status: 'in_progress', outcome: 'completed_for_review', to_status: 'review' },
      { from_status: 'in_progress', outcome: 'blocked', to_status: 'stalled' },
      { from_status: 'in_progress', outcome: 'failed', to_status: 'failed' },
      { from_status: 'review', outcome: 'qa_pass', to_status: 'qa_pass' },
      { from_status: 'review', outcome: 'qa_fail', to_status: 'ready' },
      { from_status: 'review', outcome: 'blocked', to_status: 'stalled' },
      { from_status: 'review', outcome: 'failed', to_status: 'failed' },
      { from_status: 'qa_pass', outcome: 'approved_for_merge', to_status: 'ready_to_merge', lane: 'auto' },
      { from_status: 'qa_pass', outcome: 'qa_fail', to_status: 'ready' },
      { from_status: 'qa_pass', outcome: 'failed', to_status: 'failed' },
      { from_status: 'ready_to_merge', outcome: 'deployed_live', to_status: 'deployed' },
      { from_status: 'ready_to_merge', outcome: 'qa_fail', to_status: 'ready' },
      { from_status: 'ready_to_merge', outcome: 'failed', to_status: 'failed' },
      { from_status: 'deployed', outcome: 'live_verified', to_status: 'done' },
      { from_status: 'deployed', outcome: 'qa_fail', to_status: 'ready' },
      { from_status: 'deployed', outcome: 'failed', to_status: 'failed' },
      { from_status: 'stalled', outcome: 'retry', to_status: 'ready' },
    ];

    for (const transition of transitions) {
      upsertGlobalTransition('routing_transitions', transition);
    }

    db.prepare(`
      UPDATE routing_transitions
      SET enabled = 0
      WHERE project_id IS NULL
        AND (
          (from_status = 'review' AND outcome = 'qa_pass' AND to_status = 'done')
          OR (from_status = 'review' AND outcome = 'qa_fail' AND to_status IN ('ready', 'in_progress') AND to_status != 'ready')
          OR (from_status = 'in_progress' AND outcome = 'completed_done')
        )
    `).run();
  });

  seedTx();

  // ── Migration: add task_type, priority, is_protected columns (idempotent) ──
  // These columns make routing_transitions the single canonical workflow model,
  // replacing the parallel lifecycle_rules table.
  try { db.exec(`ALTER TABLE routing_transitions ADD COLUMN task_type TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE routing_transitions ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try {
    db.exec(`ALTER TABLE routing_transitions ADD COLUMN is_protected INTEGER NOT NULL DEFAULT 0`);
  } catch { /* exists */ }
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_routing_transitions_type
        ON routing_transitions(task_type, from_status, outcome);
    `);
  } catch { /* exists */ }

  // ── Mark release-pipeline transitions as protected (code-enforced) ──────────
  // These are still validated in requireReleaseGate / assertAtlasDirectStatusGate.
  // The is_protected=1 flag makes this explicit in the UI rather than implying
  // everything is uniformly data-driven.
  db.prepare(`
    UPDATE routing_transitions
    SET is_protected = 1
    WHERE project_id IS NULL
      AND outcome IN ('completed_for_review','qa_pass','approved_for_merge','deployed_live','live_verified')
  `).run();

  // ── Seed task-type-specific overrides into routing_transitions ──────────────
  // PM family (pm, pm_analysis, pm_operational) skip qa_pass:
  //   in_progress:approved_for_merge → ready_to_merge  (primary terminal exit)
  //   review:approved_for_merge → ready_to_merge        (fallback if dispatched via review)
  const typeOverrides: Array<{ task_type: string; from_status: string; outcome: string; to_status: string; priority: number }> = [];
  for (const pmType of ['pm', 'pm_analysis', 'pm_operational']) {
    typeOverrides.push({ task_type: pmType, from_status: 'in_progress', outcome: 'approved_for_merge', to_status: 'ready_to_merge', priority: 10 });
    typeOverrides.push({ task_type: pmType, from_status: 'review',      outcome: 'approved_for_merge', to_status: 'ready_to_merge', priority: 10 });
  }
  for (const override of typeOverrides) {
    const exists = db.prepare(`
      SELECT id FROM routing_transitions
      WHERE task_type = ? AND from_status = ? AND outcome = ?
      LIMIT 1
    `).get(override.task_type, override.from_status, override.outcome);
    if (!exists) {
      db.prepare(`
        INSERT INTO routing_transitions (project_id, task_type, from_status, outcome, to_status, lane, enabled, priority)
        VALUES (NULL, ?, ?, ?, ?, 'default', 1, ?)
      `).run(override.task_type, override.from_status, override.outcome, override.to_status, override.priority);
    }
  }
}

// Exported so initSchema() can call it after tables exist.
// Previously ran at module load, which crashed on fresh DBs.
export { ensureRoutingMetadata };

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTING CONFIG — per-job settings
// ═══════════════════════════════════════════════════════════════════════════════

// GET /config — routing config for all agents
// Task #596: Reads from agents table directly (routing_config_legacy removed).
router.get('/config', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    // Primary source: agents table (Phase 4 target)
    const configs = db.prepare(`
      SELECT a.id as agent_id, a.name as agent_name, a.job_title,
             a.stall_threshold_min, a.max_retries, a.sort_rules
      FROM agents a
      WHERE a.enabled = 1
      ORDER BY a.id
    `).all();

    const parsed = (configs as any[]).map(c => ({
      ...c,
      sort_rules: (() => { try { return JSON.parse(c.sort_rules || '[]'); } catch { return []; } })(),
    }));

    res.json({ configs: parsed });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/reconciler-config', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    res.json({
      needs_attention_eligible_statuses: getNeedsAttentionEligibleStatuses(db),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.put('/reconciler-config', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const statuses = setNeedsAttentionEligibleStatuses(db, req.body?.needs_attention_eligible_statuses);
    res.json({ needs_attention_eligible_statuses: statuses });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /config/:job_id — single routing config (accepts job_id or agent_id)
// Task #594: Reads from agents table. job_id is resolved to agent_id for compat.
router.get('/config/:job_id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const paramId = Number(req.params.job_id);

    // Try agent_id directly
    const agent = db.prepare(`
      SELECT id as agent_id, name as agent_name, job_title,
             stall_threshold_min, max_retries, sort_rules
      FROM agents WHERE id = ?
    `).get(paramId) as any;

    if (!agent) {
      return res.status(404).json({ error: `No routing config for id=${paramId}` });
    }

    agent.sort_rules = (() => { try { return JSON.parse(agent.sort_rules || '[]'); } catch { return []; } })();

    res.json(agent);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /config/:job_id — update routing config (accepts job_id or agent_id)
// Task #596: Writes to agents table (routing_config_legacy removed).
router.put('/config/:job_id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const paramId = Number(req.params.job_id);
    const { stall_threshold_min, max_retries, sort_rules } = req.body;

    // Resolve to agent_id
    const agentDirect = db.prepare('SELECT id FROM agents WHERE id = ?').get(paramId) as { id: number } | undefined;
    const agentId: number | null = agentDirect?.id ?? null;

    if (!agentId) {
      return res.status(404).json({ error: `Agent or job ${paramId} not found` });
    }

    // Update agents table (primary)
    const sets: string[] = [];
    const vals: any[] = [];
    if (stall_threshold_min !== undefined) { sets.push('stall_threshold_min = ?'); vals.push(stall_threshold_min); }
    if (max_retries !== undefined) { sets.push('max_retries = ?'); vals.push(max_retries); }
    if (sort_rules !== undefined) { sets.push('sort_rules = ?'); vals.push(JSON.stringify(sort_rules)); }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    sets.push("last_active = datetime('now')");
    vals.push(agentId);
    db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    const updated = db.prepare(`
      SELECT id as agent_id, name as agent_name, job_title,
             stall_threshold_min, max_retries, sort_rules
      FROM agents WHERE id = ?
    `).get(agentId) as any;
    updated.sort_rules = (() => { try { return JSON.parse(updated.sort_rules || '[]'); } catch { return []; } })();

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASK STATUSES — status flow management
// ═══════════════════════════════════════════════════════════════════════════════

// GET /statuses — all task statuses
router.get('/statuses', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintId = parseSprintId((_req.query as Record<string, unknown>).sprint_id);
    const statuses = listSprintTaskStatuses(db, sprintId);
    res.json({ statuses });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /statuses/:name — update a status
router.put('/statuses/:name', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { name } = req.params;
    const sprintId = parseSprintId(req.body?.sprint_id ?? req.query?.sprint_id);
    const { label, color, allowed_transitions } = req.body;

    if (sprintId) {
      requireSprint(db, sprintId);
      seedSprintTaskPolicy(db, sprintId);
      const existing = db.prepare(`
        SELECT *
        FROM sprint_task_statuses
        WHERE sprint_id = ? AND status_key = ?
      `).get(sprintId, name) as Record<string, unknown> | undefined;
      if (!existing) {
        return res.status(404).json({ error: `Status '${name}' not found for sprint ${sprintId}` });
      }

      const sets: string[] = [];
      const vals: unknown[] = [];
      if (label !== undefined) { sets.push('label = ?'); vals.push(label); }
      if (color !== undefined) { sets.push('color = ?'); vals.push(color); }
      if (allowed_transitions !== undefined) {
        sets.push('allowed_transitions_json = ?');
        vals.push(JSON.stringify(allowed_transitions));
      }
      if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
      vals.push(sprintId, name);
      db.prepare(`
        UPDATE sprint_task_statuses
        SET ${sets.join(', ')}, updated_at = datetime('now')
        WHERE sprint_id = ? AND status_key = ?
      `).run(...vals);
      const updated = listSprintTaskStatuses(db, sprintId).find(status => status.name === name);
      return res.json(updated);
    }

    const existing = db.prepare('SELECT * FROM task_statuses WHERE name = ?').get(name) as any;
    if (!existing) {
      return res.status(404).json({ error: `Status '${name}' not found` });
    }

    const sets: string[] = [];
    const vals: any[] = [];

    if (label !== undefined) { sets.push('label = ?'); vals.push(label); }
    if (color !== undefined) { sets.push('color = ?'); vals.push(color); }
    if (allowed_transitions !== undefined) {
      sets.push('allowed_transitions = ?');
      vals.push(JSON.stringify(allowed_transitions));
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    vals.push(name);
    db.prepare(`UPDATE task_statuses SET ${sets.join(', ')} WHERE name = ?`).run(...vals);

    const updated = db.prepare('SELECT * FROM task_statuses WHERE name = ?').get(name) as any;
    updated.terminal = updated.terminal === 1;
    updated.is_system = updated.is_system === 1;
    updated.allowed_transitions = (() => { try { return JSON.parse(updated.allowed_transitions || '[]'); } catch { return []; } })();

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /statuses — add a new custom status
router.post('/statuses', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintId = parseSprintId(req.body?.sprint_id ?? req.query?.sprint_id);
    const { name, label, color, allowed_transitions } = req.body;

    if (!name || !label) {
      return res.status(400).json({ error: 'name and label are required' });
    }

    if (sprintId) {
      requireSprint(db, sprintId);
      seedSprintTaskPolicy(db, sprintId);
      const existing = db.prepare(`
        SELECT status_key
        FROM sprint_task_statuses
        WHERE sprint_id = ? AND status_key = ?
      `).get(sprintId, name);
      if (existing) {
        return res.status(409).json({ error: `Status '${name}' already exists for sprint ${sprintId}` });
      }
      db.prepare(`
        INSERT INTO sprint_task_statuses (
          sprint_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, 0, ?, COALESCE((SELECT MAX(stage_order) + 1 FROM sprint_task_statuses WHERE sprint_id = ?), 0), 0, '{}', datetime('now'), datetime('now'))
      `).run(sprintId, name, label, color || 'slate', JSON.stringify(allowed_transitions ?? []), sprintId);
      const created = listSprintTaskStatuses(db, sprintId).find(status => status.name === name);
      return res.status(201).json(created);
    }

    // Check for duplicates
    const existing = db.prepare('SELECT name FROM task_statuses WHERE name = ?').get(name);
    if (existing) {
      return res.status(409).json({ error: `Status '${name}' already exists` });
    }

    db.prepare(`
      INSERT INTO task_statuses (name, label, color, terminal, is_system, allowed_transitions)
      VALUES (?, ?, ?, 0, 0, ?)
    `).run(
      name,
      label,
      color || 'slate',
      allowed_transitions ? JSON.stringify(allowed_transitions) : '[]'
    );

    const created = db.prepare('SELECT * FROM task_statuses WHERE name = ?').get(name) as any;
    created.terminal = created.terminal === 1;
    created.is_system = created.is_system === 1;
    created.allowed_transitions = (() => { try { return JSON.parse(created.allowed_transitions || '[]'); } catch { return []; } })();

    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /statuses/:name — delete a custom status (with safety checks)
router.delete('/statuses/:name', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { name } = req.params;
    const sprintId = parseSprintId(req.body?.sprint_id ?? req.query?.sprint_id);

    if (sprintId) {
      requireSprint(db, sprintId);
      seedSprintTaskPolicy(db, sprintId);
      const existing = db.prepare(`
        SELECT *
        FROM sprint_task_statuses
        WHERE sprint_id = ? AND status_key = ?
      `).get(sprintId, name) as any;
      if (!existing) {
        return res.status(404).json({ error: `Status '${name}' not found for sprint ${sprintId}` });
      }
      if (existing.is_system === 1) {
        return res.status(403).json({ error: `Cannot delete system status '${name}'`, reason: 'system_protected' });
      }
      const taskCount = (db.prepare(
        'SELECT COUNT(*) as n FROM tasks WHERE sprint_id = ? AND status = ?'
      ).get(sprintId, name) as { n: number }).n;
      if (taskCount > 0) {
        return res.status(409).json({
          error: `Cannot delete status '${name}': ${taskCount} task${taskCount !== 1 ? 's' : ''} currently use this status in sprint ${sprintId}`,
          reason: 'tasks_in_use',
          task_count: taskCount,
        });
      }
      const transitionRefs = db.prepare(`
        SELECT id, from_status, outcome, to_status
        FROM sprint_task_transitions
        WHERE sprint_id = ? AND (from_status = ? OR to_status = ?)
      `).all(sprintId, name, name) as { id: number; from_status: string; outcome: string; to_status: string }[];
      if (transitionRefs.length > 0) {
        return res.status(409).json({
          error: `Cannot delete status '${name}': referenced by ${transitionRefs.length} sprint transition${transitionRefs.length !== 1 ? 's' : ''}`,
          reason: 'transitions_in_use',
          transitions: transitionRefs,
        });
      }
      const allStatuses = db.prepare(`
        SELECT status_key, allowed_transitions_json
        FROM sprint_task_statuses
        WHERE sprint_id = ? AND status_key != ?
      `).all(sprintId, name) as Array<{ status_key: string; allowed_transitions_json: string }>;
      const referencingStatuses = allStatuses.filter((row) => {
        try {
          return (JSON.parse(row.allowed_transitions_json || '[]') as string[]).includes(name);
        } catch {
          return false;
        }
      }).map(row => row.status_key);
      if (referencingStatuses.length > 0) {
        return res.status(409).json({
          error: `Cannot delete status '${name}': referenced in allowed_transitions of: ${referencingStatuses.join(', ')}`,
          reason: 'referenced_by_statuses',
          referencing_statuses: referencingStatuses,
        });
      }
      db.prepare('DELETE FROM sprint_task_statuses WHERE sprint_id = ? AND status_key = ?').run(sprintId, name);
      return res.json({ ok: true, deleted: name, sprint_id: sprintId });
    }

    const existing = db.prepare('SELECT * FROM task_statuses WHERE name = ?').get(name) as any;
    if (!existing) {
      return res.status(404).json({ error: `Status '${name}' not found` });
    }

    // Block system/protected statuses
    if (existing.is_system === 1) {
      return res.status(403).json({
        error: `Cannot delete system status '${name}'`,
        reason: 'system_protected',
      });
    }

    // Check for tasks currently using this status
    const taskCount = (db.prepare(
      'SELECT COUNT(*) as n FROM tasks WHERE status = ?'
    ).get(name) as { n: number }).n;

    if (taskCount > 0) {
      return res.status(409).json({
        error: `Cannot delete status '${name}': ${taskCount} task${taskCount !== 1 ? 's' : ''} currently use this status`,
        reason: 'tasks_in_use',
        task_count: taskCount,
      });
    }

    // Check for routing transitions referencing this status
    const transitionRefs = db.prepare(
      'SELECT id, from_status, outcome, to_status FROM routing_transitions WHERE from_status = ? OR to_status = ?'
    ).all(name, name) as { id: number; from_status: string; outcome: string; to_status: string }[];

    if (transitionRefs.length > 0) {
      return res.status(409).json({
        error: `Cannot delete status '${name}': referenced by ${transitionRefs.length} routing transition${transitionRefs.length !== 1 ? 's' : ''}`,
        reason: 'transitions_in_use',
        transitions: transitionRefs,
      });
    }

    // Check if other statuses reference this one in allowed_transitions
    const allStatuses = db.prepare('SELECT name, allowed_transitions FROM task_statuses WHERE name != ?').all(name) as { name: string; allowed_transitions: string }[];
    const referencingStatuses = allStatuses.filter(s => {
      try {
        const trans = JSON.parse(s.allowed_transitions || '[]') as string[];
        return trans.includes(name);
      } catch { return false; }
    });

    if (referencingStatuses.length > 0) {
      return res.status(409).json({
        error: `Cannot delete status '${name}': referenced in allowed_transitions of: ${referencingStatuses.map(s => s.name).join(', ')}`,
        reason: 'referenced_by_statuses',
        referencing_statuses: referencingStatuses.map(s => s.name),
      });
    }

    // Safe to delete
    db.prepare('DELETE FROM task_statuses WHERE name = ?').run(name);
    res.json({ ok: true, deleted: name });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTING TRANSITIONS — outcome-driven state machine
// ═══════════════════════════════════════════════════════════════════════════════

function readGlobalRoutingTransition(db: ReturnType<typeof getDb>, id: number) {
  return db.prepare(`
    SELECT rt.*, p.name as project_name
    FROM routing_transitions rt
    LEFT JOIN projects p ON p.id = rt.project_id
    WHERE rt.id = ?
  `).get(id);
}

function readSprintRoutingTransition(db: ReturnType<typeof getDb>, sprintId: number, id: number) {
  const sprintName = (db.prepare(`SELECT name FROM sprints WHERE id = ?`).get(sprintId) as { name?: string } | undefined)?.name ?? null;
  const row = db.prepare(`
    SELECT *
    FROM sprint_task_transitions
    WHERE id = ? AND sprint_id = ?
  `).get(id, sprintId) as Record<string, unknown> | undefined;
  return row ? { ...row, sprint_name: sprintName } : undefined;
}

// GET /transitions — all routing transition rules
router.get('/transitions', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintId = parseSprintId(req.query.sprint_id);
    if (sprintId) {
      requireSprint(db, sprintId);
      const sprintName = (db.prepare(`SELECT name FROM sprints WHERE id = ?`).get(sprintId) as { name?: string } | undefined)?.name ?? null;
      const transitions = listSprintTaskTransitions(db, sprintId).map((row) => ({
        ...row,
        sprint_name: sprintName,
      }));
      return res.json({ transitions });
    }
    const { project_id } = req.query;

    let query = `
      SELECT rt.*, p.name as project_name
      FROM routing_transitions rt
      LEFT JOIN projects p ON p.id = rt.project_id
    `;
    const params: unknown[] = [];

    if (project_id) {
      query += ' WHERE rt.project_id = ? OR rt.project_id IS NULL';
      params.push(Number(project_id));
    }

    query += ' ORDER BY rt.from_status, rt.outcome';

    const transitions = db.prepare(query).all(...params);
    res.json({ transitions });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /transitions/:id — fetch a single routing transition
router.get('/transitions/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Valid transition id is required' });

    const sprintId = parseSprintId(req.query.sprint_id);
    if (sprintId) {
      requireSprint(db, sprintId);
      const transition = readSprintRoutingTransition(db, sprintId, id);
      if (!transition) return res.status(404).json({ error: 'Routing transition not found' });
      return res.json(transition);
    }

    const transition = readGlobalRoutingTransition(db, id);
    if (!transition) return res.status(404).json({ error: 'Routing transition not found' });
    return res.json(transition);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /transitions — add a new routing transition
router.post('/transitions', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintId = parseSprintId(req.body?.sprint_id ?? req.query?.sprint_id);
    const { project_id, task_type, from_status, outcome, to_status, lane = 'default', enabled = 1, priority = 0, is_protected = 0 } = req.body;

    if (!from_status || !outcome || !to_status) {
      return res.status(400).json({ error: 'from_status, outcome, and to_status are required' });
    }

    if (task_type && !isValidTaskType(task_type)) {
      return res.status(400).json({ error: `Invalid task_type "${task_type}". Valid: ${VALID_TASK_TYPES.join(', ')}` });
    }

    if (sprintId) {
      requireSprint(db, sprintId);
      seedSprintTaskPolicy(db, sprintId);
      const result = db.prepare(`
        INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, lane, enabled, priority, is_protected, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(sprintId, task_type ?? null, from_status, outcome, to_status, lane, enabled ? 1 : 0, priority, is_protected ? 1 : 0);
      const transition = db.prepare(`
        SELECT *
        FROM sprint_task_transitions
        WHERE id = ?
      `).get(result.lastInsertRowid);
      return res.status(201).json(transition);
    }

    const result = db.prepare(`
      INSERT INTO routing_transitions (project_id, task_type, from_status, outcome, to_status, lane, enabled, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(project_id ?? null, task_type ?? null, from_status, outcome, to_status, lane, enabled ? 1 : 0, priority);

    const transition = db.prepare('SELECT * FROM routing_transitions WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(transition);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /transitions/:id — update a routing transition
router.put('/transitions/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const sprintId = parseSprintId(req.body?.sprint_id ?? req.query?.sprint_id);
    if (sprintId) {
      requireSprint(db, sprintId);
      seedSprintTaskPolicy(db, sprintId);
      const existing = db.prepare(`
        SELECT *
        FROM sprint_task_transitions
        WHERE id = ? AND sprint_id = ?
      `).get(id, sprintId) as Record<string, unknown> | undefined;
      if (!existing) return res.status(404).json({ error: 'Routing transition not found' });

      const { task_type, from_status, outcome, to_status, lane, enabled, priority, is_protected } = req.body;
      if (task_type !== undefined && task_type !== null && !isValidTaskType(task_type)) {
        return res.status(400).json({ error: `Invalid task_type "${task_type}". Valid: ${VALID_TASK_TYPES.join(', ')}` });
      }

      db.prepare(`
        UPDATE sprint_task_transitions SET
          task_type = ?,
          from_status = ?,
          outcome = ?,
          to_status = ?,
          lane = ?,
          enabled = ?,
          priority = ?,
          is_protected = ?,
          updated_at = datetime('now')
        WHERE id = ? AND sprint_id = ?
      `).run(
        task_type !== undefined ? (task_type ?? null) : existing.task_type,
        from_status ?? existing.from_status,
        outcome ?? existing.outcome,
        to_status ?? existing.to_status,
        lane ?? existing.lane,
        enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
        priority !== undefined ? priority : existing.priority,
        is_protected !== undefined ? (is_protected ? 1 : 0) : existing.is_protected,
        id,
        sprintId,
      );
      const transition = db.prepare(`SELECT * FROM sprint_task_transitions WHERE id = ? AND sprint_id = ?`).get(id, sprintId);
      return res.json(transition);
    }

    const existing = db.prepare('SELECT * FROM routing_transitions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Routing transition not found' });

    const { project_id, task_type, from_status, outcome, to_status, lane, enabled, priority } = req.body;

    if (task_type !== undefined && task_type !== null && !isValidTaskType(task_type)) {
      return res.status(400).json({ error: `Invalid task_type "${task_type}". Valid: ${VALID_TASK_TYPES.join(', ')}` });
    }

    db.prepare(`
      UPDATE routing_transitions SET
        project_id = ?,
        task_type = ?,
        from_status = ?,
        outcome = ?,
        to_status = ?,
        lane = ?,
        enabled = ?,
        priority = ?
      WHERE id = ?
    `).run(
      project_id !== undefined ? (project_id ?? null) : existing.project_id,
      task_type !== undefined ? (task_type ?? null) : existing.task_type,
      from_status ?? existing.from_status,
      outcome ?? existing.outcome,
      to_status ?? existing.to_status,
      lane ?? existing.lane,
      enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
      priority !== undefined ? priority : existing.priority,
      id
    );

    const transition = db.prepare('SELECT * FROM routing_transitions WHERE id = ?').get(id);
    res.json(transition);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /transitions/:id — remove a routing transition
router.delete('/transitions/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const sprintId = parseSprintId(req.body?.sprint_id ?? req.query?.sprint_id);
    if (sprintId) {
      requireSprint(db, sprintId);
      const existing = db.prepare('SELECT id FROM sprint_task_transitions WHERE id = ? AND sprint_id = ?').get(id, sprintId);
      if (!existing) return res.status(404).json({ error: 'Routing transition not found' });
      db.prepare('DELETE FROM sprint_task_transitions WHERE id = ? AND sprint_id = ?').run(id, sprintId);
      return res.json({ ok: true });
    }
    const existing = db.prepare('SELECT id FROM routing_transitions WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Routing transition not found' });

    db.prepare('DELETE FROM routing_transitions WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASK ROUTING RULES — deterministic task_type + status → job assignment
// ═══════════════════════════════════════════════════════════════════════════════


function selectSprintRoutingRuleRowSql(): string {
  return `
      SELECT trr.*, trr.agent_id as resolved_agent_id,
             s.name as sprint_name, a.job_title as job_title, a.name as agent_name
      FROM sprint_task_routing_rules trr
      LEFT JOIN sprints s ON s.id = trr.sprint_id
      LEFT JOIN agents a ON a.id = trr.agent_id
  `;
}

function resolveRoutingRuleTarget(
  db: ReturnType<typeof getDb>,
  input: { job_id?: unknown; agent_id?: unknown },
): { agent_id: number } {
  const agentId = input.agent_id != null ? Number(input.agent_id) : null;
  const jobId = input.job_id != null ? Number(input.job_id) : null;

  // agent_id is the canonical field
  if (agentId != null && Number.isFinite(agentId)) {
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(agentId);
    if (!agent) {
      const err = new Error(`Agent ${agentId} not found`);
      (err as Error & { status?: number }).status = 404;
      throw err;
    }
    return { agent_id: agentId };
  }

  // Legacy compat: if only job_id provided, treat it as agent_id
  if (jobId != null && Number.isFinite(jobId)) {
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(jobId);
    if (!agent) {
      const err = new Error(`Agent ${jobId} not found`);
      (err as Error & { status?: number }).status = 404;
      throw err;
    }
    return { agent_id: jobId };
  }

  const err = new Error('agent_id is required');
  (err as Error & { status?: number }).status = 400;
  throw err;
}

// GET /rules?sprint_id=X — all routing rules for a sprint
router.get('/rules', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintId = parseSprintId(req.query.sprint_id);
    if (!sprintId) {
      return res.status(400).json({ error: 'sprint_id is required' });
    }

    requireSprint(db, sprintId);
    let query = selectSprintRoutingRuleRowSql();
    query += ' WHERE trr.sprint_id = ? ORDER BY trr.sprint_id, trr.task_type, trr.status';
    const rules = db.prepare(query).all(sprintId);
    res.json({ rules });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /rules/resolve — test rule resolution for a given task_type + status + sprint
router.get('/rules/resolve', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintId = parseSprintId(req.query.sprint_id);
    const { task_type, status } = req.query;

    if (!task_type || !status || !sprintId) {
      return res.status(400).json({ error: 'sprint_id, task_type, and status are required' });
    }

    requireSprint(db, sprintId);
    const rule = db.prepare(`
      ${selectSprintRoutingRuleRowSql()}
      WHERE trr.sprint_id = ? AND trr.task_type = ? AND trr.status = ?
      ORDER BY trr.priority DESC
      LIMIT 1
    `).get(sprintId, task_type, status);
    if (!rule) {
      return res.json({ matched: false, rule: null, reason: `No rule for ${task_type}/${status} in sprint ${sprintId}` });
    }

    res.json({ matched: true, rule });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /rules/:id — fetch a single sprint routing rule
router.get('/rules/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const sprintId = parseSprintId(req.query.sprint_id);

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Valid routing rule id is required' });
    }

    let query = `${selectSprintRoutingRuleRowSql()} WHERE trr.id = ?`;
    const params: Array<number> = [id];
    if (sprintId) {
      requireSprint(db, sprintId);
      query += ' AND trr.sprint_id = ?';
      params.push(sprintId);
    }

    const rule = db.prepare(query).get(...params);
    if (!rule) {
      return res.status(404).json({ error: 'Routing rule not found' });
    }

    return res.json(rule);
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
    const message = err instanceof Error ? err.message : String(err);
    return res.status(status).json({ error: message });
  }
});

// POST /rules — create a new sprint routing rule
router.post('/rules', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintId = parseSprintId(req.body?.sprint_id ?? req.query?.sprint_id);
    const taskType = req.body?.task_type;
    const status = req.body?.status ?? req.body?.task_status;
    const jobId = req.body?.job_id;
    const agentId = req.body?.agent_id;
    const priority = req.body?.priority ?? 0;

    if (!sprintId) {
      return res.status(400).json({ error: 'sprint_id is required' });
    }
    if (!taskType || !status || (jobId == null && agentId == null)) {
      return res.status(400).json({ error: 'sprint_id, task_type, status, and either job_id or agent_id are required' });
    }

    if (!isValidTaskType(taskType)) {
      return res.status(400).json({ error: `Invalid task_type "${taskType}". Valid: ${VALID_TASK_TYPES.join(', ')}` });
    }

    const target = resolveRoutingRuleTarget(db, { job_id: jobId, agent_id: agentId });
    requireSprint(db, sprintId);
    seedSprintTaskPolicy(db, sprintId);
    const result = db.prepare(`
      INSERT INTO sprint_task_routing_rules (sprint_id, task_type, status, agent_id, priority, is_system)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(sprintId, taskType, status, target.agent_id, priority);
    const rule = db.prepare(`${selectSprintRoutingRuleRowSql()} WHERE trr.id = ?`).get(result.lastInsertRowid);
    res.status(201).json(rule);
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
    const message = err instanceof Error ? err.message : String(err);
    res.status(status).json({ error: message });
  }
});

// PUT /rules/:id — update a sprint routing rule
router.put('/rules/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM sprint_task_routing_rules WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Routing rule not found' });

    const sprintId = parseSprintId(req.body?.sprint_id ?? req.query?.sprint_id ?? existing.sprint_id);
    if (!sprintId) {
      return res.status(400).json({ error: 'Unable to resolve sprint_id for routing rule' });
    }

    requireSprint(db, sprintId);
    seedSprintTaskPolicy(db, sprintId);

    const { task_type, status, job_id, agent_id, priority } = req.body;
    if (task_type && !isValidTaskType(task_type)) {
      return res.status(400).json({ error: `Invalid task_type "${task_type}". Valid: ${VALID_TASK_TYPES.join(', ')}` });
    }
    const target = (job_id !== undefined || agent_id !== undefined)
      ? resolveRoutingRuleTarget(db, { job_id: job_id ?? null, agent_id: agent_id ?? existing.agent_id })
      : { agent_id: Number(existing.agent_id) };
    db.prepare(`
      UPDATE sprint_task_routing_rules
      SET sprint_id = ?, task_type = ?, status = ?, agent_id = ?, priority = ?, is_system = 0, updated_at = datetime('now')
      WHERE id = ?
    `).run(sprintId, task_type ?? existing.task_type, status ?? existing.status, target.agent_id, priority ?? existing.priority, id);
    const rule = db.prepare(`${selectSprintRoutingRuleRowSql()} WHERE trr.id = ?`).get(id);
    res.json(rule);
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
    const message = err instanceof Error ? err.message : String(err);
    res.status(status).json({ error: message });
  }
});

// DELETE /rules/:id — remove a sprint routing rule
router.delete('/rules/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT id, sprint_id FROM sprint_task_routing_rules WHERE id = ?').get(id) as { id: number; sprint_id: number } | undefined;
    if (!existing) return res.status(404).json({ error: 'Routing rule not found' });

    const sprintId = parseSprintId(req.body?.sprint_id ?? req.query?.sprint_id ?? existing.sprint_id);
    if (!sprintId) {
      return res.status(400).json({ error: 'Unable to resolve sprint_id for routing rule' });
    }

    requireSprint(db, sprintId);
    db.prepare('DELETE FROM sprint_task_routing_rules WHERE id = ?').run(id);
    res.json({ ok: true, deleted: true, rule_id: id, sprint_id: sprintId });
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
    const message = err instanceof Error ? err.message : String(err);
    res.status(status).json({ error: message });
  }
});

// GET /task-types — return valid task types
router.get('/task-types', (_req: Request, res: Response) => {
  res.json({ task_types: VALID_TASK_TYPES });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM POLICIES — authoritative registry of backend-enforced lifecycle rules
//
// System policies document every task state transition that is NOT driven by
// routing_config entries.  They are the source of truth for "surprise" backend
// transitions — making them visible, classifiable, and (where safe) tunable.
//
// Classification values:
//   protected_system — required for correctness; cannot be disabled
//   configurable     — threshold/behaviour can be adjusted by an admin
// ═══════════════════════════════════════════════════════════════════════════════

// GET /system-policies — full policy registry
router.get('/system-policies', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM system_policies ORDER BY classification, policy_key`).all();
    res.json({ system_policies: rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /system-policies/:key — single policy
router.get('/system-policies/:key', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM system_policies WHERE policy_key = ?`).get(req.params.key);
    if (!row) return res.status(404).json({ error: `System policy '${req.params.key}' not found` });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /system-policies/:key — update a configurable policy's threshold or enabled flag
router.put('/system-policies/:key', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { key } = req.params;
    const policy = db.prepare(`SELECT * FROM system_policies WHERE policy_key = ?`).get(key) as {
      id: number;
      classification: string;
      enabled: number;
      threshold_seconds: number | null;
    } | undefined;

    if (!policy) return res.status(404).json({ error: `System policy '${key}' not found` });

    const { threshold_seconds, enabled } = req.body;

    // Only 'configurable' policies support mutation
    if (policy.classification === 'protected_system' && enabled !== undefined && !enabled) {
      return res.status(403).json({
        error: `Cannot disable protected_system policy '${key}'`,
        reason: 'protected_system',
      });
    }

    const sets: string[] = ["updated_at = datetime('now')"];
    const vals: unknown[] = [];

    if (threshold_seconds !== undefined) {
      sets.push('threshold_seconds = ?');
      vals.push(threshold_seconds === null ? null : Number(threshold_seconds));
    }
    if (enabled !== undefined) {
      if (policy.classification === 'protected_system') {
        return res.status(403).json({
          error: `Cannot change enabled state of protected_system policy '${key}'`,
          reason: 'protected_system',
        });
      }
      sets.push('enabled = ?');
      vals.push(enabled ? 1 : 0);
    }

    if (sets.length === 1) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    vals.push(key);
    db.prepare(`UPDATE system_policies SET ${sets.join(', ')} WHERE policy_key = ?`).run(...vals);

    const updated = db.prepare(`SELECT * FROM system_policies WHERE policy_key = ?`).get(key);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE RULES — DEPRECATED (task #614)
//
// The lifecycle_rules concept has been collapsed into routing_transitions, which
// is now the single canonical workflow model (from_status + outcome → to_status,
// with optional task_type, priority, and is_protected fields).
//
// These endpoints are kept for backward compatibility but return a Deprecation
// header. New code should use /transitions (with task_type filter if needed).
// The lifecycle_rules table remains in the DB for read-only history; writes are
// proxied to routing_transitions so data stays consistent.
// ═══════════════════════════════════════════════════════════════════════════════

const LIFECYCLE_DEPRECATION_NOTICE = 'Deprecated: lifecycle-rules have been unified into routing_transitions (task #614). Use /routing/transitions instead.';

// GET /lifecycle-rules — returns lifecycle_rules for backward compat; also
// shows equivalent routing_transitions rows so the caller can see the merge.
router.get('/lifecycle-rules', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { task_type } = req.query;

    let query = `SELECT * FROM lifecycle_rules`;
    const params: unknown[] = [];

    if (task_type) {
      query += ` WHERE task_type = ? OR task_type IS NULL`;
      params.push(String(task_type));
    }

    query += ` ORDER BY task_type NULLS LAST, from_status, outcome, priority DESC`;

    const rules = db.prepare(query).all(...params);
    res.setHeader('Deprecation', 'true');
    res.setHeader('X-Deprecation-Notice', LIFECYCLE_DEPRECATION_NOTICE);
    res.json({
      lifecycle_rules: rules,
      _deprecation: LIFECYCLE_DEPRECATION_NOTICE,
      _replacement: '/api/v1/routing/transitions',
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /lifecycle-rules — proxies to routing_transitions (deprecated write path)
router.post('/lifecycle-rules', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { task_type, from_status, outcome, to_status, lane = 'default', enabled = 1, priority = 0 } = req.body;

    if (!from_status || !outcome || !to_status) {
      return res.status(400).json({ error: 'from_status, outcome, and to_status are required' });
    }

    if (task_type && !isValidTaskType(task_type)) {
      return res.status(400).json({ error: `Invalid task_type "${task_type}". Valid: ${VALID_TASK_TYPES.join(', ')}` });
    }

    // Write to routing_transitions (the canonical table)
    const result = db.prepare(`
      INSERT INTO routing_transitions (project_id, task_type, from_status, outcome, to_status, lane, enabled, priority)
      VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)
    `).run(task_type ?? null, from_status, outcome, to_status, lane, enabled ? 1 : 0, priority);

    const transition = db.prepare('SELECT * FROM routing_transitions WHERE id = ?').get(result.lastInsertRowid);
    res.setHeader('Deprecation', 'true');
    res.setHeader('X-Deprecation-Notice', LIFECYCLE_DEPRECATION_NOTICE);
    res.status(201).json({
      ...transition as object,
      _deprecation: LIFECYCLE_DEPRECATION_NOTICE,
      _replacement: '/api/v1/routing/transitions',
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /lifecycle-rules/:id — deprecated; updates routing_transitions by id
router.put('/lifecycle-rules/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    // Try routing_transitions first (new rows), then lifecycle_rules (old rows)
    const existing = db.prepare('SELECT * FROM routing_transitions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Lifecycle rule not found (use /transitions for new entries)' });

    const { task_type, from_status, outcome, to_status, lane, enabled, priority } = req.body;

    if (task_type !== undefined && task_type !== null && !isValidTaskType(task_type)) {
      return res.status(400).json({ error: `Invalid task_type "${task_type}". Valid: ${VALID_TASK_TYPES.join(', ')}` });
    }

    db.prepare(`
      UPDATE routing_transitions SET
        task_type = ?,
        from_status = ?,
        outcome = ?,
        to_status = ?,
        lane = ?,
        enabled = ?,
        priority = ?
      WHERE id = ?
    `).run(
      task_type !== undefined ? (task_type ?? null) : existing.task_type,
      from_status ?? existing.from_status,
      outcome ?? existing.outcome,
      to_status ?? existing.to_status,
      lane ?? existing.lane,
      enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
      priority ?? existing.priority,
      id,
    );

    const updated = db.prepare('SELECT * FROM routing_transitions WHERE id = ?').get(id);
    res.setHeader('Deprecation', 'true');
    res.setHeader('X-Deprecation-Notice', LIFECYCLE_DEPRECATION_NOTICE);
    res.json({
      ...updated as object,
      _deprecation: LIFECYCLE_DEPRECATION_NOTICE,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /lifecycle-rules/:id — deprecated; removes from routing_transitions
router.delete('/lifecycle-rules/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT id FROM routing_transitions WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Lifecycle rule not found (use /transitions)' });

    db.prepare('DELETE FROM routing_transitions WHERE id = ?').run(id);
    res.setHeader('Deprecation', 'true');
    res.setHeader('X-Deprecation-Notice', LIFECYCLE_DEPRECATION_NOTICE);
    res.json({ ok: true, _deprecation: LIFECYCLE_DEPRECATION_NOTICE });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /lifecycle-rules/resolve — test rule resolution (deprecated, use /transitions)
router.get('/lifecycle-rules/resolve', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { task_type, from_status, outcome } = req.query;

    if (!from_status || !outcome) {
      return res.status(400).json({ error: 'from_status and outcome are required' });
    }

    // Query routing_transitions (the canonical table) — same resolution logic as canonicalOutcomeRoute
    let rule: Record<string, unknown> | undefined;
    if (task_type) {
      rule = db.prepare(`
        SELECT * FROM routing_transitions
        WHERE task_type = ? AND from_status = ? AND outcome = ? AND enabled = 1 AND project_id IS NULL
        ORDER BY priority DESC, id ASC
        LIMIT 1
      `).get(String(task_type), String(from_status), String(outcome)) as Record<string, unknown> | undefined;
    }
    if (!rule) {
      rule = db.prepare(`
        SELECT * FROM routing_transitions
        WHERE task_type IS NULL AND from_status = ? AND outcome = ? AND enabled = 1 AND project_id IS NULL
        ORDER BY priority DESC, id ASC
        LIMIT 1
      `).get(String(from_status), String(outcome)) as Record<string, unknown> | undefined;
    }

    res.setHeader('Deprecation', 'true');
    res.setHeader('X-Deprecation-Notice', LIFECYCLE_DEPRECATION_NOTICE);

    if (!rule) {
      return res.json({
        matched: false, rule: null,
        reason: `No transition for ${task_type ?? '*'}/${from_status}:${outcome}`,
        _deprecation: LIFECYCLE_DEPRECATION_NOTICE,
      });
    }

    res.json({ matched: true, rule, _deprecation: LIFECYCLE_DEPRECATION_NOTICE });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSITION REQUIREMENTS — data-driven evidence gate checks (task #612)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /transition-requirements — all requirements, optionally filtered
router.get('/transition-requirements', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintId = parseSprintId(req.query.sprint_id);
    const { task_type, outcome: outcomeFilter } = req.query;

    if (sprintId) {
      requireSprint(db, sprintId);
      const requirements = listSprintTaskTransitionRequirements(
        db,
        sprintId,
        task_type ? String(task_type) : null,
        outcomeFilter ? String(outcomeFilter) : null,
      );
      return res.json({ transition_requirements: requirements });
    }

    let query = `SELECT * FROM transition_requirements`;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (task_type) {
      conditions.push(`(task_type = ? OR task_type IS NULL)`);
      params.push(String(task_type));
    }
    if (outcomeFilter) {
      conditions.push(`outcome = ?`);
      params.push(String(outcomeFilter));
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ` ORDER BY task_type NULLS LAST, outcome, priority DESC, id ASC`;

    const requirements = db.prepare(query).all(...params);
    res.json({ transition_requirements: requirements });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /transition-requirements — create a new requirement
router.post('/transition-requirements', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintId = parseSprintId(req.body?.sprint_id ?? req.query?.sprint_id);
    const {
      task_type, outcome, field_name, requirement_type = 'required',
      match_field, severity = 'block', message = '', enabled = 1, priority = 0,
    } = req.body;

    if (!outcome || !field_name) {
      return res.status(400).json({ error: 'outcome and field_name are required' });
    }

    if (task_type && !isValidTaskType(task_type)) {
      return res.status(400).json({ error: `Invalid task_type "${task_type}". Valid: ${VALID_TASK_TYPES.join(', ')}` });
    }

    if (!['required', 'match', 'from_status'].includes(requirement_type)) {
      return res.status(400).json({ error: 'requirement_type must be required, match, or from_status' });
    }

    if (!['block', 'warn'].includes(severity)) {
      return res.status(400).json({ error: 'severity must be block or warn' });
    }

    if (sprintId) {
      requireSprint(db, sprintId);
      seedSprintTaskPolicy(db, sprintId);
      const result = db.prepare(`
        INSERT INTO sprint_task_transition_requirements (sprint_id, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(sprintId, task_type ?? null, outcome, field_name, requirement_type, match_field ?? null, severity, message, enabled ? 1 : 0, priority);
      const req_ = db.prepare('SELECT * FROM sprint_task_transition_requirements WHERE id = ? AND sprint_id = ?').get(result.lastInsertRowid, sprintId);
      return res.status(201).json(req_);
    }

    const result = db.prepare(`
      INSERT INTO transition_requirements (task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task_type ?? null, outcome, field_name, requirement_type, match_field ?? null, severity, message, enabled ? 1 : 0, priority);

    const req_ = db.prepare('SELECT * FROM transition_requirements WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(req_);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /transition-requirements/:id — update a requirement
router.put('/transition-requirements/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const sprintId = parseSprintId(req.body?.sprint_id ?? req.query?.sprint_id);
    if (sprintId) {
      requireSprint(db, sprintId);
      seedSprintTaskPolicy(db, sprintId);
      const existing = db.prepare('SELECT * FROM sprint_task_transition_requirements WHERE id = ? AND sprint_id = ?').get(id, sprintId) as Record<string, unknown> | undefined;
      if (!existing) return res.status(404).json({ error: 'Transition requirement not found' });

      const { task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority } = req.body;
      if (task_type !== undefined && task_type !== null && !isValidTaskType(task_type)) {
        return res.status(400).json({ error: `Invalid task_type "${task_type}". Valid: ${VALID_TASK_TYPES.join(', ')}` });
      }
      db.prepare(`
        UPDATE sprint_task_transition_requirements SET
          task_type = ?,
          outcome = ?,
          field_name = ?,
          requirement_type = ?,
          match_field = ?,
          severity = ?,
          message = ?,
          enabled = ?,
          priority = ?,
          updated_at = datetime('now')
        WHERE id = ? AND sprint_id = ?
      `).run(
        task_type !== undefined ? (task_type ?? null) : existing.task_type,
        outcome ?? existing.outcome,
        field_name ?? existing.field_name,
        requirement_type ?? existing.requirement_type,
        match_field !== undefined ? (match_field ?? null) : existing.match_field,
        severity ?? existing.severity,
        message ?? existing.message,
        enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
        priority ?? existing.priority,
        id,
        sprintId,
      );
      const updated = db.prepare('SELECT * FROM sprint_task_transition_requirements WHERE id = ? AND sprint_id = ?').get(id, sprintId);
      return res.json(updated);
    }

    const existing = db.prepare('SELECT * FROM transition_requirements WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Transition requirement not found' });

    const { task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority } = req.body;

    if (task_type !== undefined && task_type !== null && !isValidTaskType(task_type)) {
      return res.status(400).json({ error: `Invalid task_type "${task_type}". Valid: ${VALID_TASK_TYPES.join(', ')}` });
    }

    db.prepare(`
      UPDATE transition_requirements SET
        task_type = ?,
        outcome = ?,
        field_name = ?,
        requirement_type = ?,
        match_field = ?,
        severity = ?,
        message = ?,
        enabled = ?,
        priority = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      task_type !== undefined ? (task_type ?? null) : existing.task_type,
      outcome ?? existing.outcome,
      field_name ?? existing.field_name,
      requirement_type ?? existing.requirement_type,
      match_field !== undefined ? (match_field ?? null) : existing.match_field,
      severity ?? existing.severity,
      message ?? existing.message,
      enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
      priority ?? existing.priority,
      id,
    );

    const updated = db.prepare('SELECT * FROM transition_requirements WHERE id = ?').get(id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /transition-requirements/:id — remove a requirement
router.delete('/transition-requirements/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const sprintId = parseSprintId(req.body?.sprint_id ?? req.query?.sprint_id);
    if (sprintId) {
      requireSprint(db, sprintId);
      const existing = db.prepare('SELECT id FROM sprint_task_transition_requirements WHERE id = ? AND sprint_id = ?').get(id, sprintId);
      if (!existing) return res.status(404).json({ error: 'Transition requirement not found' });
      db.prepare('DELETE FROM sprint_task_transition_requirements WHERE id = ? AND sprint_id = ?').run(id, sprintId);
      return res.json({ ok: true });
    }
    const existing = db.prepare('SELECT id FROM transition_requirements WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Transition requirement not found' });

    db.prepare('DELETE FROM transition_requirements WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT CONTRACTS — editable sprint-type dispatch SOP templates
// ═══════════════════════════════════════════════════════════════════════════════

// __dirname at runtime = api/dist/routes → 3 levels up = repo root.
// Resolve lazily so tests and process managers can set env after import.
function getAgentContractRoot(): string {
  return path.resolve(
    process.env.AGENT_CONTRACT_ROOT ?? path.join(__dirname, '../../../agent-contracts')
  );
}

function getLegacyAgentContractPath(): string {
  return path.resolve(
    process.env.AGENT_CONTRACT_PATH ?? path.join(__dirname, '../../../agent-contract.md')
  );
}

function normalizeSprintTypeKey(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value || 'generic';
}

function ensureSprintTypeExists(db: ReturnType<typeof getDb>, sprintTypeKey: string): void {
  const row = db.prepare(`SELECT key FROM sprint_types WHERE key = ? LIMIT 1`).get(sprintTypeKey) as { key: string } | undefined;
  if (!row) throw new Error(`Unknown sprint type "${sprintTypeKey}"`);
}

function getSprintTypeContractPath(sprintTypeKey: string): string {
  return path.join(getAgentContractRoot(), `${sprintTypeKey}.md`);
}

function readSprintTypeContract(sprintTypeKey: string): { content: string; path: string; inheritedFrom: string | null } {
  const directPath = getSprintTypeContractPath(sprintTypeKey);
  if (fs.existsSync(directPath)) {
    return { content: fs.readFileSync(directPath, 'utf-8'), path: directPath, inheritedFrom: null };
  }

  const genericPath = getSprintTypeContractPath('generic');
  if (sprintTypeKey !== 'generic' && fs.existsSync(genericPath)) {
    return {
      content: fs.readFileSync(genericPath, 'utf-8'),
      path: genericPath,
      inheritedFrom: 'generic',
    };
  }

  const legacyAgentContractPath = getLegacyAgentContractPath();
  if (fs.existsSync(legacyAgentContractPath)) {
    return {
      content: fs.readFileSync(legacyAgentContractPath, 'utf-8'),
      path: legacyAgentContractPath,
      inheritedFrom: 'legacy',
    };
  }

  throw new Error(`No contract template found for sprint type "${sprintTypeKey}"`);
}

// GET /agent-contract — read the contract file for a sprint type
router.get('/agent-contract', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintTypeKey = normalizeSprintTypeKey(req.query.sprint_type ?? req.query.sprint_type_key);
    ensureSprintTypeExists(db, sprintTypeKey);
    const contract = readSprintTypeContract(sprintTypeKey);
    res.json({
      sprint_type: sprintTypeKey,
      content: contract.content,
      path: contract.path,
      inherited_from: contract.inheritedFrom,
      placeholders: getAvailableContractPlaceholders(),
      placeholder_definitions: CONTRACT_PLACEHOLDER_DEFINITIONS,
      format: 'plain_text_v1',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.startsWith('Unknown sprint type') ? 404 : message.startsWith('No contract template found') ? 404 : 500;
    res.status(status).json({ error: message });
  }
});

// PUT /agent-contract — write the contract file for a sprint type
router.put('/agent-contract', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintTypeKey = normalizeSprintTypeKey(req.body?.sprint_type ?? req.body?.sprint_type_key);
    ensureSprintTypeExists(db, sprintTypeKey);
    const { content } = req.body;
    if (typeof content !== 'string') {
      return res.status(400).json({ error: '`content` (string) is required' });
    }
    const targetPath = getSprintTypeContractPath(sprintTypeKey);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf-8');
    res.json({ ok: true, sprint_type: sprintTypeKey, path: targetPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.startsWith('Unknown sprint type') ? 404 : 500;
    res.status(status).json({ error: message });
  }
});

export default router;
