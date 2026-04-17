'use client';

import { useEffect, useState, useCallback, useMemo, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { getApiBase, api, type SprintWorkflowTemplate } from '@/lib/api';
import { formatSprintLabel } from '@/lib/sprintLabel';
import { useLiveRefresh } from '@/lib/useLiveRefresh';
import { X, ChevronDown, Search, Plus, Check } from 'lucide-react';
import { TaskDetailPanel } from '@/components/TaskDetailPanel';
import { TaskBoard, TaskBoardSection } from '@/components/TaskBoard';
import { TaskBoardErrorBoundary } from '@/components/TaskBoardErrorBoundary';
import type { BoardTask } from '@/components/TaskBoardComponents';
import { useTaskStatuses } from '@/lib/useTaskStatuses';
import { useTaskTypes } from '@/lib/taskTypes';
import { getSharedWorkflowColumns } from '@/lib/taskBoardWorkflowColumns';

const PAGE_SIZE = 50;
const BACKGROUND_PAGE_SIZE = 200;

interface Project {
  id: number;
  name: string;
}

interface Task extends BoardTask {
  task_type?: string | null;
  routing_reason?: string | null;
  defect_type?: string | null;
}

type Status = string;

interface ModalForm extends Partial<Task> {
  recurring: boolean;
  story_points?: number | null;
}

interface Sprint {
  id: number;
  project_id: number;
  name: string;
  status: string;
}

interface StatusOption {
  key: string;
  label: string;
}

interface TaskTypeOption {
  value: string;
  label: string;
}

interface ModalProps {
  task: Partial<Task>;
  projects: Project[];
  statusOptions: StatusOption[];
  taskTypeOptions: TaskTypeOption[];
  onClose: () => void;
  onSave: (data: Partial<Task> & { recurring: number }) => Promise<void>;
  onDelete?: () => Promise<void>;
}

function TaskModal({ task, projects, statusOptions, taskTypeOptions, onClose, onSave, onDelete }: ModalProps) {
  const [form, setForm] = useState<ModalForm>({ ...task, recurring: !!task.recurring });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const base = getApiBase();

  const set = (k: keyof ModalForm, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => {
    if (form.project_id) {
      fetch(`${base}/api/v1/sprints?project_id=${form.project_id}`)
        .then(r => r.json())
        .then((data: Sprint[]) => setSprints(data))
        .catch(() => setSprints([]));
    } else {
      setSprints([]);
    }
  }, [form.project_id, base]);

  const handleSave = async () => {
    setSaving(true);
    try { await onSave({ ...form, recurring: form.recurring ? 1 : 0 }); } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    setDeleting(true);
    try { await onDelete(); } finally { setDeleting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h2 className="text-white font-semibold text-base">{task.id ? 'Edit Task' : 'New Task'}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Title *</label>
            <input
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400"
              value={form.title ?? ''}
              onChange={e => set('title', e.target.value)}
              placeholder="Task title"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Description</label>
            <textarea
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 resize-none h-24"
              value={form.description ?? ''}
              onChange={e => set('description', e.target.value)}
              placeholder="Optional details..."
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Status</label>
              <div className="relative">
                <select
                  className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                  value={form.status ?? 'todo'}
                  onChange={e => set('status', e.target.value)}
                >
                  {statusOptions.map(s => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Priority</label>
              <div className="relative">
                <select
                  className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                  value={form.priority ?? 'medium'}
                  onChange={e => set('priority', e.target.value as Task['priority'])}
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
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Project</label>
            <div className="relative">
              <select
                className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                value={form.project_id ?? ''}
                onChange={e => {
                  const val = e.target.value ? Number(e.target.value) : null;
                  setForm(f => ({ ...f, project_id: val, sprint_id: null }));
                }}
              >
                <option value="">— No project —</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
            </div>
          </div>

          {form.project_id && sprints.length > 0 && (
            <div>
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Sprint</label>
              <div className="relative">
                <select
                  className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                  value={form.sprint_id ?? ''}
                  onChange={e => set('sprint_id', e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">— No sprint —</option>
                  {sprints.map(s => <option key={s.id} value={s.id}>{formatSprintLabel(s)}</option>)}
                </select>
                <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>
            </div>
          )}

          {/* Story Points — required, 5 canonical options */}
          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
              Story Points <span className="text-red-400">*</span>
            </label>
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
            {!form.story_points && (
              <p className="text-[10px] text-amber-500/80 mt-1">Required — select a size before saving</p>
            )}
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
            <p className="text-[10px] text-slate-600 mt-0.5">Determines which agent handles this task via routing rules</p>
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
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-700">
          <div>
            {onDelete && (
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="text-sm text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">Cancel</button>
            <button
              onClick={handleSave}
              disabled={saving || !form.title?.trim() || !form.story_points}
              className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Multi-Sprint Filter Dropdown ─────────────────────────────────── */
function MultiSprintFilter({
  sprints,
  selectedIds,
  onChange,
}: {
  sprints: Sprint[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (id: number) => {
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter(x => x !== id)
        : [...selectedIds, id]
    );
  };

  const clearAll = () => onChange([]);

  const label =
    selectedIds.length === 0
      ? 'All sprints'
      : selectedIds.length === 1
        ? sprints.find(s => s.id === selectedIds[0])?.name ?? '1 sprint'
        : `${selectedIds.length} sprints`;

  return (
    <div ref={ref} className="relative">
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 w-full bg-slate-800 border border-slate-600 rounded-lg pl-3 pr-2 py-1.5 md:py-2 text-sm text-left focus:outline-none focus:border-amber-400 transition-colors hover:border-slate-500"
      >
        <span className={`flex-1 truncate ${selectedIds.length === 0 ? 'text-slate-400' : 'text-white'}`}>
          {label}
        </span>
        {selectedIds.length > 0 && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); clearAll(); }}
            className="flex-shrink-0 p-0.5 rounded hover:bg-slate-600 text-slate-400 hover:text-white transition-colors"
            aria-label="Clear sprint filter"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        <ChevronDown className={`w-4 h-4 text-slate-400 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[220px] max-h-64 overflow-y-auto bg-slate-800 border border-slate-600 rounded-lg shadow-xl">
          {sprints.length === 0 ? (
            <div className="px-3 py-2 text-sm text-slate-500 italic">No sprints available</div>
          ) : (
            <>
              {/* Clear / select-all header */}
              {selectedIds.length > 0 && (
                <button
                  type="button"
                  onClick={clearAll}
                  className="w-full px-3 py-2 text-xs text-slate-400 hover:text-white hover:bg-slate-700/50 text-left border-b border-slate-700 transition-colors"
                >
                  Clear all ({selectedIds.length} selected)
                </button>
              )}
              {sprints.map(sprint => {
                const selected = selectedIds.includes(sprint.id);
                return (
                  <button
                    key={sprint.id}
                    type="button"
                    onClick={() => toggle(sprint.id)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                      selected
                        ? 'bg-amber-900/30 text-amber-200 hover:bg-amber-900/50'
                        : 'text-slate-300 hover:bg-slate-700/50 hover:text-white'
                    }`}
                  >
                    <span className={`flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center ${
                      selected ? 'bg-amber-500 border-amber-500' : 'border-slate-500'
                    }`}>
                      {selected && <Check className="w-3 h-3 text-black" />}
                    </span>
                    <span className="truncate flex-1">{formatSprintLabel(sprint)}</span>
                    <span className="text-[10px] text-slate-500 flex-shrink-0">{sprint.status}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}

      {/* Selected chips — shown below trigger when multiple selected */}
      {selectedIds.length > 1 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {selectedIds.map(id => {
            const sprint = sprints.find(s => s.id === id);
            if (!sprint) return null;
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-amber-900/40 text-amber-300 border border-amber-700/50 rounded-full"
              >
                <span className="truncate max-w-[120px]">{formatSprintLabel(sprint)}</span>
                <button
                  type="button"
                  onClick={() => toggle(id)}
                  className="hover:text-white transition-colors"
                  aria-label={`Remove ${formatSprintLabel(sprint)}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TasksPageInner() {
  const searchParams = useSearchParams();
  const deepLinkTaskId = searchParams.get('id') ? Number(searchParams.get('id')) : null;
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [selectedProject, setSelectedProject] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [isBackgroundLoading, setIsBackgroundLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [totalTasks, setTotalTasks] = useState(0);
  const [modal, setModal] = useState<{ task: Partial<Task> } | null>(null);
  const [viewTask, setViewTask] = useState<Task | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [defectsOnly, setDefectsOnly] = useState(false);
  const [selectedSprintIds, setSelectedSprintIds] = useState<number[]>([]);
  const [sprintWorkflowMap] = useState<Record<number, SprintWorkflowTemplate | null>>({});
  // Track which sprint IDs have had their tasks fetched via viewport-triggered lazy load
  const loadedSprintIds = useRef<Set<number>>(new Set());
  // Track which sprint IDs are currently loading (for UI placeholder)
  const [loadingSprintIds, setLoadingSprintIds] = useState<Set<number>>(new Set());
  const selectedSingleSprintId = selectedSprintIds.length === 1 ? selectedSprintIds[0] : null;

  // Track how many tasks are currently loaded for live-refresh window sizing
  const loadedCountRef = useRef(PAGE_SIZE);
  const loadRunIdRef = useRef(0);
  const backgroundLoadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    loadedCountRef.current = Math.max(tasks.length, PAGE_SIZE);
  }, [tasks.length]);

  useEffect(() => {
    return () => {
      if (backgroundLoadTimeoutRef.current) clearTimeout(backgroundLoadTimeoutRef.current);
    };
  }, []);

  const { statuses: taskStatusCatalog, definitions: taskStatusDefs } = useTaskStatuses(selectedSingleSprintId);
  const { options: taskTypeOptions } = useTaskTypes();
  const statusOptions = useMemo(
    () => taskStatusDefs.map(d => ({ key: d.key, label: d.label })),
    [taskStatusDefs]
  );

  const base = getApiBase();

  // Deep-link: if ?id=<taskId> is set, fetch and open that task in the detail panel
  useEffect(() => {
    if (!deepLinkTaskId) return;
    fetch(`${base}/api/v1/tasks/${deepLinkTaskId}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then((t: Task) => setViewTask(t))
      .catch(err => console.warn('[tasks] Deep-link task fetch failed:', err));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkTaskId]);

  useEffect(() => {
    fetch(`${base}/api/v1/projects`).then(r => r.json()).then((p: Project[]) => {
      setProjects(p);

      const stored = localStorage.getItem('tasks-project-id');
      const storedId = stored ? Number(stored) : null;
      const validId = storedId && p.find(x => x.id === storedId) ? storedId : null;
      setSelectedProject(validId ?? (p[0]?.id ?? null));
    }).catch(console.error);
  }, [base]);

  // Core loader: fetches the first visible batch quickly; remaining rows hydrate automatically.
  // opts.silent       — no loading spinner (background refresh)
  // opts.refreshCount — how many tasks to fetch for silent refresh (keeps current view fresh)
  const loadTasks = useCallback((opts: {
    silent?: boolean;
    refreshCount?: number;
  } = {}) => {
    const { silent = false, refreshCount } = opts;
    const runId = ++loadRunIdRef.current;

    if (backgroundLoadTimeoutRef.current) {
      clearTimeout(backgroundLoadTimeoutRef.current);
      backgroundLoadTimeoutRef.current = null;
    }

    if (!silent) {
      setLoading(true);
      setIsBackgroundLoading(false);
    }

    const params = new URLSearchParams({
      limit: String(refreshCount ?? PAGE_SIZE),
      offset: '0',
    });
    if (selectedProject) params.set('project_id', String(selectedProject));

    const tasksFetch = fetch(`${base}/api/v1/tasks?${params.toString()}`).then(r => r.json());
    const sprintsFetch = !selectedProject
      ? Promise.resolve(null)
      : fetch(`${base}/api/v1/sprints?project_id=${selectedProject}`).then(r => r.json()).catch(() => []);

    Promise.all([tasksFetch, sprintsFetch])
      .then(([taskData, sprintData]) => {
        if (loadRunIdRef.current !== runId) return;

        const { tasks: newTasks, hasMore: more, total } = taskData as {
          tasks: Task[];
          hasMore: boolean;
          total: number;
        };
        setTasks(newTasks);
        setHasMore(more);
        setTotalTasks(total);
        if (sprintData !== null) {
          setSprints((sprintData as Sprint[]).filter(s => s.status === 'active' || s.status === 'planning'));
        }
      })
      .catch(console.error)
      .finally(() => {
        if (!silent && loadRunIdRef.current === runId) setLoading(false);
      });
  }, [base, selectedProject]);

  useEffect(() => {
    if (loading || !hasMore || isBackgroundLoading) return;

    const runId = loadRunIdRef.current;
    setIsBackgroundLoading(true);

    const params = new URLSearchParams({
      limit: String(BACKGROUND_PAGE_SIZE),
      offset: String(tasks.length),
    });
    if (selectedProject) params.set('project_id', String(selectedProject));

    backgroundLoadTimeoutRef.current = setTimeout(() => {
      backgroundLoadTimeoutRef.current = null;
      fetch(`${base}/api/v1/tasks?${params.toString()}`)
        .then(r => r.json())
        .then((data: { tasks: Task[]; hasMore: boolean; total: number }) => {
          if (loadRunIdRef.current !== runId) return;

          const incoming = data.tasks ?? [];
          setTasks(prev => {
            if (!incoming.length) return prev;
            const seen = new Set(prev.map(task => task.id));
            const deduped = incoming.filter(task => !seen.has(task.id));
            return deduped.length ? [...prev, ...deduped] : prev;
          });
          setHasMore(data.hasMore);
          setTotalTasks(data.total);
        })
        .catch(console.error)
        .finally(() => {
          if (loadRunIdRef.current === runId) setIsBackgroundLoading(false);
        });
    }, 0);
  }, [base, hasMore, isBackgroundLoading, loading, selectedProject, tasks.length]);

  // Per-sprint lazy loader — fires when a sprint section enters the viewport.
  // Fetches all tasks for that sprint and merges them into the task list.
  // Skips sprints already loaded or currently loading.
  const handleSectionVisible = useCallback((sectionKey: string) => {
    if (!sectionKey.startsWith('sprint-')) return;
    const sprintId = Number(sectionKey.replace('sprint-', ''));
    if (!sprintId || loadedSprintIds.current.has(sprintId)) return;
    loadedSprintIds.current.add(sprintId);

    setLoadingSprintIds(prev => new Set([...prev, sprintId]));

    const params = new URLSearchParams({ limit: '200', offset: '0', sprint_id: String(sprintId) });
    if (selectedProject) params.set('project_id', String(selectedProject));

    fetch(`${getApiBase()}/api/v1/tasks?${params.toString()}`)
      .then(r => r.json())
      .then((data: { tasks: Task[] }) => {
        if (data.tasks?.length) {
          setTasks(prev => {
            const existingIds = new Set(prev.map(t => t.id));
            const newTasks = data.tasks.filter(t => !existingIds.has(t.id));
            return newTasks.length > 0 ? [...prev, ...newTasks] : prev;
          });
        }
      })
      .catch(console.error)
      .finally(() => {
        setLoadingSprintIds(prev => {
          const next = new Set(prev);
          next.delete(sprintId);
          return next;
        });
      });
  }, [selectedProject]);

  useEffect(() => {
    // Reset per-sprint lazy load cache on project change so sections re-fetch
    loadedSprintIds.current = new Set();
    setLoadingSprintIds(new Set());
    // Clear sprint filter when project changes (sprints are project-scoped)
    setSelectedSprintIds([]);

    if (selectedProject !== null) {
      localStorage.setItem('tasks-project-id', String(selectedProject));
    } else {
      // Clear sprints when "All Projects" selected (sprints are project-scoped)
      setSprints([]);
    }
    loadTasks();
  }, [selectedProject, loadTasks]);

  // Live polling — silently refresh tasks/sprints every 10s so external changes appear automatically.
  // Refreshes up to the currently-loaded window (loadedCountRef) so paged tasks stay current.
  useLiveRefresh(() => loadTasks({ silent: true, refreshCount: loadedCountRef.current }), {
    enabled: true,
    intervalMs: 10000,
    hiddenIntervalMs: 30000,
  });

  const openNew = (status: Status) => {
    setModal({ task: { status, priority: 'medium', project_id: selectedProject } });
  };

  const shouldShowTask = useCallback((task: Task) => {
    if (selectedProject && task.project_id !== selectedProject) return false;
    return true;
  }, [selectedProject]);

  const upsertTask = useCallback((task: Task) => {
    setTasks(prev => {
      const visible = shouldShowTask(task);
      const existingIndex = prev.findIndex(t => t.id === task.id);

      if (!visible) {
        if (existingIndex === -1) return prev;
        return prev.filter(t => t.id !== task.id);
      }

      if (existingIndex === -1) {
        return [task, ...prev];
      }

      return prev.map(t => (t.id === task.id ? task : t));
    });
  }, [shouldShowTask]);

  const removeTaskFromBoard = useCallback((taskId: number) => {
    setTasks(prev => prev.filter(t => t.id !== taskId));
  }, []);

  const handleSave = async (data: Partial<Task> & { recurring: number }) => {
    if (data.id) {
      const res = await fetch(`${base}/api/v1/tasks/${data.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, changed_by: 'User' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
      const updated = await res.json() as Task;
      upsertTask(updated);
    } else {
      const res = await fetch(`${base}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Create failed (${res.status})`);
      }
      const created = await res.json() as Task;
      upsertTask(created);
    }
    setModal(null);
  };

  const handleDelete = async (id: number) => {
    await fetch(`${base}/api/v1/tasks/${id}?deleted_by=User`, { method: 'DELETE' });
    removeTaskFromBoard(id);
    setModal(null);
  };

  const handlePanelSave = async (data: Partial<Task> & { recurring: number }) => {
    if (!viewTask) return;
    const res = await fetch(`${base}/api/v1/tasks/${viewTask.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, changed_by: 'User' }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Save failed (${res.status})`);
    }
    const updated = await res.json() as Task;
    setViewTask(updated);
    upsertTask(updated);
  };

  const handlePanelDelete = async () => {
    if (!viewTask) return;
    await fetch(`${base}/api/v1/tasks/${viewTask.id}?deleted_by=User`, { method: 'DELETE' });
    removeTaskFromBoard(viewTask.id);
    setViewTask(null);
  };

  const handleAddBlocker = async (taskId: number, blockerId: number) => {
    await fetch(`${base}/api/v1/tasks/${taskId}/blockers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocker_id: blockerId }),
    });
    loadTasks();
  };

  const handleRemoveBlocker = async (taskId: number, blockerId: number) => {
    await fetch(`${base}/api/v1/tasks/${taskId}/blockers/${blockerId}`, { method: 'DELETE' });
    loadTasks();
  };

  const handleCancel = async (taskId: number) => {
    const reason = window.prompt('Pause reason (optional):') ?? undefined;
    if (reason === null) return;
    const result = await api.stopTask(taskId, reason || undefined);
    if (viewTask?.id === taskId) setViewTask(result.task as any);
    loadTasks();
  };

  const handlePause = async (taskId: number, reason?: string) => {
    const result = await api.pauseTask(taskId, reason);
    if (viewTask?.id === taskId) setViewTask(result.task as any);
    loadTasks();
  };

  const handleUnpause = async (taskId: number) => {
    const result = await api.unpauseTask(taskId);
    if (viewTask?.id === taskId) setViewTask(result.task as any);
    loadTasks();
  };

  const handleStatusChange = async (taskId: number, newStatus: string) => {
    const res = await fetch(`${base}/api/v1/tasks/${taskId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus, changed_by: 'User' }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Status update failed (${res.status})`);
    }
    const updated = await res.json() as Task;
    upsertTask(updated);
    setViewTask(prev => (prev?.id === updated.id ? updated : prev));
  };

  const filteredTasks = useMemo(() => {
    const q = searchQuery.trim();
    let result = tasks;
    if (q) {
      const lower = q.toLowerCase();
      const asNum = Number(q);
      const isExactId = Number.isInteger(asNum) && asNum > 0 && String(asNum) === q;
      result = result.filter(t =>
        (isExactId && t.id === asNum) || t.title.toLowerCase().includes(lower)
      );
    }
    // Defects only filter
    if (defectsOnly) {
      result = result.filter(t => t.defect_type != null);
    }
    // Multi-sprint filter (OR logic: tasks from any selected sprint)
    if (selectedSprintIds.length > 0) {
      const idSet = new Set(selectedSprintIds);
      result = result.filter(t => t.sprint_id != null && idSet.has(t.sprint_id));
    }
    return result;
  }, [tasks, searchQuery, defectsOnly, selectedSprintIds]);

  // True when any filter (search query or defects toggle) is active — drives
  // column/sprint auto-collapse in TaskBoard.
  const isFiltered = searchQuery.trim().length > 0 || defectsOnly;

  const workflowColumns = useMemo(
    () => getSharedWorkflowColumns(sprints, selectedSprintIds, sprintWorkflowMap),
    [sprints, selectedSprintIds, sprintWorkflowMap]
  );

  const desktopSections = useMemo<TaskBoardSection[] | undefined>(() => {
    if (sprints.length <= 1) return undefined;

    // When sprint filter is active, only show sections for selected sprints
    const visibleSprints = selectedSprintIds.length > 0
      ? sprints.filter(s => selectedSprintIds.includes(s.id))
      : sprints;

    // Always render a section for every visible sprint — even if its tasks
    // are not yet loaded. Visibility triggers lazy fetch via onSectionVisible/IntersectionObserver.
    // Exception: when a search/filter is active, hide sprint sections with zero matching tasks
    // so the user only sees signal.
    const sprintSections: TaskBoardSection[] = visibleSprints
      .map(sprint => {
        const sprintTasks = filteredTasks.filter(t => t.sprint_id === sprint.id);
        const isLoading = loadingSprintIds.has(sprint.id);
        // hasUnloadedTasks: sprint is active, has no loaded tasks, and hasn't finished lazy loading
        const hasUnloadedTasks = sprintTasks.length === 0 && !isLoading && !loadedSprintIds.current.has(sprint.id);
        return {
          key: `sprint-${sprint.id}`,
          title: `🏃 ${formatSprintLabel(sprint)}`,
          tasks: sprintTasks,
          statusLabel: sprint.status,
          // When search is active and no tasks match, don't claim unloaded tasks exist either —
          // the visible set has already been filtered, so we suppress the section entirely below.
          hasUnloadedTasks: isFiltered ? false : hasUnloadedTasks,
          isLoading: isFiltered ? false : isLoading,
        };
      })
      // When a filter is active, suppress sprint sections that have no matching tasks.
      // When no filter: keep all sprints (including unloaded ones) so lazy loading still fires.
      .filter(s => !isFiltered || s.tasks.length > 0);

    // Only show "No Sprint" when unsprinted tasks actually exist and no sprint filter is active.
    if (selectedSprintIds.length === 0) {
      const unsprinted = filteredTasks.filter(t => !t.sprint_id);
      if (unsprinted.length > 0) {
        sprintSections.push({
          key: 'no-sprint',
          title: 'No Sprint',
          tasks: unsprinted,
          tone: 'muted',
        });
      }
    }

    return sprintSections;
  }, [sprints, filteredTasks, loadingSprintIds, selectedSprintIds, isFiltered]);

  return (
    <div className="flex flex-col bg-slate-950 p-2 md:p-6 overflow-y-auto md:flex-1 md:overflow-hidden md:min-h-0 pb-20 md:pb-6">
      <div className="flex items-center justify-between gap-2 mb-2 md:mb-6 flex-shrink-0">
        <h1 className="text-lg md:text-xl font-bold text-white shrink-0">Tasks
          {!loading && totalTasks > 0 && (
            <span className="ml-2 text-xs text-slate-500 font-normal hidden sm:inline">
              ({tasks.length} of {totalTasks}){isBackgroundLoading ? ' • loading more…' : ''}
            </span>
          )}
        </h1>

        <div className="flex items-center gap-2 flex-1 min-w-0 md:gap-3">
          <div className="relative flex-1 sm:min-w-[200px]">
            <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search…"
              className="w-full bg-slate-800 border border-slate-600 rounded-lg pl-9 pr-8 py-1.5 md:py-2 text-white text-sm focus:outline-none focus:border-amber-400 placeholder-slate-500"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-2 text-slate-400 hover:text-white transition-colors"
                aria-label="Clear search"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          {/* Defects only toggle */}
          <button
            onClick={() => setDefectsOnly(v => !v)}
            title={defectsOnly ? 'Show all tasks' : 'Show defects only'}
            className={`flex-shrink-0 px-2 py-1.5 md:px-3 md:py-2 text-xs rounded-lg border transition-colors font-medium whitespace-nowrap ${
              defectsOnly
                ? 'bg-amber-900/60 border-amber-600 text-amber-300'
                : 'bg-transparent border-slate-600 text-slate-400 hover:border-slate-400 hover:text-slate-300'
            }`}
          >
            Defects
          </button>
          {/* Create Task button */}
          <button
            onClick={() => openNew('todo')}
            className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 md:py-2 text-xs md:text-sm font-semibold bg-amber-500 hover:bg-amber-400 text-black rounded-lg transition-colors whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5 md:w-4 md:h-4" />
            <span className="hidden sm:inline">Create Task</span>
            <span className="sm:hidden">New</span>
          </button>
          <div className="relative min-w-[120px] sm:min-w-[200px] md:min-w-[240px]">
            <select
              className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg pl-3 pr-8 py-1.5 md:py-2 text-white text-sm focus:outline-none focus:border-amber-400"
              value={selectedProject ?? ''}
              onChange={e => setSelectedProject(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">All projects</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
          </div>
        </div>
      </div>

      {/* Sprint multi-select filter — shown when sprints exist */}
      {sprints.length > 0 && (
        <div className="mb-2 md:mb-3 flex-shrink-0">
          <MultiSprintFilter
            sprints={sprints}
            selectedIds={selectedSprintIds}
            onChange={ids => {
              setSelectedSprintIds(ids);
              // Trigger lazy load for newly-selected sprints
              ids.forEach(id => handleSectionVisible(`sprint-${id}`));
            }}
          />
        </div>
      )}

      <div data-tour-target="tasks-board" className="flex min-h-0 flex-1 flex-col">
        <TaskBoardErrorBoundary fallbackTitle="Task board encountered an error">
          {loading ? (
            <div className="flex items-center justify-center flex-1">
              <div className="text-slate-500 text-sm animate-pulse">Loading tasks…</div>
            </div>
          ) : (
            <>
              <TaskBoard
                tasks={filteredTasks}
                storageKey="tasks-visible-cols"
                sprintId={selectedSingleSprintId}
                onTaskClick={task => setViewTask(task as Task)}
                onAddBlocker={handleAddBlocker}
                onRemoveBlocker={handleRemoveBlocker}
                onPause={handlePause}
                onNewTask={openNew}
                onStatusChange={handleStatusChange}
                showSprint
                sections={desktopSections}
                onSectionVisible={handleSectionVisible}
                isFiltered={isFiltered}
              />
              {/* Hint when sprint filter is active and tasks are still loading */}
              {selectedSprintIds.length > 0 && filteredTasks.length === 0 && selectedSprintIds.some(id => loadingSprintIds.has(id)) && (
                <div className="flex-shrink-0 flex items-center justify-center py-4 text-slate-400 text-sm italic text-center px-4 animate-pulse">
                  Loading sprint tasks…
                </div>
              )}
              {isBackgroundLoading && hasMore && (
                <div className="flex-shrink-0 flex items-center justify-center pt-4 text-sm text-slate-400 animate-pulse">
                  Loading remaining tasks…
                </div>
              )}
            </>
          )}
        </TaskBoardErrorBoundary>
      </div>

      {modal && (
        <TaskModal
          task={modal.task}
          projects={projects}
          statusOptions={statusOptions}
          taskTypeOptions={taskTypeOptions}
          onClose={() => setModal(null)}
          onSave={handleSave}
          onDelete={modal.task.id ? () => handleDelete(modal.task.id!) : undefined}
        />
      )}

      {viewTask && (
        <TaskBoardErrorBoundary fallbackTitle="Task detail panel encountered an error">
          <TaskDetailPanel
            task={viewTask as any}
            statuses={taskStatusCatalog}
            onClose={() => setViewTask(null)}
            onSave={handlePanelSave}
            onDelete={handlePanelDelete}
            onCancel={() => handleCancel(viewTask.id)}
            onPause={(reason) => handlePause(viewTask.id, reason)}
            onUnpause={() => handleUnpause(viewTask.id)}
          />
        </TaskBoardErrorBoundary>
      )}
    </div>
  );
}

export default function TasksPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" /></div>}>
      <TasksPageInner />
    </Suspense>
  );
}
