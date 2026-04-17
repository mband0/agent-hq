/**
 * lib/taskTypes.ts — single source of truth for valid task_type values.
 *
 * Both routes/tasks.ts and routes/routing.ts import from here.
 * To add a new task type, update this array only.
 */
export const VALID_TASK_TYPES = [
  'frontend',
  'backend',
  'fullstack',
  'qa',
  'design',
  'marketing',
  'pm',
  'pm_analysis',
  'pm_operational',
  'ops',
  'data',
  'adhoc',
  'other',
] as const;

export type TaskType = typeof VALID_TASK_TYPES[number];

export function isValidTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && (VALID_TASK_TYPES as readonly string[]).includes(value);
}
