import Database from 'better-sqlite3';
import { OpenClawRuntime } from './OpenClawRuntime';
import { recordRunCheckIn } from '../lib/runObservability';
import { markTaskNeedsAttentionForMissingSemanticHandoff } from '../lib/lifecycleHandoff';
import { applyTaskOutcome } from '../lib/taskOutcome';

jest.mock('../db/client', () => ({
  getDb: jest.fn(),
}));

jest.mock('../lib/runObservability', () => ({
  recordRunCheckIn: jest.fn(),
}));

jest.mock('../lib/taskOutcome', () => ({
  applyTaskOutcome: jest.fn(),
}));

jest.mock('../lib/lifecycleHandoff', () => ({
  taskRequiresSemanticOutcome: jest.fn(() => true),
  markTaskNeedsAttentionForMissingSemanticHandoff: jest.fn(),
}));

describe('OpenClawRuntime terminal failure handling', () => {
  let db: Pick<Database.Database, 'prepare'>;

  beforeEach(() => {
    jest.clearAllMocks();

    const statements = new Map<string, { get?: jest.Mock; run?: jest.Mock }>([
      [
        `
        SELECT status, lifecycle_outcome_posted_at, task_outcome, task_id, session_key
        FROM job_instances
        WHERE id = ?
      `,
        {
          get: jest.fn().mockReturnValue({
            status: 'running',
            lifecycle_outcome_posted_at: null,
            task_outcome: null,
            task_id: 383,
            session_key: 'agent:test:hook:atlas:jobrun:1757',
          }),
        },
      ],
      [
        `
    SELECT content
    FROM chat_messages
    WHERE instance_id = ?
      AND role = 'assistant'
    ORDER BY timestamp DESC
    LIMIT 8
  `,
        {
          all: jest.fn?.(),
        } as never,
      ],
      [
        `
        UPDATE job_instances
        SET status = ?,
            started_at = COALESCE(started_at, ?),
            completed_at = COALESCE(completed_at, ?),
            runtime_ended_at = COALESCE(runtime_ended_at, ?),
            runtime_end_success = COALESCE(runtime_end_success, ?),
            runtime_end_error = COALESCE(?, runtime_end_error),
            runtime_end_source = COALESCE(?, runtime_end_source)
        WHERE id = ?
          AND status IN ('running', 'dispatched')
          AND runtime_ended_at IS NULL
      `,
        {
          run: jest.fn().mockReturnValue({ changes: 1 }),
        },
      ],
      [
        `
        INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp, event_type, event_meta)
        SELECT ?, agent_id, id, 'system', ?, ?, 'turn_end', ?
        FROM job_instances
        WHERE id = ?
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          timestamp = excluded.timestamp,
          event_type = excluded.event_type,
          event_meta = excluded.event_meta
      `,
        {
          run: jest.fn(),
        },
      ],
      [
        `
        UPDATE job_instances
        SET response = json_set(COALESCE(response, '{}'), '$.runtimeEnd', json(?))
        WHERE id = ?
      `,
        {
          run: jest.fn(),
        },
      ],
      [
        `
          SELECT ji.task_id, ji.agent_id,
                 t.status AS task_status,
                 t.task_type,
                 t.sprint_id,
                 s.sprint_type,
                 t.review_branch,
                 t.review_commit,
                 t.review_url,
                 t.qa_verified_commit,
                 t.qa_tested_url,
                 t.merged_commit,
                 t.deployed_commit,
                 t.deploy_target,
                 t.deployed_at
          FROM job_instances ji
          LEFT JOIN tasks t ON t.id = ji.task_id
          LEFT JOIN sprints s ON s.id = t.sprint_id
          WHERE ji.id = ?
        `,
        {
          get: jest.fn().mockReturnValue({
            task_id: 383,
            agent_id: 42,
            task_status: 'review',
            task_type: null,
            sprint_id: 9,
            sprint_type: 'enhancement',
            review_branch: 'cinder-backend/task-403-prevent-outcome-less-run-completions-fro',
            review_commit: '27bf9e9fb2f32af10d3f8cbd067f76a59b535240',
            review_url: 'http://localhost:3510/tasks/403',
            qa_verified_commit: '27bf9e9fb2f32af10d3f8cbd067f76a59b535240',
            qa_tested_url: 'http://localhost:3510/tasks/403',
            merged_commit: null,
            deployed_commit: null,
            deploy_target: null,
            deployed_at: null,
          }),
        },
      ],
    ]);

    db = {
      prepare: jest.fn((sql: string) => {
        const stmt = statements.get(sql);
        if (!stmt) throw new Error(`Unexpected SQL: ${sql}`);
        return stmt;
      }),
    } as unknown as Pick<Database.Database, 'prepare'>;

    const { getDb } = jest.requireMock('../db/client') as { getDb: jest.Mock };
    getDb.mockReturnValue(db);

    (db.prepare(`
    SELECT content
    FROM chat_messages
    WHERE instance_id = ?
      AND role = 'assistant'
    ORDER BY timestamp DESC
    LIMIT 8
  `) as unknown as { all: jest.Mock }).all.mockReturnValue([]);
  });

  it('quarantines missing lifecycle handoff after runtime success on lifecycle-managed lanes', async () => {
    const runtime = new OpenClawRuntime();
    const handleTurnEnd = (runtime as unknown as {
      handleTurnEnd: (instanceId: number, event: { success: boolean; reason: string; sessionKey: string; endedAt: string; type: string }, onRuntimeEnd?: jest.Mock) => Promise<void>;
    }).handleTurnEnd.bind(runtime);

    await handleTurnEnd(1757, {
      type: 'runEnded',
      success: true,
      reason: 'completed',
      sessionKey: 'agent:test:hook:atlas:jobrun:1757',
      endedAt: new Date().toISOString(),
    });

    expect(recordRunCheckIn).toHaveBeenCalledWith(db, expect.objectContaining({
      instanceId: 1757,
      stage: 'completion',
      runtimeEndSuccess: true,
      outcome: 'completed',
      summary: 'OpenClaw runtime ended without required lifecycle outcome',
    }));
    expect(applyTaskOutcome).not.toHaveBeenCalled();
    expect(markTaskNeedsAttentionForMissingSemanticHandoff).toHaveBeenCalledWith(db, expect.objectContaining({
      taskId: 383,
      instanceId: 1757,
      lane: 'review',
      priorTaskStatus: 'review',
      reviewQaDeployEvidenceRecorded: 'yes',
    }));
  });

  it('posts a failed task outcome when provider-limit failure is detected behind a successful terminal event', async () => {
    const { taskRequiresSemanticOutcome } = jest.requireMock('../lib/lifecycleHandoff') as { taskRequiresSemanticOutcome: jest.Mock };
    taskRequiresSemanticOutcome.mockReturnValue(false);
    (db.prepare(`
    SELECT content
    FROM chat_messages
    WHERE instance_id = ?
      AND role = 'assistant'
    ORDER BY timestamp DESC
    LIMIT 8
  `) as unknown as { all: jest.Mock }).all.mockReturnValue([
      { content: 'Agent failed before reply: provider rate limit exceeded (429 too many requests)' },
    ]);

    const runtime = new OpenClawRuntime();
    const handleTurnEnd = (runtime as unknown as {
      handleTurnEnd: (instanceId: number, event: { success: boolean; reason: string; sessionKey: string; endedAt: string; type: string }, onRuntimeEnd?: jest.Mock) => Promise<void>;
    }).handleTurnEnd.bind(runtime);

    await handleTurnEnd(1757, {
      type: 'runEnded',
      success: true,
      reason: 'completed',
      sessionKey: 'agent:test:hook:atlas:jobrun:1757',
      endedAt: new Date().toISOString(),
    });

    expect(recordRunCheckIn).toHaveBeenCalledWith(db, expect.objectContaining({
      instanceId: 1757,
      stage: 'completion',
      runtimeEndSuccess: false,
      outcome: 'failed',
      summary: expect.stringContaining('rate limit exceeded'),
    }));
    expect(applyTaskOutcome).toHaveBeenCalledWith(db, expect.objectContaining({
      taskId: 383,
      outcome: 'failed',
      instanceId: 1757,
      failureClass: 'infra_failure',
      failureDetail: expect.stringContaining('rate limit exceeded'),
    }));
  });
});
