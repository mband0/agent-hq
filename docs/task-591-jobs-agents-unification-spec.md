# Spec: Jobs → Agents Unification (Task #591)

**Objective:** Make `agents` the single canonical execution/routing object in Atlas HQ, eliminating `job_templates` as an independent entity.

---

## 1. Current State (after Task #459 Phases 0 + 3)

### Already done
- **Phase 0:** Added all job-template columns directly to `agents` table: `job_title`, `project_id`, `sprint_id`, `schedule`, `dispatch_mode`, `pre_instructions`, `skill_name`, `skill_names`, `enabled`, `timeout_seconds`. Backfilled from `job_templates`.
- **Phase 3:** Added `agent_id` columns to all tables that had `job_id` FKs (`task_routing_rules`, `sprint_job_assignments`, `sprint_job_schedules`, `task_creation_events`, `task_outcome_metrics`, `dispatch_log`). Backfilled from `job_templates.agent_id`.

### Still in place (to be resolved by this spec)
- `job_templates` table exists and has live data
- `job_instances.template_id` FK → `job_templates`
- `tasks.job_id` FK → `job_templates`
- `tasks.review_owner_agent_id` → `agents`
- `routing_config_legacy.job_id` FK → `job_templates`
- `task_routing_rules.job_id` FK → `job_templates`
- `sprint_job_assignments.job_id` FK → `job_templates`
- `sprint_job_schedules.job_id` FK → `job_templates`
- `sprint_schedule_fires.schedule_id` → `sprint_job_schedules`
- `task_creation_events.job_id` FK → `job_templates`
- `task_outcome_metrics.job_id` FK → `job_templates`
- `dispatch_log.job_id` FK → `job_templates`
- Dispatcher (`dispatcher.ts`) queries `job_templates` to resolve template_id, job_title, etc.
- Routing rules (`task_routing_rules`) resolve via `job_id` → `job_templates` → `agents`
- API routes: `GET/POST/PUT/DELETE /api/v1/jobs` still CRUD `job_templates`
- UI: agent detail and job management pages reference job_templates

---

## 2. Target Agent Schema

After unification, the `agents` table is the **sole canonical entity** for:

### 2a. Identity & Runtime
| Field | Source | Notes |
|-------|--------|-------|
| `id` | agents | PK — all FKs point here |
| `name` | agents | Human label, e.g. "Forge (Backend)" |
| `role` | agents | Description |
| `slug` | agents | URL-safe identifier |
| `session_key` | agents | OpenClaw session key |
| `workspace_path` | agents | Agent workspace dir |
| `os_user` | agents | OS-level isolation user |
| `openclaw_agent_id` | agents | OpenClaw agent registry ID |
| `runtime_type` | agents | `openclaw` / `veri` |
| `runtime_config` | agents | JSON runtime params |
| `hooks_url` | agents | Container routing URL |
| `hooks_auth_header` | agents | Per-agent auth header |
| `model` | agents | Default model override |
| `preferred_provider` | agents | Provider preference |
| `github_identity_id` | agents | FK to github_identities |
| `repo_path` | agents | Canonical git repo path |
| `status` | agents | idle/running/blocked |
| `last_active` | agents | Timestamp |
| `created_at` | agents | Timestamp |

### 2b. Execution Metadata (absorbed from job_templates)
| Field | Source | Notes |
|-------|--------|-------|
| `job_title` | job_templates.title | Display name for the execution lane |
| `dispatch_mode` | job_templates | `agentTurn` / `systemEvent` |
| `pre_instructions` | job_templates | Operating template / SOP text |
| `timeout_seconds` | job_templates | Max run duration (default 900) |

### 2c. Schedule
| Field | Source | Notes |
|-------|--------|-------|
| `schedule` | job_templates | Cron expression (empty = on-demand only) |

### 2d. Dispatch / Routing Config
| Field | Source | Notes |
|-------|--------|-------|
| `enabled` | job_templates | Master on/off switch |

**Routing config (stall thresholds, sort rules):** Currently in `routing_config_legacy` keyed by `job_id`. Migrate to new `routing_config_agents` keyed by `agent_id`, or add columns directly to `agents`:

