import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';

const router = Router();

// GET /api/v1/model-routing — list all rules ordered by max_points ASC
router.get('/', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const rules = db.prepare(`
      SELECT * FROM story_point_model_routing
      ORDER BY max_points ASC
    `).all();
    return res.json(rules);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// POST /api/v1/model-routing — create a rule
router.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const {
      max_points,
      provider = 'anthropic',
      model,
      fallback_model,
      max_turns,
      max_budget_usd,
      label,
    } = req.body as {
      max_points?: number;
      provider?: string;
      model?: string;
      fallback_model?: string | null;
      max_turns?: number | null;
      max_budget_usd?: number | null;
      label?: string | null;
    };

    if (max_points == null || !model) {
      return res.status(400).json({ error: 'max_points and model are required' });
    }

    const result = db.prepare(`
      INSERT INTO story_point_model_routing
        (max_points, provider, model, fallback_model, max_turns, max_budget_usd, label)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      max_points,
      provider,
      model,
      fallback_model ?? null,
      max_turns ?? null,
      max_budget_usd ?? null,
      label ?? null,
    );

    const created = db.prepare(`SELECT * FROM story_point_model_routing WHERE id = ?`).get(result.lastInsertRowid);
    return res.status(201).json(created);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// PUT /api/v1/model-routing/:id — update a rule
router.put('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM story_point_model_routing WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Routing rule not found' });

    const {
      max_points,
      provider,
      model,
      fallback_model,
      max_turns,
      max_budget_usd,
      label,
    } = req.body as {
      max_points?: number;
      provider?: string;
      model?: string;
      fallback_model?: string | null;
      max_turns?: number | null;
      max_budget_usd?: number | null;
      label?: string | null;
    };

    db.prepare(`
      UPDATE story_point_model_routing SET
        max_points     = ?,
        provider       = ?,
        model          = ?,
        fallback_model = ?,
        max_turns      = ?,
        max_budget_usd = ?,
        label          = ?,
        updated_at     = datetime('now')
      WHERE id = ?
    `).run(
      max_points     !== undefined ? max_points     : existing.max_points,
      provider       !== undefined ? provider       : existing.provider,
      model          !== undefined ? model          : existing.model,
      fallback_model !== undefined ? fallback_model : existing.fallback_model,
      max_turns      !== undefined ? max_turns      : existing.max_turns,
      max_budget_usd !== undefined ? max_budget_usd : existing.max_budget_usd,
      label          !== undefined ? label          : existing.label,
      req.params.id,
    );

    const updated = db.prepare(`SELECT * FROM story_point_model_routing WHERE id = ?`).get(req.params.id);
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/v1/model-routing/:id — delete a rule
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const existing = db.prepare(`SELECT id FROM story_point_model_routing WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Routing rule not found' });

    db.prepare(`DELETE FROM story_point_model_routing WHERE id = ?`).run(req.params.id);
    return res.json({ ok: true, deleted: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
