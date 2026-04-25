import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';

const router = Router();

function normalizeNullableText(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return null;
  const text = typeof value === 'string' ? value.trim() : String(value).trim();
  return text.length > 0 ? text : null;
}

function normalizeOptionalPositiveInt(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
    throw new Error('Expected a positive integer');
  }
  return num;
}

function normalizeOptionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error('Expected a number');
  }
  return num;
}

function normalizeModelRoutingPayload(body: Record<string, unknown>, mode: 'create' | 'update') {
  const minStoryPoints = normalizeOptionalPositiveInt(body.min_story_points);
  const maxStoryPoints = normalizeOptionalPositiveInt(body.max_story_points);
  const maxPoints = normalizeOptionalPositiveInt(body.max_points);
  const provider = normalizeNullableText(body.provider);
  const model = normalizeNullableText(body.model);
  const fallbackModel = normalizeNullableText(body.fallback_model);
  const maxTurns = normalizeOptionalPositiveInt(body.max_turns);
  const maxBudgetUsd = normalizeOptionalNumber(body.max_budget_usd);
  const label = normalizeNullableText(body.label);
  const priority = normalizeOptionalPositiveInt(body.priority);

  if (maxStoryPoints != null && minStoryPoints != null && maxStoryPoints < minStoryPoints) {
    throw new Error('max_story_points must be greater than or equal to min_story_points');
  }

  const resolvedMaxPoints = maxPoints ?? maxStoryPoints;
  if (mode === 'create' && (resolvedMaxPoints == null || !model)) {
    const err = new Error('max_points and model are required (aliases: max_story_points for max_points)');
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  return {
    min_story_points: minStoryPoints,
    max_points: resolvedMaxPoints,
    max_story_points: maxStoryPoints,
    provider: provider ?? undefined,
    model: model ?? undefined,
    fallback_model: fallbackModel,
    max_turns: maxTurns,
    max_budget_usd: maxBudgetUsd,
    label,
    priority,
  };
}

function serializeRule(rule: Record<string, unknown>) {
  const maxPoints = Number(rule.max_points);
  const payload = {
    ...rule,
    max_story_points: Number.isFinite(maxPoints) ? maxPoints : rule.max_points,
  } as Record<string, unknown>;
  if (!('min_story_points' in payload) || payload.min_story_points == null) payload.min_story_points = 1;
  return payload;
}

function readRuleById(id: number) {
  const db = getDb();
  return db.prepare(`SELECT * FROM story_point_model_routing WHERE id = ?`).get(id);
}

// GET /api/v1/model-routing — list all rules ordered by max_points ASC
router.get('/', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const rules = db.prepare(`
      SELECT * FROM story_point_model_routing
      ORDER BY max_points ASC
    `).all() as Record<string, unknown>[];
    return res.json(rules.map((rule) => serializeRule(rule)));
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/model-routing/:id — fetch a single canonical routing rule
router.get('/:id', (req: Request, res: Response) => {
  try {
    const rule = readRuleById(Number(req.params.id)) as Record<string, unknown> | undefined;
    if (!rule) return res.status(404).json({ error: 'Routing rule not found' });
    return res.json(serializeRule(rule));
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// POST /api/v1/model-routing — create a rule
router.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const payload = normalizeModelRoutingPayload((req.body ?? {}) as Record<string, unknown>, 'create');

    const result = db.prepare(`
      INSERT INTO story_point_model_routing
        (max_points, provider, model, fallback_model, max_turns, max_budget_usd, label)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      payload.max_points,
      payload.provider ?? 'anthropic',
      payload.model,
      payload.fallback_model ?? null,
      payload.max_turns ?? null,
      payload.max_budget_usd ?? null,
      payload.label ?? null,
    );

    const created = db.prepare(`SELECT * FROM story_point_model_routing WHERE id = ?`).get(result.lastInsertRowid) as Record<string, unknown> | undefined;
    return res.status(201).json(serializeRule(created ?? {}));
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
    return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// PUT /api/v1/model-routing/:id — update a rule
router.put('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM story_point_model_routing WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Routing rule not found' });

    const payload = normalizeModelRoutingPayload((req.body ?? {}) as Record<string, unknown>, 'update');

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
      payload.max_points     !== undefined ? payload.max_points     : existing.max_points,
      payload.provider       !== undefined ? payload.provider       : existing.provider,
      payload.model          !== undefined ? payload.model          : existing.model,
      payload.fallback_model !== undefined ? payload.fallback_model : existing.fallback_model,
      payload.max_turns      !== undefined ? payload.max_turns      : existing.max_turns,
      payload.max_budget_usd !== undefined ? payload.max_budget_usd : existing.max_budget_usd,
      payload.label          !== undefined ? payload.label          : existing.label,
      req.params.id,
    );

    const updated = db.prepare(`SELECT * FROM story_point_model_routing WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined;
    return res.json(serializeRule(updated ?? {}));
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
    return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
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
