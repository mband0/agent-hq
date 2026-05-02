import type Database from 'better-sqlite3';
import { resolveSprintOutcomeMap, type SprintOutcomeDefinition, getLegacyOutcomeMeta } from './sprintOutcomes';

export interface ResolvedTaskOutcomeCatalogEntry extends SprintOutcomeDefinition {
  laneHint: 'implementation' | 'review' | 'release' | 'pm' | 'generic';
  terminalForInstance: boolean;
  blockerLike: boolean;
  failureLike: boolean;
}

function normalizeTaskType(taskType?: string | null): string | null {
  const value = typeof taskType === 'string' ? taskType.trim() : '';
  return value.length > 0 ? value : null;
}

function inferLaneHint(outcomeKey: string, _taskType?: string | null): ResolvedTaskOutcomeCatalogEntry['laneHint'] {
  if (outcomeKey === 'completed_for_review') return 'implementation';
  if (outcomeKey === 'qa_pass' || outcomeKey === 'qa_fail') return 'review';
  if (outcomeKey === 'approved_for_merge' || outcomeKey === 'deployed_live' || outcomeKey === 'live_verified') return 'release';
  if (outcomeKey === 'blocked' || outcomeKey === 'failed' || outcomeKey.startsWith('failed:')) return 'generic';
  return 'generic';
}

export function isFailureLikeOutcome(outcomeKey: string): boolean {
  return outcomeKey === 'failed' || outcomeKey.startsWith('failed:');
}

export function isBlockerLikeOutcome(outcomeKey: string): boolean {
  return outcomeKey === 'blocked';
}

export function isTerminalInstanceOutcome(outcomeKey: string): boolean {
  return outcomeKey !== 'deployed_live';
}

export function resolveTaskOutcomeCatalog(
  db: Database.Database,
  options: { sprintId?: number | null; sprintType?: string | null; taskType?: string | null; fallbackOutcomes?: string[] },
): ResolvedTaskOutcomeCatalogEntry[] {
  const taskType = normalizeTaskType(options.taskType);
  return Array.from(resolveSprintOutcomeMap(db, {
    sprintId: options.sprintId,
    sprintType: options.sprintType,
    taskType,
    fallbackOutcomes: options.fallbackOutcomes,
  }).values()).map((entry) => ({
    ...entry,
    laneHint: inferLaneHint(entry.outcome_key, taskType),
    terminalForInstance: isTerminalInstanceOutcome(entry.outcome_key),
    blockerLike: isBlockerLikeOutcome(entry.outcome_key),
    failureLike: isFailureLikeOutcome(entry.outcome_key),
  }));
}

export function resolveTaskOutcomeCatalogEntries(
  db: Database.Database,
  options: { sprintId?: number | null; sprintType?: string | null; taskType?: string | null; fallbackOutcomes?: string[] },
): ResolvedTaskOutcomeCatalogEntry[] {
  return resolveTaskOutcomeCatalog(db, options);
}

export function getOutcomeDisplayMeta(outcomeKey: string, configured?: Pick<SprintOutcomeDefinition, 'label' | 'description' | 'badge_variant'> | null) {
  const legacy = getLegacyOutcomeMeta(outcomeKey);
  return {
    label: configured?.label || legacy.label,
    description: configured?.description || legacy.description,
    badge_variant: configured?.badge_variant ?? legacy.badge_variant ?? 'workspace',
  };
}
