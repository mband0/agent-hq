'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { api, ReconcilerConfig, RoutingConfig, TaskStatusMeta, RoutingTransition, TaskRoutingRule, LifecycleRule, TransitionRequirement, Sprint, Project, apiFetch } from '@/lib/api';
import { getTaskTypeLabel, useTaskTypes } from '@/lib/taskTypes';
import { formatSprintNumber } from '@/lib/sprintLabel';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  GitBranch,
  Save,
  Plus,
  X,
  ChevronDown,
  Lock,
  AlertTriangle,
  Check,
  RefreshCw,
  ChevronRight,
  ExternalLink,
  Activity,
  Trash2,
} from 'lucide-react';

const AVAILABLE_SORT_RULES = [
  { value: 'priority_desc', label: 'Priority (high → low)' },
  { value: 'blocking_first', label: 'Blocking tasks first' },
  { value: 'oldest_first', label: 'Oldest first' },
  { value: 'newest_first', label: 'Newest first' },
];

const COLOR_OPTIONS = [
  'slate', 'red', 'orange', 'amber', 'yellow', 'green', 'blue', 'indigo', 'purple', 'pink',
];

const COLOR_CLASSES: Record<string, string> = {
  slate:  'bg-slate-500',
  red:    'bg-red-500',
  orange: 'bg-orange-500',
  amber:  'bg-amber-500',
  yellow: 'bg-yellow-500',
  green:  'bg-green-500',
  blue:   'bg-blue-500',
  indigo: 'bg-indigo-500',
  purple: 'bg-purple-500',
  pink:   'bg-pink-500',
};

const COLOR_BADGE_CLASSES: Record<string, string> = {
  slate:  'bg-slate-700 text-slate-300',
  red:    'bg-red-900/60 text-red-300',
  orange: 'bg-orange-900/60 text-orange-300',
  amber:  'bg-amber-900/60 text-amber-300',
  yellow: 'bg-yellow-900/60 text-yellow-300',
  green:  'bg-green-900/60 text-green-300',
  blue:   'bg-blue-900/60 text-blue-300',
  indigo: 'bg-indigo-900/60 text-indigo-300',
  purple: 'bg-purple-900/60 text-purple-300',
  pink:   'bg-pink-900/60 text-pink-300',
};

// ─── Types ────────────────────────────────────────────────────
interface DispatchLogEntry {
  id: number;
  task_id: number;
  agent_id: number;
  dispatched_at: string;
  routing_reason: string;
  candidate_count: number;
  candidates_skipped: { id: number; title: string; reason: string }[];
  task_title: string;
  agent_name: string;
}

interface DispatchLogResponse {
  log: DispatchLogEntry[];
  total: number;
  limit: number;
  offset: number;
}

interface AgentOption {
  id: number;
  name: string;
}

interface ContractPlaceholderDefinition {
  key: string;
  description: string;
}

