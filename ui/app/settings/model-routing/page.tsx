'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Cpu,
  Plus,
  Trash2,
  Check,
  X,
  RefreshCw,
  Pencil,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────
interface ModelRoutingRule {
  id: number;
  label: string;
  max_points: number;
  model: string;
  fallback_model: string | null;
  max_turns: number | null;
  max_budget_usd: number | null;
  provider: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Preview Legend ───────────────────────────────────────────
function PreviewLegend({ rules }: { rules: ModelRoutingRule[] }) {
  const sorted = [...rules].sort((a, b) => a.max_points - b.max_points);

  if (sorted.length === 0) return null;

  const segments: { label: string; points: string; model: string }[] = [];
  let prev = 0;
  for (const rule of sorted) {
    const rangeStart = prev + 1;
    const rangeEnd = rule.max_points;
    segments.push({
      label: rule.label,
      points: rangeStart === rangeEnd ? `${rangeStart} pt` : `${rangeStart}–${rangeEnd} pts`,
      model: rule.model,
    });
    prev = rule.max_points;
  }

  return (
    <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
        Routing Preview
      </h3>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {segments.map((seg, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <span className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200">
              <span className="text-slate-400">{seg.points}</span>
              <span className="mx-1.5 text-slate-600">→</span>
              <span className="text-amber-300 font-medium">{seg.label}</span>
              <span className="mx-1.5 text-slate-600">·</span>
              <span className="text-slate-400 font-mono">{seg.model}</span>
            </span>
            {i < segments.length - 1 && (
              <ChevronRight className="w-3 h-3 text-slate-600 flex-shrink-0" />
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Add Rule Form ────────────────────────────────────────────
function AddRuleForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    label: '',
    max_points: '',
    provider: 'anthropic',
    model: '',
    fallback_model: '',
    max_turns: '',
    max_budget_usd: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!form.label.trim() || !form.max_points || !form.model.trim()) {
      setError('Label, Max Points, and Model are required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/api/v1/model-routing', {
        method: 'POST',
        body: JSON.stringify({
          label: form.label.trim(),
          max_points: Number(form.max_points),
          provider: form.provider,
          model: form.model.trim(),
          fallback_model: form.fallback_model.trim() || null,
          max_turns: form.max_turns ? Number(form.max_turns) : null,
          max_budget_usd: form.max_budget_usd ? Number(form.max_budget_usd) : null,
        }),
      });
      onCreated();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr className="border-b border-amber-500/20 bg-amber-500/5">
      <td className="px-3 py-3">
        <input
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-full focus:outline-none focus:border-amber-500 min-w-[100px]"
          placeholder="e.g. Small"
          value={form.label}
          onChange={e => setForm({ ...form, label: e.target.value })}
        />
      </td>
      <td className="px-3 py-3">
        <input
          type="number"
          min={1}
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-20 focus:outline-none focus:border-amber-500"
          placeholder="e.g. 2"
          value={form.max_points}
          onChange={e => setForm({ ...form, max_points: e.target.value })}
        />
      </td>
      <td className="px-3 py-3">
        <select
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-amber-500 w-full min-w-[100px]"
          value={form.provider}
          onChange={e => setForm({ ...form, provider: e.target.value })}
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
          <option value="google">Google</option>
          <option value="veri">Veri</option>
          <option value="local">Local (MLX)</option>
        </select>
      </td>
      <td className="px-3 py-3">
        <input
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-full font-mono focus:outline-none focus:border-amber-500 min-w-[180px]"
          placeholder="e.g. anthropic/claude-haiku-4"
          value={form.model}
          onChange={e => setForm({ ...form, model: e.target.value })}
        />
      </td>
      <td className="px-3 py-3">
        <input
          type="number"
          min={1}
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-20 focus:outline-none focus:border-amber-500"
          placeholder="—"
          value={form.max_turns}
          onChange={e => setForm({ ...form, max_turns: e.target.value })}
        />
      </td>
      <td className="px-3 py-3">
        <input
          type="number"
          min={0}
          step={0.01}
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-24 focus:outline-none focus:border-amber-500"
          placeholder="—"
          value={form.max_budget_usd}
          onChange={e => setForm({ ...form, max_budget_usd: e.target.value })}
        />
      </td>
      <td className="px-3 py-3">
        <div className="flex items-center gap-1 justify-end">
          <Button variant="primary" size="sm" onClick={handleCreate} loading={saving}>
            <Check className="w-3 h-3" /> Add
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            <X className="w-3 h-3" />
          </Button>
        </div>
        {error && <p className="text-red-400 text-[10px] mt-1 text-right whitespace-nowrap">{error}</p>}
      </td>
    </tr>
  );
}

// ─── Rule Row ─────────────────────────────────────────────────
function RuleRow({
  rule,
  onSaved,
  onDeleted,
}: {
  rule: ModelRoutingRule;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    label: rule.label,
    max_points: String(rule.max_points),
    provider: rule.provider ?? 'anthropic',
    model: rule.model,
    max_turns: rule.max_turns != null ? String(rule.max_turns) : '',
    max_budget_usd: rule.max_budget_usd != null ? String(rule.max_budget_usd) : '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleSave = async () => {
    if (!form.label.trim() || !form.max_points || !form.model.trim()) {
      setError('Label, Max Points, and Model are required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/model-routing/${rule.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          label: form.label.trim(),
          max_points: Number(form.max_points),
          provider: form.provider,
          model: form.model.trim(),
          max_turns: form.max_turns ? Number(form.max_turns) : null,
          max_budget_usd: form.max_budget_usd ? Number(form.max_budget_usd) : null,
        }),
      });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setForm({
      label: rule.label,
      max_points: String(rule.max_points),
      provider: rule.provider ?? 'anthropic',
      model: rule.model,
      max_turns: rule.max_turns != null ? String(rule.max_turns) : '',
      max_budget_usd: rule.max_budget_usd != null ? String(rule.max_budget_usd) : '',
    });
    setEditing(false);
    setError(null);
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await apiFetch(`/api/v1/model-routing/${rule.id}`, { method: 'DELETE' });
      onDeleted();
    } catch (e) {
      setError(String(e));
      setDeleteConfirm(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <tr className="border-b border-slate-700/50 hover:bg-slate-800/30 transition-colors group">
      {/* Label */}
      <td className="px-3 py-3">
        {editing ? (
          <input
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-full focus:outline-none focus:border-amber-500 min-w-[100px]"
            value={form.label}
            onChange={e => setForm({ ...form, label: e.target.value })}
          />
        ) : (
          <span className="text-slate-200 text-sm font-medium">{rule.label}</span>
        )}
      </td>

      {/* Max Points */}
      <td className="px-3 py-3">
        {editing ? (
          <input
            type="number"
            min={1}
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-20 focus:outline-none focus:border-amber-500"
            value={form.max_points}
            onChange={e => setForm({ ...form, max_points: e.target.value })}
          />
        ) : (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-mono">
            ≤ {rule.max_points}
          </span>
        )}
      </td>

      {/* Provider */}
      <td className="px-3 py-3">
        {editing ? (
          <select
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-amber-500 w-full min-w-[100px]"
            value={form.provider}
            onChange={e => setForm({ ...form, provider: e.target.value })}
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="google">Google</option>
            <option value="veri">Veri</option>
            <option value="local">Local (MLX)</option>
          </select>
        ) : (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-700/50 border border-slate-600/50 text-slate-300 text-xs capitalize">
            {rule.provider ?? 'anthropic'}
          </span>
        )}
      </td>

      {/* Model */}
      <td className="px-3 py-3">
        {editing ? (
          <input
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-full font-mono focus:outline-none focus:border-amber-500 min-w-[180px]"
            value={form.model}
            onChange={e => setForm({ ...form, model: e.target.value })}
          />
        ) : (
          <code className="text-slate-300 text-xs">{rule.model}</code>
        )}
      </td>

      {/* Max Turns */}
      <td className="px-3 py-3">
        {editing ? (
          <input
            type="number"
            min={1}
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-20 focus:outline-none focus:border-amber-500"
            value={form.max_turns}
            onChange={e => setForm({ ...form, max_turns: e.target.value })}
            placeholder="—"
          />
        ) : (
          <span className="text-slate-400 text-xs">
            {rule.max_turns != null ? rule.max_turns : <span className="text-slate-600">—</span>}
          </span>
        )}
      </td>

      {/* Max Budget */}
      <td className="px-3 py-3">
        {editing ? (
          <input
            type="number"
            min={0}
            step={0.01}
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-24 focus:outline-none focus:border-amber-500"
            value={form.max_budget_usd}
            onChange={e => setForm({ ...form, max_budget_usd: e.target.value })}
            placeholder="—"
          />
        ) : (
          <span className="text-slate-400 text-xs">
            {rule.max_budget_usd != null
              ? `$${Number(rule.max_budget_usd).toFixed(2)}`
              : <span className="text-slate-600">—</span>}
          </span>
        )}
      </td>

      {/* Actions */}
      <td className="px-3 py-3">
        {deleteConfirm ? (
          <div className="flex items-center gap-1 justify-end">
            <span className="text-red-400 text-[10px] mr-1">Delete?</span>
            <Button
              variant="danger"
              size="sm"
              onClick={handleDelete}
              loading={deleting}
            >
              <Trash2 className="w-3 h-3" /> Yes
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDeleteConfirm(false)}>
              <X className="w-3 h-3" />
            </Button>
          </div>
        ) : editing ? (
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-1">
              <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
                <Check className="w-3 h-3" /> Save
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCancel}>
                <X className="w-3 h-3" />
              </Button>
            </div>
            {error && <p className="text-red-400 text-[10px]">{error}</p>}
          </div>
        ) : (
          <div className="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="w-3 h-3" /> Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeleteConfirm(true)}
              className="text-slate-500 hover:text-red-400 hover:bg-red-900/10"
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

// ─── Main Page ────────────────────────────────────────────────
export default function ModelRoutingPage() {
  const [rules, setRules] = useState<ModelRoutingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<ModelRoutingRule[]>('/api/v1/model-routing');
      const sorted = [...data].sort((a, b) => a.max_points - b.max_points);
      setRules(sorted);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Cpu className="w-5 h-5 text-amber-400" />
          <h1 className="text-2xl font-bold text-white">Model Routing</h1>
        </div>
        <p className="text-slate-400 text-sm">
          Configure which AI model runs tasks based on story point complexity. Rules are evaluated
          at dispatch time — highest matching <code className="text-slate-300 text-xs bg-slate-800 px-1 py-0.5 rounded">max_points</code> wins.
        </p>
      </div>

      {/* Alert if no rules */}
      {!loading && rules.length === 0 && !error && (
        <div className="flex items-start gap-3 bg-amber-900/20 border border-amber-700/40 rounded-xl p-4">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
          <p className="text-amber-300 text-sm">
            No routing rules configured. Add at least one rule so tasks can be dispatched with the correct model.
          </p>
        </div>
      )}

      {/* Preview Legend */}
      {rules.length > 0 && <PreviewLegend rules={rules} />}

      {/* Controls */}
      <div className="flex items-center justify-between">
        <p className="text-slate-400 text-sm">
          {loading ? 'Loading…' : `${rules.length} rule${rules.length !== 1 ? 's' : ''} configured`}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowAdd(s => !s)}
            disabled={showAdd}
          >
            <Plus className="w-3.5 h-3.5" /> Add Rule
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-700 text-left">
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Label
                </th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Max Points
                </th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Provider
                </th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Model
                </th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Max Turns
                </th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Max Budget USD
                </th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {showAdd && (
                <AddRuleForm
                  onCreated={() => { setShowAdd(false); load(); }}
                  onCancel={() => setShowAdd(false)}
                />
              )}
              {loading && rules.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-12 text-center">
                    <div className="flex items-center justify-center">
                      <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                    </div>
                  </td>
                </tr>
              ) : rules.length === 0 && !showAdd ? (
                <tr>
                  <td colSpan={7} className="px-3 py-12 text-center text-slate-500 text-sm">
                    No model routing rules yet. Click <strong>Add Rule</strong> to create one.
                  </td>
                </tr>
              ) : (
                rules.map(rule => (
                  <RuleRow
                    key={rule.id}
                    rule={rule}
                    onSaved={load}
                    onDeleted={load}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Info card */}
      <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4 text-xs text-slate-500 space-y-1">
        <p>
          <strong className="text-slate-400">How it works:</strong> When a task is dispatched, its story point estimate
          is compared against each rule&apos;s <code className="text-slate-400">max_points</code> threshold. The rule
          with the lowest <code className="text-slate-400">max_points</code> that is &ge; the task&apos;s points wins.
        </p>
        <p>
          Tasks exceeding all thresholds fall back to the highest-threshold rule.
        </p>
      </div>
    </div>
  );
}
