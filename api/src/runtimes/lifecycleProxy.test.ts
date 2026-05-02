import Database from 'better-sqlite3';
import { getDb } from '../db/client';
import { initSchema } from '../db/schema';
import { proxyOutcome, runPostStreamLifecycle } from './lifecycleProxy';

jest.mock('../lib/agentHqBaseUrl', () => ({
  getAgentHqBaseUrl: () => 'http://localhost:9',
}));

describe('lifecycleProxy configured outcome vocabulary', () => {
  let db: Database.Database;
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();
    db = getDb();
    initSchema();
    db.exec(`
      DELETE FROM sprint_workflow_transitions;
      DELETE FROM sprint_workflow_statuses;
      DELETE FROM sprint_workflow_templates;
      DELETE FROM sprint_type_outcomes;
      DELETE FROM sprint_type_task_types;
      DELETE FROM sprint_types;
      DELETE FROM sprints;
      DELETE FROM tasks;
      DELETE FROM projects;
    `);

    db.prepare(`INSERT INTO projects (id, name, description, context_md, created_at) VALUES (1, 'Agent HQ', '', '', datetime('now'))`).run();
    db.prepare(`INSERT INTO sprint_types (key, name, description, is_system, created_at, updated_at) VALUES ('enhancements', 'Enhancements', '', 0, datetime('now'), datetime('now'))`).run();
    db.prepare(`INSERT INTO sprints (id, project_id, name, goal, sprint_type, workflow_template_key, status, length_kind, length_value, created_at) VALUES (1, 1, 'Sprint', '', 'enhancements', 'default', 'active', 'time', '2w', datetime('now'))`).run();
    db.prepare(`INSERT INTO sprint_workflow_templates (id, sprint_type_key, key, name, description, is_default, is_system, created_at, updated_at) VALUES (1, 'enhancements', 'default', 'Default', '', 1, 0, datetime('now'), datetime('now'))`).run();
    db.prepare(`INSERT INTO sprint_workflow_statuses (template_id, status_key, label, color, stage_order, terminal, is_default_entry, metadata_json, created_at, updated_at) VALUES (1, 'in_progress', 'In Progress', 'blue', 0, 0, 1, '{}', datetime('now'), datetime('now')), (1, 'review', 'Review', 'purple', 1, 0, 0, '{}', datetime('now'), datetime('now')), (1, 'blocked_custom', 'Blocked Custom', 'amber', 2, 0, 0, '{}', datetime('now'), datetime('now'))`).run();
    db.prepare(`INSERT INTO sprint_workflow_transitions (template_id, from_status_key, to_status_key, transition_key, label, outcome, stage_order, is_system, metadata_json, created_at, updated_at) VALUES (1, 'in_progress', 'review', 'ship-it', 'Ship it', 'ship_it', 0, 0, '{}', datetime('now'), datetime('now')), (1, 'in_progress', 'blocked_custom', 'blocked-custom', 'Blocked custom', 'blocked_custom', 1, 0, '{}', datetime('now'), datetime('now'))`).run();
    db.prepare(`INSERT INTO sprint_type_outcomes (sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, color, badge_variant, stage_order, is_system, metadata_json, created_at, updated_at) VALUES ('enhancements', NULL, 'ship_it', 'Ship It', 'Move to review', 1, 'base', NULL, NULL, 0, 0, '{}', datetime('now'), datetime('now')), ('enhancements', NULL, 'blocked_custom', 'Blocked Custom', 'Custom blocked state', 1, 'base', NULL, NULL, 1, 0, '{}', datetime('now'), datetime('now'))`).run();
    db.prepare(`INSERT INTO tasks (id, title, status, sprint_id, task_type, created_at, updated_at) VALUES (389, 'Outcome config task', 'in_progress', 1, 'backend', datetime('now'), datetime('now'))`).run();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    });
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  });

  it('accepts configured sprint-type outcomes for proxy-managed lifecycle completion', async () => {
    const result = await runPostStreamLifecycle(
      {
        instanceId: 1906,
        taskId: 389,
        sessionKey: 'hook:atlas:jobrun:1906',
        changedBy: 'cinder-backend',
      },
      [
        'Finished implementation.',
        '```atlas_lifecycle',
        JSON.stringify({ outcome: 'ship_it', summary: 'Configured outcome accepted.' }),
        '```',
      ].join('\n'),
    );

    expect(result.effectiveOutcome).toBe('ship_it');
    expect(result.outcomePosted).toBe(true);
    const outcomeCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/api/v1/tasks/389/outcome'));
    expect(outcomeCall).toBeTruthy();
    expect(JSON.parse(String((outcomeCall?.[1] as RequestInit).body))).toMatchObject({ outcome: 'ship_it' });
  });

  it('still rejects unconfigured outcomes truthfully by falling back to the configured lane-safe outcome', async () => {
    const result = await runPostStreamLifecycle(
      {
        instanceId: 1906,
        taskId: 389,
        sessionKey: 'hook:atlas:jobrun:1906',
        changedBy: 'cinder-backend',
      },
      [
        'Finished implementation.',
        '```atlas_lifecycle',
        JSON.stringify({ outcome: 'completed_for_review', summary: 'Legacy outcome should not pass here.' }),
        '```',
      ].join('\n'),
    );

    expect(result.effectiveOutcome).toBe('blocked_custom');
    const outcomeCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/api/v1/tasks/389/outcome'));
    expect(outcomeCall).toBeTruthy();
    expect(JSON.parse(String((outcomeCall?.[1] as RequestInit).body))).toMatchObject({ outcome: 'blocked_custom' });
  });

  it('forwards release evidence fields from structured lifecycle output', async () => {
    const posted = await proxyOutcome(
      {
        instanceId: 1906,
        taskId: 389,
        sessionKey: 'hook:atlas:jobrun:1906',
        changedBy: 'release-agent',
      },
      'live_verified',
      'Production verified.',
      null,
      undefined,
      {
        deployed_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329',
        live_verified_by: 'release-agent',
        live_verified_at: '2026-05-01T23:46:35Z',
      },
    );

    expect(posted).toBe(true);
    const outcomeCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/api/v1/tasks/389/outcome'));
    expect(outcomeCall).toBeTruthy();
    expect(JSON.parse(String((outcomeCall?.[1] as RequestInit).body))).toMatchObject({
      outcome: 'live_verified',
      deployed_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329',
      live_verified_by: 'release-agent',
      live_verified_at: '2026-05-01T23:46:35Z',
    });
  });
});
