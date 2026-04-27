import cron from 'node-cron';
import { getDb } from '../db/client';
import { attachInstanceToTask, selectTaskForAgent } from '../lib/runObservability';
import { writeTaskStatusChange } from '../lib/taskHistory';
import {
  buildDispatchMessage, buildDispatchTaskNotesSection, buildInstanceCallbackContract,
  dispatchInstance, getDispatchTaskNotesContext,
} from '../services/dispatcher';
import { resolveTransportMode } from '../services/contracts';
import { getAgentHqBaseUrl } from '../lib/agentHqBaseUrl';
import { buildHookSessionKey, resolveRuntimeAgentSlug } from '../lib/sessionKeys';

interface Agent {
  id: number;
  name: string;
  session_key: string;
  openclaw_agent_id: string | null;
  model: string | null;
  /** Container hooks URL — when set, dispatch routes to this container instead of the host gateway. */
  hooks_url: string | null;
  /** Per-agent Authorization header for hooks_url dispatch (task #431). */
  hooks_auth_header: string | null;
  /** Agent runtime type (openclaw, veri, claude-code, etc.). */
  runtime_type: string | null;
  /** Agent runtime config JSON. */
  runtime_config: unknown;
  /* ── Merged job-template fields (task #459) ── */
  job_title: string;
  project_id: number | null;
  sprint_id: number | null;
  schedule: string;
  pre_instructions: string;
  skill_name: string | null;
  enabled: number;
}

interface TaskDispatchContextRow {
  status: string;
  task_type: string | null;
  sprint_type: string | null;
}

const activeTasks = new Map<number, cron.ScheduledTask>();