| Field | Source | Notes |
|-------|--------|-------|
| `stall_threshold_min` | routing_config_legacy | Default 30 min |
| `max_retries` | routing_config_legacy | Default 3 |
| `sort_rules` | routing_config_legacy | JSON array of sort criteria |

**Recommendation:** Add these 3 columns to `agents` directly. They're per-agent operational config, not complex enough to warrant a separate table.

### 2e. Project & Sprint Binding
| Field | Source | Notes |
|-------|--------|-------|
| `project_id` | job_templates | FK to projects |
| `sprint_id` | job_templates | FK to sprints (primary sprint assignment) |

Sprint ↔ agent many-to-many: replace `sprint_job_assignments` with `sprint_agent_assignments`.

### 2f. Skills
| Field | Source | Notes |
|-------|--------|-------|
| `skill_name` | job_templates | Legacy single skill (nullable) |
| `skill_names` | job_templates | JSON array of skill slugs |

---

## 3. Field Migration Map

### 3a. job_templates → agents (already done in Phase 0)
All operational fields already copied. No new columns needed on `agents` except:
- `stall_threshold_min INTEGER NOT NULL DEFAULT 30`
- `max_retries INTEGER NOT NULL DEFAULT 3`
- `sort_rules TEXT NOT NULL DEFAULT '[]'`

Backfill from `routing_config_legacy` where a matching `job_id` → `agent_id` exists.

### 3b. FK Redirections

| Table | Old FK | New FK | Status |
|-------|--------|--------|--------|
| `job_instances` | `template_id → job_templates` | `template_id` stays (renamed conceptually; points to agent via `agent_id`) | **Phase 4** — stop writing template_id on new instances; read from agent_id only |
| `tasks` | `job_id → job_templates` | `agent_id → agents` | Phase 3 backfilled agent_id; **Phase 4** — stop writing job_id on new tasks |
| `tasks` | `review_owner_agent_id` | `review_owner_agent_id → agents` | Canonical review-owner FK |
| `task_routing_rules` | `job_id → job_templates` | `agent_id → agents` | Phase 3 backfilled; **Phase 4** — queries read agent_id; stop writing job_id |
| `routing_config_legacy` | `job_id → job_templates` | Absorb into agents table | **Phase 4** — read from agents.stall_threshold_min etc. |
| `sprint_job_schedules` | `job_id → job_templates` | `agent_id → agents` | Phase 3 backfilled; **Phase 4** — stop writing job_id |
| `sprint_job_assignments` | `job_id → job_templates` | `agent_id → agents` | Phase 3 backfilled; **Phase 4** — stop writing job_id |
| `task_creation_events` | `job_id → job_templates` | `agent_id → agents` | Phase 3 backfilled; **Phase 4** — stop writing job_id |
| `task_outcome_metrics` | `job_id → job_templates` | `agent_id → agents` | Phase 3 backfilled; **Phase 4** — stop writing job_id |
| `dispatch_log` | `job_id → job_templates` | `agent_id → agents` | Phase 3 backfilled; **Phase 4** — stop writing job_id |

---

## 4. Routing Rules Target Agents Directly

### 4a. task_routing_rules
Current: `(project_id, task_type, status) → job_id` → `job_templates.agent_id`
Target: `(project_id, task_type, status) → agent_id` directly

**Migration:**
1. All rows already have `agent_id` backfilled (Phase 3)
2. Dispatcher switches to read `agent_id` instead of joining through `job_templates`
3. API routes (`/routing/rules`) accept `agent_id` in POST/PUT; `job_id` accepted as compat alias (resolved to agent_id via job_templates lookup, logged as deprecated)
4. UI updates to show agent name/dropdown instead of job dropdown

### 4b. routing_config_legacy → agents
Current: `routing_config_legacy.job_id → stall_threshold_min, max_retries, sort_rules`
Target: These fields live on `agents` directly

**Migration:**
1. Add columns to agents (Phase 4 schema migration)
2. Backfill from routing_config_legacy
3. Dispatcher reads from agents table
4. Drop routing_config_legacy (Phase 5)

---

## 5. Project/Sprint Associations After Refactor

### Projects
- `agents.project_id` is the canonical project binding (already exists)
- One agent → one project (1:N from project side)
- Tasks inherit project_id from their assigned agent

