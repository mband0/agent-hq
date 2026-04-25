import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAllowedTransitionsMap } from './useTaskStatuses.ts';
import type { TaskStatusMeta } from './api.ts';

const statuses: TaskStatusMeta[] = [
  {
    name: 'todo',
    label: 'To Do',
    color: 'slate',
    terminal: false,
    is_system: true,
    allowed_transitions: ['ready', 'cancelled'],
  },
  {
    name: 'ready',
    label: 'Ready',
    color: 'blue',
    terminal: false,
    is_system: true,
    allowed_transitions: ['in_progress'],
  },
  {
    name: 'in_progress',
    label: 'In Progress',
    color: 'yellow',
    terminal: false,
    is_system: true,
    allowed_transitions: ['review'],
  },
];

test('buildAllowedTransitionsMap uses status allowed_transitions for board move gating', () => {
  const result = buildAllowedTransitionsMap(statuses);

  assert.deepEqual(result, {
    todo: ['ready', 'cancelled'],
    ready: ['in_progress'],
    in_progress: ['review'],
  });
});

test('buildAllowedTransitionsMap falls back to empty arrays when a status omits allowed_transitions', () => {
  const result = buildAllowedTransitionsMap([
    ...statuses,
    {
      name: 'review',
      label: 'Review',
      color: 'purple',
      terminal: false,
      is_system: true,
      allowed_transitions: undefined as unknown as string[],
    },
  ]);

  assert.deepEqual(result.review, []);
});
