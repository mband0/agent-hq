'use client';

import { useState, useEffect, useMemo } from 'react';
import { api, RoutingTransition, TaskStatusMeta } from '@/lib/api';
import { normalizeTaskStatuses, TaskStatusDefinition, getTaskBoardColumns, getDefaultVisibleTaskColumns } from '@/lib/taskStatuses';

export function buildAllowedTransitionsMap(statuses: TaskStatusMeta[]): Record<string, string[]> {
  return Object.fromEntries(
    statuses.map((status) => [status.name, Array.isArray(status.allowed_transitions) ? status.allowed_transitions : []])
  );
}

export interface TaskStatusesState {
  statuses: TaskStatusMeta[];
  definitions: TaskStatusDefinition[];
  allColumns: { key: string; label: string; color: string }[];
  defaultVisible: string[];
  allowedTransitionsMap: Record<string, string[]>;
  loading: boolean;
}

const CACHE_KEY = '_atlas_status_catalog';
const CACHE_TTL_MS = 60_000; // 1 min

interface CacheEntry {
  statuses: TaskStatusMeta[];
  fetchedAt: number;
}

function readCache(): TaskStatusMeta[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry: CacheEntry = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
    return entry.statuses;
  } catch {
    return null;
  }
}

function writeCache(statuses: TaskStatusMeta[]) {
  if (typeof window === 'undefined') return;
  try {
    const entry: CacheEntry = { statuses, fetchedAt: Date.now() };
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch { /* ignore */ }
}

/**
 * Fetches the full status catalog from the backend and returns normalized state.
 * Falls back to the hardcoded TASK_STATUSES list when the API is unavailable.
 */
export function useTaskStatuses(sprintId?: number | null): TaskStatusesState {
  const [statuses, setStatuses] = useState<TaskStatusMeta[]>([]);
  const [allowedTransitionsMap, setAllowedTransitionsMap] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);

      if (sprintId) {
        try {
          const { statuses: fetchedStatuses } = await api.getRoutingStatuses(sprintId);
          if (cancelled) return;
          setStatuses(fetchedStatuses);
          setAllowedTransitionsMap(buildAllowedTransitionsMap(fetchedStatuses));
        } catch {
          if (!cancelled) {
            setStatuses([]);
            setAllowedTransitionsMap({});
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
        return;
      }

      const cached = readCache();
      if (cached && !cancelled) {
        setStatuses(cached);
      }

      try {
        const statusResponse = await (cached ? Promise.resolve({ statuses: cached }) : api.getRoutingStatuses());
        if (cancelled) return;
        setStatuses(statusResponse.statuses);
        setAllowedTransitionsMap(buildAllowedTransitionsMap(statusResponse.statuses));
        if (!cached) writeCache(statusResponse.statuses);
      } catch {
        if (!cancelled) {
          setAllowedTransitionsMap(buildAllowedTransitionsMap(cached ?? []));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [sprintId]);

  const definitions = useMemo(() => normalizeTaskStatuses(statuses.length ? statuses : null), [statuses]);
  const allColumns = useMemo(() => getTaskBoardColumns(statuses.length ? statuses : null), [statuses]);
  const defaultVisible = useMemo(() => getDefaultVisibleTaskColumns(statuses.length ? statuses : null), [statuses]);

  return { statuses, definitions, allColumns, defaultVisible, allowedTransitionsMap, loading };
}
