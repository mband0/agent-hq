import Database from 'better-sqlite3';
import { markTaskNeedsAttentionForMissingSemanticHandoff } from './lifecycleHandoff';

jest.mock('./reconcilerConfig', () => ({
  isNeedsAttentionEligibleStatus: jest.fn(() => true),
}));

jest.mock('./taskNotifications', () => ({
  notifyTaskStatusChange: jest.fn(),
}));

describe('markTaskNeedsAttentionForMissingSemanticHandoff', () => {
  it('writes a structured operator recovery note for missing lifecycle handoff', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        title TEXT,
        status TEXT,
        previous_status TEXT,
        updated_at TEXT,
        task_type TEXT,
        sprint_id INTEGER
      );
      CREATE TABLE sprints (
        id INTEGER PRIMARY KEY,
        sprint_type TEXT
      );
      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        task_outcome TEXT,
        lifecycle_outcome_posted_at TEXT,
        lifecycle_handoff_status TEXT,
        semantic_outcome_missing INTEGER NOT NULL DEFAULT 0,
        runtime_completed_at TEXT,
        runtime_ended_at TEXT
      );
      CREATE TABLE task_notes (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        author TEXT,
        content TEXT
      );
      CREATE TABLE task_history (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        changed_by TEXT,
        field TEXT,
        old_value TEXT,
        new_value TEXT
      );
      CREATE TABLE integrity_events (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        project_id INTEGER,
        agent_id INTEGER,
        instance_id INTEGER,
        anomaly_type TEXT,
        detail TEXT
      );
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        project_id INTEGER,
        agent_id INTEGER,
        from_status TEXT,
        to_status TEXT,
        moved_by TEXT,
        move_type TEXT,
        instance_id INTEGER,
        reason TEXT
      );
    `);

    db.prepare(`INSERT INTO tasks (id, title, status) VALUES (403, 'Task 403', 'review')`).run();
    db.prepare(`INSERT INTO job_instances (id, task_id, runtime_ended_at) VALUES (2028, 403, '2026-05-01T19:44:23.584Z')`).run();

    const changed = markTaskNeedsAttentionForMissingSemanticHandoff(db, {
      taskId: 403,
      instanceId: 2028,
      changedBy: 'agent:96',
      lane: 'qa',
      priorTaskStatus: 'review',
      sessionKey: 'run:2028',
      reviewQaDeployEvidenceRecorded: 'no',
      runtimeEnd: {
        source: 'instance_complete',
        success: true,
        endedAt: '2026-05-01T19:44:23.584Z',
      },
    });

    expect(changed).toBe(true);

    const note = db.prepare(`SELECT content FROM task_notes WHERE task_id = 403`).get() as { content: string } | undefined;
    expect(note?.content).toContain('Summary: run ended without required lifecycle outcome');
    expect(note?.content).toContain('Work completed: runtime session reached a terminal state, but no valid semantic lifecycle outcome was posted for this lane');
    expect(note?.content).toContain('Result: needs_attention');
    expect(note?.content).toContain('Failure or issue observed: runtime ended successfully at the session level without the required lifecycle handoff');
    expect(note?.content).toContain('Root cause assessment: control-plane/lifecycle contract failure or missing outcome write');
    expect(note?.content).toContain('Evidence: instance_id=2028; session_key=run:2028; lane=qa; prior_status=review; runtime_success=yes; review_qa_deploy_evidence_recorded=no');
    expect(note?.content).toContain('Recommended next action: operator review before any redispatch or lane re-entry');
    expect(note?.content).toContain('Next owner: PM/operator');
  });
});
