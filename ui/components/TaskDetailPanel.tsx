'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { api, apiFetch, Task, TaskNote, TaskHistory, TaskAttachment, TaskStatusMeta, JobInstance, CustomFieldDefinition, ResolvedTaskFieldSchemaResponse } from '@/lib/api';
import { timeAgo, formatDateTime } from '@/lib/date';
import { X, Pencil, AlertTriangle, ChevronDown, ExternalLink, Paperclip, Download, Upload, StopCircle, Trash2, Activity, Cpu, PauseCircle, PlayCircle, Plus, Search, Shield } from 'lucide-react';
import Link from 'next/link';
import { getTaskStatusMaps } from '@/lib/taskStatuses';
import { getRunLifecycle, getTaskOutcomeLabel, getTaskOutcomeBadgeVariant } from '@/lib/runLifecycle';
import { useTaskTypes } from '@/lib/taskTypes';
import { getFailureActor, getFailureSourceLabel, getFailureSummary, getFailureTone, hadQaPassBeforeFailure, isFailureBlocked } from '@/lib/taskFailure';
import { formatSprintLabel } from '@/lib/sprintLabel';

// ── Story points → model routing ─────────────────────────────────────────────

interface ModelRoutingRule {
  id: number;
  max_points: number;
  provider: string;
  model: string;
  label: string | null;
}

function shortModelName(model: string): string {
  // Convert "anthropic/claude-sonnet-4-6" → "Sonnet" etc.
  const lower = model.toLowerCase();
  if (lower.includes('haiku')) return 'Haiku';
  if (lower.includes('sonnet')) return 'Sonnet';
  if (lower.includes('opus')) return 'Opus';
  if (lower.includes('gpt-4.1-mini')) return 'GPT-4.1 Mini';
  if (lower.includes('gpt-4.1')) return 'GPT-4.1';
  if (lower.includes('gpt-5')) return 'GPT-5';
  if (lower.includes('gemini-flash')) return 'Gemini Flash';
  if (lower.includes('gemini')) return 'Gemini';
  // Fallback: take the model slug after the last slash/dot
  const parts = model.split('/');
  return parts[parts.length - 1] ?? model;
}

function resolveEffectiveModel(storyPoints: number | null | undefined, rules: ModelRoutingRule[]): string | null {
  if (storyPoints == null || rules.length === 0) return null;
  const sorted = [...rules].sort((a, b) => a.max_points - b.max_points);
  const match = sorted.find(r => storyPoints <= r.max_points);
  return match ? match.model : sorted[sorted.length - 1]?.model ?? null;
}

function useModelRoutingRules(): ModelRoutingRule[] {
  const [rules, setRules] = useState<ModelRoutingRule[]>([]);
  useEffect(() => {
    apiFetch<ModelRoutingRule[]>('/api/v1/model-routing')
      .then(setRules)
      .catch(() => {});
  }, []);
  return rules;
}

const PRIORITY_BADGE: Record<string, string> = {
  low: 'bg-slate-700 text-slate-300',
  medium: 'bg-amber-900/60 text-amber-300',
  high: 'bg-red-900/60 text-red-300',
};

const {
  labels: FALLBACK_STATUS_LABELS,
  badges: FALLBACK_STATUS_BADGE,
  dots: FALLBACK_STATUS_DOT,
} = getTaskStatusMaps();

interface ProjOpt { id: number; name: string; }
interface SprintOpt { id: number; name: string; status?: string; }

interface Props {
  task: Task;
  statuses?: TaskStatusMeta[];
  onClose: () => void;
  onSave?: (data: Partial<Task> & { recurring: number }) => Promise<void>;
  onDelete?: () => Promise<void>;
  onCancel?: () => Promise<void>;
  onPause?: (reason?: string) => Promise<void>;
  onUnpause?: () => Promise<void>;
}

type FormState = Task & { recurring: boolean };

// ── Time helper ──────────────────────────────────────────────────────────────



// ── Blockers Section ─────────────────────────────────────────────────────────

interface BlockerSearchResult {
  id: number;
  title: string;
  status: string;
}

