import { useEffect, useMemo, useState } from 'react';
import { api, apiFetch } from '@/lib/api';

export interface TaskTypeOption {
  value: string;
  label: string;
}

interface TaskTypesResponse {
  task_types: string[];
}

function formatTaskTypeLabel(taskType: string): string {
  const specialLabels: Record<string, string> = {
    qa: 'QA',
    pm: 'PM',
    pm_analysis: 'PM Analysis',
    pm_operational: 'PM Operational',
  };

  return specialLabels[taskType] ?? taskType
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function useTaskTypes(sprintId?: number | null) {
  const [taskTypes, setTaskTypes] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;

    const loadTaskTypes = async () => {
      try {
        if (sprintId != null) {
          const resolved = await api.resolveTaskFieldSchema({ sprint_id: sprintId, task_type: null });
          if (!cancelled) setTaskTypes(resolved.allowed_task_types ?? []);
          return;
        }

        const data = await apiFetch<TaskTypesResponse>('/api/v1/routing/task-types');
        if (!cancelled) setTaskTypes(data.task_types ?? []);
      } catch {
        if (!cancelled) setTaskTypes([]);
      }
    };

    void loadTaskTypes();

    return () => {
      cancelled = true;
    };
  }, [sprintId]);

  const options = useMemo<TaskTypeOption[]>(() => (
    taskTypes.map(taskType => ({
      value: taskType,
      label: formatTaskTypeLabel(taskType),
    }))
  ), [taskTypes]);

  return { taskTypes, options };
}

export function getTaskTypeLabel(taskType: string): string {
  return formatTaskTypeLabel(taskType);
}
