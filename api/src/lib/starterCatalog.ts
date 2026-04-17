import type { TaskType } from './taskTypes';

export type StarterSprintTypeKey = 'generic' | 'dev' | 'ops';

export const STARTER_BACKLOG_SPRINT_NAME = 'Backlog';
export const STARTER_ROUTING_PRIORITY = -100;

export const STARTER_SPRINT_TYPE_SEEDS: Array<{ key: StarterSprintTypeKey; name: string; description: string }> = [
  { key: 'generic', name: 'Generic', description: 'Catch-all sprint profile for mixed delivery work and backlog management.' },
  { key: 'dev', name: 'Development', description: 'Implementation-focused sprint profile for product and software delivery work.' },
  { key: 'ops', name: 'Operations', description: 'Operational sprint profile for release, support, maintenance, and infra work.' },
];

export const STARTER_FIELD_SCHEMA_SEEDS: Array<{ sprintType: StarterSprintTypeKey; schema: Record<string, unknown> }> = [
  {
    sprintType: 'generic',
    schema: {
      fields: [
        { key: 'success_criteria', label: 'Success Criteria', type: 'textarea', required: false, help_text: 'What should be true when this work is finished.' },
      ],
    },
  },
  {
    sprintType: 'dev',
    schema: {
      fields: [
        { key: 'target_surface', label: 'Target Surface', type: 'select', required: false, options: ['api', 'ui', 'fullstack', 'infra'] },
        { key: 'test_plan', label: 'Test Plan', type: 'textarea', required: false, help_text: 'How the implementation should be verified before review.' },
        { key: 'rollout_notes', label: 'Rollout Notes', type: 'textarea', required: false },
      ],
    },
  },
  {
    sprintType: 'ops',
    schema: {
      fields: [
        { key: 'environment', label: 'Environment', type: 'select', required: false, options: ['dev', 'staging', 'production'] },
        { key: 'impact_level', label: 'Impact Level', type: 'select', required: false, options: ['low', 'medium', 'high'] },
        { key: 'runbook_url', label: 'Runbook URL', type: 'url', required: false },
        { key: 'rollback_notes', label: 'Rollback Notes', type: 'textarea', required: false },
      ],
    },
  },
];

export const STARTER_SPRINT_TYPE_TASK_TYPE_SEEDS: Array<{ sprintType: StarterSprintTypeKey; taskTypes: TaskType[] }> = [
  { sprintType: 'generic', taskTypes: ['adhoc', 'backend', 'frontend', 'fullstack', 'qa', 'other'] },
  { sprintType: 'dev', taskTypes: ['backend', 'frontend', 'fullstack', 'qa'] },
  { sprintType: 'ops', taskTypes: ['ops', 'adhoc', 'qa', 'other'] },
];

export const STARTER_SPRINT_WORKFLOW_TEMPLATE_SEEDS: Array<{
  sprintType: StarterSprintTypeKey;
  key: string;
  name: string;
  description: string;
  isDefault: number;
  statuses: Array<{ status_key: string; label: string; color: string; stage_order: number; terminal?: number; is_default_entry?: number; metadata?: Record<string, unknown> }>;
  transitions: Array<{ from_status_key: string; to_status_key: string; transition_key: string; label: string; outcome?: string | null; stage_order: number; metadata?: Record<string, unknown> }>;
}> = [
  {
    sprintType: 'generic',
    key: 'generic-delivery',
    name: 'Generic Delivery Workflow',
    description: 'Default planning-to-done workflow for mixed delivery sprints.',
    isDefault: 1,
    statuses: [
      { status_key: 'planned', label: 'Planned', color: 'slate', stage_order: 0, is_default_entry: 1 },
      { status_key: 'active', label: 'Active', color: 'blue', stage_order: 1 },
      { status_key: 'done', label: 'Done', color: 'green', stage_order: 2, terminal: 1 },
    ],
    transitions: [
      { from_status_key: 'planned', to_status_key: 'active', transition_key: 'start', label: 'Start work', stage_order: 0 },
      { from_status_key: 'active', to_status_key: 'done', transition_key: 'complete', label: 'Complete sprint work', stage_order: 1 },
    ],
  },
  {
    sprintType: 'dev',
    key: 'dev-release',
    name: 'Development Release Workflow',
    description: 'Development sprint workflow with review and ship stages.',
    isDefault: 1,
    statuses: [
      { status_key: 'planned', label: 'Planned', color: 'slate', stage_order: 0, is_default_entry: 1 },
      { status_key: 'building', label: 'Building', color: 'blue', stage_order: 1 },
      { status_key: 'verifying', label: 'Verifying', color: 'purple', stage_order: 2 },
      { status_key: 'shipped', label: 'Shipped', color: 'green', stage_order: 3, terminal: 1 },
    ],
    transitions: [
      { from_status_key: 'planned', to_status_key: 'building', transition_key: 'start-build', label: 'Start implementation', stage_order: 0 },
      { from_status_key: 'building', to_status_key: 'verifying', transition_key: 'submit-for-verification', label: 'Submit for verification', stage_order: 1, outcome: 'completed_for_review' },
      { from_status_key: 'verifying', to_status_key: 'shipped', transition_key: 'ship', label: 'Ship sprint output', stage_order: 2 },
    ],
  },
  {
    sprintType: 'ops',
    key: 'ops-execution',
    name: 'Operations Execution Workflow',
    description: 'Operational sprint workflow for triage through validation.',
    isDefault: 1,
    statuses: [
      { status_key: 'queued', label: 'Queued', color: 'slate', stage_order: 0, is_default_entry: 1 },
      { status_key: 'executing', label: 'Executing', color: 'orange', stage_order: 1 },
      { status_key: 'validated', label: 'Validated', color: 'green', stage_order: 2, terminal: 1 },
    ],
    transitions: [
      { from_status_key: 'queued', to_status_key: 'executing', transition_key: 'begin', label: 'Begin operational work', stage_order: 0 },
      { from_status_key: 'executing', to_status_key: 'validated', transition_key: 'validate', label: 'Validate completion', stage_order: 1 },
    ],
  },
];

export function isStarterSprintTypeKey(value: string | null | undefined): value is StarterSprintTypeKey {
  return value === 'generic' || value === 'dev' || value === 'ops';
}

export function getStarterTaskTypesForSprintType(sprintType: string | null | undefined): TaskType[] {
  const row = STARTER_SPRINT_TYPE_TASK_TYPE_SEEDS.find((entry) => entry.sprintType === sprintType);
  return row ? [...row.taskTypes] : [];
}