function BlockersSection({ taskId, initialBlockers }: { taskId: number; initialBlockers?: Task[] }) {
  const [blockers, setBlockers] = useState<Task[]>(initialBlockers ?? []);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<BlockerSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync with parent task updates
  useEffect(() => {
    setBlockers(initialBlockers ?? []);
  }, [initialBlockers]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
        setQuery('');
        setResults([]);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (searchOpen && inputRef.current) inputRef.current.focus();
  }, [searchOpen]);

  const doSearch = useCallback((q: string) => {
    if (!q.trim()) { setResults([]); return; }
    setSearching(true);
    api.searchTasks(q, taskId)
      .then(rows => {
        const existingIds = new Set(blockers.map(b => b.id));
        setResults(rows.filter(r => !existingIds.has(r.id)));
      })
      .catch(() => setResults([]))
      .finally(() => setSearching(false));
  }, [taskId, blockers]);

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => doSearch(val), 200);
  };

  const handleAdd = async (result: BlockerSearchResult) => {
    setAdding(result.id);
    try {
      await api.addBlocker(taskId, result.id);
      // Optimistically add to local state
      setBlockers(prev => [...prev, { id: result.id, title: result.title, status: result.status } as Task]);
      setSearchOpen(false);
      setQuery('');
      setResults([]);
    } catch { /* ignore */ } finally {
      setAdding(null);
    }
  };

  const handleRemove = async (blockerId: number) => {
    setRemoving(blockerId);
    try {
      await api.removeBlocker(taskId, blockerId);
      setBlockers(prev => prev.filter(b => b.id !== blockerId));
    } catch { /* ignore */ } finally {
      setRemoving(null);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
          Blocked by
        </p>
        <div className="relative" ref={pickerRef}>
          <button
            onClick={() => setSearchOpen(o => !o)}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-amber-400 transition-colors"
            title="Add blocker"
          >
            <Plus className="w-3 h-3" />
            Add
          </button>
          {searchOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-slate-800 border border-slate-600 rounded-lg shadow-xl w-72">
              <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-slate-700">
                <Search className="w-3 h-3 text-slate-500 shrink-0" />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={handleQueryChange}
                  placeholder="Search by #id or title…"
                  className="flex-1 bg-transparent text-xs text-white placeholder-slate-500 focus:outline-none"
                />
                {searching && <span className="text-[10px] text-slate-500">…</span>}
              </div>
              <div className="max-h-52 overflow-y-auto">
                {query.trim() === '' ? (
                  <p className="text-xs text-slate-500 p-3">Type a task number or title to search</p>
                ) : results.length === 0 && !searching ? (
                  <p className="text-xs text-slate-500 p-3">No matching tasks</p>
                ) : (
                  results.map(t => (
                    <button
                      key={t.id}
                      onClick={() => handleAdd(t)}
                      disabled={adding === t.id}
                      className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-700 transition-colors disabled:opacity-50"
                    >
                      {adding === t.id ? (
                        <span className="text-amber-400">Adding…</span>
                      ) : (
                        <div className="flex items-start gap-2">
                          <Shield className="w-3 h-3 text-slate-500 shrink-0 mt-0.5" />
                          <div className="min-w-0 flex-1">
                            <span className="text-slate-400 font-mono">#{t.id}</span>
                            {' '}
                            <span className="break-words">{t.title}</span>
                            <span className="ml-1.5 text-[10px] text-slate-500">({t.status})</span>
                          </div>
                        </div>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {blockers.length === 0 ? (
        <p className="text-xs text-slate-600 italic">No blockers</p>
      ) : (
        <div className="space-y-1.5">
          {blockers.map(b => (
            <div
              key={b.id}
              className={`flex items-center justify-between gap-2 text-xs px-3 py-2 rounded-lg border group ${
                b.status === 'done'
                  ? 'text-slate-500 border-slate-800 bg-slate-800/40'
                  : 'text-slate-300 border-slate-700 bg-slate-800'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className={`font-mono text-slate-500 shrink-0 ${b.status === 'done' ? 'line-through' : ''}`}>#{b.id}</span>
                <span className={`truncate ${b.status === 'done' ? 'line-through' : ''}`}>{b.title}</span>
                <span className="text-[10px] text-slate-500 shrink-0 no-underline" style={{ textDecoration: 'none' }}>({b.status})</span>
              </div>
              <button
                onClick={() => handleRemove(b.id)}
                disabled={removing === b.id}
                className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-red-400 transition-all disabled:opacity-50 shrink-0"
                title="Remove blocker"
              >
                {removing === b.id ? (
                  <span className="text-[10px]">…</span>
                ) : (
                  <X className="w-3 h-3" />
                )}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Notes Section ─────────────────────────────────────────────────────────────

function NotesSection({ taskId }: { taskId: number }) {
  const [notes, setNotes] = useState<TaskNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [author, setAuthor] = useState('Atlas');
  const [submitting, setSubmitting] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);

  const loadNotes = useCallback(async () => {
    try {
      const data = await api.getTaskNotes(taskId);
      setNotes(data);
    } catch { /* ignore */ }
    setLoading(false);
  }, [taskId]);

  useEffect(() => { loadNotes(); }, [loadNotes]);

  const handleSubmit = async () => {
    if (!content.trim()) return;
    setSubmitting(true);
    try {
      await api.createTaskNote(taskId, { author, content: content.trim() });
      setContent('');
      await loadNotes();
    } catch { /* ignore */ }
    setSubmitting(false);
  };

  const handleDelete = async (noteId: number) => {
    try {
      await api.deleteTaskNote(taskId, noteId);
      await loadNotes();
    } catch { /* ignore */ }
  };

  return (
    <div>
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Notes</p>

      {loading ? (
        <p className="text-xs text-slate-500 italic">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="text-xs text-slate-600 italic mb-3">No notes yet.</p>
      ) : (
        <div className="space-y-3 mb-4">
          {notes.map(note => (
            <div
              key={note.id}
              className="bg-slate-800 border border-slate-700 rounded-lg p-3 group relative"
              onMouseEnter={() => setHovered(note.id)}
              onMouseLeave={() => setHovered(null)}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-slate-400 font-medium">
                  {note.author} <span className="text-slate-600">·</span> <span className="text-slate-500">{timeAgo(note.created_at)}</span>
                </span>
                {hovered === note.id && (
                  <button
                    onClick={() => handleDelete(note.id)}
                    className="text-slate-600 hover:text-red-400 transition-colors text-xs"
                    title="Delete note"
                  >
                    ×
                  </button>
                )}
              </div>
              <p className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">{note.content}</p>
            </div>
          ))}
        </div>
      )}

      {/* Add note form */}
      <div className="border border-slate-700 rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-700 bg-slate-800/50">
          <span className="text-xs text-slate-500">Author:</span>
          <input
            className="bg-transparent text-xs text-slate-300 focus:outline-none w-20"
            value={author}
            onChange={e => setAuthor(e.target.value)}
          />
        </div>
        <textarea
          className="w-full bg-slate-800 px-3 py-2 text-sm text-white focus:outline-none resize-none h-16 placeholder-slate-600"
          placeholder="Add a note…"
          value={content}
          onChange={e => setContent(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit();
          }}
        />
        <div className="flex justify-end px-3 py-1.5 bg-slate-800/50 border-t border-slate-700">
          <button
            onClick={handleSubmit}
            disabled={submitting || !content.trim()}
            className="text-xs bg-amber-500 hover:bg-amber-400 text-black font-semibold px-3 py-1 rounded transition-colors disabled:opacity-50"
          >
            {submitting ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Attachments Section ───────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentsSection({ taskId }: { taskId: number }) {
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);

  const loadAttachments = useCallback(async () => {
    try {
      const data = await api.getTaskAttachments(taskId);
      setAttachments(data);
    } catch { /* ignore */ }
    setLoading(false);
  }, [taskId]);

  useEffect(() => { loadAttachments(); }, [loadAttachments]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await api.uploadTaskAttachment(taskId, file, 'Atlas');
      await loadAttachments();
    } catch { /* ignore */ }
    setUploading(false);
    // Reset input so the same file can be re-uploaded
    e.target.value = '';
  };

  const handleDelete = async (attachmentId: number) => {
    try {
      await api.deleteTaskAttachment(taskId, attachmentId);
      await loadAttachments();
    } catch { /* ignore */ }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1.5">
          <Paperclip className="w-3 h-3" />
          Attachments
        </p>
        <label className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 transition-colors cursor-pointer">
          <Upload className="w-3 h-3" />
          {uploading ? 'Uploading…' : 'Upload'}
          <input
            type="file"
            className="hidden"
            onChange={handleUpload}
            disabled={uploading}
          />
        </label>
      </div>

      {loading ? (
        <p className="text-xs text-slate-500 italic">Loading…</p>
      ) : attachments.length === 0 ? (
        <p className="text-xs text-slate-600 italic">No attachments.</p>
      ) : (
        <div className="space-y-2">
          {attachments.map(att => (
            <div
              key={att.id}
              className="flex items-center justify-between bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 group"
              onMouseEnter={() => setHovered(att.id)}
              onMouseLeave={() => setHovered(null)}
            >
              <div className="flex items-center gap-2 min-w-0">
                <a
                  href={api.getTaskAttachmentUrl(taskId, att.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-slate-300 hover:text-amber-300 transition-colors truncate flex items-center gap-1.5"
                  title={att.filename}
                >
                  <Download className="w-3 h-3 shrink-0 text-slate-500" />
                  <span className="truncate">{att.filename}</span>
                </a>
                <span className="text-xs text-slate-600 shrink-0">{formatFileSize(att.size)}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-2">
                <span className="text-xs text-slate-500">{att.uploaded_by}</span>
                {hovered === att.id && (
                  <button
                    onClick={() => handleDelete(att.id)}
                    className="text-slate-600 hover:text-red-400 transition-colors text-xs"
                    title="Delete attachment"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── History Section ───────────────────────────────────────────────────────────

function HistorySection({ taskId }: { taskId: number }) {
  const [history, setHistory] = useState<TaskHistory[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getTaskHistory(taskId)
      .then(setHistory)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [taskId]);

  if (loading) return <p className="text-xs text-slate-500 italic">Loading…</p>;
  if (history.length === 0) return <p className="text-xs text-slate-600 italic">No changes recorded yet.</p>;

  return (
    <div className="space-y-2">
      {history.map(entry => {
        const isStatus = entry.field === 'status';
        const dotColor = isStatus && entry.new_value ? (FALLBACK_STATUS_DOT[entry.new_value] ?? 'bg-slate-400') : 'bg-slate-500';

        return (
          <div key={entry.id} className="flex items-start gap-2.5 text-xs">
            <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
            <div className="flex-1 min-w-0">
              <span className="text-slate-300">
                <span className="text-slate-500">{entry.field}:</span>{' '}
                {entry.old_value != null ? (
                  <><span className="text-slate-400 line-through">{entry.old_value}</span> → </>
                ) : null}
                <span className="text-white">{entry.new_value ?? '—'}</span>
              </span>
              <span className="text-slate-600 ml-2">by {entry.changed_by} · {timeAgo(entry.created_at)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Related Runs Section ──────────────────────────────────────────────────────

const RUN_STATUS_BADGE: Record<string, string> = {
  queued: 'bg-slate-700 text-slate-300',
  dispatched: 'bg-blue-900/60 text-blue-300',
  starting: 'bg-cyan-900/60 text-cyan-300',
  running: 'bg-green-900/60 text-green-300',
  awaiting_outcome: 'bg-amber-900/60 text-amber-200 border border-amber-500/30',
  done: 'bg-emerald-900/60 text-emerald-300',
  failed: 'bg-red-900/60 text-red-300',
};

const OUTCOME_BADGE: Record<string, string> = {
  completed_for_review: 'bg-violet-900/60 text-violet-300',
  qa_pass: 'bg-emerald-900/60 text-emerald-300',
  qa_fail: 'bg-red-900/60 text-red-300',
  blocked: 'bg-orange-900/60 text-orange-300',
  failed: 'bg-red-900/60 text-red-300',
  deployed_live: 'bg-blue-900/60 text-blue-300',
  live_verified: 'bg-green-900/60 text-green-300',
};

function formatRuntimeEndSource(source?: string | null): string {
  if (!source) return 'Unknown';
  return source.replace(/_/g, ' ');
}

function getRuntimeHandoffState(instance: Pick<JobInstance, 'runtime_ended_at' | 'lifecycle_outcome_posted_at'>) {
  if (!instance.runtime_ended_at) return null;
  return instance.lifecycle_outcome_posted_at ? 'posted' : 'missing';
}

function getRuntimeHandoffSummary(instance: Pick<JobInstance, 'runtime_ended_at' | 'runtime_end_source' | 'runtime_end_error' | 'lifecycle_outcome_posted_at'>) {
  const handoffState = getRuntimeHandoffState(instance);
  if (!handoffState) return null;
  if (handoffState === 'missing') {
    return `Runtime ended${instance.runtime_end_source ? ` via ${formatRuntimeEndSource(instance.runtime_end_source)}` : ''} without a lifecycle outcome handoff.`;
  }
  return `Runtime ended${instance.runtime_end_source ? ` via ${formatRuntimeEndSource(instance.runtime_end_source)}` : ''} and posted a lifecycle outcome.`;
}

function RelatedRunsSection({ taskId }: { taskId: number }) {
  const [instances, setInstances] = useState<JobInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    api.getTaskInstances(taskId)
      .then(setInstances)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [taskId]);

  if (loading) return <p className="text-xs text-slate-500 italic">Loading…</p>;
  if (instances.length === 0) return <p className="text-xs text-slate-600 italic">No runs yet.</p>;

  return (
    <div className="space-y-2">
      {instances.map((inst, idx) => {
        const lifecycle = getRunLifecycle(inst);
        const taskOutcome = lifecycle.taskOutcome;
        const isLatest = idx === 0;
        const isExpanded = expanded === inst.id;

        return (
          <div key={inst.id}>
            <div
              className="flex items-center gap-2 py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700/80 cursor-pointer transition-colors"
              onClick={() => setExpanded(isExpanded ? null : inst.id)}
            >
              {/* Latest badge */}
              {isLatest && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-300 font-medium shrink-0">latest</span>
              )}
              {/* Exec status */}
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${RUN_STATUS_BADGE[lifecycle.displayStatus] ?? 'bg-slate-700 text-slate-300'}`}>
                {lifecycle.displayStatus}
              </span>
              {/* Task outcome */}
              {taskOutcome && (
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${OUTCOME_BADGE[taskOutcome] ?? 'bg-slate-700 text-slate-300'}`}>
                  {getTaskOutcomeLabel(taskOutcome)}
                </span>
              )}
              {/* Instance ID + job */}
              <span className="text-xs text-slate-400 flex-1 truncate min-w-0">
                #{inst.id}{inst.agent_name ? ` · ${inst.agent_name}` : ''}
                {inst.agent_name ? <span className="text-slate-500"> · {inst.agent_name}</span> : null}
              </span>
              {/* Dispatched timestamp */}
              <span className="text-xs text-slate-500 shrink-0 hidden sm:block">
                {formatDateTime(inst.dispatched_at ?? inst.created_at)}
              </span>
              {/* Link to chat session for this run */}
              <Link
                href={`/chat?agentId=${inst.agent_id}&instanceId=${inst.id}`}
                onClick={e => e.stopPropagation()}
                className="text-xs text-amber-400 hover:text-amber-300 underline shrink-0"
                title="Open run chat"
              >
                View
              </Link>
              <span className="text-xs text-slate-600 shrink-0">{isExpanded ? '▲' : '▼'}</span>
            </div>

            {/* Expanded detail */}
            {isExpanded && (
              <div className="mt-1 mb-1 mx-2 rounded-lg border border-slate-700 bg-slate-900/60 p-3 space-y-2 text-xs">
                {inst.effective_model && (
                  <div className="flex items-center gap-1.5 pb-1 border-b border-slate-700/50">
                    <Cpu className="w-3 h-3 text-violet-400 shrink-0" />
                    <span className="text-violet-300 font-medium text-xs">{shortModelName(inst.effective_model)}</span>
                    <span className="text-slate-600 text-[10px] font-mono">{inst.effective_model}</span>
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-slate-400">
                  {inst.dispatched_at && <span>Dispatched: <span className="text-slate-200">{formatDateTime(inst.dispatched_at)}</span></span>}
                  {inst.started_at && <span>Started: <span className="text-slate-200">{formatDateTime(inst.started_at)}</span></span>}
                  {inst.completed_at && <span>Completed: <span className="text-slate-200">{formatDateTime(inst.completed_at)}</span></span>}
                  {inst.runtime_ended_at && <span>Runtime ended: <span className="text-slate-200">{formatDateTime(inst.runtime_ended_at)}</span></span>}
                  {inst.runtime_end_source && <span>Terminal source: <span className="text-slate-200">{formatRuntimeEndSource(inst.runtime_end_source)}</span></span>}
                  {typeof inst.runtime_end_success === 'number' && <span>Runtime result: <span className="text-slate-200">{inst.runtime_end_success ? 'success' : 'error'}</span></span>}
                  {inst.lifecycle_outcome_posted_at && <span>Lifecycle outcome posted: <span className="text-slate-200">{formatDateTime(inst.lifecycle_outcome_posted_at)}</span></span>}
                  {inst.current_stage && <span>Stage: <span className="text-slate-200">{inst.current_stage}</span></span>}
                  {inst.branch_name && <span>Branch: <span className="text-slate-200 font-mono">{inst.branch_name}</span></span>}
                  {inst.latest_commit_hash && <span>Commit: <span className="text-slate-200 font-mono">{inst.latest_commit_hash}</span></span>}
                  {typeof inst.changed_files_count === 'number' && <span>Files changed: <span className="text-slate-200">{inst.changed_files_count}</span></span>}
                  {inst.last_agent_heartbeat_at && <span>Heartbeat: <span className="text-slate-200">{timeAgo(inst.last_agent_heartbeat_at)}</span></span>}
                </div>
                {getRuntimeHandoffSummary(inst) && (
                  <div className={`rounded-md border px-2.5 py-2 ${getRuntimeHandoffState(inst) === 'missing' ? 'border-amber-500/30 bg-amber-950/30 text-amber-200' : 'border-emerald-600/30 bg-emerald-950/20 text-emerald-200'}`}>
                    <p className="font-medium">{getRuntimeHandoffSummary(inst)}</p>
                    {inst.runtime_end_error && (
                      <p className="mt-1 text-red-300">Runtime error: {inst.runtime_end_error}</p>
                    )}
                  </div>
                )}
                {inst.artifact_summary && (
                  <p className="text-slate-300 whitespace-pre-wrap">{inst.artifact_summary}</p>
                )}
                {inst.blocker_reason && (
                  <p className="text-orange-300">Blocker: {inst.blocker_reason}</p>
                )}
                {inst.error && (
                  <p className="text-red-400">Error: {inst.error}</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function NeedsAttentionSection({ task }: { task: Task }) {
  const hasRuntimeEnd = Boolean(task.active_instance_runtime_ended_at);
  const missingHandoff = hasRuntimeEnd && !task.active_instance_lifecycle_outcome_posted_at;
  const isNeedsAttention = task.status === 'needs_attention';
  const sectionTitle = isNeedsAttention ? 'Needs Attention' : 'Runtime-end observability';
  const badgeLabel = isNeedsAttention ? 'operator recovery lane' : 'runtime-end signal';
  const summary = isNeedsAttention
    ? (missingHandoff
        ? 'This run ended at the runtime layer, no semantic lifecycle outcome was posted, and the task is currently in Needs Attention for operator recovery.'
        : 'This task is in Needs Attention. Treat it as a recovery/control-plane lane, not a normal QA or implementation failure.')
    : 'This run ended at the runtime layer, and no semantic lifecycle outcome has been posted yet. The task is not currently in Needs Attention.';

  if (!isNeedsAttention && !missingHandoff) return null;

  return (
    <div>
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">{sectionTitle}</p>
      <div className="border border-amber-500/30 bg-amber-950/20 rounded-lg p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs px-2 py-1 rounded-full font-semibold bg-amber-900/60 text-amber-200 border border-amber-500/30">
            {badgeLabel}
          </span>
          {task.previous_status && (
            <span className="text-xs px-2 py-1 rounded-full font-semibold bg-slate-700 text-slate-200">
              from {task.previous_status}
            </span>
          )}
        </div>
        <p className="text-sm text-amber-100">{summary}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {task.active_instance_runtime_ended_at && (
            <div>
              <p className="text-xs text-amber-300/70 uppercase tracking-wide">Runtime ended</p>
              <p className="text-amber-50 mt-0.5">{formatDateTime(task.active_instance_runtime_ended_at)}</p>
            </div>
          )}
          {task.active_instance_runtime_end_source && (
            <div>
              <p className="text-xs text-amber-300/70 uppercase tracking-wide">Terminal source</p>
              <p className="text-amber-50 mt-0.5">{formatRuntimeEndSource(task.active_instance_runtime_end_source)}</p>
            </div>
          )}
          <div>
            <p className="text-xs text-amber-300/70 uppercase tracking-wide">Lifecycle handoff</p>
            <p className="text-amber-50 mt-0.5">{missingHandoff ? 'Missing after runtime end' : (task.active_instance_lifecycle_outcome_posted_at ? 'Posted' : 'Unknown')}</p>
          </div>
          {typeof task.active_instance_runtime_end_success === 'number' && (
            <div>
              <p className="text-xs text-amber-300/70 uppercase tracking-wide">Runtime result</p>
              <p className="text-amber-50 mt-0.5">{task.active_instance_runtime_end_success ? 'success' : 'error'}</p>
            </div>
          )}
        </div>
        {task.active_instance_runtime_end_error && (
          <p className="text-sm text-red-300">Runtime error: {task.active_instance_runtime_end_error}</p>
        )}
      </div>
    </div>
  );
}

function FailureStateSection({ task, history }: { task: Task; history: TaskHistory[] }) {
  const failureSource = getFailureSourceLabel(task);
  if (!failureSource) return null;

  const tone = getFailureTone(task);
  const blockedState = isFailureBlocked(task);
  const actor = getFailureActor(history);
  const summary = getFailureSummary(task);
  const qaPassedEarlier = hadQaPassBeforeFailure(task);

  return (
    <div>
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Failure State</p>
      <div className={`border rounded-lg p-3 space-y-3 ${tone.panel}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-xs px-2 py-1 rounded-full font-semibold ${tone.pill}`}>
            {blockedState ? `${failureSource} blocked` : `${failureSource} failed`}
          </span>
          {qaPassedEarlier && (
            <span className="text-xs px-2 py-1 rounded-full font-semibold bg-emerald-900/60 text-emerald-300 border border-emerald-600/30">
              QA already passed
            </span>
          )}
          {task.previous_status && (
            <span className="text-xs px-2 py-1 rounded-full font-semibold bg-slate-700 text-slate-200">
              from {task.previous_status}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Lane</p>
            <p className="text-slate-200 mt-0.5">{failureSource}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">State</p>
            <p className="text-slate-200 mt-0.5">{blockedState ? 'Blocked, not code-failed' : 'Failed'}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Actor</p>
            <p className="text-slate-200 mt-0.5">{actor ?? task.agent_name ?? 'Unknown'}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Recovery</p>
            <p className="text-slate-200 mt-0.5">{task.failure_recovery?.recoveryStatus ?? 'Manual triage'}</p>
          </div>
        </div>

        {summary && (
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Summary</p>
            <p className={`mt-0.5 text-sm ${tone.text}`}>{summary}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function formatCustomFieldValue(field: CustomFieldDefinition, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  return String(value);
}

function CustomFieldsSection({
  fields,
  values,
}: {
  fields: CustomFieldDefinition[];
  values?: Record<string, unknown> | null;
}) {
  const visibleFields = fields.filter(field => values && values[field.key] !== undefined && values[field.key] !== null && values[field.key] !== '');
  if (visibleFields.length === 0) return null;

  return (
    <div>
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Custom Fields</p>
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 space-y-3">
        {visibleFields.map(field => (
          <div key={field.key}>
            <p className="text-xs text-slate-500 uppercase tracking-wide">{field.label ?? field.key}</p>
            <p className="text-sm text-slate-200 whitespace-pre-wrap mt-0.5">{formatCustomFieldValue(field, values?.[field.key])}</p>
            {field.help_text && <p className="text-[10px] text-slate-500 mt-1">{field.help_text}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReleaseEvidenceSection({ task }: { task: Task }) {
  const warnings = task.integrity_warnings ?? [];
  const rows: Array<{ label: string; value?: string | null }> = [
    { label: 'Review branch', value: task.review_branch },
    { label: 'Review commit', value: task.review_commit },
    { label: 'Review URL', value: task.review_url },
    { label: 'QA verified commit', value: task.qa_verified_commit },
    { label: 'QA tested URL', value: task.qa_tested_url },
    { label: 'Merged commit', value: task.merged_commit },
    { label: 'Deployed commit', value: task.deployed_commit },
    { label: 'Deploy target', value: task.deploy_target },
    { label: 'Deployed at', value: task.deployed_at },
    { label: 'Live verified at', value: task.live_verified_at },
    { label: 'Live verified by', value: task.live_verified_by },
  ];

  const badges = [
    task.status === 'review' ? 'Review build only' : null,
    task.status === 'qa_pass' ? 'QA passed (not live)' : null,
    task.status === 'ready_to_merge' ? 'Ready to merge' : null,
    task.status === 'deployed' ? 'Deployed to live' : null,
    task.status === 'done' && !task.is_legacy_unverified_done ? 'Live verified' : null,
    task.status === 'done' && task.is_legacy_unverified_done ? 'Done (legacy, unverified)' : null,
  ].filter(Boolean) as string[];

  const showWarning = task.status === 'qa_pass' || task.status === 'deployed' || (task.status === 'done' && warnings.length > 0) || warnings.length > 0;

  return (
    <div>
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Release Evidence</p>
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 space-y-3">
        {badges.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {badges.map(badge => (
              <span key={badge} className="text-xs px-2 py-1 rounded-full font-medium bg-slate-700 text-slate-200">
                {badge}
              </span>
            ))}
          </div>
        )}
        {showWarning && warnings.length > 0 && (
          <div className={`rounded-lg border px-3 py-2 text-xs ${task.status === 'done' ? 'border-red-500/40 bg-red-950/30 text-red-200' : 'border-amber-500/30 bg-amber-950/20 text-amber-200'}`}>
            {warnings.map((warning, index) => (
              <p key={`${warning}-${index}`}>{warning}</p>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {rows.map(row => (
            <div key={row.label}>
              <p className="text-xs text-slate-500 uppercase tracking-wide">{row.label}</p>
              <p className="text-slate-200 break-all font-mono text-xs mt-0.5">{row.value || '—'}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────

export function TaskDetailPanel({ task, statuses, onClose, onSave, onDelete, onCancel, onPause, onUnpause }: Props) {
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const { definitions: taskStatuses, labels: STATUS_LABELS, badges: STATUS_BADGE, dots: STATUS_DOT } = getTaskStatusMaps(statuses);
  const modelRoutingRules = useModelRoutingRules();
  const effectiveModel = resolveEffectiveModel(task.story_points, modelRoutingRules);
  const [projects, setProjects] = useState<ProjOpt[]>([]);
  const [sprints, setSprints] = useState<SprintOpt[]>([]);
  const [loadingSprints, setLoadingSprints] = useState(false);
  const [form, setForm] = useState<FormState>({ ...task, recurring: !!task.recurring });
  const { options: taskTypeOptions } = useTaskTypes(form.sprint_id ?? task.sprint_id ?? null);

  // Keep form in sync when the parent pushes a fresh task (e.g. after a successful save)
  useEffect(() => {
    setForm({ ...task, recurring: !!task.recurring });
  }, [task]);

  useEffect(() => {
    let cancelled = false;

    const loadProjectSprints = async () => {
      if (!form.project_id) {
        if (!cancelled) setSprints([]);
        return;
      }

      setLoadingSprints(true);
      try {
        const projectSprints = await api.getSprints(form.project_id, true);
        if (cancelled) return;
        setSprints(projectSprints);
        if (form.sprint_id != null && !projectSprints.some(sprint => sprint.id === form.sprint_id)) {
          setForm(current => current.sprint_id == null ? current : ({ ...current, sprint_id: null, sprint_name: null }));
        }
      } catch {
        if (!cancelled) setSprints([]);
      } finally {
        if (!cancelled) setLoadingSprints(false);
      }
    };

    loadProjectSprints();
    return () => { cancelled = true; };
  }, [form.project_id, form.sprint_id]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<TaskHistory[]>([]);
  const [resolvedFieldSchema, setResolvedFieldSchema] = useState<ResolvedTaskFieldSchemaResponse | null>(task.resolved_custom_field_schema
    ? {
        sprint_type: task.resolved_sprint_type ?? 'generic',
        allowed_task_types: [],
        fields: task.resolved_custom_field_schema.fields ?? [],
      }
    : null);

  const isBlocked = (task.blockers ?? []).some(b => b.status !== 'done');

  useEffect(() => {
    api.getTaskHistory(task.id).then(setHistoryEntries).catch(() => {});
  }, [task.id]);

  useEffect(() => {
    let cancelled = false;

    api.resolveTaskFieldSchema({ sprint_id: form.sprint_id ?? null, task_type: form.task_type ?? null })
      .then(schema => {
        if (!cancelled) setResolvedFieldSchema(schema);
      })
      .catch(() => {
        if (!cancelled) setResolvedFieldSchema(null);
      });

    return () => {
      cancelled = true;
    };
  }, [form.sprint_id, form.task_type]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const switchToEdit = async () => {
    if (projects.length === 0) {
      setLoadingEdit(true);
      try {
        const p = await api.getProjects();
        setProjects(p);
      } catch { /* ignore */ }
      setLoadingEdit(false);
    }
    setMode('edit');
  };

  const handleSave = async () => {
    if (!onSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({ ...form, recurring: form.recurring ? 1 : 0 });
      // On success, switch back to view mode. The parent has already updated viewTask.
      setMode('view');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteRequest = () => {
    setDeleteConfirm(true);
  };

  const handleDeleteConfirm = async () => {
    if (!onDelete) return;
    setDeleting(true);
    setDeleteConfirm(false);
    try { await onDelete(); } finally { setDeleting(false); }
  };

  const handleDeleteCancel = () => {
    setDeleteConfirm(false);
  };

  const handleCancel = async () => {
    if (!onCancel) return;
    if (!window.confirm('Stop the current run and pause this task? Its workflow status will stay the same.')) return;
    setCancelling(true);
    try { await onCancel(); } finally { setCancelling(false); }
  };

  const handlePause = async () => {
    if (!onPause) return;
    const reason = window.prompt('Pause reason (optional):') ?? undefined;
    if (reason === null) return; // user cancelled the prompt
    setPausing(true);
    try { await onPause(reason || undefined); } finally { setPausing(false); }
  };

  const handleUnpause = async () => {
    if (!onUnpause) return;
    setPausing(true);
    try { await onUnpause(); } finally { setPausing(false); }
  };

  const set = (k: keyof FormState, v: unknown) =>
    setForm(f => ({ ...f, [k]: v }));

  // Extract branch name from URL for display
  const branchName = task.branch_url
    ? task.branch_url.replace(/.*\/tree\//, '')
    : null;
  const observedBranch = task.branch_name ?? branchName;
  const activeRunLifecycle = task.active_instance_id ? getRunLifecycle({
    status: task.active_instance_status ?? 'queued',
    created_at: task.active_instance_created_at,
    dispatched_at: task.active_instance_dispatched_at,
    started_at: task.active_instance_started_at,
    completed_at: task.active_instance_completed_at,
    runtime_ended_at: task.active_instance_runtime_ended_at,
    lifecycle_outcome_posted_at: task.active_instance_lifecycle_outcome_posted_at,
    task_outcome: task.active_instance_task_outcome,
    artifact_outcome: task.latest_run_outcome,
  }) : null;
  const activeRunStatus = activeRunLifecycle?.displayStatus ?? null;

  return (
    <>
      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={handleDeleteCancel} />
          <div className="relative z-10 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-sm p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-900/40 border border-red-500/30 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-white font-semibold text-base">Delete task?</h3>
                <p className="text-slate-400 text-xs mt-0.5">This cannot be undone.</p>
              </div>
            </div>
            <p className="text-sm text-slate-300 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 mb-5 font-medium truncate">
              #{task.id} · {task.title}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={handleDeleteCancel}
                className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white font-semibold rounded-lg transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Slide-over panel — full screen on mobile, side panel on desktop */}
      <div className="fixed inset-0 md:inset-auto md:right-0 md:top-0 md:bottom-0 z-50 w-full md:max-w-[520px] bg-slate-900 md:border-l border-slate-700 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-slate-500 text-sm font-mono shrink-0">#{task.id}</span>
            <h2 className="text-white font-semibold text-base truncate">
              {mode === 'view' ? task.title : 'Edit Task'}
            </h2>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 ml-2">
            {mode === 'view' && task.active_instance_id && onCancel && !['done', 'cancelled', 'failed'].includes(task.status) && (
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 transition-colors border border-red-500/30 hover:border-red-400/50 rounded px-2 sm:px-2.5 py-1.5 disabled:opacity-50"
                title="Stop the current run and pause this task"
              >
                <StopCircle className="w-3 h-3 shrink-0" />
                <span className="hidden sm:inline">{cancelling ? 'Stopping…' : 'Stop'}</span>
              </button>
            )}
            {mode === 'view' && !task.paused_at && onPause && !['done', 'cancelled', 'failed'].includes(task.status) && (
              <button
                onClick={handlePause}
                disabled={pausing}
                className="flex items-center gap-1.5 text-xs text-yellow-400 hover:text-yellow-300 transition-colors border border-yellow-500/30 hover:border-yellow-400/50 rounded px-2 sm:px-2.5 py-1.5 disabled:opacity-50"
                title="Pause this task — excludes it from routing and dispatch"
              >
                <PauseCircle className="w-3 h-3 shrink-0" />
                <span className="hidden sm:inline">{pausing ? 'Pausing…' : 'Pause'}</span>
              </button>
            )}
            {mode === 'view' && task.paused_at && onUnpause && (
              <button
                onClick={handleUnpause}
                disabled={pausing}
                className="flex items-center gap-1.5 text-xs text-green-400 hover:text-green-300 transition-colors border border-green-500/30 hover:border-green-400/50 rounded px-2 sm:px-2.5 py-1.5 disabled:opacity-50"
                title="Unpause — restore routing and dispatch eligibility"
              >
                <PlayCircle className="w-3 h-3 shrink-0" />
                <span className="hidden sm:inline">{pausing ? 'Unpausing…' : 'Unpause'}</span>
              </button>
            )}
            {mode === 'view' && onSave && (
              <button
                onClick={switchToEdit}
                disabled={loadingEdit}
                className="flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300 transition-colors border border-amber-500/30 hover:border-amber-400/50 rounded px-2 sm:px-2.5 py-1.5 disabled:opacity-50"
                title="Edit task"
              >
                <Pencil className="w-3 h-3 shrink-0" />
                <span className="hidden sm:inline">{loadingEdit ? 'Loading…' : 'Edit'}</span>
              </button>
            )}
            {mode === 'view' && onDelete && (
              <button
                onClick={handleDeleteRequest}
                disabled={deleting}
                className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-red-400 transition-colors border border-slate-700 hover:border-red-500/40 rounded px-2 sm:px-2.5 py-1.5 disabled:opacity-50"
                title="Delete this task"
              >
                <Trash2 className="w-3 h-3 shrink-0" />
                <span className="hidden sm:inline">{deleting ? 'Deleting…' : 'Delete'}</span>
              </button>
            )}
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-white transition-colors p-1"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 pb-20 md:pb-5">
          {mode === 'view' ? (
            <div className="space-y-5">
              {/* Title */}
              <div className="flex items-start gap-2">
                {isBlocked && (
                  <AlertTriangle className="w-4 h-4 text-orange-400 shrink-0 mt-1" />
                )}
                <h3 className="text-lg font-bold text-white leading-snug">
                  {task.title}
                  {task.recurring ? (
                    <span className="ml-2 text-sm text-slate-400" title="Recurring">🔁</span>
                  ) : null}
                </h3>
              </div>

              {/* Status + Priority badges */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${STATUS_BADGE[task.status]}`}>
                  {STATUS_LABELS[task.status] ?? task.status}
                </span>
                <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${PRIORITY_BADGE[task.priority]}`}>
                  {task.priority} priority
                </span>
                {typeof task.story_points === 'number' && (
                  <span className="text-xs px-2.5 py-1 rounded-full font-medium bg-cyan-900/60 text-cyan-300">
                    {task.story_points} pts
                  </span>
                )}
                {effectiveModel && (
                  <span
                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium bg-violet-900/50 text-violet-300 border border-violet-700/40"
                    title={`Effective model: ${effectiveModel}`}
                  >
                    <Cpu className="w-3 h-3 shrink-0" />
                    {shortModelName(effectiveModel)}
                  </span>
                )}
                {isBlocked && (
                  <span className="text-xs px-2.5 py-1 rounded-full font-medium bg-orange-900/60 text-orange-300">
                    blocked
                  </span>
                )}
                {task.paused_at && (
                  <span
                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium bg-yellow-900/60 text-yellow-300 border border-yellow-600/40"
                    title={task.pause_reason ? `Paused: ${task.pause_reason}` : 'Task is paused — excluded from routing and dispatch'}
                  >
                    <PauseCircle className="w-3 h-3 shrink-0" />
                    paused
                  </span>
                )}
              </div>

              {/* Sprint */}
              {task.sprint_name && task.sprint_id && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500 uppercase tracking-wide w-20 shrink-0">Sprint</span>
                  <Link
                    href={`/sprints/${task.sprint_id}`}
                    onClick={onClose}
                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-violet-900/50 text-violet-300 hover:bg-violet-800/60 hover:text-violet-200 transition-colors"
                  >
                    🏃 {formatSprintLabel({ id: task.sprint_id, name: task.sprint_name })}
                  </Link>
                </div>
              )}

              {typeof task.story_points === 'number' && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500 uppercase tracking-wide w-20 shrink-0">Points</span>
                  <span className="text-sm text-cyan-300 font-semibold">{task.story_points} story points</span>
                </div>
              )}

              {/* Paused banner */}
              {task.paused_at && (
                <div className="flex items-start gap-2 bg-yellow-900/20 border border-yellow-600/30 rounded-lg px-3 py-2.5">
                  <PauseCircle className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-yellow-300">Task paused</p>
                    {task.pause_reason && (
                      <p className="text-xs text-yellow-400/80 mt-0.5">{task.pause_reason}</p>
                    )}
                    <p className="text-xs text-yellow-500/70 mt-0.5">Excluded from routing and agent dispatch until unpaused.</p>
                  </div>
                </div>
              )}

              {/* Agent */}
              {task.agent_name && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500 uppercase tracking-wide w-20 shrink-0">Agent</span>
                  {task.agent_id ? (
                    <Link
                      href={`/agents/${task.agent_id}`}
                      onClick={onClose}
                      className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-emerald-900/50 text-emerald-300 hover:bg-emerald-800/60 hover:text-emerald-200 transition-colors"
                    >
                      {task.agent_name}
                    </Link>
                  ) : (
                    <span className="text-sm text-slate-300">{task.agent_name}</span>
                  )}
                </div>
              )}

              {/* Task Type */}
              {task.task_type && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500 uppercase tracking-wide w-20 shrink-0">Type</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300 font-mono">
                    {task.task_type}
                  </span>
                </div>
              )}

              {/* Defect badge */}
              {task.defect_type && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500 uppercase tracking-wide w-20 shrink-0">Defect</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-amber-900/60 text-amber-300 font-semibold">
                    {task.defect_type.replace(/_/g, ' ')}
                  </span>
                </div>
              )}

              {/* Origin task link */}
              {task.origin_task_id && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500 uppercase tracking-wide w-20 shrink-0">Origin</span>
                  <Link
                    href={`/tasks?task=${task.origin_task_id}`}
                    onClick={onClose}
                    className="text-xs text-amber-400 hover:text-amber-300 transition-colors"
                    title={task.origin_task_title ? `Defect from #${task.origin_task_id} — ${task.origin_task_title}` : `Origin task #${task.origin_task_id}`}
                  >
                    Defect from #{task.origin_task_id}
                    {task.origin_task_title && (
                      <span className="text-slate-400 ml-1">— {task.origin_task_title.length > 60 ? task.origin_task_title.slice(0, 60) + '…' : task.origin_task_title}</span>
                    )}
                  </Link>
                </div>
              )}

              {/* Spawned defects indicator */}
              {(task.spawned_defects ?? 0) > 0 && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500 uppercase tracking-wide w-20 shrink-0">Defects</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-red-900/40 text-red-400 font-semibold">
                    {task.spawned_defects} defect{task.spawned_defects === 1 ? '' : 's'} spawned
                  </span>
                </div>
              )}

              {/* Agent */}
              {task.agent_name && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500 uppercase tracking-wide w-20 shrink-0">Agent</span>
                  {task.agent_id ? (
                    <Link
                      href={`/agents/${task.agent_id}`}
                      onClick={onClose}
                      className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-amber-900/50 text-amber-300 hover:bg-amber-800/60 hover:text-amber-200 transition-colors"
                    >
                      {task.agent_name}
                    </Link>
                  ) : (
                    <span className="text-sm text-amber-400">{task.agent_name}</span>
                  )}
                </div>
              )}

              {/* Branch URL */}
              {task.branch_url && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500 uppercase tracking-wide w-20 shrink-0">Branch</span>
                  <a
                    href={task.branch_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                  >
                    <span className="font-mono">{branchName}</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              )}

              {/* Run Observability */}
              {(task.active_instance_id || task.latest_artifact_summary || task.last_agent_heartbeat_at || task.run_is_stale) && (
                <div>
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                    Run Observability
                  </p>
                  <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 space-y-2 text-sm">
                    <div className="flex items-center gap-2 flex-wrap">
                      {task.active_instance_id && (
                        <span className="text-xs text-slate-400 font-mono">instance #{task.active_instance_id}</span>
                      )}
                      {activeRunStatus && (
                        <span className={`text-xs px-2 py-1 rounded-full font-medium ${RUN_STATUS_BADGE[activeRunStatus] ?? 'bg-slate-700 text-slate-300'}`}>
                          {activeRunStatus === 'awaiting_outcome' ? 'Awaiting Outcome' : activeRunStatus}
                        </span>
                      )}
                      {task.run_is_stale ? (
                        <span className="text-xs px-2 py-1 rounded-full font-medium bg-red-900/60 text-orange-300">
                          stale run
                        </span>
                      ) : null}
                      {task.active_instance_runtime_ended_at && (
                        <span className={`text-xs px-2 py-1 rounded-full font-medium ${task.active_instance_lifecycle_outcome_posted_at ? 'bg-emerald-900/60 text-emerald-300' : 'bg-amber-900/60 text-amber-200 border border-amber-500/30'}`}>
                          {task.active_instance_lifecycle_outcome_posted_at ? 'runtime ended' : 'ended without handoff'}
                        </span>
                      )}
                      {task.latest_run_stage ? (
                        <span className="text-xs px-2 py-1 rounded-full font-medium bg-slate-700 text-slate-300">
                          {task.latest_run_stage}
                        </span>
                      ) : null}
                    </div>
                    {task.latest_artifact_summary && (
                      <p className="text-slate-200 whitespace-pre-wrap">{task.latest_artifact_summary}</p>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-slate-400">
                      {task.last_agent_heartbeat_at && <div>Last heartbeat: <span className="text-slate-200">{timeAgo(task.last_agent_heartbeat_at)}</span></div>}
                      {task.last_meaningful_output_at && <div>Last output: <span className="text-slate-200">{timeAgo(task.last_meaningful_output_at)}</span></div>}
                      {task.active_instance_runtime_ended_at && <div>Runtime ended: <span className="text-slate-200">{formatDateTime(task.active_instance_runtime_ended_at)}</span></div>}
                      {task.active_instance_runtime_end_source && <div>Terminal source: <span className="text-slate-200">{formatRuntimeEndSource(task.active_instance_runtime_end_source)}</span></div>}
                      {task.active_instance_lifecycle_outcome_posted_at && <div>Lifecycle outcome posted: <span className="text-slate-200">{formatDateTime(task.active_instance_lifecycle_outcome_posted_at)}</span></div>}
                      {observedBranch && <div>Branch: <span className="text-slate-200 font-mono">{observedBranch}</span></div>}
                      {task.latest_commit_hash && <div>Commit: <span className="text-slate-200 font-mono">{task.latest_commit_hash}</span></div>}
                      {typeof task.changed_files_count === 'number' && <div>Changed files: <span className="text-slate-200">{task.changed_files_count}</span></div>}
                      {task.latest_run_outcome && <div>Outcome: <span className="text-slate-200">{task.latest_run_outcome}</span></div>}
                    </div>
                    {!task.active_instance_lifecycle_outcome_posted_at && task.active_instance_runtime_ended_at && (
                      <div className="text-xs text-amber-200 border border-amber-500/30 bg-amber-950/20 rounded-md px-2.5 py-2">
                        Runtime ended{task.active_instance_runtime_end_source ? ` via ${formatRuntimeEndSource(task.active_instance_runtime_end_source)}` : ''} without a lifecycle outcome handoff. This is recovery/observability state, not a normal QA or release failure.
                      </div>
                    )}
                    {task.blocker_reason && (
                      <div className="text-xs text-orange-300">Blocker: {task.blocker_reason}</div>
                    )}
                    {(task.changed_files?.length ?? 0) > 0 && (
                      <div>
                        <p className="text-xs text-slate-500 mb-1">Files</p>
                        <p className="text-xs text-slate-300 font-mono break-all">{task.changed_files?.join(', ')}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <NeedsAttentionSection task={task} />

              <FailureStateSection task={task} history={historyEntries} />

              <ReleaseEvidenceSection task={task} />

              {/* Related Runs */}
              <div>
                <div className="flex items-center gap-1.5 mb-3">
                  <Activity className="w-3.5 h-3.5 text-slate-400" />
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Agent Runs</p>
                </div>
                <RelatedRunsSection taskId={task.id} />
              </div>

              <CustomFieldsSection
                fields={resolvedFieldSchema?.fields ?? task.resolved_custom_field_schema?.fields ?? []}
                values={form.custom_fields ?? task.custom_fields}
              />

              {/* Description */}
              {task.description ? (
                <div>
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                    Description
                  </p>
                  <p className="text-sm text-slate-300 whitespace-pre-wrap bg-slate-800 border border-slate-700 rounded-lg p-3 leading-relaxed">
                    {task.description}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-slate-600 italic">No description</p>
              )}

              {/* Blockers */}
              <BlockersSection taskId={task.id} initialBlockers={task.blockers} />

              {/* Divider */}
              <div className="border-t border-slate-800" />

              {/* Attachments Section */}
              <AttachmentsSection taskId={task.id} />

              {/* Divider */}
              <div className="border-t border-slate-800" />

              {/* Notes Section */}
              <NotesSection taskId={task.id} />

              {/* Divider */}
              <div className="border-t border-slate-800" />

              {/* History Section */}
              <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">History</p>
                <HistorySection taskId={task.id} />
              </div>
            </div>
          ) : (
            /* Edit mode */
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
                  Title *
                </label>
                <input
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400"
                  value={form.title ?? ''}
                  onChange={e => set('title', e.target.value)}
                  placeholder="Task title"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
                  Description
                </label>
                <textarea
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 resize-none h-24"
                  value={form.description ?? ''}
                  onChange={e => set('description', e.target.value)}
                  placeholder="Optional details…"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Task Type</label>
                <div className="relative">
                  <select
                    className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                    value={form.task_type ?? ''}
                    onChange={e => set('task_type', e.target.value || null)}
                  >
                    <option value="">— None —</option>
                    {taskTypeOptions.map(taskType => (
                      <option key={taskType.value} value={taskType.value}>{taskType.label}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
                </div>
              </div>

              {(resolvedFieldSchema?.fields?.length ?? 0) > 0 && (
                <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
                  <div>
                    <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">Sprint Custom Fields</p>
                    <p className="text-[10px] text-slate-500 mt-1">Driven by sprint type {resolvedFieldSchema?.sprint_type ?? task.resolved_sprint_type ?? 'generic'}.</p>
                  </div>
                  {resolvedFieldSchema?.fields.map(field => {
                    const value = (form.custom_fields ?? {})[field.key];
                    const baseClass = 'w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400';
                    return (
                      <div key={field.key}>
                        <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
                          {field.label ?? field.key}{field.required ? ' *' : ''}
                        </label>
                        {field.type === 'textarea' ? (
                          <textarea
                            className={`${baseClass} resize-none h-24`}
                            value={typeof value === 'string' ? value : ''}
                            onChange={e => set('custom_fields', { ...(form.custom_fields ?? {}), [field.key]: e.target.value })}
                          />
                        ) : field.type === 'select' ? (
                          <select
                            className={baseClass}
                            value={typeof value === 'string' ? value : ''}
                            onChange={e => set('custom_fields', { ...(form.custom_fields ?? {}), [field.key]: e.target.value || '' })}
                          >
                            <option value="">— Select —</option>
                            {(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
                          </select>
                        ) : field.type === 'checkbox' ? (
                          <label className="inline-flex items-center gap-2 text-sm text-slate-200">
                            <input
                              type="checkbox"
                              checked={Boolean(value)}
                              onChange={e => set('custom_fields', { ...(form.custom_fields ?? {}), [field.key]: e.target.checked })}
                            />
                            Enabled
                          </label>
                        ) : field.type === 'number' ? (
                          <input
                            type="number"
                            className={baseClass}
                            value={typeof value === 'number' ? value : ''}
                            onChange={e => set('custom_fields', { ...(form.custom_fields ?? {}), [field.key]: e.target.value === '' ? '' : Number(e.target.value) })}
                          />
                        ) : (
                          <input
                            type={field.type === 'url' ? 'url' : 'text'}
                            className={baseClass}
                            value={typeof value === 'string' ? value : ''}
                            onChange={e => set('custom_fields', { ...(form.custom_fields ?? {}), [field.key]: e.target.value })}
                          />
                        )}
                        {field.help_text && <p className="text-[10px] text-slate-500 mt-1">{field.help_text}</p>}
                      </div>
                    );
                  })}
                </div>
              )}

              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Story Points</label>
                <div className="grid grid-cols-5 gap-1.5">
                  {([
                    { value: 1, label: 'Trivial' },
                    { value: 2, label: 'Small' },
                    { value: 3, label: 'Medium' },
                    { value: 5, label: 'Large' },
                    { value: 8, label: 'Epic' },
                  ] as const).map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => set('story_points', value)}
                      className={`flex flex-col items-center justify-center py-2 px-1 rounded-lg border text-xs font-semibold transition-all
                        ${form.story_points === value
                          ? 'border-cyan-400 bg-cyan-900/40 text-cyan-300'
                          : 'border-slate-600 bg-slate-800 text-slate-400 hover:border-slate-500 hover:text-slate-200'
                        }`}
                    >
                      <span className="text-base leading-tight">{value}</span>
                      <span className="text-[9px] leading-tight mt-0.5 font-normal">{label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">                <div>
                  <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
                    Status
                  </label>
                  <div className="relative">
                    <select
                      className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                      value={form.status ?? 'todo'}
                      onChange={e => set('status', e.target.value)}
                    >
                      {taskStatuses.map(status => (
                        <option key={status.key} value={status.key}>{status.label}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
                    Priority
                  </label>
                  <div className="relative">
                    <select
                      className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                      value={form.priority ?? 'medium'}
                      onChange={e => set('priority', e.target.value)}
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                    <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
                  </div>
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
                  Project
                </label>
                <div className="relative">
                  <select
                    className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                    value={form.project_id ?? ''}
                    onChange={e => {
                      const nextProjectId = e.target.value ? Number(e.target.value) : null;
                      setForm(current => ({
                        ...current,
                        project_id: nextProjectId,
                        sprint_id: current.project_id === nextProjectId ? current.sprint_id : null,
                        sprint_name: current.project_id === nextProjectId ? current.sprint_name : null,
                      }));
                    }}
                  >
                    <option value="">— No project —</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
                  Sprint
                </label>
                <div className="relative">
                  <select
                    className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8 disabled:opacity-60"
                    value={form.sprint_id ?? ''}
                    onChange={e => setForm(current => ({
                      ...current,
                      sprint_id: e.target.value ? Number(e.target.value) : null,
                      sprint_name: e.target.value ? (sprints.find(sprint => sprint.id === Number(e.target.value))?.name ?? current.sprint_name ?? null) : null,
                    }))}
                    disabled={!form.project_id || loadingSprints}
                  >
                    <option value="">{form.project_id ? '— No sprint —' : 'Select a project first'}</option>
                    {sprints.map(sprint => (
                      <option key={sprint.id} value={sprint.id}>
                        {formatSprintLabel(sprint)}{sprint.status ? ` (${sprint.status})` : ''}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
                </div>
                <p className="text-[10px] text-slate-600 mt-0.5">
                  {loadingSprints ? 'Loading sprints…' : form.project_id ? 'Choose a sprint for this project or leave it unassigned' : 'Assign a project before choosing a sprint'}
                </p>
              </div>

              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
                  Agent Assignment
                </label>
                <p className="text-sm text-slate-500 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
                  {form.agent_name ?? 'Auto — resolved by routing rules at dispatch time'}
                </p>
                <p className="text-[10px] text-slate-600 mt-0.5">Set task_type instead — the dispatcher resolves the correct agent</p>
              </div>

              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
                  Branch URL
                </label>
                <input
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 font-mono"
                  value={form.branch_url ?? ''}
                  onChange={e => set('branch_url', e.target.value || null)}
                  placeholder="https://github.com/org/repo/tree/branch-name"
                />
              </div>

              <div className="flex items-center justify-between p-3 bg-slate-700/50 border border-slate-600 rounded-lg">
                <div>
                  <p className="text-sm text-white font-medium">Recurring</p>
                  <p className="text-xs text-slate-400">Resets to To Do on each new agent run</p>
                </div>
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, recurring: !f.recurring }))}
                  className={`relative w-10 h-5 rounded-full transition-colors ${form.recurring ? 'bg-amber-500' : 'bg-slate-600'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${form.recurring ? 'left-5' : 'left-0.5'}`} />
                </button>
              </div>

              {/* Blockers — editable in edit mode too */}
              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-2">
                  Blockers
                </label>
                <BlockersSection taskId={task.id} initialBlockers={task.blockers} />
              </div>
            </div>
          )}
        </div>

        {/* Footer — only in edit mode */}
        {mode === 'edit' && (
          <div className="flex flex-col gap-2 px-6 py-4 border-t border-slate-700 shrink-0">
            {saveError && (
              <p className="text-xs text-red-400 bg-red-950/30 border border-red-500/30 rounded px-3 py-2">
                {saveError}
              </p>
            )}
            <div className="flex items-center justify-between">
              <div>
                {onDelete && (
                  <button
                    onClick={handleDeleteRequest}
                    disabled={deleting}
                    className="text-sm text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
                  >
                    {deleting ? 'Deleting…' : 'Delete'}
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => { setMode('view'); setSaveError(null); }}
                  className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || !form.title?.trim()}
                  className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
