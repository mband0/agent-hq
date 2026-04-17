'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, X, Shield, AlertTriangle, GripVertical, PauseCircle, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { getFailureSourceLabel, getFailureTone, isFailureBlocked } from '@/lib/taskFailure';
import { formatSprintLabel } from '@/lib/sprintLabel';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BoardTask {
  id: number;
  title: string;
  description: string;
  status: string;
  priority: 'low' | 'medium' | 'high';
  agent_id?: number | null;
  project_id: number | null;
  sprint_id?: number | null;
  sprint_name?: string | null;
  agent_name?: string;
  recurring?: number | boolean;
  story_points?: number | null;
  task_type?: string | null;
  active_instance_id?: number | null;
  blockers?: BoardTask[];
  blocking?: BoardTask[];
  origin_task_id?: number | null;
  origin_task_title?: string | null;
  defect_type?: string | null;
  spawned_defects?: number | null;
  paused_at?: string | null;
  pause_reason?: string | null;
  failure_class?: 'qa_failure' | 'release_failure' | 'approval_blocked' | 'env_blocked' | 'infra_failure' | 'runtime_failure' | 'unknown' | null;
  failure_detail?: string | null;
}

export type ColumnDef = { key: string; label: string; color: string };

/** Static fallback — used only if the backend status catalog hasn't loaded yet.
 *  The live columns are fetched dynamically in TaskBoard via useTaskStatuses. */
export const ALL_COLUMNS: ColumnDef[] = [
  { key: 'todo', label: 'To Do', color: 'slate' },
  { key: 'ready', label: 'Ready', color: 'blue' },
  { key: 'dispatched', label: 'Dispatched', color: 'indigo' },
  { key: 'in_progress', label: 'In Progress', color: 'yellow' },
  { key: 'review', label: 'Review', color: 'purple' },
  { key: 'qa_pass', label: 'QA Pass', color: 'emerald' },
  { key: 'ready_to_merge', label: 'Ready to Merge', color: 'fuchsia' },
  { key: 'deployed', label: 'Deployed', color: 'teal' },
  { key: 'stalled', label: 'Stalled', color: 'orange' },
  { key: 'done', label: 'Done', color: 'green' },
  { key: 'failed', label: 'Failed', color: 'red' },
  { key: 'cancelled', label: 'Cancelled', color: 'red' },
];

export const DEFAULT_VISIBLE = ['todo', 'ready', 'dispatched', 'in_progress', 'review', 'stalled', 'done'];

export const PRIORITY_BADGE: Record<string, string> = {
  low: 'bg-slate-700 text-slate-300',
  medium: 'bg-amber-900/60 text-amber-300',
  high: 'bg-red-900/60 text-red-300',
};

export function isBlocked(task: BoardTask): boolean {
  return (task.blockers ?? []).some(b => b.status !== 'done');
}

export function groupByJob(list: BoardTask[]): Record<string, BoardTask[]> {
  const groups: Record<string, BoardTask[]> = {};
  for (const t of list) {
    const key = t.agent_name ?? '__none__';
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  }
  return groups;
}

// ── Blocker Picker ────────────────────────────────────────────────────────────

interface BlockerPickerProps {
  task: BoardTask;
  allTasks?: BoardTask[];
  onAdd: (blockerId: number) => Promise<void>;
}

interface TaskSearchResult {
  id: number;
  title: string;
  status: string;
}