// ─── Dispatch Log Section ─────────────────────────────────────
function DispatchLogSection() {
  const [log, setLog] = useState<DispatchLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Agents for filter dropdown
  const [agents, setAgents] = useState<AgentOption[]>([]);

  // Expand state for skipped candidates
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLog = useCallback(async (resetOffset?: boolean) => {
    const currentOffset = resetOffset ? 0 : offset;
    if (resetOffset) setOffset(0);

    const qs = new URLSearchParams();
    if (agentFilter) qs.set('agent_id', agentFilter);
    if (fromDate) qs.set('from', fromDate);
    if (toDate) qs.set('to', toDate);
    qs.set('limit', String(limit));
    qs.set('offset', String(currentOffset));

    try {
      const data = await apiFetch<DispatchLogResponse>(`/api/v1/dispatch/log?${qs.toString()}`);
      setLog(data.log);
      setTotal(data.total);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [agentFilter, fromDate, toDate, limit, offset]);

  // Initial load + jobs
  useEffect(() => {
    api.getAgents().then(a => setAgents(a.map(ag => ({ id: ag.id, name: ag.name })))).catch(() => {});
    fetchLog(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch when filters change (reset offset)
  useEffect(() => {
    fetchLog(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentFilter, fromDate, toDate, limit]);

  // Re-fetch when offset changes
  useEffect(() => {
    fetchLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset]);

  // Auto-refresh
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (autoRefresh) {
      intervalRef.current = setInterval(() => fetchLog(), 30000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, fetchLog]);

  const toggleRow = (id: number) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  const formatTs = (ts: string) => {
    const d = new Date(ts + (ts.endsWith('Z') ? '' : 'Z'));
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
  };

  return (
    <div className="space-y-4">
      {/* Controls bar */}
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-3">
        {/* Agent filter */}
        <div className="flex flex-col gap-1 min-w-0">
          <label className="text-slate-400 text-xs">Filter by agent</label>
          <div className="relative">
            <select
              className="appearance-none bg-slate-800 border border-slate-700 rounded-lg pl-3 pr-8 py-2 text-sm text-slate-200 focus:outline-none focus:border-amber-500 w-full sm:min-w-[180px]"
              value={agentFilter}
              onChange={e => setAgentFilter(e.target.value)}
            >
              <option value="">All agents</option>
              {agents.map(a => (
                <option key={a.id} value={String(a.id)}>{a.name}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
          </div>
        </div>

        {/* Date range row */}
        <div className="flex gap-3 flex-wrap">
          <div className="flex flex-col gap-1 flex-1 min-w-[120px]">
            <label className="text-slate-400 text-xs">From</label>
            <input
              type="date"
              className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-amber-500 w-full"
              value={fromDate}
              onChange={e => setFromDate(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1 flex-1 min-w-[120px]">
            <label className="text-slate-400 text-xs">To</label>
            <input
              type="date"
              className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-amber-500 w-full"
              value={toDate}
              onChange={e => setToDate(e.target.value)}
            />
          </div>

          {/* Limit */}
          <div className="flex flex-col gap-1">
            <label className="text-slate-400 text-xs">Rows</label>
            <div className="relative">
              <select
                className="appearance-none bg-slate-800 border border-slate-700 rounded-lg pl-3 pr-8 py-2 text-sm text-slate-200 focus:outline-none focus:border-amber-500"
                value={limit}
                onChange={e => setLimit(Number(e.target.value))}
              >
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
            </div>
          </div>
        </div>

        {/* Actions row */}
        <div className="flex items-center gap-2 sm:ml-auto flex-wrap">
          {/* Auto-refresh toggle */}
          <button
            onClick={() => setAutoRefresh(r => !r)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
              autoRefresh
                ? 'bg-amber-500/10 border-amber-500/40 text-amber-300'
                : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'
            }`}
          >
            <Activity className={`w-3.5 h-3.5 ${autoRefresh ? 'animate-pulse' : ''}`} />
            <span className="hidden sm:inline">Auto-refresh</span>
          </button>

          {/* Manual refresh */}
          <Button variant="ghost" size="sm" onClick={() => fetchLog()} loading={loading}>
            <RefreshCw className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-4 text-red-300 text-sm">{error}</div>
      )}

      {/* Table */}
      <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-700 text-left">
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider w-8" />
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Timestamp</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Task</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Agent</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Routing Reason</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider text-center">Candidates</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider text-center">Skipped</th>
              </tr>
            </thead>
            <tbody>
              {loading && log.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-12 text-center">
                    <div className="flex items-center justify-center">
                      <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                    </div>
                  </td>
                </tr>
              ) : log.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-12 text-center text-slate-500 text-sm">
                    No dispatch log entries yet
                  </td>
                </tr>
              ) : (
                log.map(entry => {
                  const hasSkipped = entry.candidates_skipped && entry.candidates_skipped.length > 0;
                  const isExpanded = expandedRows.has(entry.id);

                  return (
                    <>
                      <tr
                        key={entry.id}
                        className="border-b border-slate-700/50 hover:bg-slate-800/30 transition-colors"
                      >
                        {/* Expand toggle */}
                        <td className="px-3 py-3 text-center">
                          {hasSkipped ? (
                            <button
                              onClick={() => toggleRow(entry.id)}
                              className="text-slate-500 hover:text-slate-300 transition-colors"
                            >
                              <ChevronRight
                                className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                              />
                            </button>
                          ) : null}
                        </td>

                        {/* Timestamp */}
                        <td className="px-3 py-3">
                          <span className="text-slate-400 text-xs font-mono whitespace-nowrap">
                            {formatTs(entry.dispatched_at)}
                          </span>
                        </td>

                        {/* Task */}
                        <td className="px-3 py-3">
                          <a
                            href={`/tasks?id=${entry.task_id}`}
                            className="flex items-center gap-1.5 group hover:no-underline"
                          >
                            <span className="text-slate-500 text-xs font-mono">#{entry.task_id}</span>
                            <span className="text-slate-200 text-xs group-hover:text-amber-300 transition-colors line-clamp-1">
                              {entry.task_title}
                            </span>
                            <ExternalLink className="w-3 h-3 text-slate-600 group-hover:text-amber-400 flex-shrink-0 transition-colors" />
                          </a>
                        </td>

                        {/* Agent */}
                        <td className="px-3 py-3">
                          <p className="text-slate-200 text-xs whitespace-nowrap">{entry.agent_name}</p>
                        </td>

                        {/* Routing Reason */}
                        <td className="px-3 py-3">
                          <span className="text-slate-400 text-xs">{entry.routing_reason}</span>
                        </td>

                        {/* Candidates */}
                        <td className="px-3 py-3 text-center">
                          <span className="text-slate-300 text-xs font-mono">{entry.candidate_count}</span>
                        </td>

                        {/* Skipped count */}
                        <td className="px-3 py-3 text-center">
                          {hasSkipped ? (
                            <button
                              onClick={() => toggleRow(entry.id)}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-orange-900/40 text-orange-300 text-xs hover:bg-orange-900/60 transition-colors"
                            >
                              {entry.candidates_skipped.length}
                            </button>
                          ) : (
                            <span className="text-slate-600 text-xs">—</span>
                          )}
                        </td>
                      </tr>

                      {/* Expanded skipped candidates */}
                      {isExpanded && hasSkipped && (
                        <tr key={`${entry.id}-expanded`} className="border-b border-slate-700/30 bg-slate-900/40">
                          <td />
                          <td colSpan={6} className="px-3 py-3">
                            <div className="space-y-1.5">
                              <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-2">
                                Skipped candidates
                              </p>
                              {entry.candidates_skipped.map((s, idx) => (
                                <div
                                  key={idx}
                                  className="flex items-start gap-3 bg-slate-800/60 rounded-lg px-3 py-2"
                                >
                                  <span className="text-slate-500 text-xs font-mono flex-shrink-0">#{s.id}</span>
                                  <span className="text-slate-300 text-xs flex-1">{s.title}</span>
                                  <span className="text-orange-400 text-xs">{s.reason}</span>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination footer */}
        {total > 0 && (
          <div className="border-t border-slate-700/50 px-4 py-3 flex items-center justify-between">
            <span className="text-slate-500 text-xs">
              {total} total · page {currentPage} of {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
              >
                ← Prev
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={offset + limit >= total}
                onClick={() => setOffset(offset + limit)}
              >
                Next →
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Agent Routing Config Card ────────────────────────────────
function JobConfigCard({
  config,
  onSaved,
}: {
  config: RoutingConfig;
  onSaved: () => void;
}) {
  const [stallMin, setStallMin] = useState(config.stall_threshold_min);
  const [maxRetries, setMaxRetries] = useState(config.max_retries);
  const [sortRules, setSortRules] = useState<string[]>(config.sort_rules ?? []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    stallMin !== config.stall_threshold_min ||
    maxRetries !== config.max_retries ||
    JSON.stringify(sortRules) !== JSON.stringify(config.sort_rules ?? []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateRoutingConfig(config.agent_id, {
        stall_threshold_min: stallMin,
        max_retries: maxRetries,
        sort_rules: sortRules,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const addRule = (rule: string) => {
    if (!sortRules.includes(rule)) {
      setSortRules([...sortRules, rule]);
    }
  };

  const removeRule = (rule: string) => {
    setSortRules(sortRules.filter(r => r !== rule));
  };

  const moveRule = (idx: number, dir: -1 | 1) => {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= sortRules.length) return;
    const next = [...sortRules];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    setSortRules(next);
  };

  const availableToAdd = AVAILABLE_SORT_RULES.filter(r => !sortRules.includes(r.value));

  return (
    <Card className="hover:border-slate-600 transition-colors">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="font-semibold text-white text-sm">{config.agent_name ?? `Agent #${config.agent_id}`}</h3>
          <p className="text-slate-500 text-xs mt-0.5">{config.agent_name}</p>
        </div>
        <Button
          variant={saved ? 'primary' : dirty ? 'primary' : 'ghost'}
          size="sm"
          onClick={handleSave}
          loading={saving}
          disabled={!dirty && !saving}
        >
          {saved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
          {saved ? 'Saved' : 'Save'}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <label className="block">
          <span className="text-slate-400 text-xs mb-1 block">Stall threshold (min)</span>
          <input
            type="number"
            min={1}
            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
            value={stallMin}
            onChange={e => setStallMin(Number(e.target.value))}
          />
          <p className="text-slate-600 text-[10px] mt-1">Mark stalled after X min with no update</p>
        </label>
        <label className="block">
          <span className="text-slate-400 text-xs mb-1 block">Max retries</span>
          <input
            type="number"
            min={0}
            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
            value={maxRetries}
            onChange={e => setMaxRetries(Number(e.target.value))}
          />
          <p className="text-slate-600 text-[10px] mt-1">Send back to dev max X times before failing</p>
        </label>
      </div>

      {/* Sort rules */}
      <div>
        <span className="text-slate-400 text-xs mb-2 block">Sort rules (ordered)</span>
        {sortRules.length > 0 ? (
          <div className="space-y-1 mb-2">
            {sortRules.map((rule, idx) => {
              const info = AVAILABLE_SORT_RULES.find(r => r.value === rule);
              return (
                <div
                  key={rule}
                  className="flex items-center gap-2 bg-slate-700/50 rounded-lg px-3 py-1.5 text-sm group"
                >
                  <div className="flex flex-col gap-0.5">
                    <button
                      onClick={() => moveRule(idx, -1)}
                      disabled={idx === 0}
                      className="text-slate-500 hover:text-white disabled:opacity-20 transition-colors leading-none text-[10px]"
                    >
                      ▲
                    </button>
                    <button
                      onClick={() => moveRule(idx, 1)}
                      disabled={idx === sortRules.length - 1}
                      className="text-slate-500 hover:text-white disabled:opacity-20 transition-colors leading-none text-[10px]"
                    >
                      ▼
                    </button>
                  </div>
                  <span className="text-slate-300 text-xs flex-1">
                    {idx + 1}. {info?.label ?? rule}
                  </span>
                  <button
                    onClick={() => removeRule(rule)}
                    className="text-slate-600 hover:text-red-400 transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-slate-600 text-xs mb-2">No sort rules — default ordering applies</p>
        )}

        {availableToAdd.length > 0 && (
          <div className="relative">
            <select
              className="appearance-none bg-slate-700 border border-slate-600 rounded-lg pl-3 pr-8 py-1.5 text-xs text-slate-400 focus:outline-none focus:border-amber-500 w-full cursor-pointer"
              value=""
              onChange={e => {
                if (e.target.value) addRule(e.target.value);
              }}
            >
              <option value="">+ Add sort rule…</option>
              {availableToAdd.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
          </div>
        )}
      </div>

      {error && <p className="text-red-400 text-xs mt-3">{error}</p>}
    </Card>
  );
}

function ReconcilerConfigCard({
  config,
  statuses,
  onSaved,
}: {
  config: ReconcilerConfig;
  statuses: TaskStatusMeta[];
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(config.needs_attention_eligible_statuses);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = statuses.filter(status => !status.terminal && status.name !== 'needs_attention');
  const dirty = JSON.stringify(selected) !== JSON.stringify(config.needs_attention_eligible_statuses);

  const toggle = (name: string) => {
    setSelected(current => current.includes(name)
      ? current.filter(value => value !== name)
      : [...current, name]
    );
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateRoutingReconcilerConfig({ needs_attention_eligible_statuses: selected });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="md:col-span-2 xl:col-span-3 border-amber-500/20 bg-amber-500/5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="font-semibold text-white text-sm">Reconciler safety net</h3>
          <p className="text-slate-400 text-xs mt-1">
            Choose which task statuses may auto-move to Needs Attention when a runtime ends without a lifecycle handoff.
          </p>
        </div>
        <Button variant={saved ? 'primary' : dirty ? 'primary' : 'ghost'} size="sm" onClick={handleSave} loading={saving} disabled={saving || !dirty}>
          {saved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
          {saved ? 'Saved' : 'Save'}
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
        {options.map(status => {
          const active = selected.includes(status.name);
          return (
            <button
              key={status.name}
              type="button"
              onClick={() => toggle(status.name)}
              className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${active ? 'border-amber-400 bg-amber-500/10 text-amber-200' : 'border-slate-700 bg-slate-800/60 text-slate-300 hover:border-slate-600'}`}
            >
              <div className="font-medium">{status.label}</div>
              <div className="text-[11px] text-slate-500">{status.name}</div>
            </button>
          );
        })}
      </div>

      <p className="text-slate-500 text-xs mt-3">
        This setting is shared by the reconciler tick and the immediate instance-complete fallback path.
      </p>
      {error && <p className="text-red-400 text-xs mt-3">{error}</p>}
    </Card>
  );
}

// ─── Status Row ──────────────────────────────────────────────
function StatusRow({
  status,
  allStatuses,
  sprintId,
  onSaved,
}: {
  status: TaskStatusMeta;
  allStatuses: TaskStatusMeta[];
  sprintId: number;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(status.label);
  const [color, setColor] = useState(status.color);
  const [transitions, setTransitions] = useState<string[]>(status.allowed_transitions);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSystemWarning, setShowSystemWarning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleStartEdit = () => {
    if (status.is_system) {
      setShowSystemWarning(true);
    }
    setEditing(true);
    setLabel(status.label);
    setColor(status.color);
    setTransitions([...status.allowed_transitions]);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateRoutingStatus(status.name, {
        sprint_id: sprintId,
        label,
        color,
        allowed_transitions: transitions,
      });
      setEditing(false);
      setShowSystemWarning(false);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditing(false);
    setShowSystemWarning(false);
    setError(null);
  };

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteRoutingStatus(status.name, sprintId);
      onSaved();
    } catch (e: any) {
      setDeleteError(e.message || String(e));
      setDeleteConfirm(false);
    } finally {
      setDeleting(false);
    }
  };

  const toggleTransition = (name: string) => {
    setTransitions(prev =>
      prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]
    );
  };

  const otherStatuses = allStatuses.filter(s => s.name !== status.name);

  return (
    <tr className="border-b border-slate-700/50 hover:bg-slate-800/30 transition-colors group">
      {/* Name */}
      <td className="px-3 py-3 text-sm">
        <div className="flex items-center gap-2">
          <code className="text-slate-300 font-mono text-xs">{status.name}</code>
          {status.is_system && (
            <span title="System status"><Lock className="w-3 h-3 text-slate-500" /></span>
          )}
        </div>
      </td>

      {/* Label */}
      <td className="px-3 py-3 text-sm">
        {editing ? (
          <input
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-white text-xs w-full focus:outline-none focus:border-amber-500"
            value={label}
            onChange={e => setLabel(e.target.value)}
          />
        ) : (
          <span className="text-slate-200 text-xs">{status.label}</span>
        )}
      </td>

      {/* Color */}
      <td className="px-3 py-3 text-sm">
        {editing ? (
          <div className="flex items-center gap-1.5 flex-wrap">
            {COLOR_OPTIONS.map(c => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`w-5 h-5 rounded-full ${COLOR_CLASSES[c]} ${
                  color === c ? 'ring-2 ring-white ring-offset-1 ring-offset-slate-800' : 'opacity-60 hover:opacity-100'
                } transition-all`}
                title={c}
              />
            ))}
          </div>
        ) : (
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${COLOR_BADGE_CLASSES[status.color] ?? COLOR_BADGE_CLASSES.slate}`}>
            {status.color}
          </span>
        )}
      </td>

      {/* Terminal */}
      <td className="px-3 py-3 text-sm text-center">
        {status.terminal ? (
          <span className="text-green-400 text-xs">✓</span>
        ) : (
          <span className="text-slate-600 text-xs">—</span>
        )}
      </td>

      {/* Transitions */}
      <td className="px-3 py-3 text-sm">
        {editing ? (
          <div className="flex flex-wrap gap-1">
            {otherStatuses.map(s => {
              const active = transitions.includes(s.name);
              return (
                <button
                  key={s.name}
                  onClick={() => toggleTransition(s.name)}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    active
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                      : 'bg-slate-700/50 text-slate-500 border border-slate-700 hover:border-slate-500'
                  }`}
                >
                  {s.name}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {status.allowed_transitions.map(t => (
              <span key={t} className="px-1.5 py-0.5 rounded bg-slate-700/50 text-slate-400 text-[10px] font-mono">
                {t}
              </span>
            ))}
          </div>
        )}
      </td>

      {/* Actions */}
      <td className="px-3 py-3 text-sm text-right">
        {deleteConfirm ? (
          <div className="flex items-center gap-1 justify-end">
            <span className="text-red-400 text-[10px] mr-1">Delete "{status.label}"?</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDelete}
              loading={deleting}
              className="text-red-400 hover:text-red-300 hover:bg-red-900/20"
            >
              <Trash2 className="w-3 h-3" /> Yes
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setDeleteConfirm(false); setDeleteError(null); }}>
              <X className="w-3 h-3" /> No
            </Button>
          </div>
        ) : editing ? (
          <div className="flex items-center gap-1 justify-end">
            {showSystemWarning && (
              <span title="System status — edit carefully"><AlertTriangle className="w-3.5 h-3.5 text-amber-400 mr-1" /></span>
            )}
            <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
              <Check className="w-3 h-3" /> Save
            </Button>
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              <X className="w-3 h-3" />
            </Button>
            {error && <span className="text-red-400 text-[10px] ml-1">{error}</span>}
          </div>
        ) : (
          <div className="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleStartEdit}
            >
              Edit
            </Button>
            {!status.is_system && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDeleteConfirm(true)}
                className="text-slate-500 hover:text-red-400 hover:bg-red-900/10"
                title="Delete status"
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            )}
          </div>
        )}
        {deleteError && (
          <p className="text-red-400 text-[10px] mt-1 text-right max-w-[300px] ml-auto">{deleteError}</p>
        )}
      </td>
    </tr>
  );
}

// ─── New Status Form ─────────────────────────────────────────
function NewStatusForm({
  allStatuses,
  sprintId,
  onCreated,
  onCancel,
}: {
  allStatuses: TaskStatusMeta[];
  sprintId: number;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [color, setColor] = useState('slate');
  const [transitions, setTransitions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleTransition = (n: string) => {
    setTransitions(prev =>
      prev.includes(n) ? prev.filter(t => t !== n) : [...prev, n]
    );
  };

  const handleCreate = async () => {
    if (!name.trim() || !label.trim()) {
      setError('Name and label are required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.createRoutingStatus({
        sprint_id: sprintId,
        name: name.trim().toLowerCase().replace(/\s+/g, '_'),
        label: label.trim(),
        color,
        allowed_transitions: transitions,
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
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-white text-xs w-full font-mono focus:outline-none focus:border-amber-500"
          placeholder="status_name"
          value={name}
          onChange={e => setName(e.target.value)}
        />
      </td>
      <td className="px-3 py-3">
        <input
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-white text-xs w-full focus:outline-none focus:border-amber-500"
          placeholder="Display Label"
          value={label}
          onChange={e => setLabel(e.target.value)}
        />
      </td>
      <td className="px-3 py-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          {COLOR_OPTIONS.map(c => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={`w-5 h-5 rounded-full ${COLOR_CLASSES[c]} ${
                color === c ? 'ring-2 ring-white ring-offset-1 ring-offset-slate-800' : 'opacity-60 hover:opacity-100'
              } transition-all`}
              title={c}
            />
          ))}
        </div>
      </td>
      <td className="px-3 py-3 text-center">
        <span className="text-slate-600 text-xs">—</span>
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-wrap gap-1">
          {allStatuses.map(s => {
            const active = transitions.includes(s.name);
            return (
              <button
                key={s.name}
                onClick={() => toggleTransition(s.name)}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                  active
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                    : 'bg-slate-700/50 text-slate-500 border border-slate-700 hover:border-slate-500'
                }`}
              >
                {s.name}
              </button>
            );
          })}
        </div>
      </td>
      <td className="px-3 py-3 text-right">
        <div className="flex items-center gap-1 justify-end">
          <Button variant="primary" size="sm" onClick={handleCreate} loading={saving}>
            <Check className="w-3 h-3" /> Create
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            <X className="w-3 h-3" />
          </Button>
        </div>
        {error && <p className="text-red-400 text-[10px] mt-1 text-right">{error}</p>}
      </td>
    </tr>
  );
}

// ─── Transitions Section ─────────────────────────────────────
// Transitions is the canonical workflow model (task #614).
// Each row = from_status + outcome → to_status, with optional task_type override,
// priority, and is_protected flag for code-enforced transitions.
function TransitionsSection({ sprintId, sprintName }: { sprintId: number | null; sprintName: string | null }) {
  const [transitions, setTransitions] = useState<RoutingTransition[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const { taskTypes } = useTaskTypes();
  const [newForm, setNewForm] = useState({
    task_type: '' as string,
    from_status: 'in_progress',
    outcome: 'completed_for_review',
    to_status: 'review',
    lane: 'default',
    priority: 0,
  });

  const STATUSES = ['todo', 'ready', 'dispatched', 'in_progress', 'review', 'qa_pass', 'ready_to_merge', 'deployed', 'done', 'needs_attention', 'cancelled', 'stalled', 'failed'];
  const OUTCOMES = ['completed_for_review', 'completed_done', 'qa_pass', 'qa_fail', 'approved_for_merge', 'deployed_live', 'live_verified', 'blocked', 'failed', 'retry', 'user_update'];

  const STATUS_BADGE: Record<string, string> = {
    todo: 'bg-slate-700 text-slate-300',
    ready: 'bg-blue-900/60 text-blue-300',
    dispatched: 'bg-indigo-900/60 text-indigo-300',
    in_progress: 'bg-amber-900/60 text-amber-300',
    review: 'bg-purple-900/60 text-purple-300',
    needs_attention: 'bg-amber-900/60 text-amber-300',
    done: 'bg-green-900/60 text-green-300',
    cancelled: 'bg-red-900/60 text-red-300',
    stalled: 'bg-orange-900/60 text-orange-300',
    failed: 'bg-red-900/60 text-red-300',
  };

  const load = useCallback(() => {
    if (!sprintId) {
      setTransitions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    api.getRoutingTransitions(undefined, sprintId)
      .then((t) => {
        setTransitions(t.transitions);
      })
      .catch(e => console.error(e))
      .finally(() => setLoading(false));
  }, [sprintId]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!sprintId) return;
    try {
      await api.createRoutingTransition({
        sprint_id: sprintId,
        task_type: newForm.task_type || null,
        from_status: newForm.from_status,
        outcome: newForm.outcome,
        to_status: newForm.to_status,
        lane: newForm.lane,
        priority: newForm.priority,
      });
      setShowAdd(false);
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleToggle = async (t: RoutingTransition) => {
    try {
      await api.updateRoutingTransition(t.id, { sprint_id: sprintId ?? undefined, enabled: t.enabled ? 0 : 1 });
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this transition rule?')) return;
    try {
      await api.deleteRoutingTransition(id, sprintId ?? undefined);
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  if (!sprintId) {
    return (
      <Card className="bg-slate-900/50 border-slate-700/50 p-6 text-sm text-slate-400">
        Select a sprint to edit its automatic transitions.
      </Card>
    );
  }

  if (loading) return (
    <div className="flex items-center justify-center h-32">
      <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  const activeTransitions = transitions.filter(t => t.enabled);
  // Global (no task-type) defaults only, for the flow preview
  const globalDefaultTransitions = activeTransitions.filter(t => !t.task_type);

  return (
    <div className="space-y-4">
      {/* Context banner */}
      <div className="bg-amber-900/20 border border-amber-700/40 rounded-xl px-4 py-3 text-sm text-amber-300/90">
        <strong>Canonical workflow model for {sprintName ?? `Sprint #${sprintId}`}.</strong> Each row defines one transition: a (from_status + outcome) pair → to_status.
        Optional <span className="font-mono text-xs bg-amber-900/40 px-1 rounded">task_type</span> overrides apply to specific task types at higher priority than global defaults.
        Transitions marked <span className="font-mono text-xs bg-amber-900/40 px-1 rounded">protected</span> are also enforced in code via evidence gates — they cannot be bypassed by disabling the row.
      </div>

      {/* Visual Flow */}
      <Card className="bg-slate-900/50 border-slate-700/50 p-4">
        <h3 className="text-sm font-semibold text-slate-300 mb-3">Active Sprint Transitions</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {globalDefaultTransitions.map(t => (
            <div key={t.id} className="flex items-center gap-1.5 text-xs bg-slate-800/40 rounded-lg px-3 py-2">
              <Badge className={`${STATUS_BADGE[t.from_status] || 'bg-slate-700'} text-[10px] px-1.5`}>
                {t.from_status}
              </Badge>
              <ChevronRight className="w-3 h-3 text-slate-500 flex-shrink-0" />
              <span className="text-slate-400 font-mono truncate">{t.outcome}</span>
              <ChevronRight className="w-3 h-3 text-slate-500 flex-shrink-0" />
              <Badge className={`${STATUS_BADGE[t.to_status] || 'bg-slate-700'} text-[10px] px-1.5`}>
                {t.to_status}
              </Badge>
              {t.is_protected ? <span title="Protected: also enforced in code"><Lock className="w-3 h-3 text-amber-400 flex-shrink-0" /></span> : null}
            </div>
          ))}
          {globalDefaultTransitions.length === 0 && (
            <p className="text-slate-500 text-sm col-span-full">No active transitions configured for this sprint.</p>
          )}
        </div>
      </Card>

      {/* Add Rule Form */}
      <div className="flex items-center justify-between">
        <p className="text-slate-400 text-sm">{transitions.length} transition rule{transitions.length !== 1 ? 's' : ''}</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setShowAdd(!showAdd)}
        >
          <Plus className="w-3.5 h-3.5" /> Add Transition
        </Button>
      </div>

      {showAdd && (
        <Card className="bg-slate-900/50 border-slate-700/50 p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Task Type (optional override)</label>
              <select
                value={newForm.task_type}
                onChange={e => setNewForm({ ...newForm, task_type: e.target.value })}
                className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm"
              >
                <option value="">All types (default)</option>
                {taskTypes.map(tt => <option key={tt} value={tt}>{tt}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">From Status</label>
              <select
                value={newForm.from_status}
                onChange={e => setNewForm({ ...newForm, from_status: e.target.value })}
                className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm"
              >
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Outcome</label>
              <select
                value={newForm.outcome}
                onChange={e => setNewForm({ ...newForm, outcome: e.target.value })}
                className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm"
              >
                {OUTCOMES.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">To Status</label>
              <select
                value={newForm.to_status}
                onChange={e => setNewForm({ ...newForm, to_status: e.target.value })}
                className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm"
              >
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Lane</label>
              <input
                type="text"
                value={newForm.lane}
                onChange={e => setNewForm({ ...newForm, lane: e.target.value })}
                className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm"
                placeholder="default"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Priority</label>
              <input
                type="number"
                value={newForm.priority}
                onChange={e => setNewForm({ ...newForm, priority: Number(e.target.value) })}
                className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm"
                placeholder="0"
              />
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <Button onClick={handleAdd} size="sm" className="bg-green-700 hover:bg-green-600 text-white">Save</Button>
            <Button onClick={() => setShowAdd(false)} variant="ghost" size="sm" className="text-slate-400">Cancel</Button>
          </div>
        </Card>
      )}

      {/* Rules Table */}
      <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-left">
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Sprint</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Task Type</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">From</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Outcome</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">To</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Lane / Pri</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider text-center">Enabled</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {transitions.map(t => (
                <tr key={t.id} className={`border-b border-slate-800/50 hover:bg-slate-800/30 ${t.is_protected ? 'bg-amber-950/10' : ''}`}>
                  <td className="px-3 py-2.5 text-slate-300">{t.sprint_name ?? sprintName ?? `Sprint #${sprintId}`}</td>
                  <td className="px-3 py-2.5">
                    {t.task_type ? (
                      <span className="font-mono text-xs text-indigo-300 bg-indigo-900/30 px-1.5 py-0.5 rounded">{t.task_type}</span>
                    ) : (
                      <span className="text-slate-600 text-xs">all types</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge className={`${STATUS_BADGE[t.from_status] || 'bg-slate-700'} text-xs`}>{t.from_status}</Badge>
                  </td>
                  <td className="px-3 py-2.5 text-slate-300 font-mono text-xs">{t.outcome}</td>
                  <td className="px-3 py-2.5">
                    <Badge className={`${STATUS_BADGE[t.to_status] || 'bg-slate-700'} text-xs`}>{t.to_status}</Badge>
                  </td>
                  <td className="px-3 py-2.5 text-slate-400 text-xs">
                    <span>{t.lane}</span>
                    {(t as any).priority > 0 && <span className="ml-1 text-slate-500">p{(t as any).priority}</span>}
                    {t.is_protected ? (
                      <span className="ml-1.5 inline-flex items-center gap-0.5 text-amber-400/80">
                        <Lock className="w-3 h-3" /><span className="text-[10px]">protected</span>
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <button onClick={() => handleToggle(t)} className="focus:outline-none" disabled={!!t.is_protected} title={t.is_protected ? 'Protected transitions remain code-enforced even when disabled here' : undefined}>
                      {t.enabled ? (
                        <Check className="w-4 h-4 text-green-400 inline" />
                      ) : (
                        <X className="w-4 h-4 text-slate-500 inline" />
                      )}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {!t.is_protected && (
                      <button onClick={() => handleDelete(t.id)} className="text-red-400 hover:text-red-300 p-1">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {transitions.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-slate-500">
                    No transition rules. Add one to define outcome-driven state changes.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Routing Rules Section (deterministic task_type + status → job) ──────────
function RoutingRulesSection({ sprintId, sprintName }: { sprintId: number | null; sprintName: string | null }) {
  const [rules, setRules] = useState<TaskRoutingRule[]>([]);
  const [agentsList, setAgentsList] = useState<{ id: number; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newForm, setNewForm] = useState({
    task_type: 'frontend',
    status: 'ready',
    agent_id: '' as number | '',
    priority: 0,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { options: taskTypeOptions } = useTaskTypes();
  const STATUSES = ['todo', 'ready', 'in_progress', 'review', 'done', 'stalled', 'failed'];

  const TYPE_BADGE: Record<string, string> = {
    frontend: 'bg-blue-900/60 text-blue-300',
    backend: 'bg-green-900/60 text-green-300',
    fullstack: 'bg-indigo-900/60 text-indigo-300',
    qa: 'bg-purple-900/60 text-purple-300',
    design: 'bg-pink-900/60 text-pink-300',
    marketing: 'bg-amber-900/60 text-amber-300',
    pm: 'bg-slate-600 text-slate-200',
    ops: 'bg-orange-900/60 text-orange-300',
    data: 'bg-cyan-900/60 text-cyan-300',
    other: 'bg-slate-700 text-slate-300',
  };

  const STATUS_BADGE: Record<string, string> = {
    todo: 'bg-slate-700 text-slate-300',
    ready: 'bg-blue-900/60 text-blue-300',
    in_progress: 'bg-amber-900/60 text-amber-300',
    review: 'bg-purple-900/60 text-purple-300',
    done: 'bg-green-900/60 text-green-300',
    stalled: 'bg-orange-900/60 text-orange-300',
    failed: 'bg-red-900/60 text-red-300',
  };

  const load = useCallback(() => {
    if (!sprintId) {
      setRules([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([
      api.getRoutingRules(undefined, sprintId),
      api.getAgents(),
    ])
      .then(([r, a]) => {
        setRules(r.rules);
        setAgentsList(a.map(ag => ({ id: ag.id, name: ag.name })));
      })
      .catch(e => console.error(e))
      .finally(() => setLoading(false));
  }, [sprintId]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!sprintId || !newForm.agent_id) {
      setError('Sprint and Agent are required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.createRoutingRule({
        sprint_id: sprintId,
        task_type: newForm.task_type,
        status: newForm.status,
        agent_id: Number(newForm.agent_id),
        priority: newForm.priority,
      });
      setShowAdd(false);
      setNewForm({ task_type: 'frontend', status: 'ready', agent_id: '', priority: 0 });
      load();
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this routing rule?')) return;
    try {
      await api.deleteRoutingRule(id, sprintId ?? undefined);
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-32">
      <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (!sprintId) {
    return (
      <Card className="bg-slate-900/50 border-slate-700/50 p-6 text-sm text-slate-400">
        Select a sprint to edit deterministic routing rules.
      </Card>
    );
  }

  return (
    <div className="space-y-4" data-tour-target="routing-rules">
      {/* Description */}
      <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-slate-300 mb-1">Deterministic Task Routing</h3>
        <p className="text-slate-500 text-xs">
          Rules map <code className="text-slate-400">task_type + status → agent</code> for {sprintName ?? `Sprint #${sprintId}`}.
          When a task has a type, the system assigns it to the correct agent automatically — no LLM decision needed.
          Rules are evaluated on task creation and explicit status transitions.
        </p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="text-xs text-slate-500">{sprintName ?? `Sprint #${sprintId}`}</div>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => setShowAdd(!showAdd)}>
          <Plus className="w-3.5 h-3.5" /> Add Rule
        </Button>
        <Button variant="ghost" size="sm" onClick={() => load()}>
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </Button>
      </div>

      {/* Add Rule Form */}
      {showAdd && (
        <Card className="bg-slate-900/50 border-slate-700/50 p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Task Type *</label>
              <select
                value={newForm.task_type}
                onChange={e => setNewForm({ ...newForm, task_type: e.target.value })}
                className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm"
              >
                {taskTypeOptions.map(taskType => (
                  <option key={taskType.value} value={taskType.value}>{taskType.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">When Status *</label>
              <select
                value={newForm.status}
                onChange={e => setNewForm({ ...newForm, status: e.target.value })}
                className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm"
              >
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Assign to Agent *</label>
              <select
                value={newForm.agent_id}
                onChange={e => setNewForm({ ...newForm, agent_id: e.target.value === '' ? '' : Number(e.target.value) })}
                className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm"
              >
                <option value="">Select agent…</option>
                {agentsList.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Priority</label>
              <input
                type="number"
                value={newForm.priority}
                onChange={e => setNewForm({ ...newForm, priority: Number(e.target.value) })}
                className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm"
                placeholder="0"
              />
              <p className="text-slate-600 text-[10px] mt-0.5">Higher = preferred</p>
            </div>
          </div>
          <div className="flex items-center gap-2 mt-3">
            <Button onClick={handleAdd} size="sm" className="bg-green-700 hover:bg-green-600 text-white" loading={saving}>
              <Check className="w-3 h-3" /> Save Rule
            </Button>
            <Button onClick={() => { setShowAdd(false); setError(null); }} variant="ghost" size="sm" className="text-slate-400">Cancel</Button>
            {error && <span className="text-red-400 text-xs ml-2">{error}</span>}
          </div>
        </Card>
      )}

      {/* Rules Table */}
      {rules.length === 0 ? (
        <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-8 text-center">
          <p className="text-slate-500 text-sm">No routing rules configured yet.</p>
          <p className="text-slate-600 text-xs mt-1">Add rules to enable deterministic task routing.</p>
        </div>
      ) : (
        <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-left">
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Task Type</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">When Status</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">→</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Assigned Agent</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map(rule => (
                <tr key={rule.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 group">
                  <td className="px-3 py-2.5">
                    <Badge className={`${TYPE_BADGE[rule.task_type] || 'bg-slate-700'} text-xs`}>
                      {getTaskTypeLabel(rule.task_type)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge className={`${STATUS_BADGE[rule.status] || 'bg-slate-700'} text-xs`}>
                      {rule.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <ChevronRight className="w-3 h-3 text-slate-500" />
                  </td>
                  <td className="px-3 py-2.5 text-slate-200 text-xs">{rule.agent_name ?? `Agent #${rule.agent_id}`}</td>
                  <td className="px-3 py-2.5 text-right">
                    <button
                      onClick={() => handleDelete(rule.id)}
                      className="text-slate-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 p-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Missing rules warning */}
      {rules.length > 0 && (
        <MissingRulesWarning rules={rules} projectName={sprintName ?? `Sprint #${sprintId}`} />
      )}
    </div>
  );
}

// ─── Missing Rules Warning ────────────────────────────────────
function MissingRulesWarning({ rules, projectName }: { rules: TaskRoutingRule[]; projectName: string }) {
  const CORE_COMBOS = [
    { type: 'frontend', statuses: ['ready', 'review'] },
    { type: 'backend', statuses: ['ready', 'review'] },
    { type: 'fullstack', statuses: ['ready', 'review'] },
  ];
  const missing: string[] = [];
  for (const combo of CORE_COMBOS) {
    for (const status of combo.statuses) {
      const hasRule = rules.some(r => r.task_type === combo.type && r.status === status);
      if (!hasRule && rules.some(r => r.task_type === combo.type)) {
        missing.push(`${combo.type}/${status}`);
      }
    }
  }
  if (missing.length === 0) return null;

  return (
    <div className="bg-amber-900/20 border border-amber-700/40 rounded-xl p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-amber-300 text-sm font-medium">Incomplete routing coverage</p>
          <p className="text-amber-400/80 text-xs mt-1">
            <strong>{projectName}</strong>: missing rules for {missing.join(', ')}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Tab type ────────────────────────────────────────────────
// ─── Agent Contract Editor ────────────────────────────────────
function AgentContractSection() {
  const [sprintTypes, setSprintTypes] = useState<Array<{ key: string; name: string }>>([]);
  const [selectedSprintType, setSelectedSprintType] = useState('generic');
  const [content, setContent] = useState('');
  const [placeholderDefinitions, setPlaceholderDefinitions] = useState<ContractPlaceholderDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [inheritedFrom, setInheritedFrom] = useState<string | null>(null);

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  };

  useEffect(() => {
    apiFetch<{ sprint_types?: Array<{ key: string; name: string }> }>('/api/v1/sprints/config')
      .then(data => {
        const types = data.sprint_types ?? [];
        setSprintTypes(types.map(type => ({ key: type.key, name: type.name })));
        if (types.length > 0 && !types.some(type => type.key === selectedSprintType)) {
          setSelectedSprintType(types[0]?.key ?? 'generic');
        }
      })
      .catch(e => showToast('error', `Failed to load sprint types: ${e}`));
  }, []);

  useEffect(() => {
    setLoading(true);
    apiFetch<{ content: string; inherited_from?: string | null; placeholder_definitions?: ContractPlaceholderDefinition[] }>(`/api/v1/routing/agent-contract?sprint_type=${encodeURIComponent(selectedSprintType)}`)
      .then(data => {
        setContent(data.content ?? '');
        setInheritedFrom(data.inherited_from ?? null);
        setPlaceholderDefinitions(data.placeholder_definitions ?? []);
      })
      .catch(e => showToast('error', `Failed to load: ${e}`))
      .finally(() => setLoading(false));
  }, [selectedSprintType]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/v1/routing/agent-contract', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sprint_type: selectedSprintType, content }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? res.statusText);
      }
      setInheritedFrom(null);
      showToast('success', `Agent contract saved for ${selectedSprintType}.`);
    } catch (e) {
      showToast('error', `Save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Agent Dispatch Contract</h2>
          <p className="text-slate-400 text-sm mt-0.5">
            One plain text contract template per sprint type, injected into dispatched agent runs. Supports{' '}
            <code className="text-amber-300 text-xs bg-slate-800 px-1 py-0.5 rounded">{'{{placeholder}}'}</code> syntax.
          </p>
        </div>
        <Button onClick={handleSave} disabled={saving || loading} size="sm">
          {saving ? (
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Save className="w-3.5 h-3.5" />
          )}
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      {toast && (
        <div
          className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium ${
            toast.type === 'success'
              ? 'bg-green-900/40 border border-green-700/50 text-green-300'
              : 'bg-red-900/40 border border-red-700/50 text-red-300'
          }`}
        >
          {toast.type === 'success' ? <Check className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {toast.message}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-slate-300">
          Sprint type
          <select
            value={selectedSprintType}
            onChange={e => setSelectedSprintType(e.target.value)}
            className="ml-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
          >
            {sprintTypes.map(type => (
              <option key={type.key} value={type.key}>{type.name}</option>
            ))}
          </select>
        </label>
        {inheritedFrom && (
          <p className="text-xs text-slate-400">
            Using fallback template from <code className="text-amber-300">{inheritedFrom}</code> until this sprint type is saved explicitly.
          </p>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          className="w-full h-[520px] bg-slate-900 border border-slate-700 rounded-xl p-4 text-sm text-slate-200 font-mono resize-y focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50"
          spellCheck={false}
          placeholder="Paste or edit the agent dispatch contract here…"
        />
      )}

      <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg p-3 space-y-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-2">Available placeholders</p>
          <div className="flex flex-wrap gap-1.5">
            {placeholderDefinitions.map(({ key }) => {
              const placeholder = `{{${key}}}`;
              return (
                <span key={placeholder} className="inline-block bg-slate-700 text-amber-300 px-1.5 py-0.5 rounded text-xs font-mono">
                  {placeholder}
                </span>
              );
            })}
          </div>
        </div>

        <div className="border-t border-slate-700/60 pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-2">Placeholder definitions</p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {placeholderDefinitions.map(({ key, description }) => (
              <div key={key} className="rounded-lg border border-slate-700/60 bg-slate-900/50 p-3">
                <code className="text-xs text-amber-300 font-mono">{`{{${key}}}`}</code>
                <p className="mt-1 text-xs leading-5 text-slate-300">{description}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE RULES SECTION — data-driven outcome→status routing (task #612)
// ═══════════════════════════════════════════════════════════════════════════════

function LifecycleRulesSection() {
  const [rules, setRules] = useState<LifecycleRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const { options: taskTypeOptions } = useTaskTypes();
  const [filterType, setFilterType] = useState<string>('');
  const [newForm, setNewForm] = useState({
    task_type: '' as string,
    from_status: 'in_progress',
    outcome: 'completed_for_review',
    to_status: 'review',
    lane: 'default',
    priority: 0,
  });

  const STATUSES = ['todo', 'ready', 'dispatched', 'in_progress', 'review', 'qa_pass', 'ready_to_merge', 'deployed', 'done', 'needs_attention', 'stalled', 'failed', 'cancelled'];
  const OUTCOMES = ['completed_for_review', 'qa_pass', 'qa_fail', 'approved_for_merge', 'deployed_live', 'live_verified', 'blocked', 'failed', 'retry'];

  const STATUS_BADGE: Record<string, string> = {
    todo: 'bg-slate-700 text-slate-300',
    ready: 'bg-blue-900/60 text-blue-300',
    dispatched: 'bg-indigo-900/60 text-indigo-300',
    in_progress: 'bg-amber-900/60 text-amber-300',
    review: 'bg-purple-900/60 text-purple-300',
    qa_pass: 'bg-emerald-900/60 text-emerald-300',
    ready_to_merge: 'bg-cyan-900/60 text-cyan-300',
    deployed: 'bg-green-900/60 text-green-300',
    needs_attention: 'bg-amber-900/60 text-amber-300',
    done: 'bg-green-900/60 text-green-300',
    stalled: 'bg-orange-900/60 text-orange-300',
    failed: 'bg-red-900/60 text-red-300',
    cancelled: 'bg-red-900/60 text-red-300',
  };

  const load = useCallback(() => {
    setLoading(true);
    api.getLifecycleRules(filterType || undefined)
      .then(data => setRules(data.lifecycle_rules))
      .catch(e => console.error(e))
      .finally(() => setLoading(false));
  }, [filterType]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    try {
      await api.createLifecycleRule({
        task_type: newForm.task_type || null,
        from_status: newForm.from_status,
        outcome: newForm.outcome,
        to_status: newForm.to_status,
        lane: newForm.lane,
        priority: newForm.priority,
      });
      setShowAdd(false);
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleToggle = async (rule: LifecycleRule) => {
    try {
      await api.updateLifecycleRule(rule.id, { enabled: rule.enabled ? 0 : 1 });
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this lifecycle rule?')) return;
    try {
      await api.deleteLifecycleRule(id);
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-32">
      <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  const globalRules = rules.filter(r => !r.task_type);
  const typeRules = rules.filter(r => r.task_type);

  return (
    <div className="space-y-4">
      <Card className="bg-slate-900/50 border-slate-700/50 p-4">
        <h3 className="text-sm font-semibold text-slate-300 mb-2">Data-Driven Lifecycle Rules</h3>
        <p className="text-xs text-slate-500">
          These rules replace hardcoded outcome→status routing. Task-type-specific rules (priority &gt; 0) override global defaults.
          When a task outcome is posted, the engine resolves: type-specific rule → global rule → legacy fallback.
        </p>
      </Card>

      {/* Filter + Add */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">Filter by type:</span>
          <select
            value={filterType}
            onChange={e => setFilterType(e.target.value)}
            className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-white text-xs"
          >
            <option value="">All types</option>
            {taskTypeOptions.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <span className="text-xs text-slate-500">{rules.length} rule{rules.length !== 1 ? 's' : ''}</span>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setShowAdd(!showAdd)}>
          <Plus className="w-3.5 h-3.5" /> Add Rule
        </Button>
      </div>

      {/* Add form */}
      {showAdd && (
        <Card className="bg-slate-800/60 border-slate-700/50 p-4 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <div>
              <label className="text-xs text-slate-400 block mb-1">Task Type</label>
              <select value={newForm.task_type} onChange={e => setNewForm({ ...newForm, task_type: e.target.value })} className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm">
                <option value="">All (global)</option>
                {taskTypeOptions.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">From Status</label>
              <select value={newForm.from_status} onChange={e => setNewForm({ ...newForm, from_status: e.target.value })} className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm">
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Outcome</label>
              <select value={newForm.outcome} onChange={e => setNewForm({ ...newForm, outcome: e.target.value })} className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm">
                {OUTCOMES.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">To Status</label>
              <select value={newForm.to_status} onChange={e => setNewForm({ ...newForm, to_status: e.target.value })} className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm">
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Priority</label>
              <input type="number" value={newForm.priority} onChange={e => setNewForm({ ...newForm, priority: Number(e.target.value) })} className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm" />
            </div>
            <div className="flex items-end gap-2">
              <Button size="sm" onClick={handleAdd}>Add</Button>
              <Button variant="ghost" size="sm" onClick={() => setShowAdd(false)}><X className="w-3.5 h-3.5" /></Button>
            </div>
          </div>
        </Card>
      )}

      {/* Type-specific overrides */}
      {typeRules.length > 0 && (
        <Card className="bg-slate-800/60 border-slate-700/50 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-700/50">
            <h4 className="text-xs font-semibold text-amber-400 uppercase tracking-wider">Type-Specific Overrides</h4>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-700 text-left">
                  <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase">Task Type</th>
                  <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase">From</th>
                  <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase">Outcome</th>
                  <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase">To</th>
                  <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase text-center">Priority</th>
                  <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase text-center">Enabled</th>
                  <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {typeRules.map(rule => (
                  <tr key={rule.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                    <td className="px-3 py-2">
                      <Badge className="bg-amber-900/40 text-amber-300 text-xs">{getTaskTypeLabel(rule.task_type!)}</Badge>
                    </td>
                    <td className="px-3 py-2"><Badge className={`${STATUS_BADGE[rule.from_status] || 'bg-slate-700'} text-[10px]`}>{rule.from_status}</Badge></td>
                    <td className="px-3 py-2"><span className="text-xs text-slate-300 font-mono">{rule.outcome}</span></td>
                    <td className="px-3 py-2"><Badge className={`${STATUS_BADGE[rule.to_status] || 'bg-slate-700'} text-[10px]`}>{rule.to_status}</Badge></td>
                    <td className="px-3 py-2 text-center"><span className="text-xs text-slate-400">{rule.priority}</span></td>
                    <td className="px-3 py-2 text-center">
                      <button onClick={() => handleToggle(rule)} className={`w-8 h-4 rounded-full transition-colors ${rule.enabled ? 'bg-green-600' : 'bg-slate-600'}`}>
                        <div className={`w-3 h-3 rounded-full bg-white transition-transform ${rule.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </button>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => handleDelete(rule.id)} className="text-red-400 hover:text-red-300 p-1"><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Global defaults */}
      <Card className="bg-slate-800/60 border-slate-700/50 overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-700/50">
          <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Global Defaults</h4>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-700 text-left">
                <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase">From</th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase">Outcome</th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase">To</th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase">Lane</th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase text-center">Enabled</th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {globalRules.map(rule => (
                <tr key={rule.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                  <td className="px-3 py-2"><Badge className={`${STATUS_BADGE[rule.from_status] || 'bg-slate-700'} text-[10px]`}>{rule.from_status}</Badge></td>
                  <td className="px-3 py-2"><span className="text-xs text-slate-300 font-mono">{rule.outcome}</span></td>
                  <td className="px-3 py-2"><Badge className={`${STATUS_BADGE[rule.to_status] || 'bg-slate-700'} text-[10px]`}>{rule.to_status}</Badge></td>
                  <td className="px-3 py-2"><span className="text-xs text-slate-400">{rule.lane}</span></td>
                  <td className="px-3 py-2 text-center">
                    <button onClick={() => handleToggle(rule)} className={`w-8 h-4 rounded-full transition-colors ${rule.enabled ? 'bg-green-600' : 'bg-slate-600'}`}>
                      <div className={`w-3 h-3 rounded-full bg-white transition-transform ${rule.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => handleDelete(rule.id)} className="text-red-400 hover:text-red-300 p-1"><Trash2 className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ))}
              {globalRules.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-4 text-center text-sm text-slate-500">No global lifecycle rules configured.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSITION REQUIREMENTS SECTION — data-driven evidence gates (task #612)
// ═══════════════════════════════════════════════════════════════════════════════

function TransitionRequirementsSection({ sprintId, sprintName }: { sprintId: number | null; sprintName: string | null }) {
  const [reqs, setReqs] = useState<TransitionRequirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const { options: taskTypeOptions } = useTaskTypes();
  const [filterType, setFilterType] = useState<string>('');
  const [filterOutcome, setFilterOutcome] = useState<string>('');
  const [newForm, setNewForm] = useState({
    task_type: '' as string,
    outcome: 'completed_for_review',
    field_name: 'review_branch',
    requirement_type: 'required' as 'required' | 'match' | 'from_status',
    match_field: '',
    severity: 'block' as 'block' | 'warn',
    message: '',
    priority: 0,
  });

  const OUTCOMES = ['completed_for_review', 'qa_pass', 'qa_fail', 'approved_for_merge', 'deployed_live', 'live_verified', 'blocked', 'failed', 'retry'];
  const TASK_FIELDS = ['review_branch', 'review_commit', 'review_url', 'qa_verified_commit', 'qa_tested_url', 'merged_commit', 'deployed_commit', 'deployed_at', 'live_verified_at', 'live_verified_by', 'deploy_target', 'status'];

  const load = useCallback(() => {
    if (!sprintId) {
      setReqs([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    api.getTransitionRequirements(filterType || undefined, filterOutcome || undefined, sprintId)
      .then(data => setReqs(data.transition_requirements))
      .catch(e => console.error(e))
      .finally(() => setLoading(false));
  }, [filterType, filterOutcome, sprintId]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!sprintId) return;
    try {
      await api.createTransitionRequirement({
        sprint_id: sprintId,
        task_type: newForm.task_type || null,
        outcome: newForm.outcome,
        field_name: newForm.field_name,
        requirement_type: newForm.requirement_type,
        match_field: newForm.requirement_type !== 'required' ? (newForm.match_field || null) : null,
        severity: newForm.severity,
        message: newForm.message,
        priority: newForm.priority,
      });
      setShowAdd(false);
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleToggle = async (req: TransitionRequirement) => {
    try {
      await api.updateTransitionRequirement(req.id, { sprint_id: sprintId ?? undefined, enabled: req.enabled ? 0 : 1 });
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this transition requirement?')) return;
    try {
      await api.deleteTransitionRequirement(id, sprintId ?? undefined);
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-32">
      <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (!sprintId) {
    return (
      <Card className="bg-slate-900/50 border-slate-700/50 p-6 text-sm text-slate-400">
        Select a sprint to edit gate requirements.
      </Card>
    );
  }

  const SEVERITY_BADGE: Record<string, string> = {
    block: 'bg-red-900/60 text-red-300',
    warn: 'bg-yellow-900/60 text-yellow-300',
  };

  const REQ_TYPE_BADGE: Record<string, string> = {
    required: 'bg-blue-900/60 text-blue-300',
    match: 'bg-purple-900/60 text-purple-300',
    from_status: 'bg-indigo-900/60 text-indigo-300',
  };

  // Group by outcome for readability
  const grouped = reqs.reduce<Record<string, TransitionRequirement[]>>((acc, req) => {
    const key = req.outcome;
    if (!acc[key]) acc[key] = [];
    acc[key].push(req);
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <Card className="bg-slate-900/50 border-slate-700/50 p-4">
        <h3 className="text-sm font-semibold text-slate-300 mb-2">Transition Gate Requirements</h3>
        <p className="text-xs text-slate-500">
          Configurable field checks for each outcome in {sprintName ?? `Sprint #${sprintId}`}. For example, &quot;completed_for_review&quot; requires review_branch and review_commit.
          Task-type-specific requirements override global defaults. Severity controls whether a failed check blocks the transition or just warns.
        </p>
      </Card>

      {/* Filter + Add */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-400">Filter:</span>
          <select value={filterType} onChange={e => setFilterType(e.target.value)} className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-white text-xs">
            <option value="">All types</option>
            {taskTypeOptions.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <select value={filterOutcome} onChange={e => setFilterOutcome(e.target.value)} className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-white text-xs">
            <option value="">All outcomes</option>
            {OUTCOMES.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
          <span className="text-xs text-slate-500">{reqs.length} requirement{reqs.length !== 1 ? 's' : ''}</span>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setShowAdd(!showAdd)}>
          <Plus className="w-3.5 h-3.5" /> Add Requirement
        </Button>
      </div>

      {/* Add form */}
      {showAdd && (
        <Card className="bg-slate-800/60 border-slate-700/50 p-4 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            <div>
              <label className="text-xs text-slate-400 block mb-1">Task Type</label>
              <select value={newForm.task_type} onChange={e => setNewForm({ ...newForm, task_type: e.target.value })} className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm">
                <option value="">All (global)</option>
                {taskTypeOptions.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Outcome</label>
              <select value={newForm.outcome} onChange={e => setNewForm({ ...newForm, outcome: e.target.value })} className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm">
                {OUTCOMES.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Field</label>
              <select value={newForm.field_name} onChange={e => setNewForm({ ...newForm, field_name: e.target.value })} className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm">
                {TASK_FIELDS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Type</label>
              <select value={newForm.requirement_type} onChange={e => setNewForm({ ...newForm, requirement_type: e.target.value as 'required' | 'match' | 'from_status' })} className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm">
                <option value="required">Required (field must be truthy)</option>
                <option value="match">Match (must equal another field)</option>
                <option value="from_status">From Status (task must be in status)</option>
              </select>
            </div>
            {newForm.requirement_type !== 'required' && (
              <div>
                <label className="text-xs text-slate-400 block mb-1">{newForm.requirement_type === 'match' ? 'Match Field' : 'Required Status'}</label>
                <input type="text" value={newForm.match_field} onChange={e => setNewForm({ ...newForm, match_field: e.target.value })} placeholder={newForm.requirement_type === 'match' ? 'e.g. review_commit' : 'e.g. review'} className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm" />
              </div>
            )}
            <div>
              <label className="text-xs text-slate-400 block mb-1">Severity</label>
              <select value={newForm.severity} onChange={e => setNewForm({ ...newForm, severity: e.target.value as 'block' | 'warn' })} className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm">
                <option value="block">Block (prevents transition)</option>
                <option value="warn">Warn (allows with warning)</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Message</label>
              <input type="text" value={newForm.message} onChange={e => setNewForm({ ...newForm, message: e.target.value })} placeholder="Error/warning message" className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm" />
            </div>
            <div className="flex items-end gap-2">
              <Button size="sm" onClick={handleAdd}>Add</Button>
              <Button variant="ghost" size="sm" onClick={() => setShowAdd(false)}><X className="w-3.5 h-3.5" /></Button>
            </div>
          </div>
        </Card>
      )}

      {/* Grouped by outcome */}
      {Object.entries(grouped).map(([outcome, outcomeReqs]) => (
        <Card key={outcome} className="bg-slate-800/60 border-slate-700/50 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-700/50 flex items-center gap-2">
            <span className="text-xs font-mono text-amber-300">{outcome}</span>
            <span className="text-xs text-slate-500">({outcomeReqs.length} check{outcomeReqs.length !== 1 ? 's' : ''})</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-700 text-left">
                  <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase">Scope</th>
                  <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase">Field</th>
                  <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase">Check</th>
                  <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase">Severity</th>
                  <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase">Message</th>
                  <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase text-center">Enabled</th>
                  <th className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {outcomeReqs.map(req => (
                  <tr key={req.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                    <td className="px-3 py-2">
                      {req.task_type ? (
                        <Badge className="bg-amber-900/40 text-amber-300 text-xs">{getTaskTypeLabel(req.task_type)}</Badge>
                      ) : (
                        <span className="text-xs text-slate-500">Global</span>
                      )}
                    </td>
                    <td className="px-3 py-2"><span className="text-xs text-slate-300 font-mono">{req.field_name}</span></td>
                    <td className="px-3 py-2">
                      <Badge className={`${REQ_TYPE_BADGE[req.requirement_type] || 'bg-slate-700'} text-[10px]`}>
                        {req.requirement_type}
                      </Badge>
                      {req.match_field && <span className="text-xs text-slate-500 ml-1">→ {req.match_field}</span>}
                    </td>
                    <td className="px-3 py-2">
                      <Badge className={`${SEVERITY_BADGE[req.severity] || 'bg-slate-700'} text-[10px]`}>
                        {req.severity}
                      </Badge>
                    </td>
                    <td className="px-3 py-2"><span className="text-xs text-slate-400 truncate max-w-48 block">{req.message}</span></td>
                    <td className="px-3 py-2 text-center">
                      <button onClick={() => handleToggle(req)} className={`w-8 h-4 rounded-full transition-colors ${req.enabled ? 'bg-green-600' : 'bg-slate-600'}`}>
                        <div className={`w-3 h-3 rounded-full bg-white transition-transform ${req.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </button>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => handleDelete(req.id)} className="text-red-400 hover:text-red-300 p-1"><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}

      {Object.keys(grouped).length === 0 && (
        <Card className="bg-slate-800/60 border-slate-700/50 p-6 text-center">
          <p className="text-sm text-slate-500">No transition requirements configured.</p>
        </Card>
      )}
    </div>
  );
}

// 'lifecycle-rules' tab removed (task #614) — collapsed into 'transitions'
type RoutingTab = 'rules' | 'config' | 'statuses' | 'transitions' | 'transition-reqs' | 'dispatch-log' | 'agent-contract';

// ─── Main Page ───────────────────────────────────────────────
export default function RoutingPage() {
  const [configs, setConfigs] = useState<RoutingConfig[]>([]);
  const [reconcilerConfig, setReconcilerConfig] = useState<ReconcilerConfig>({ needs_attention_eligible_statuses: [] });
  const [statuses, setStatuses] = useState<TaskStatusMeta[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [selectedSprintId, setSelectedSprintId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNewStatus, setShowNewStatus] = useState(false);
  const [activeTab, setActiveTab] = useState<RoutingTab>('rules');
  const sprintScopedTabs: RoutingTab[] = ['rules', 'statuses', 'transitions', 'transition-reqs'];
  const reloadStatuses = useCallback(() => {
    if (!selectedSprintId) {
      setStatuses([]);
      return Promise.resolve();
    }
    return api.getRoutingStatuses(selectedSprintId)
      .then(s => setStatuses(s.statuses))
      .catch(e => setError(String(e)));
  }, [selectedSprintId]);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.getRoutingConfigs(),
      api.getRoutingReconcilerConfig(),
      api.getProjects(),
      api.getSprints(undefined, true),
    ])
      .then(([c, rc, projectList, sprintList]) => {
        setConfigs(c.configs);
        setReconcilerConfig(rc);
        setProjects(projectList);
        setSprints(sprintList);
        setSelectedProjectId(current => {
          if (current && projectList.some(project => project.id === current)) return current;
          return sprintList.find(sprint => sprint.status !== 'closed')?.project_id
            ?? sprintList[0]?.project_id
            ?? projectList[0]?.id
            ?? null;
        });
        setSelectedSprintId(current => {
          if (current && sprintList.some(sprint => sprint.id === current)) return current;
          return sprintList.find(sprint => sprint.status !== 'closed')?.id ?? sprintList[0]?.id ?? null;
        });
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selectedSprintId || !sprintScopedTabs.includes(activeTab)) {
      if (!sprintScopedTabs.includes(activeTab)) setStatuses([]);
      return;
    }
    void reloadStatuses();
  }, [activeTab, reloadStatuses]);

  useEffect(() => {
    const projectScopedSprints = selectedProjectId
      ? sprints.filter(sprint => sprint.project_id === selectedProjectId)
      : [];
    setSelectedSprintId(current => {
      if (current && projectScopedSprints.some(sprint => sprint.id === current)) return current;
      return projectScopedSprints.find(sprint => sprint.status !== 'closed')?.id ?? projectScopedSprints[0]?.id ?? null;
    });
  }, [selectedProjectId, sprints]);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (error) return (
    <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error}</div>
  );

  const tabs: { id: RoutingTab; label: string; count?: number }[] = [
    { id: 'rules', label: 'Routing Rules' },
    { id: 'config', label: 'Per-Agent Config', count: configs.length },
    { id: 'statuses', label: 'Status Labels', count: sprintScopedTabs.includes(activeTab) ? statuses.length : undefined },
    { id: 'transitions', label: 'Automatic Transitions' },
    { id: 'transition-reqs', label: 'Gate Requirements' },
    { id: 'dispatch-log', label: 'Dispatch Log' },
    { id: 'agent-contract', label: 'Agent Contract' },
  ];
  const filteredSprints = selectedProjectId
    ? sprints.filter(sprint => sprint.project_id === selectedProjectId)
    : [];
  const selectedProject = projects.find(project => project.id === selectedProjectId) ?? null;
  const selectedSprint = sprints.find(sprint => sprint.id === selectedSprintId) ?? null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <GitBranch className="w-5 h-5 text-amber-400" />
          <h1 className="text-2xl font-bold text-white">Task Routing</h1>
        </div>
        <p className="text-slate-400 text-sm">
          Workflow configuration: sprint-scoped task policy for transitions, gate requirements, status labels, and dispatch rules
        </p>
      </div>

      {sprintScopedTabs.includes(activeTab) && (
        <Card className="bg-slate-900/50 border-slate-700/50 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">Sprint Scope</p>
              <p className="mt-1 text-sm text-slate-300">Live task policy is edited per sprint and filtered by project first.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:min-w-[560px]">
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Project</p>
                <div className="relative">
                  <select
                    className="appearance-none w-full bg-slate-800 border border-slate-700 rounded-lg pl-3 pr-8 py-2 text-sm text-slate-200 focus:outline-none focus:border-amber-500"
                    value={selectedProjectId ?? ''}
                    onChange={e => setSelectedProjectId(e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">Select project…</option>
                    {projects.map(project => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                </div>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Sprint</p>
                <div className="relative">
                  <select
                    className="appearance-none w-full bg-slate-800 border border-slate-700 rounded-lg pl-3 pr-8 py-2 text-sm text-slate-200 focus:outline-none focus:border-amber-500 disabled:opacity-60"
                    value={selectedSprintId ?? ''}
                    onChange={e => setSelectedSprintId(e.target.value ? Number(e.target.value) : null)}
                    disabled={filteredSprints.length === 0}
                  >
                    <option value="">{selectedProject ? 'Select sprint…' : 'Select project first…'}</option>
                    {filteredSprints.map(sprint => (
                      <option key={sprint.id} value={sprint.id}>
                        {formatSprintNumber(sprint.id)} · {sprint.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Tabs — scrollable on mobile */}
      <div className="border-b border-slate-700/50 overflow-x-auto scrollbar-none">
        <div className="flex gap-1 min-w-max">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
                activeTab === tab.id
                  ? 'border-amber-400 text-amber-300'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
                  activeTab === tab.id ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-700 text-slate-500'
                }`}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'rules' && (
        <RoutingRulesSection sprintId={selectedSprintId} sprintName={selectedSprint?.name ?? null} />
      )}

      {activeTab === 'config' && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <ReconcilerConfigCard config={reconcilerConfig} statuses={statuses} onSaved={load} />
          {configs.map(config => (
            <JobConfigCard key={config.id} config={config} onSaved={load} />
          ))}
        </div>
      )}

      {activeTab === 'statuses' && (
        <div>
          {!selectedSprintId ? (
            <Card className="bg-slate-900/50 border-slate-700/50 p-6 text-sm text-slate-400">
              Select a sprint to edit status labels and colors.
            </Card>
          ) : (
            <>
          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl px-4 py-3 mb-4 text-sm text-slate-400">
            <strong className="text-slate-300">Display metadata only.</strong> Status labels, colors, and the &ldquo;Allowed Transitions&rdquo; list here are for UI display and user guidance.
            Actual automatic status movement is driven by <button className="text-amber-400 underline" onClick={() => setActiveTab('transitions' as RoutingTab)}>Automatic Transitions</button>.
            The &ldquo;Allowed Transitions&rdquo; field does not gate backend state changes — add an <button className="text-amber-400 underline" onClick={() => setActiveTab('transitions' as RoutingTab)}>Automatic Transition</button> row to actually enforce a path.
          </div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-slate-400 text-sm">{statuses.length} statuses configured</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowNewStatus(true)}
              disabled={showNewStatus || !selectedSprintId}
            >
              <Plus className="w-3.5 h-3.5" /> Add Status
            </Button>
          </div>

          <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-700 text-left">
                    <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Name</th>
                    <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Label</th>
                    <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Color</th>
                    <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider text-center">Terminal</th>
                    <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Allowed Transitions</th>
                    <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {showNewStatus && (
                    <NewStatusForm
                      allStatuses={statuses}
                      sprintId={selectedSprintId ?? 0}
                      onCreated={() => { setShowNewStatus(false); void reloadStatuses(); }}
                      onCancel={() => setShowNewStatus(false)}
                    />
                  )}
                  {statuses.map(status => (
                    <StatusRow
                      key={status.name}
                      status={status}
                      allStatuses={statuses}
                      sprintId={selectedSprintId ?? 0}
                      onSaved={() => { void reloadStatuses(); }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
            </>
          )}
        </div>
      )}

      {activeTab === 'transitions' && (
        <TransitionsSection sprintId={selectedSprintId} sprintName={selectedSprint?.name ?? null} />
      )}

      {activeTab === 'transition-reqs' && (
        <TransitionRequirementsSection sprintId={selectedSprintId} sprintName={selectedSprint?.name ?? null} />
      )}

      {activeTab === 'dispatch-log' && (
        <DispatchLogSection />
      )}

      {activeTab === 'agent-contract' && (
        <AgentContractSection />
      )}
    </div>
  );
}
