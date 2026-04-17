'use client';

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import {
  DndContext,
  DragStartEvent,
  DragEndEvent,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  pointerWithin,
  rectIntersection,
  CollisionDetection,
} from '@dnd-kit/core';
import {
  BoardColumn,
  BoardTask,
  ColumnDef,
  TaskCard,
} from '@/components/TaskBoardComponents';
import { useTaskStatuses } from '@/lib/useTaskStatuses';
import { DEFAULT_VISIBLE_TASK_COLUMNS, TASK_BOARD_COLUMNS } from '@/lib/taskStatuses';

export interface TaskBoardSection {
  key: string;
  title: string;
  tasks: BoardTask[];
  tone?: 'default' | 'muted';
  statusLabel?: string;
  /** True when the sprint is active but has tasks outside the currently-loaded page */
  hasUnloadedTasks?: boolean;
  /** True when this section is in the process of loading tasks (IntersectionObserver triggered) */
  isLoading?: boolean;
}

interface TaskBoardProps {
  tasks: BoardTask[];
  storageKey: string;
  sprintId?: number | null;
  onTaskClick: (task: BoardTask) => void;
  onAddBlocker: (taskId: number, blockerId: number) => Promise<void>;
  onRemoveBlocker: (taskId: number, blockerId: number) => Promise<void>;
  onPause: (taskId: number) => Promise<void>;
  onNewTask?: (status: string) => void;
  onStatusChange?: (taskId: number, newStatus: string) => Promise<void>;
  showSprint?: boolean;
  sections?: TaskBoardSection[];
  columnsButtonAlign?: 'left' | 'right';
  /** Called when a section key enters the viewport (for lazy loading sprint tasks) */
  onSectionVisible?: (sectionKey: string) => void;
  /**
   * When true (search/filter is active), columns and sprint sections with zero matching
   * tasks are hidden. Columns/sections reappear as soon as they have at least one match.
   * Has no effect when false/undefined (all columns visible as normal).
   */
  isFiltered?: boolean;
}

