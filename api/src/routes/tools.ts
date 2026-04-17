import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { executeToolImplementation } from '../runtimes/toolInjection';
import { syncAssignedMcpForAgent } from '../runtimes/mcpMaterialization';

const router = Router();

function scheduleAgentToolMcpSync(agentId: number): void {
  setImmediate(() => {
    try {
      const result = syncAssignedMcpForAgent({
        db: getDb(),
        agentId,
      });
      for (const warn of result.warnings) {
        console.warn(`[tools] ${warn}`);
      }
      if (result.skipped === 'unsupported_runtime') return;
      if (result.skipped === 'missing_workspace') {
        console.warn(`[tools] tool MCP sync skipped for agent #${agentId}: no workspace_path`);
        return;
      }
      if (!result.ok && result.error) {
        console.warn(`[tools] tool MCP sync failed for agent #${agentId}: ${result.error}`);
      }
    } catch (err) {
      console.warn(
        `[tools] tool MCP sync failed for agent #${agentId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  });
}

function scheduleToolDefinitionSync(toolId: number): void {
  setImmediate(() => {
    try {
      const db = getDb();
      const agentRows = db.prepare(`
        SELECT DISTINCT agent_id
        FROM agent_tool_assignments
        WHERE tool_id = ?
        ORDER BY agent_id ASC
      `).all(toolId) as Array<{ agent_id: number }>;
      for (const row of agentRows) {
        scheduleAgentToolMcpSync(row.agent_id);
      }
    } catch (err) {
      console.warn(
        `[tools] tool definition sync failed for tool #${toolId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  });
}

// ---------------------------------------------------------------------------
// GET /api/v1/tools — list all tools (filter by ?tag=..., ?enabled=0|1)
// ---------------------------------------------------------------------------
router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    let sql = `SELECT * FROM tools WHERE 1=1`;
    const params: unknown[] = [];

    // Filter by enabled (default: only enabled)
    if (req.query.enabled !== undefined) {
      sql += ` AND enabled = ?`;
      params.push(Number(req.query.enabled));
    }

    // Filter by tag (JSON array contains)
    if (req.query.tag) {
      // tags is stored as a JSON text array, e.g. '["git","filesystem"]'
      // We use LIKE as a simple containment check. For exact matching
      // we'd use json_each, but LIKE on the serialised array is fine
      // for tag filtering in practice.
      sql += ` AND tags LIKE ?`;
      params.push(`%"${String(req.query.tag)}"%`);
    }

    sql += ` ORDER BY name ASC`;

    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/tools/:id — get tool detail
// ---------------------------------------------------------------------------
router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tool = db.prepare(`SELECT * FROM tools WHERE id = ?`).get(req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    return res.json(tool);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/tools — create tool
// ---------------------------------------------------------------------------
router.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const {
      name, slug, description,
      implementation_type, implementation_body,
      input_schema, permissions, tags, enabled,
    } = req.body;

    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!slug) return res.status(400).json({ error: 'slug is required' });
    if (!implementation_type) return res.status(400).json({ error: 'implementation_type is required' });

    const result = db.prepare(`
      INSERT INTO tools (name, slug, description, implementation_type, implementation_body, input_schema, permissions, tags, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      slug,
      description ?? '',
      implementation_type,
      implementation_body ?? '',
      input_schema ? JSON.stringify(input_schema) : '{}',
      permissions ?? 'read_only',
      tags ? JSON.stringify(tags) : '[]',
      enabled !== undefined ? (enabled ? 1 : 0) : 1,
    );

    const created = db.prepare(`SELECT * FROM tools WHERE id = ?`).get(result.lastInsertRowid);
    return res.status(201).json(created);
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || String(err).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'A tool with this slug already exists' });
    }
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/v1/tools/:id — update tool
// ---------------------------------------------------------------------------
router.put('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM tools WHERE id = ?`).get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: 'Tool not found' });

    const {
      name, slug, description,
      implementation_type, implementation_body,
      input_schema, permissions, tags, enabled,
    } = req.body;

    db.prepare(`
      UPDATE tools SET
        name = ?,
        slug = ?,
        description = ?,
        implementation_type = ?,
        implementation_body = ?,
        input_schema = ?,
        permissions = ?,
        tags = ?,
        enabled = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name ?? existing.name,
      slug ?? existing.slug,
      description ?? existing.description,
      implementation_type ?? existing.implementation_type,
      implementation_body ?? existing.implementation_body,
      input_schema !== undefined ? JSON.stringify(input_schema) : existing.input_schema,
      permissions ?? existing.permissions,
      tags !== undefined ? JSON.stringify(tags) : existing.tags,
      enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
      req.params.id,
    );

    const updated = db.prepare(`SELECT * FROM tools WHERE id = ?`).get(req.params.id);
    scheduleToolDefinitionSync(Number(req.params.id));
    return res.json(updated);
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || String(err).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'A tool with this slug already exists' });
    }
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/tools/:id — soft delete (set enabled=false)
// ---------------------------------------------------------------------------
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const existing = db.prepare(`SELECT id FROM tools WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Tool not found' });

    db.prepare(`UPDATE tools SET enabled = 0, updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
    scheduleToolDefinitionSync(Number(req.params.id));
    return res.json({ ok: true, id: Number(req.params.id) });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/tools/:id/test — run a tool with sample input in a sandbox
// ---------------------------------------------------------------------------
router.post('/:id/test', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tool = db.prepare(`SELECT * FROM tools WHERE id = ?`).get(req.params.id) as any;
    if (!tool) return res.status(404).json({ error: 'Tool not found' });

    const { input } = req.body;
    if (input === undefined) {
      return res.status(400).json({ error: 'input is required' });
    }

    // Validate input against schema if present
    if (tool.input_schema) {
      try {
        const schema = JSON.parse(tool.input_schema);
        // Basic type validation: if schema says "object" and input is not an object
        if (schema.type === 'object' && (typeof input !== 'object' || Array.isArray(input) || input === null)) {
          return res.status(400).json({ error: 'input must be an object matching the tool input_schema' });
        }
        // Required field validation
        if (schema.required && Array.isArray(schema.required)) {
          const missing = schema.required.filter((k: string) => !(k in input));
          if (missing.length > 0) {
            return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
          }
        }
      } catch (parseErr) {
        // Schema is malformed — skip validation
      }
    }

    const start = Date.now();

    // Execute in /tmp (sandboxed — no access to agent workspaces)
    const result = executeToolImplementation(
      {
        id: tool.id,
        assignment_id: 0,
        name: tool.name,
        slug: tool.slug,
        description: tool.description ?? '',
        implementation_type: tool.implementation_type,
        implementation_body: tool.implementation_body ?? '',
        input_schema: tool.input_schema ?? '{}',
        permissions: tool.permissions ?? 'read_only',
        tags: tool.tags ?? '[]',
        enabled: tool.enabled ?? 1,
        overrides: '{}',
        assignment_enabled: 1,
      },
      typeof input === 'object' && input !== null ? input : {},
      '/tmp',
    );

    const duration_ms = Date.now() - start;

    const output = result.content.map((c: any) => c.text).join('');
    if (result.isError) {
      return res.json({ output: null, duration_ms, error: output });
    }
    return res.json({ output, duration_ms });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/tools — get all tools assigned to an agent
// (mounted on the agents router or re-exported; see agentToolsRouter below)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Agent tool assignment sub-router (mounted at /api/v1/agents/:agentId/tools)
// ---------------------------------------------------------------------------
export const agentToolsRouter = Router({ mergeParams: true });

agentToolsRouter.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const agentId = req.params.agentId ?? req.params.id;

    // Verify agent exists
    const agent = db.prepare(`SELECT id FROM agents WHERE id = ?`).get(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const rows = db.prepare(`
      SELECT ata.id as assignment_id,
             ata.agent_id,
             ata.tool_id,
             ata.overrides,
             ata.enabled as assignment_enabled,
             t.*
      FROM agent_tool_assignments ata
      JOIN tools t ON t.id = ata.tool_id
      WHERE ata.agent_id = ?
      ORDER BY t.name ASC
    `).all(agentId);

    // Contract: each assignment row returns both assignment identity and tool identity.
    // `assignment_id` identifies the join row only.
    // `tool_id` is the canonical identifier for assigned-tool checks and DELETE calls.
    // `id` mirrors the same tool id via t.* for backward compatibility.

    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

agentToolsRouter.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const agentId = req.params.agentId ?? req.params.id;
    const { tool_id, overrides, enabled } = req.body;

    if (!tool_id) return res.status(400).json({ error: 'tool_id is required' });

    // Verify agent and tool exist
    const agent = db.prepare(`SELECT id FROM agents WHERE id = ?`).get(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const tool = db.prepare(`SELECT id FROM tools WHERE id = ?`).get(tool_id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });

    const result = db.prepare(`
      INSERT INTO agent_tool_assignments (agent_id, tool_id, overrides, enabled)
      VALUES (?, ?, ?, ?)
    `).run(
      agentId,
      tool_id,
      overrides ? JSON.stringify(overrides) : '{}',
      enabled !== undefined ? (enabled ? 1 : 0) : 1,
    );

    const created = db.prepare(`
      SELECT ata.id as assignment_id,
             ata.agent_id,
             ata.tool_id,
             ata.overrides,
             ata.enabled as assignment_enabled,
             t.*
      FROM agent_tool_assignments ata
      JOIN tools t ON t.id = ata.tool_id
      WHERE ata.id = ?
    `).get(result.lastInsertRowid);

    scheduleAgentToolMcpSync(Number(agentId));

    return res.status(201).json(created);
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || String(err).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'This tool is already assigned to the agent' });
    }
    return res.status(500).json({ error: String(err) });
  }
});

agentToolsRouter.delete('/:toolId', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const agentId = req.params.agentId ?? req.params.id;
    const toolId = req.params.toolId;

    const existing = db.prepare(`
      SELECT id FROM agent_tool_assignments WHERE agent_id = ? AND tool_id = ?
    `).get(agentId, toolId);
    if (!existing) return res.status(404).json({ error: 'Assignment not found' });

    db.prepare(`DELETE FROM agent_tool_assignments WHERE agent_id = ? AND tool_id = ?`).run(agentId, toolId);
    scheduleAgentToolMcpSync(Number(agentId));
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