export function BlockerPicker({ task, onAdd }: BlockerPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TaskSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
        setResults([]);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  const doSearch = useCallback((q: string) => {
    if (!q.trim()) { setResults([]); return; }
    setSearching(true);
    api.searchTasks(q, task.id)
      .then(rows => {
        const existingIds = new Set((task.blockers ?? []).map(b => b.id));
        setResults(rows.filter(r => !existingIds.has(r.id)));
      })
      .catch(() => setResults([]))
      .finally(() => setSearching(false));
  }, [task.id, task.blockers]);

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => doSearch(val), 200);
  };

  const handleAdd = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    setAdding(id);
    try {
      await onAdd(id);
      setOpen(false);
      setQuery('');
      setResults([]);
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        className="flex items-center gap-1 text-xs text-slate-400 hover:text-amber-400 transition-colors px-1.5 py-0.5 rounded border border-slate-600 hover:border-amber-400/50"
        title="Add blocker"
      >
        <Plus className="w-3 h-3" />
        Add Blocker
      </button>
      {open && (
        <div
          className="absolute left-0 top-full mt-1 z-40 bg-slate-800 border border-slate-600 rounded-lg shadow-xl w-64"
          onClick={e => e.stopPropagation()}
        >
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
          <div className="max-h-48 overflow-y-auto">
            {query.trim() === '' ? (
              <p className="text-xs text-slate-500 p-3">Type a task number or title to search</p>
            ) : results.length === 0 && !searching ? (
              <p className="text-xs text-slate-500 p-3">No matching tasks</p>
            ) : (
              results.map(t => (
                <button
                  key={t.id}
                  onClick={e => handleAdd(e, t.id)}
                  disabled={adding === t.id}
                  className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-700 transition-colors disabled:opacity-50"
                >
                  {adding === t.id ? (
                    <span className="text-amber-400">Adding…</span>
                  ) : (
                    <div className="flex items-start gap-2">
                      <Shield className="w-3 h-3 text-slate-500 shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <span className="text-slate-400 font-mono">#{t.id}</span>
                        {' '}
                        <span className="truncate">{t.title}</span>
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
  );
}

// ── Task Card ─────────────────────────────────────────────────────────────────

interface TaskCardProps {
  task: BoardTask;
  allTasks: BoardTask[];
  onClick: () => void;
  onAddBlocker: (taskId: number, blockerId: number) => Promise<void>;
  onRemoveBlocker: (taskId: number, blockerId: number) => Promise<void>;
  onPause: (taskId: number) => Promise<void>;
  /** When true, shows sprint link badge on the card */
  showSprint?: boolean;
}

export function TaskCard({ task, allTasks, onClick, onAddBlocker, onRemoveBlocker, onPause, showSprint = false }: TaskCardProps) {
  const [pausing, setPausing] = useState(false);
  const blocked = isBlocked(task);
  const blockers = task.blockers ?? [];
  const blocking = task.blocking ?? [];
  const failureSource = getFailureSourceLabel(task);
  const failureTone = getFailureTone(task);
  const pipelineBlocked = isFailureBlocked(task);

  return (
    <div
      onClick={onClick}
      className={`bg-slate-800 border rounded-lg p-3 cursor-pointer transition-all group min-h-[44px]
        ${blocked
          ? 'border-orange-500/50 hover:border-orange-400/70 active:border-orange-400/70'
          : 'border-slate-700 hover:border-amber-400/40 hover:bg-slate-750 active:bg-slate-700'
        }`}
    >
      {/* Task number + title row */}
      <div className="flex items-start gap-1.5 mb-2">
        {blocked && (
          <span title="Blocked by unfinished tasks"><AlertTriangle className="w-3.5 h-3.5 text-orange-400 shrink-0 mt-0.5" /></span>
        )}
        <div className="flex-1 min-w-0">
          <span className="text-xs text-slate-600 font-mono mr-1.5">#{task.id}</span>
          <span className={`text-sm md:text-sm font-semibold leading-snug ${blocked ? 'text-orange-100' : 'text-white group-hover:text-amber-50'}`}>
            {task.title}
            {task.recurring ? <span className="ml-1.5 text-xs text-slate-400" title="Recurring">🔁</span> : null}
          </span>
        </div>
      </div>

      {/* Priority + story points + agent + stop button */}
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className={`text-xs px-2 py-1 rounded-full font-semibold ${PRIORITY_BADGE[task.priority]}`}>
          {task.priority}
        </span>
        {task.story_points != null && (
          <span className="text-xs px-2 py-0.5 rounded-full font-bold bg-cyan-900/50 text-cyan-300 border border-cyan-700/40" title="Story points">
            {task.story_points}pt
          </span>
        )}
        {task.task_type && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 font-mono">
            {task.task_type}
          </span>
        )}
        {task.defect_type && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-300 font-semibold" title={`Defect: ${task.defect_type.replace(/_/g, ' ')}`}>
            {task.defect_type.replace(/_/g, ' ')}
          </span>
        )}
        {(task.spawned_defects ?? 0) > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-red-900/40 text-red-400 font-semibold" title={`${task.spawned_defects} defect(s) spawned from this task`}>
            {task.spawned_defects} defect{task.spawned_defects === 1 ? '' : 's'}
          </span>
        )}
        {failureSource && (
          <span className={`text-xs px-2 py-1 rounded-full font-semibold ${failureTone.pill}`} title={task.failure_detail ?? undefined}>
            {pipelineBlocked ? `${failureSource} blocked` : `${failureSource} failed`}
          </span>
        )}
        {blocked && !failureSource && (
          <span className="text-xs px-2 py-1 rounded-full font-semibold bg-orange-900/60 text-orange-300">
            blocked
          </span>
        )}
        {task.paused_at && (
          <span
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full font-semibold bg-yellow-900/60 text-yellow-300 border border-yellow-600/30"
            title={task.pause_reason ? `Paused: ${task.pause_reason}` : 'Paused — excluded from routing and dispatch'}
          >
            <PauseCircle className="w-3 h-3 shrink-0" />
            paused
          </span>
        )}
        {task.agent_name && (
          <span className="text-xs text-slate-400 truncate max-w-[120px]">{task.agent_name}</span>
        )}
        {task.active_instance_id && (
          <span className="text-xs px-2 py-1 rounded-full font-semibold bg-orange-900/60 text-orange-300" title={`Active instance #${task.active_instance_id}; open the task to confirm dispatch/start timestamps`}>
            instance active
          </span>
        )}
        {task.active_instance_id && (
          <span className="flex items-center gap-1 ml-auto min-h-[32px]">
            {/* Pause button — stops dispatch without cancelling */}
            <button
              onClick={async e => {
                e.stopPropagation();
                if (!window.confirm('Pause this task? It will stop receiving new dispatches until resumed.')) return;
                setPausing(true);
                try { await onPause(task.id); } finally { setPausing(false); }
              }}
              disabled={pausing}
              className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 transition-colors border border-amber-500/30 hover:border-amber-400/50 rounded px-1.5 py-1 disabled:opacity-50"
              title="Pause this task"
            >
              <PauseCircle className="w-3 h-3" />
              {pausing ? '…' : 'Pause'}
            </button>
          </span>
        )}
      </div>

      {/* Sprint badge — hidden on mobile by default to save space */}
      {showSprint && task.sprint_name && task.sprint_id && (
        <div className="mb-2 hidden sm:block" onClick={e => e.stopPropagation()}>
          <a
            href={`/sprints/${task.sprint_id}`}
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-violet-900/50 text-violet-300 hover:bg-violet-800/60 hover:text-violet-200 transition-colors"
            title={formatSprintLabel({ id: task.sprint_id, name: task.sprint_name })}
          >
            🏃 {formatSprintLabel({ id: task.sprint_id, name: task.sprint_name })}
          </a>
        </div>
      )}

      {task.failure_detail && failureSource && (
        <div className={`mt-2 rounded-md px-2.5 py-2 text-xs ${failureTone.panel} ${failureTone.text}`}>
          <span className="font-semibold">{pipelineBlocked ? 'Blocked' : 'Failure'}:</span> {task.failure_detail}
        </div>
      )}

      {/* Blockers section */}
      {blockers.length > 0 && (
        <div className="mt-2 pt-2 border-t border-slate-700/60" onClick={e => e.stopPropagation()}>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Blocked by</p>
          <div className="space-y-1">
            {blockers.map(b => (
              <div key={b.id} className="flex items-center justify-between gap-1 group/blocker">
                <span className={`text-xs truncate ${b.status === 'done' ? 'text-slate-500 line-through' : 'text-slate-300'}`}>
                  {b.title}
                </span>
                <button
                  onClick={e => { e.stopPropagation(); onRemoveBlocker(task.id, b.id); }}
                  className="text-slate-600 hover:text-red-400 transition-colors shrink-0 opacity-0 group-hover/blocker:opacity-100"
                  title="Remove blocker"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Blocking section */}
      {blocking.length > 0 && (
        <div className="mt-2 pt-2 border-t border-slate-700/60">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Blocking</p>
          <div className="space-y-1">
            {blocking.map(b => (
              <span key={b.id} className="block text-xs text-slate-400 truncate">
                {b.title}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Add Blocker */}
      <div className="mt-2 pt-2 border-t border-slate-700/60" onClick={e => e.stopPropagation()}>
        <BlockerPicker
          task={task}
          allTasks={allTasks}
          onAdd={(blockerId) => onAddBlocker(task.id, blockerId)}
        />
      </div>
    </div>
  );
}

// ── Draggable Task Card ───────────────────────────────────────────────────────

interface DraggableTaskCardProps extends TaskCardProps {
  /** When true, drag handle is shown and card is draggable */
  dragEnabled?: boolean;
}

export function DraggableTaskCard({ dragEnabled = true, ...props }: DraggableTaskCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `task-${props.task.id}`,
    data: { task: props.task },
    disabled: !dragEnabled,
  });

  const style = transform
    ? {
        transform: CSS.Translate.toString(transform),
        zIndex: isDragging ? 50 : undefined,
        opacity: isDragging ? 0.5 : undefined,
      }
    : undefined;

  return (
    <div ref={setNodeRef} style={style} className="relative group/drag">
      {dragEnabled && (
        <div
          {...listeners}
          {...attributes}
          className="absolute left-0 top-0 bottom-0 w-6 flex items-center justify-center cursor-grab active:cursor-grabbing opacity-0 group-hover/drag:opacity-100 transition-opacity z-10"
          title="Drag to move"
        >
          <GripVertical className="w-3.5 h-3.5 text-slate-500" />
        </div>
      )}
      <TaskCard {...props} />
    </div>
  );
}

// ── Board Column ──────────────────────────────────────────────────────────────

interface BoardColumnProps {
  col: ColumnDef;
  tasks: BoardTask[];
  allTasks: BoardTask[];
  onClickTask: (task: BoardTask) => void;
  onAddBlocker: (taskId: number, blockerId: number) => Promise<void>;
  onRemoveBlocker: (taskId: number, blockerId: number) => Promise<void>;
  onPause: (taskId: number) => Promise<void>;
  onNewTask?: (status: string) => void;
  showSprint?: boolean;
  /** Whether to show column header (hidden on mobile when tab bar is present) */
  showHeader?: boolean;
  /** Enable drag-and-drop on task cards */
  dragEnabled?: boolean;
  /** Whether this column is a valid drop target for the currently-dragged card */
  isDropTarget?: boolean;
  /** Whether this column is an invalid (disabled) drop target */
  isInvalidTarget?: boolean;
  /** Override the droppable ID (default: column-{col.key}). Must be unique within a DndContext. */
  droppableId?: string;
}

export function BoardColumn({
  col, tasks: colTasks, allTasks, onClickTask,
  onAddBlocker, onRemoveBlocker, onPause,
  onNewTask, showSprint = false, showHeader = true,
  dragEnabled = false, isDropTarget = false, isInvalidTarget = false,
  droppableId,
}: BoardColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: droppableId ?? `column-${col.key}`,
    data: { status: col.key },
    disabled: isInvalidTarget,
  });

  const groups = groupByJob(colTasks);
  const groupKeys = Object.keys(groups).sort((a, b) =>
    a === '__none__' ? 1 : b === '__none__' ? -1 : a.localeCompare(b)
  );

  // Visual feedback classes
  const dropHighlight = isOver && isDropTarget
    ? 'ring-2 ring-amber-400/60 bg-amber-950/20'
    : isDropTarget
      ? 'ring-1 ring-amber-400/30'
      : isInvalidTarget
        ? 'opacity-40'
        : '';

  const CardComponent = dragEnabled ? DraggableTaskCard : TaskCard;

  return (
    <div ref={setNodeRef} className={`bg-slate-900 border border-slate-800 rounded-xl flex flex-col md:h-full transition-all duration-150 ${dropHighlight}`}>
      {/* Column header */}
      {showHeader && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <span className="text-white font-semibold text-sm">{col.label}</span>
            <span className="text-xs text-slate-500 bg-slate-800 rounded-full px-2 py-0.5">{colTasks.length}</span>
          </div>
          {onNewTask && (
            <button
              onClick={() => onNewTask(col.key)}
              className="text-slate-400 hover:text-amber-400 transition-colors"
              title={`Add task to ${col.label}`}
            >
              <Plus className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {/* Cards */}
      <div className="md:flex-1 p-3 space-y-4 md:overflow-y-auto">
        {colTasks.length === 0 && (
          <p className={`text-xs text-center mt-4 ${isOver && isDropTarget ? 'text-amber-400' : 'text-slate-600'}`}>
            {isOver && isDropTarget ? 'Drop here' : 'No tasks'}
          </p>
        )}
        {groupKeys.map(jobKey => (
          <div key={jobKey}>
            {jobKey !== '__none__' && (
              <p className="text-xs font-semibold text-amber-400/70 uppercase tracking-wide mb-1.5 px-0.5">
                {jobKey}
              </p>
            )}
            <div className="space-y-2">
              {groups[jobKey].map(task => (
                <CardComponent
                  key={task.id}
                  task={task}
                  allTasks={allTasks}
                  onClick={() => onClickTask(task)}
                  onAddBlocker={onAddBlocker}
                  onRemoveBlocker={onRemoveBlocker}
                  onPause={onPause}
                  showSprint={showSprint}
                  dragEnabled={dragEnabled}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Bottom add button */}
      {onNewTask && (
        <button
          onClick={() => onNewTask(col.key)}
          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-amber-400 transition-colors px-4 py-3 border-t border-slate-800 min-h-[44px]"
        >
          <Plus className="w-3.5 h-3.5" />
          New Task
        </button>
      )}
    </div>
  );
}