### Sprints
- `agents.sprint_id` = primary sprint assignment (already exists)
- `sprint_agent_assignments(sprint_id, agent_id)` = secondary sprint access (replaces `sprint_job_assignments`)
- Sprint schedules: `sprint_agent_schedules` replaces `sprint_job_schedules`
- Sprint fires: `sprint_schedule_fires.schedule_id` stays as-is (FK to schedule table, not to job_templates)

---

## 6. Implementation Phases

### Phase 4: Dual-Write Stop (Backend)
**Goal:** All new writes go through agents; stop writing job_id/template_id.

1. **Dispatcher** (`dispatcher.ts`):
   - Candidate selection: query `agents` directly instead of joining `job_templates`
   - Agent-level fields (pre_instructions, schedule, timeout, enabled, model) read from `agents`
   - `job_instances` creation: still write `template_id` for backward compat but primary keying is `agent_id`
   - Remove `hasActiveInstance(db, rule.job_id)` → use `agent_id`

2. **Task routing** (`task_routing_rules`):
   - Queries read `agent_id` column; `job_id` ignored when `agent_id` is present
   - New rule creation writes `agent_id`; `job_id` populated as compat shim via lookup

3. **Task writes** (`tasks`):
   - `agent_id` is the canonical assignment field
   - `job_id` written as compat shim (nullable, deprecated)
   - `review_owner_agent_id` added and used as the sole review-owner field

4. **Routing config**:
   - Add `stall_threshold_min`, `max_retries`, `sort_rules` to `agents`
   - Backfill from `routing_config_legacy`
   - Dispatcher reads from `agents`

5. **Sprint tables**:
   - Rename `sprint_job_assignments` → `sprint_agent_assignments` (or create new + migrate)
   - Rename `sprint_job_schedules` → `sprint_agent_schedules` (or create new + migrate)

6. **Schema migration** in `schema.ts`:
   - Add new agent columns (stall config)
   - Add `review_owner_agent_id` to tasks
   - Backfill from legacy tables
   - All migrations are idempotent (try/catch pattern)

### Phase 5: API Surface Update (Backend + Frontend)
**Goal:** API returns agents as the canonical object; jobs endpoints deprecated.

1. **Jobs API** (`/api/v1/jobs`):
   - `GET /jobs` → returns agents data shaped as jobs (compat shim)
   - Response includes `Deprecation: true` header
   - `POST /jobs` → creates/updates an agent (not a job_template row)
   - `PUT /jobs/:id` → updates the linked agent
   - `DELETE /jobs/:id` → soft-deprecate only (no delete — data still referenced)

2. **Agents API** (`/api/v1/agents`):
   - Already returns all necessary fields
   - Remove `job_template_id` join — no longer needed
   - Add `stall_threshold_min`, `max_retries`, `sort_rules` to response

3. **Routing API** (`/api/v1/routing`):
   - `/routing/config` → read from agents; response keyed by agent_id
   - `/routing/rules` → accept agent_id; job_id treated as deprecated alias

4. **Frontend**:
   - Agent management page absorbs job template editing
   - Sprint → job assignment UI becomes sprint → agent assignment
   - Routing rules UI shows agent picker instead of job picker
   - Jobs page redirects to agents or shows deprecation notice

### Phase 6: Cleanup (Backend)
**Goal:** Remove all job_templates dependencies.

1. Stop writing `job_id` / `template_id` on new rows entirely
2. Drop `job_templates` table (or rename to `job_templates_archive`)
3. Drop `routing_config_legacy` table
4. Drop `sprint_job_assignments` (replaced by `sprint_agent_assignments`)
5. Drop `sprint_job_schedules` (replaced by `sprint_agent_schedules`)
6. Remove `job_id` columns from tasks, task_routing_rules, etc. (or leave as nullable archive)
7. Remove `template_id` from job_instances (or leave as nullable archive)
8. Remove jobs API routes (or keep as permanent redirect)
9. Clean up dispatcher.ts — remove all job_templates joins and lookups

---

## 7. Backwards Compatibility & Migration Strategy

