import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { writeProjectAudit, diffFields, extractActor } from '../lib/projectAudit';
import { ensureProjectBacklogSprint, syncStarterRoutingForProject } from '../lib/starterSetup';

const router = Router();

interface Project {
  id: number;
  name: string;
  description: string;
  context_md: string;
  created_at: string;
}

// GET /api/v1/projects
router.get('/', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const projects = db.prepare(`
      SELECT p.*,
        COUNT(a.id) as agent_count
      FROM projects p
      LEFT JOIN agents a ON a.project_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `).all();
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/v1/projects
router.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { name, description, context_md } = req.body as Partial<Project>;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const result = db.prepare(`
      INSERT INTO projects (name, description, context_md)
      VALUES (?, ?, ?)
    `).run(name, description ?? '', context_md ?? '');

    const newId = Number(result.lastInsertRowid);
    ensureProjectBacklogSprint(db, newId);
    syncStarterRoutingForProject(db, newId);
    const actor = extractActor(req);
    writeProjectAudit(db, newId, 'project', newId, 'created', actor, {
      name, description: description ?? '', context_md: context_md ?? '',
    });

    const project = db.prepare(`
      SELECT p.*, COUNT(a.id) as agent_count
      FROM projects p
      LEFT JOIN agents a ON a.project_id = p.id
      WHERE p.id = ?
      GROUP BY p.id
    `).get(newId);
    return res.status(201).json(project);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/projects/:id
router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const project = db.prepare(`
      SELECT p.*, COUNT(a.id) as agent_count
      FROM projects p
      LEFT JOIN agents a ON a.project_id = p.id
      WHERE p.id = ?
      GROUP BY p.id
    `).get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    return res.json(project);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// PUT /api/v1/projects/:id
router.put('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Project | undefined;
    if (!existing) return res.status(404).json({ error: 'Project not found' });

    const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
    const allowedFields = new Set(['name', 'description', 'context_md']);
    const unsupportedFields = Object.keys(body).filter((key) => !allowedFields.has(key));
    if (unsupportedFields.length > 0) {
      return res.status(400).json({
        error: `Unsupported project update field(s): ${unsupportedFields.join(', ')}`,
        code: 'unsupported_project_update_fields',
        unsupported_fields: unsupportedFields,
        allowed_fields: Array.from(allowedFields),
      });
    }

    const { name, description, context_md } = body as Partial<Project>;

    const newValues = {
      name: name ?? existing.name,
      description: description !== undefined ? description : existing.description,
      context_md: context_md !== undefined ? context_md : existing.context_md,
    };

    db.prepare(`
      UPDATE projects SET
        name = ?,
        description = ?,
        context_md = ?
      WHERE id = ?
    `).run(newValues.name, newValues.description, newValues.context_md, req.params.id);

    const changes = diffFields(
      { name: existing.name, description: existing.description, context_md: existing.context_md },
      newValues,
    );
    if (Object.keys(changes).length > 0) {
      const actor = extractActor(req);
      writeProjectAudit(db, existing.id, 'project', existing.id, 'updated', actor, changes);
    }

    const updated = db.prepare(`
      SELECT p.*, COUNT(a.id) as agent_count
      FROM projects p
      LEFT JOIN agents a ON a.project_id = p.id
      WHERE p.id = ?
      GROUP BY p.id
    `).get(req.params.id);
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/projects/:id/cascade-check — check for active work before deleting
router.get('/:id/cascade-check', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const activeTasksRow = db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE project_id = ? AND status IN ('in_progress', 'review', 'dispatched')
    `).get(req.params.id) as { count: number };

    const runningInstancesRow = db.prepare(`
      SELECT COUNT(*) as count FROM job_instances ji
      JOIN agents a ON a.id = ji.agent_id
      WHERE a.project_id = ? AND ji.status IN ('queued', 'dispatched', 'running')
    `).get(req.params.id) as { count: number };

    const sprintCountRow = db.prepare(`SELECT COUNT(*) as count FROM sprints WHERE project_id = ?`).get(req.params.id) as { count: number };
    const taskCountRow = db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE project_id = ?`).get(req.params.id) as { count: number };
    const agentCountRow = db.prepare(`SELECT COUNT(*) as count FROM agents WHERE project_id = ?`).get(req.params.id) as { count: number };

    return res.json({
      active_tasks: activeTasksRow.count ?? 0,
      running_instances: runningInstancesRow.count ?? 0,
      dependent_sprints: sprintCountRow.count ?? 0,
      dependent_tasks: taskCountRow.count ?? 0,
      dependent_agents: agentCountRow.count ?? 0,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/v1/projects/:id
// Query params: ?force=true to bypass cascade warnings
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const force = req.query.force === 'true';

    const activeTasksRow = db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE project_id = ? AND status IN ('in_progress', 'review', 'dispatched')
    `).get(req.params.id) as { count: number };

    const runningInstancesRow = db.prepare(`
      SELECT COUNT(*) as count FROM job_instances ji
      JOIN agents a ON a.id = ji.agent_id
      WHERE a.project_id = ? AND ji.status IN ('queued', 'dispatched', 'running')
    `).get(req.params.id) as { count: number };

    const sprintCountRow = db.prepare(`SELECT COUNT(*) as count FROM sprints WHERE project_id = ?`).get(req.params.id) as { count: number };
    const taskCountRow = db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE project_id = ?`).get(req.params.id) as { count: number };
    const agentCountRow = db.prepare(`SELECT COUNT(*) as count FROM agents WHERE project_id = ?`).get(req.params.id) as { count: number };

    const activeTasks = activeTasksRow.count ?? 0;
    const runningInstances = runningInstancesRow.count ?? 0;
    const sprintCount = sprintCountRow.count ?? 0;
    const taskCount = taskCountRow.count ?? 0;
    const agentCount = agentCountRow.count ?? 0;

    if (!force && (activeTasks > 0 || runningInstances > 0 || sprintCount > 0 || taskCount > 0 || agentCount > 0)) {
      return res.status(409).json({
        error: 'Project delete requires confirmation',
        code: 'project_delete_requires_force',
        active_tasks: activeTasks,
        running_instances: runningInstances,
        dependent_sprints: sprintCount,
        dependent_tasks: taskCount,
        dependent_agents: agentCount,
        message: `Project ${req.params.id} still owns ${sprintCount} sprint(s), ${taskCount} task(s), and ${agentCount} agent(s), with ${activeTasks} active task(s) and ${runningInstances} running instance(s). Pass ?force=true to delete this project and its dependents.`,
      });
    }

    const actor = extractActor(req);
    const proj = project as Project;
    writeProjectAudit(db, proj.id, 'project', proj.id, 'deleted', actor, {
      name: proj.name, description: proj.description,
    });

    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    return res.json({ ok: true, deleted: true, project_id: Number(req.params.id), forced: force });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/projects/:id/metrics — aggregate metrics across all sprints
router.get('/:id/metrics', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const taskRow = db.prepare(`
      SELECT
        COUNT(*) as tasks_total,
        COUNT(CASE WHEN t.status = 'done' THEN 1 END) as tasks_done
      FROM tasks t
      WHERE t.project_id = ?
    `).get(Number(req.params.id)) as { tasks_total: number; tasks_done: number };

    const blockerRow = db.prepare(`
      SELECT COUNT(DISTINCT td.blocked_id) as blocker_count
      FROM task_dependencies td
      JOIN tasks blocked ON blocked.id = td.blocked_id
      JOIN tasks blocker ON blocker.id = td.blocker_id
      WHERE blocked.project_id = ?
        AND blocker.status != 'done'
    `).get(Number(req.params.id)) as { blocker_count: number };

    const durationRow = db.prepare(`
      SELECT AVG(
        (strftime('%s', updated_at) - strftime('%s', created_at)) * 1000
      ) as avg_ms
      FROM tasks
      WHERE project_id = ? AND status = 'done'
    `).get(Number(req.params.id)) as { avg_ms: number | null };

    const runRow = db.prepare(`
      SELECT
        COUNT(*) as job_runs_total,
        COUNT(CASE WHEN ji.status = 'done' THEN 1 END) as job_runs_success,
        COUNT(CASE WHEN ji.status = 'failed' THEN 1 END) as job_runs_failed
      FROM job_instances ji
      JOIN agents a ON a.id = ji.agent_id
      WHERE a.project_id = ?
    `).get(Number(req.params.id)) as { job_runs_total: number; job_runs_success: number; job_runs_failed: number };

    const sprintCount = (db.prepare('SELECT COUNT(*) as n FROM sprints WHERE project_id = ?').get(Number(req.params.id)) as { n: number }).n;

    const tasks_total = taskRow.tasks_total ?? 0;
    const tasks_done = taskRow.tasks_done ?? 0;
    const completion_rate = tasks_total > 0 ? Math.round((tasks_done / tasks_total) * 100) : 0;
    const job_runs_total = runRow.job_runs_total ?? 0;
    const job_runs_success = runRow.job_runs_success ?? 0;
    const job_runs_failed = runRow.job_runs_failed ?? 0;
    const success_rate = job_runs_total > 0
      ? Math.round((job_runs_success / job_runs_total) * 1000) / 10
      : 0;

    return res.json({
      project_id: Number(req.params.id),
      sprint_count: sprintCount,
      tasks_total,
      tasks_done,
      completion_rate,
      job_runs_total,
      job_runs_success,
      job_runs_failed,
      success_rate,
      blocker_count: blockerRow.blocker_count ?? 0,
      avg_task_duration_ms: Math.round(durationRow.avg_ms ?? 0),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/projects/:id/jobs — list job templates for this project
router.get('/:id/jobs', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Read from agents table — agents now have all job-template columns
    const jobs = db.prepare(`
      SELECT a.*, a.name as agent_name, a.session_key as agent_session_key,
             a.job_title as title, p.name as project_name
      FROM agents a
      LEFT JOIN projects p ON p.id = a.project_id
      WHERE a.project_id = ?
      ORDER BY a.created_at DESC
    `).all(req.params.id);
    return res.json(jobs);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/projects/:id/audit — project-level audit history
router.get('/:id/audit', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const projectId = Number(req.params.id);
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    const entityType = req.query.entity_type as string | undefined;

    let query = `
      SELECT * FROM project_audit_log
      WHERE project_id = ?
    `;
    const params: unknown[] = [projectId];

    if (entityType && ['project', 'sprint', 'job_template'].includes(entityType)) {
      query += ` AND entity_type = ?`;
      params.push(entityType);
    }

    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;

    // Parse the changes JSON for each row
    const entries = rows.map(row => ({
      ...row,
      changes: (() => { try { return JSON.parse(row.changes as string); } catch { return {}; } })(),
    }));

    return res.json(entries);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
