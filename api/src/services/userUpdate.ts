import type Database from 'better-sqlite3';
import { resolveSprintTaskRoutingAssignment } from '../lib/sprintTaskPolicy';

export const USER_UPDATE_OUTCOME = 'user_update';

export function isManualUserStatusChange(changedBy: string | null | undefined, priorStatus: string | null | undefined, nextStatus: string | null | undefined): boolean {
  return String(changedBy ?? '').trim().toLowerCase() === 'user'
    && String(priorStatus ?? '') !== String(nextStatus ?? '');
}

export function resolveTaskRoutingRule(
  db: Database.Database,
  sprintId: number | null | undefined,
  projectId: number | null | undefined,
  taskType: string | null | undefined,
  status: string | null | undefined,
): { agentId: number | null; routingReason: string | null } {
  if (!taskType || !status) {
    return { agentId: null, routingReason: null };
  }

  const sprintRule = resolveSprintTaskRoutingAssignment(db, sprintId ?? null, taskType, status);
  if (sprintRule.agent_id != null) {
    return {
      agentId: sprintRule.agent_id,
      routingReason: `Sprint policy: ${taskType}/${status} → agent #${sprintRule.agent_id}`,
    };
  }

  if (!projectId) {
    return { agentId: null, routingReason: null };
  }

  const rule = db.prepare(`
    SELECT agent_id FROM task_routing_rules
    WHERE project_id = ? AND task_type = ? AND status = ?
    ORDER BY priority DESC
    LIMIT 1
  `).get(projectId, taskType, status) as { agent_id: number } | undefined;

  if (!rule) {
    return { agentId: null, routingReason: null };
  }

  return {
    agentId: rule.agent_id,
    routingReason: `Deterministic: ${taskType}/${status} → agent #${rule.agent_id}`,
  };
}

export function resolveManualUserUpdate(
  db: Database.Database,
  params: {
    changedBy: string | null | undefined;
    priorStatus: string | null | undefined;
    nextStatus: string | null | undefined;
    sprintId: number | null | undefined;
    projectId: number | null | undefined;
    taskType: string | null | undefined;
    explicitAgentIdProvided: boolean;
    explicitAgentId: number | null | undefined;
    currentAgentId: number | null | undefined;
  }
): { emitted: boolean; resolvedAgentId: number | null; routingReason: string | null } {
  const emitted = isManualUserStatusChange(params.changedBy, params.priorStatus, params.nextStatus);
  if (!emitted) {
    return {
      emitted: false,
      resolvedAgentId: params.explicitAgentIdProvided ? (params.explicitAgentId ?? null) : (params.currentAgentId ?? null),
      routingReason: null,
    };
  }

  if (params.explicitAgentIdProvided) {
    return {
      emitted: true,
      resolvedAgentId: params.explicitAgentId ?? null,
      routingReason: null,
    };
  }

  const route = resolveTaskRoutingRule(db, params.sprintId, params.projectId, params.taskType, params.nextStatus);
  if (route.agentId != null) {
    return {
      emitted: true,
      resolvedAgentId: route.agentId,
      routingReason: route.routingReason,
    };
  }

  return {
    emitted: true,
    resolvedAgentId: params.currentAgentId ?? null,
    routingReason: null,
  };
}

export function buildUserUpdateAuditLog(taskId: number, priorStatus: string, nextStatus: string, changedBy: string, agentId?: number | null): string {
  return `Manual board status change emitted outcome "${USER_UPDATE_OUTCOME}": task #${taskId} (${priorStatus} → ${nextStatus}), actor="${changedBy}"${agentId ? `, agent_id=${agentId}` : ''}`;
}