### Compat Period (Phases 4–5)
- **Dual-FK:** Both `job_id` and `agent_id` written on new rows
- **Read preference:** Code reads `agent_id` first, falls back to `job_id → job_templates.agent_id`
- **API compat:** `/api/v1/jobs` still works but returns deprecation headers
- **UI:** Can show both views; agent view is primary
- **Agent contract / pre_instructions:** The `{this_job_id}` placeholder in SOP templates (e.g. Archer's prospecting instructions reference `job_id={this_job_id}`) needs migration to `{this_agent_id}`

### What Is Fully Removed (Phase 6)
- `job_templates` table → archived or dropped
- `routing_config_legacy` table → dropped (data in agents)
- All `job_id` writes → stopped
- `/api/v1/jobs` CRUD → removed or permanent redirect to `/agents`

### What Is Temporarily Shimmed (Phases 4–5)
- `job_id` columns on tasks, routing rules, telemetry tables → written for compat, not read
- `template_id` on job_instances → written for compat, agent_id is primary
- `/api/v1/jobs` endpoints → return agent data shaped as jobs
- `review_owner_agent_id` is the only review-owner field written

---

## 8. Multi-Job Agents (Edge Case)

Some agents currently have **multiple job_templates** (e.g. Flint has job #46 "Agency — Backend 2" + job #48 "Agency — Flint Weekly Reflection"). The Phase 0 backfill picked the most recent job per agent.

### Resolution
Agents with genuinely different operational modes (different pre_instructions, different schedules) need one of:
1. **Split into separate agents** — one agent per execution lane (recommended for Flint: separate "Flint (Backend)" and "Flint (Reflection)" agents)
2. **Multi-mode support** — agent has a `modes` JSON column with named configs (over-engineered for current needs)

**Recommendation:** Split. The schema already supports it. Task #459 logged warnings for multi-job agents. The split creates:
- Agent A: Flint (Backend) — job_title "Agency — Backend 2", schedule "", pre_instructions for task work
- Agent B: Flint (Reflection) — job_title "Agency — Flint Weekly Reflection", schedule "10 10 * * 0", pre_instructions for reflection

Same pattern for Iris (Frontend 2 + Reflection).

---

## 9. Acceptance Criteria

- [ ] Target agent schema is documented with all fields and their sources
- [ ] Every job_template field has an explicit mapping to agents or is explicitly dropped
- [ ] FK migration path is documented for every table referencing job_templates
- [ ] Dispatcher can select candidates and fire runs using agents table only (no job_templates join required)
- [ ] Routing rules (task_routing_rules) resolve via agent_id directly
- [ ] Stall/retry config lives on agents (no routing_config_legacy dependency)
- [ ] Sprint associations work via agent_id
- [ ] Multi-job agents are resolved (split into separate agents)
- [ ] API compat layer documented: /jobs returns agent data with deprecation header
- [ ] Pre_instructions `{this_job_id}` placeholder migrated to `{this_agent_id}`
- [ ] Phase 4 can ship without breaking Phase 5/6 (backward compat maintained)

---

## 10. Dependencies & Sequencing

```
Phase 4 (Dual-Write Stop)         — Backend only, no UI changes
  ├── 4a: Add stall/retry columns to agents + backfill
  ├── 4b: Add review_owner_agent_id to tasks + backfill
  ├── 4c: Split multi-job agents (Flint, Iris)
  ├── 4d: Dispatcher reads agents-only
  ├── 4e: Routing rules read agent_id
  └── 4f: Sprint tables renamed/migrated

Phase 5 (API + UI)                 — Depends on Phase 4
  ├── 5a: Jobs API returns agent data (compat)
  ├── 5b: Agents API drops job_template_id join
  ├── 5c: Routing API accepts agent_id
  └── 5d: Frontend agent management absorbs job editing

Phase 6 (Cleanup)                  — Depends on Phase 5 + stabilization period
  ├── 6a: Stop dual-writing job_id columns
  ├── 6b: Archive/drop job_templates
  ├── 6c: Drop routing_config_legacy
  └── 6d: Remove jobs API routes
```

### Task Breakdown Recommendation
- **Task A (Backend):** Phase 4a + 4b + 4d + 4e — schema migration + dispatcher + routing reads
- **Task B (Backend):** Phase 4c — split multi-job agents (Flint, Iris)
- **Task C (Backend):** Phase 4f — sprint table rename/migration
- **Task D (Backend):** Phase 5a + 5b + 5c — API surface update
- **Task E (Frontend):** Phase 5d — UI updates (agent management absorbs job editing)
- **Task F (Backend):** Phase 6 — cleanup (after stabilization)
