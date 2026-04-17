export function formatSprintNumber(sprintId: number): string {
  return `#${sprintId}`;
}

export function formatSprintLabel(sprint: { id: number; name?: string | null }): string {
  const number = formatSprintNumber(sprint.id);
  const name = sprint.name?.trim();
  return name ? `${number} · ${name}` : number;
}