export function TaskBoard({
  tasks,
  storageKey,
  sprintId = null,
  onTaskClick,
  onAddBlocker,
  onRemoveBlocker,
  onPause,
  onNewTask,
  onStatusChange,
  showSprint = false,
  sections,
  columnsButtonAlign = 'right',
  onSectionVisible,
  isFiltered = false,
}: TaskBoardProps) {
  // Fetch the full status catalog from the backend
  const {
    allColumns: ALL_COLUMNS,
    defaultVisible: DEFAULT_VISIBLE,
    loading: statusesLoading,
    statuses,
    allowedTransitionsMap: allowedTransitionsArrayMap,
  } = useTaskStatuses(sprintId);

  const [mobileCol, setMobileCol] = useState<string>('todo');
  // Initialize with hardcoded fallback so SSR and first client render are identical,
  // preventing hydration mismatches. The effect below upgrades to API-loaded columns.
  const [visibleCols, setVisibleCols] = useState<string[]>(DEFAULT_VISIBLE_TASK_COLUMNS);
  const [colsInitialized, setColsInitialized] = useState(false);
  const [showColConfig, setShowColConfig] = useState(false);

  // Once status catalog loads from API, merge stored prefs with the full catalog.
  // New statuses (not yet in localStorage) are added as visible by default.
  useEffect(() => {
    if (statusesLoading || ALL_COLUMNS.length === 0) return;

    const allKeys = ALL_COLUMNS.map(c => c.key);
    let initialCols: string[] = DEFAULT_VISIBLE;

    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        try {
          const parsed: unknown = JSON.parse(stored);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const storedKeys = parsed as string[];
            // Keep stored visible columns that are still valid
            const retained = storedKeys.filter(k => allKeys.includes(k));
            // Add any new catalog statuses that weren't in storage yet
            const newStatuses = allKeys.filter(k => !storedKeys.includes(k) && DEFAULT_VISIBLE.includes(k));
            initialCols = [...retained, ...newStatuses].filter(k => allKeys.includes(k));
            if (initialCols.length === 0) initialCols = DEFAULT_VISIBLE;
          }
        } catch { /* ignore */ }
      }
    }

    setVisibleCols(initialCols);
    setColsInitialized(true);
  }, [statusesLoading, ALL_COLUMNS, DEFAULT_VISIBLE, storageKey]);

  useEffect(() => {
    if (colsInitialized) {
      localStorage.setItem(storageKey, JSON.stringify(visibleCols));
    }
  }, [storageKey, visibleCols, colsInitialized]);

  // While API columns are loading, fall back to the hardcoded column list so the
  // board always renders a stable set of columns on first paint (avoids empty render).
  const columnsSource = ALL_COLUMNS.length > 0 ? ALL_COLUMNS : TASK_BOARD_COLUMNS;
  const activeColumns = useMemo(
    () => columnsSource.filter(c => visibleCols.includes(c.key)),
    [columnsSource, visibleCols]
  );

  useEffect(() => {
    if (activeColumns.length === 0) return;
    if (!activeColumns.some(c => c.key === mobileCol)) {
      setMobileCol(activeColumns[0].key);
    }
  }, [activeColumns, mobileCol]);

  // ── IntersectionObserver: fire onSectionVisible when sprint section enters viewport ──
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());
  const firedSections = useRef<Set<string>>(new Set());

  const registerSectionRef = useCallback((key: string, el: HTMLElement | null) => {
    if (el) {
      sectionRefs.current.set(key, el);
    } else {
      sectionRefs.current.delete(key);
    }
  }, []);

  useEffect(() => {
    if (!onSectionVisible || !sections) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const key = (entry.target as HTMLElement).dataset.sectionKey;
          if (!key || firedSections.current.has(key)) continue;
          firedSections.current.add(key);
          onSectionVisible(key);
        }
      },
      { rootMargin: '200px 0px', threshold: 0 }
    );

    for (const [, el] of sectionRefs.current) {
      observer.observe(el);
    }

    return () => observer.disconnect();
  }, [onSectionVisible, sections]);

  // ── Drag-and-drop state ──────────────────────────────────────────────────
  const [activeTask, setActiveTask] = useState<BoardTask | null>(null);
  const [dragError, setDragError] = useState<string | null>(null);
  // Optimistic status overrides: taskId → newStatus. Applied immediately on drop,
  // cleared when the parent re-renders with updated task data from the API.
  const [optimisticMoves, setOptimisticMoves] = useState<Map<number, string>>(new Map());

  // Build allowed transitions map from status catalog
  const allowedTransitionsMap = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    const entries = Object.entries(allowedTransitionsArrayMap);
    if (entries.length > 0) {
      for (const [status, transitions] of entries) {
        map[status] = new Set(transitions);
      }
      return map;
    }
    for (const status of statuses) {
      map[status.name] = new Set(status.allowed_transitions ?? []);
    }
    return map;
  }, [allowedTransitionsArrayMap, statuses]);

  const getValidTargets = useCallback(
    (fromStatus: string): Set<string> => allowedTransitionsMap[fromStatus] ?? new Set(),
    [allowedTransitionsMap],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const task = event.active.data.current?.task as BoardTask | undefined;
    if (task) setActiveTask(task);
    setDragError(null);
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const task = activeTask;
      setActiveTask(null);

      if (!task || !event.over || !onStatusChange) return;

      const targetStatus = event.over.data.current?.status as string | undefined;
      if (!targetStatus || targetStatus === task.status) return;

      const valid = getValidTargets(task.status);
      if (!valid.has(targetStatus)) {
        setDragError(`Cannot move from "${task.status}" to "${targetStatus}"`);
        setTimeout(() => setDragError(null), 3000);
        return;
      }

      // Apply optimistic UI immediately
      setOptimisticMoves(prev => new Map(prev).set(task.id, targetStatus));

      try {
        await onStatusChange(task.id, targetStatus);
      } catch (err) {
        // Revert optimistic move on failure
        setOptimisticMoves(prev => {
          const next = new Map(prev);
          next.delete(task.id);
          return next;
        });
        setDragError(err instanceof Error ? err.message : 'Status update failed');
        setTimeout(() => setDragError(null), 3000);
      }
    },
    [activeTask, onStatusChange, getValidTargets],
  );

  const handleDragCancel = useCallback(() => {
    setActiveTask(null);
  }, []);

  // Clear optimistic overrides when the upstream task list catches up
  useEffect(() => {
    if (optimisticMoves.size === 0) return;
    setOptimisticMoves(prev => {
      const next = new Map(prev);
      let changed = false;
      for (const [taskId, expectedStatus] of prev) {
        const t = tasks.find(t => t.id === taskId);
        // Clear if task now has the expected status, or the task is gone
        if (!t || t.status === expectedStatus) {
          next.delete(taskId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tasks, optimisticMoves]);

  // Build optimistically-patched task list
  const effectiveTasks = useMemo(() => {
    if (optimisticMoves.size === 0) return tasks;
    return tasks.map(t => {
      const override = optimisticMoves.get(t.id);
      return override ? { ...t, status: override } : t;
    });
  }, [tasks, optimisticMoves]);

  // When a filter is active, derive a subset of activeColumns that actually contain tasks.
  // This drives both desktop and mobile views: empty columns disappear instantly while the
  // filter is set and reappear the moment they have a match.
  // Must be declared after effectiveTasks since it references it for the flat (no-sections) view.
  const visibleColumns = useMemo(() => {
    if (!isFiltered) return activeColumns;
    return activeColumns.filter(c => {
      // In sections mode each section shows a subset — a column is "non-empty" if any section
      // has at least one task in that column; otherwise it has nothing to show.
      if (sections && sections.length > 0) {
        return sections.some(s => s.tasks.some(t => t.status === c.key));
      }
      // Flat view: check effectiveTasks directly.
      return effectiveTasks.some(t => t.status === c.key);
    });
  }, [isFiltered, activeColumns, sections, effectiveTasks]);

  // Keep mobile selected column in sync when it becomes empty during filtering.
  useEffect(() => {
    if (visibleColumns.length === 0) return;
    if (!visibleColumns.some(c => c.key === mobileCol)) {
      setMobileCol(visibleColumns[0].key);
    }
  }, [visibleColumns, mobileCol]);

  const dragEnabled = !!onStatusChange && Object.keys(allowedTransitionsMap).length > 0;

  // Custom collision detection: prefer pointerWithin, fall back to rectIntersection
  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      const result = pointerWithin(args);
      return result.length > 0 ? result : rectIntersection(args);
    },
    [],
  );

  const toggleCol = (key: string) => {
    setVisibleCols(prev => {
      const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
      return next.length > 0 ? next : prev;
    });
  };

  const columnCounts = useMemo(
    () => Object.fromEntries(columnsSource.map(c => [c.key, effectiveTasks.filter(t => t.status === c.key).length])),
    [columnsSource, effectiveTasks]
  ) as Record<string, number>;

  // Apply optimistic moves to section task lists.
  // Sections with zero loaded tasks are kept — they may have tasks outside the current page.
  const effectiveSections = useMemo(() => {
    if (!sections || sections.length === 0) return null;
    if (optimisticMoves.size === 0) return sections;
    return sections.map(s => ({
      ...s,
      tasks: s.tasks.map(t => {
        const override = optimisticMoves.get(t.id);
        return override ? { ...t, status: override } : t;
      }),
    }));
  }, [sections, optimisticMoves]);

  const desktopSections = effectiveSections;

  // Determine which columns are valid/invalid drop targets while dragging
  const validTargets = activeTask ? getValidTargets(activeTask.status) : new Set<string>();
  const isDragging = !!activeTask;

  const renderColumn = (col: ColumnDef, colTasks: BoardTask[], showHeader = true, sectionKey?: string) => (
    <BoardColumn
      col={col}
      tasks={colTasks}
      allTasks={effectiveTasks}
      onClickTask={onTaskClick}
      onAddBlocker={onAddBlocker}
      onRemoveBlocker={onRemoveBlocker}
      onPause={onPause}
      onNewTask={onNewTask}
      showSprint={showSprint}
      showHeader={showHeader}
      dragEnabled={dragEnabled}
      isDropTarget={isDragging && validTargets.has(col.key)}
      isInvalidTarget={isDragging && !validTargets.has(col.key) && col.key !== activeTask?.status}
      droppableId={sectionKey ? `column-${sectionKey}-${col.key}` : `column-${col.key}`}
    />
  );

  const boardContent = (
    <div className="flex flex-col md:flex-1 md:min-h-0 md:overflow-hidden">
      {/* Drag error toast */}
      {dragError && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] bg-red-900/90 border border-red-700 text-red-200 text-sm px-4 py-2 rounded-lg shadow-xl animate-in fade-in slide-in-from-top-2">
          {dragError}
        </div>
      )}

      <div className={`flex items-center mb-3 flex-shrink-0 ${columnsButtonAlign === 'left' ? 'justify-start' : 'justify-end'}`}>
        <div className="relative">
          <button
            onClick={() => setShowColConfig(o => !o)}
            className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-slate-400 text-sm hover:text-white hover:border-amber-400/50 transition-colors"
            title="Configure visible columns"
          >
            Columns
          </button>
          {showColConfig && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-slate-800 border border-slate-600 rounded-lg shadow-xl p-3 w-56">
              <p className="text-xs text-slate-400 font-semibold uppercase mb-2">Visible Columns</p>
              {columnsSource.map(c => (
                <label key={c.key} className="flex items-center gap-2 py-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={visibleCols.includes(c.key)}
                    onChange={() => toggleCol(c.key)}
                    className="accent-amber-400"
                  />
                  <span className="text-sm text-white">{c.label}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="md:hidden mb-4 flex flex-col">
        <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none flex-shrink-0 min-h-[44px] items-center">
          {visibleColumns.map(col => (
            <button
              key={col.key}
              onClick={() => setMobileCol(col.key)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors shrink-0 min-h-[36px] ${
                mobileCol === col.key
                  ? 'bg-amber-500 text-black'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              {col.label}
              {(columnCounts[col.key] ?? 0) > 0 && (
                <span className={`text-xs rounded-full px-1.5 py-0.5 font-semibold ${
                  mobileCol === col.key ? 'bg-black/20 text-black' : 'bg-slate-700 text-slate-300'
                }`}>
                  {columnCounts[col.key]}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between mt-3 mb-2">
          <h2 className="text-base font-semibold text-white">
            {visibleColumns.find(c => c.key === mobileCol)?.label ?? mobileCol}
          </h2>
          {onNewTask && (
            <button
              onClick={() => onNewTask(mobileCol)}
              className="flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300 transition-colors border border-amber-500/30 rounded-lg px-3 py-2 min-h-[36px]"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Task
            </button>
          )}
        </div>

        {visibleColumns.find(c => c.key === mobileCol) && renderColumn(
          visibleColumns.find(c => c.key === mobileCol)!,
          effectiveTasks.filter(t => t.status === mobileCol),
          false,
        )}
      </div>

      {desktopSections ? (
        <div className="hidden md:block overflow-auto pb-4 flex-1 min-h-0">
          <div className="flex min-w-max flex-col gap-8 pr-6">
            {desktopSections.map(section => (
              <div
                key={section.key}
                className="min-w-full"
                data-section-key={section.key}
                ref={el => registerSectionRef(section.key, el)}
              >
                <div className="flex items-center gap-2 mb-3 sticky top-0 z-10 bg-slate-950/95 backdrop-blur supports-[backdrop-filter]:bg-slate-950/80 py-1">
                  <h2 className={`text-base font-semibold ${section.tone === 'muted' ? 'text-slate-400' : 'text-white'}`}>
                    {section.title}
                  </h2>
                  <span className="text-xs text-slate-500 bg-slate-800 rounded-full px-2 py-0.5">{section.tasks.length} tasks</span>
                  {section.statusLabel && (
                    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                      section.statusLabel === 'active' ? 'bg-green-900/60 text-green-300' : 'bg-slate-700 text-slate-400'
                    }`}>
                      {section.statusLabel}
                    </span>
                  )}
                  {section.isLoading && (
                    <span className="text-xs text-slate-400 italic animate-pulse">Loading tasks…</span>
                  )}
                </div>
                {section.tasks.length === 0 && section.isLoading ? (
                  <div className="flex items-center justify-center h-16 border border-dashed border-slate-700 rounded-lg text-slate-500 text-sm animate-pulse">
                    Loading sprint tasks…
                  </div>
                ) : section.tasks.length === 0 && section.hasUnloadedTasks ? (
                  <div className="flex items-center justify-center h-16 border border-dashed border-slate-700 rounded-lg text-slate-500 text-sm italic">
                    Tasks loading…
                  </div>
                ) : (
                  <div className="flex gap-4 w-max min-w-full h-[600px]" style={{ scrollSnapType: 'x mandatory' }}>
                    {visibleColumns.map(col => (
                      <div key={col.key} className="min-w-[280px] w-[280px] flex-shrink-0 h-full" style={{ scrollSnapAlign: 'start' }}>
                        {renderColumn(col, section.tasks.filter(t => t.status === col.key), true, section.key)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="hidden md:flex gap-4 overflow-x-auto pb-4 h-[600px]" style={{ scrollSnapType: 'x mandatory' }}>
          {visibleColumns.map(col => (
            <div key={col.key} className="min-w-[280px] flex-shrink-0 flex flex-col h-full" style={{ scrollSnapAlign: 'start' }}>
              {renderColumn(col, effectiveTasks.filter(t => t.status === col.key))}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  // Wrap in DndContext when drag-and-drop is enabled
  if (!dragEnabled) return boardContent;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {boardContent}

      {/* Drag overlay — renders the card being dragged */}
      <DragOverlay dropAnimation={null}>
        {activeTask ? (
          <div className="w-[280px] opacity-90 rotate-2 shadow-2xl">
            <TaskCard
              task={activeTask}
              allTasks={tasks}
              onClick={() => {}}
              onAddBlocker={async () => {}}
              onRemoveBlocker={async () => {}}
              onPause={async () => {}}
              showSprint={showSprint}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