function loadAndSchedule(): void {
  const db = getDb();
  const agents = db.prepare(`
    SELECT * FROM agents WHERE enabled = 1 AND schedule != ''
  `).all() as Agent[];

  // Stop tasks that are no longer present or have changed
  for (const [id, task] of activeTasks) {
    const still = agents.find(a => a.id === id);
    if (!still) {
      task.stop();
      activeTasks.delete(id);
      console.log(`[scheduler] Stopped job for agent ${id}`);
    }
  }

  // Add/update tasks
  for (const agent of agents) {
    if (!cron.validate(agent.schedule)) {
      console.warn(`[scheduler] Invalid cron for agent ${agent.id} "${agent.job_title}": ${agent.schedule}`);
      continue;
    }

    if (activeTasks.has(agent.id)) {
      // Already scheduled — skip (we'd need to check if schedule changed for refresh)
      continue;
    }

    const task = cron.schedule(agent.schedule, async () => {
      console.log(`[scheduler] Firing job for agent ${agent.id}: "${agent.job_title}"`);

      // Look up project if agent has one
      let projectName: string | null = null;
      let projectContext: string | null = null;
      if (agent.project_id) {
        const project = db.prepare('SELECT name, context_md FROM projects WHERE id = ?').get(agent.project_id) as { name: string; context_md: string } | undefined;
        if (project) {
          projectName = project.name;
          projectContext = project.context_md;
        }
      }

      // Look up sprint goal if agent belongs to a sprint
      let sprintGoal: string | null = null;
      if (agent.sprint_id) {
        const sprint = db.prepare('SELECT goal FROM sprints WHERE id = ?').get(agent.sprint_id) as { goal: string } | undefined;
        if (sprint?.goal) {
          sprintGoal = sprint.goal;
        }
      }

      // Check if agent is already running another instance
      const runningInstance = db.prepare(`
        SELECT id FROM job_instances
        WHERE agent_id = ? AND status IN ('queued', 'dispatched', 'running')
        ORDER BY created_at DESC
        LIMIT 1
      `).get(agent.id) as { id: number } | undefined;

      if (runningInstance) {
        console.log(`[scheduler] Skipping agent ${agent.id} "${agent.job_title}" — agent is busy (instance ${runningInstance.id} in progress)`);
        db.prepare(`
          INSERT INTO logs (agent_id, job_title, level, message)
          VALUES (?, ?, 'info', ?)
        `).run(agent.id, agent.job_title, `Scheduler: skipped — agent busy with instance ${runningInstance.id}`);
        return;
      }

      // Reset recurring tasks for this agent — with per-task history logging
      const recurringDone = db.prepare(`
        SELECT id FROM tasks WHERE agent_id = ? AND recurring = 1 AND status = 'done'
      `).all(agent.id) as Array<{ id: number }>;
      if (recurringDone.length > 0) {
        db.prepare(`
          UPDATE tasks
          SET status = 'todo',
              active_instance_id = NULL,
              updated_at = datetime('now')
          WHERE agent_id = ? AND recurring = 1 AND status = 'done'
        `).run(agent.id);
        for (const t of recurringDone) {
          writeTaskStatusChange(db, t.id, 'scheduler', 'done', 'todo');
        }
        console.log(`[scheduler] Reset ${recurringDone.length} recurring task(s) for agent ${agent.id} back to todo`);
      }

      const instanceResult = db.prepare(`
        INSERT INTO job_instances (agent_id, status)
        VALUES (?, 'queued')
      `).run(agent.id);

      const instanceId = instanceResult.lastInsertRowid as number;
      const taskId = selectTaskForAgent(db, agent.id);
      attachInstanceToTask(db, instanceId, taskId);

      // Look up task status for lifecycle contract generation
      let taskContext: TaskDispatchContextRow | null = null;
      if (taskId) {
        taskContext = db.prepare(`
          SELECT
            tasks.status,
            tasks.task_type,
            sprints.sprint_type
          FROM tasks
          LEFT JOIN sprints ON sprints.id = tasks.sprint_id
          WHERE tasks.id = ?
          LIMIT 1
        `).get(taskId) as TaskDispatchContextRow | undefined ?? null;
      }

      db.prepare(`
        INSERT INTO logs (instance_id, agent_id, job_title, level, message)
        VALUES (?, ?, ?, 'info', ?)
      `).run(instanceId, agent.id, agent.job_title, `Scheduler triggered job "${agent.job_title}" (instance ${instanceId})`);

      const taskNotesSection = taskId
        ? buildDispatchTaskNotesSection(getDispatchTaskNotesContext(db, {
            taskId,
            agentId: agent.id,
            currentInstanceId: instanceId,
          }))
        : '';

      // Build message via shared helper
      let message = buildDispatchMessage({
        preInstructions: agent.pre_instructions,
        skillName: agent.skill_name,
        projectName,
        projectContext,
        sprintGoal,
        taskNotesSection,
      });

      // Append lifecycle contract when task is available
      if (taskId) {
        const agentSlug = resolveRuntimeAgentSlug(agent)
          ?? agent.session_key.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
        const runSessionKey = buildHookSessionKey(instanceId);
        const contract = buildInstanceCallbackContract({
          instanceId,
          taskId,
          taskStatus: taskContext?.status ?? 'ready',
          taskType: taskContext?.task_type ?? null,
          sprintType: taskContext?.sprint_type ?? null,
          agentSlug,
          sessionKey: runSessionKey,
          transportMode: resolveTransportMode({
            runtimeType: agent.runtime_type,
            runtimeConfig: agent.runtime_config,
            hooksUrl: agent.hooks_url,
          }),
        });
        message += `\n\n${contract}`;
      } else {
        // Non-task dispatch — minimal completion instruction
        const completionUrl = getAgentHqBaseUrl();
        message += `\n\n---\n## Atlas HQ completion contract\nWhen you have fully completed this task, report back to Atlas HQ:\ncurl -s -X PUT ${completionUrl}/api/v1/instances/${instanceId}/complete \\\n  -H "Content-Type: application/json" \\\n  -d '{"status":"done","summary":"<one sentence summary of what you accomplished>"}'\n---`;
      }

      const effectiveModel = agent.model ?? null;

      try {
        await dispatchInstance({
          instanceId,
          agentId: agent.id,
          jobTitle: agent.job_title,
          sessionKey: agent.session_key,
          message,
          model: effectiveModel,
          timeoutSeconds: undefined,
          hooksUrl: agent.hooks_url,
          hooksAuthHeader: agent.hooks_auth_header,
          runtimeType: agent.runtime_type,
          runtimeConfig: agent.runtime_config,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] Agent ${agent.id} dispatch failed:`, errMsg);
        db.prepare(`
          INSERT INTO logs (instance_id, agent_id, job_title, level, message)
          VALUES (?, ?, ?, 'error', ?)
        `).run(instanceId, agent.id, agent.job_title, `Scheduler dispatch failed: ${errMsg}`);
      }
    });

    activeTasks.set(agent.id, task);
    console.log(`[scheduler] Scheduled agent ${agent.id} "${agent.job_title}" at "${agent.schedule}"`);
  }
}

export function startScheduler(): void {
  console.log('[scheduler] Starting...');
  loadAndSchedule();

  // Reload schedule every 60 seconds to pick up new/changed jobs
  setInterval(() => {
    loadAndSchedule();
  }, 60_000);

  console.log('[scheduler] Running — polling every 60s for job changes');
}
