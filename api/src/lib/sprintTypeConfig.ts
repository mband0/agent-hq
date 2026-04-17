import type Database from 'better-sqlite3';

function normalizeSprintType(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().toLowerCase()
    : 'generic';
}

function normalizeTaskType(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

export function resolveSprintTypeForSprintId(db: Database.Database, sprintId: unknown): string {
  if (sprintId == null || sprintId === '') return 'generic';

  try {
    const row = db.prepare(`SELECT sprint_type FROM sprints WHERE id = ? LIMIT 1`).get(Number(sprintId)) as { sprint_type?: string | null } | undefined;
    return normalizeSprintType(row?.sprint_type);
  } catch {
    return 'generic';
  }
}

export function getAllowedTaskTypesForSprintType(db: Database.Database, sprintType: string): string[] {
  try {
    const rows = db.prepare(`
      SELECT task_type
      FROM sprint_type_task_types
      WHERE sprint_type_key = ?
      ORDER BY task_type ASC
    `).all(normalizeSprintType(sprintType)) as Array<{ task_type: string | null }>;

    return rows
      .map(row => normalizeTaskType(row.task_type))
      .filter((taskType): taskType is string => Boolean(taskType));
  } catch {
    return [];
  }
}

export function isTaskTypeAllowedForSprintType(
  db: Database.Database,
  sprintType: string,
  taskType: unknown,
): boolean {
  const normalizedTaskType = normalizeTaskType(taskType);
  if (!normalizedTaskType) return true;

  const allowedTaskTypes = getAllowedTaskTypesForSprintType(db, sprintType);
  if (allowedTaskTypes.length === 0) return true;

  return allowedTaskTypes.includes(normalizedTaskType);
}

export function resolveTaskWorkflowContext(
  db: Database.Database,
  input: { sprintId?: unknown; sprintType?: unknown; taskType?: unknown },
): { sprintType: string; taskType: string | null; allowedTaskTypes: string[] } {
  const sprintType = input.sprintType != null
    ? normalizeSprintType(input.sprintType)
    : resolveSprintTypeForSprintId(db, input.sprintId ?? null);
  const taskType = normalizeTaskType(input.taskType);
  const allowedTaskTypes = getAllowedTaskTypesForSprintType(db, sprintType);

  return {
    sprintType,
    taskType,
    allowedTaskTypes,
  };
}
