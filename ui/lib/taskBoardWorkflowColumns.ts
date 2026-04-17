import type { SprintWorkflowTemplate } from './api';
import type { ColumnDef } from '../components/TaskBoardComponents';

interface SprintLike {
  id: number;
}

function getWorkflowShape(template: SprintWorkflowTemplate): string[] {
  return template.statuses
    .slice()
    .sort((a, b) => a.stage_order - b.stage_order)
    .map(status => status.status_key);
}

export function getSharedWorkflowColumns(
  sprints: SprintLike[],
  selectedSprintIds: number[],
  sprintWorkflowMap: Record<number, SprintWorkflowTemplate | null>,
): ColumnDef[] | undefined {
  const relevantSprints = selectedSprintIds.length > 0
    ? sprints.filter(sprint => selectedSprintIds.includes(sprint.id))
    : sprints;

  if (relevantSprints.length === 0) return undefined;

  const templates = relevantSprints.map(sprint => sprintWorkflowMap[sprint.id]);
  if (templates.some(template => !template || template.statuses.length === 0)) return undefined;

  const [template, ...rest] = templates as SprintWorkflowTemplate[];
  const templateShape = getWorkflowShape(template);

  if (rest.some(candidate => {
    const candidateShape = getWorkflowShape(candidate);
    return candidateShape.length !== templateShape.length || candidateShape.some((key, index) => key !== templateShape[index]);
  })) {
    return undefined;
  }

  return template.statuses
    .slice()
    .sort((a, b) => a.stage_order - b.stage_order)
    .map(status => ({
      key: status.status_key,
      label: status.label,
      color: status.color || 'slate',
    }));
}
