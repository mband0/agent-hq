import type { TaskStatusMeta } from '@/lib/api';

export type TaskStatusColor = 'slate' | 'cyan' | 'violet' | 'amber' | 'blue' | 'emerald' | 'fuchsia' | 'teal' | 'green' | 'red' | 'orange' | 'yellow' | 'purple' | 'indigo';

export interface TaskStatusDefinition {
  key: string;
  label: string;
  color: TaskStatusColor;
  badgeClass: string;
  dotClass: string;
}

const COLOR_STYLES: Record<TaskStatusColor, { badgeClass: string; dotClass: string }> = {
  slate: { badgeClass: 'bg-slate-700 text-slate-300', dotClass: 'bg-slate-400' },
  cyan: { badgeClass: 'bg-cyan-900/60 text-cyan-300', dotClass: 'bg-cyan-400' },
  violet: { badgeClass: 'bg-violet-900/60 text-violet-300', dotClass: 'bg-violet-400' },
  amber: { badgeClass: 'bg-amber-900/60 text-amber-300', dotClass: 'bg-amber-400' },
  blue: { badgeClass: 'bg-blue-900/60 text-blue-300', dotClass: 'bg-blue-400' },
  emerald: { badgeClass: 'bg-emerald-900/60 text-emerald-300', dotClass: 'bg-emerald-400' },
  fuchsia: { badgeClass: 'bg-fuchsia-900/60 text-fuchsia-300', dotClass: 'bg-fuchsia-400' },
  teal: { badgeClass: 'bg-teal-900/60 text-teal-300', dotClass: 'bg-teal-400' },
  green: { badgeClass: 'bg-green-900/60 text-green-300', dotClass: 'bg-green-400' },
  red: { badgeClass: 'bg-red-900/60 text-red-300', dotClass: 'bg-red-400' },
  orange: { badgeClass: 'bg-orange-900/60 text-orange-300', dotClass: 'bg-orange-400' },
  yellow: { badgeClass: 'bg-yellow-900/60 text-yellow-300', dotClass: 'bg-yellow-400' },
  purple: { badgeClass: 'bg-purple-900/60 text-purple-300', dotClass: 'bg-purple-400' },
  indigo: { badgeClass: 'bg-indigo-900/60 text-indigo-300', dotClass: 'bg-indigo-400' },
};

const DEFAULT_STATUS_ORDER = [
  'todo',
  'ready',
  'dispatched',
  'in_progress',
  'review',
  'qa_pass',
  'ready_to_merge',
  'deployed',
  'needs_attention',
  'stalled',
  'blocked',
  'done',
  'cancelled',
  'failed',
] as const;

export const TASK_STATUSES: TaskStatusDefinition[] = [
  { key: 'todo', label: 'To Do', color: 'slate', ...COLOR_STYLES.slate },
  { key: 'ready', label: 'Ready', color: 'cyan', ...COLOR_STYLES.cyan },
  { key: 'dispatched', label: 'Dispatched', color: 'violet', ...COLOR_STYLES.violet },
  { key: 'in_progress', label: 'In Progress', color: 'amber', ...COLOR_STYLES.amber },
  { key: 'review', label: 'Review', color: 'blue', ...COLOR_STYLES.blue },
  { key: 'qa_pass', label: 'QA Passed', color: 'emerald', ...COLOR_STYLES.emerald },
  { key: 'ready_to_merge', label: 'Ready to Merge', color: 'fuchsia', ...COLOR_STYLES.fuchsia },
  { key: 'deployed', label: 'Deployed', color: 'teal', ...COLOR_STYLES.teal },
  { key: 'needs_attention', label: 'Needs Attention', color: 'amber', ...COLOR_STYLES.amber },
  { key: 'done', label: 'Done', color: 'green', ...COLOR_STYLES.green },
  { key: 'cancelled', label: 'Cancelled', color: 'red', ...COLOR_STYLES.red },
  { key: 'stalled', label: 'Stalled', color: 'orange', ...COLOR_STYLES.orange },
  { key: 'blocked', label: 'Blocked', color: 'yellow', ...COLOR_STYLES.yellow },
  { key: 'failed', label: 'Failed', color: 'red', badgeClass: 'bg-red-900/60 text-red-300', dotClass: 'bg-red-500' },
];

function toUiColor(color?: string): TaskStatusColor {
  const normalized = (color || 'slate').toLowerCase();
  if (normalized in COLOR_STYLES) return normalized as TaskStatusColor;
  return 'slate';
}

export function normalizeTaskStatuses(statuses?: TaskStatusMeta[] | null): TaskStatusDefinition[] {
  if (!statuses?.length) return TASK_STATUSES;

  const fallbackMap = Object.fromEntries(TASK_STATUSES.map(status => [status.key, status]));
  const normalized = statuses.map((status) => {
    const fallback = fallbackMap[status.name];
    const color = toUiColor(status.color || fallback?.color);
    return {
      key: status.name,
      label: status.label || fallback?.label || status.name,
      color,
      badgeClass: fallback?.badgeClass || COLOR_STYLES[color].badgeClass,
      dotClass: fallback?.dotClass || COLOR_STYLES[color].dotClass,
    } satisfies TaskStatusDefinition;
  });

  normalized.sort((a, b) => {
    const aIndex = DEFAULT_STATUS_ORDER.indexOf(a.key as typeof DEFAULT_STATUS_ORDER[number]);
    const bIndex = DEFAULT_STATUS_ORDER.indexOf(b.key as typeof DEFAULT_STATUS_ORDER[number]);
    if (aIndex !== -1 || bIndex !== -1) return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
    return a.label.localeCompare(b.label);
  });

  return normalized;
}

export function getTaskStatusMaps(statuses?: TaskStatusMeta[] | null) {
  const normalized = normalizeTaskStatuses(statuses);
  return {
    definitions: normalized,
    labels: Object.fromEntries(normalized.map(status => [status.key, status.label])) as Record<string, string>,
    badges: Object.fromEntries(normalized.map(status => [status.key, status.badgeClass])) as Record<string, string>,
    dots: Object.fromEntries(normalized.map(status => [status.key, status.dotClass])) as Record<string, string>,
  };
}

export function getTaskBoardColumns(statuses?: TaskStatusMeta[] | null) {
  return normalizeTaskStatuses(statuses).map(({ key, label, color }) => ({ key, label, color }));
}

export function getDefaultVisibleTaskColumns(statuses?: TaskStatusMeta[] | null) {
  return getTaskBoardColumns(statuses).map(status => status.key);
}

export const TASK_STATUS_MAP = Object.fromEntries(TASK_STATUSES.map(status => [status.key, status]));
export const TASK_STATUS_LABELS = Object.fromEntries(TASK_STATUSES.map(status => [status.key, status.label]));
export const TASK_STATUS_BADGES = Object.fromEntries(TASK_STATUSES.map(status => [status.key, status.badgeClass]));
export const TASK_STATUS_DOTS = Object.fromEntries(TASK_STATUSES.map(status => [status.key, status.dotClass]));

export const TASK_BOARD_COLUMNS = getTaskBoardColumns();
export const DEFAULT_VISIBLE_TASK_COLUMNS = getDefaultVisibleTaskColumns();
