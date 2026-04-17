# Atlas HQ MCP Server — v1 Product & Technical Spec

**Task:** #576  
**Author:** Wren (PM)  
**Date:** 2026-04-03  
**Sprint:** Atlas HQ — MCP Support  
**Status:** Implementation-ready  

---

## 1. Overview

Atlas HQ will expose a Model Context Protocol (MCP) server so external AI clients — including the ChatGPT desktop/mobile app, Claude desktop/mobile app, and any MCP-compatible agent — can read and manage Atlas HQ projects, boards, tasks, and related workflows.

This spec defines the **v1 capability surface**: what's in scope, what's deferred, read/write boundaries, safety rules, response shaping, and success criteria.

---

## 2. User Stories

| # | As a… | I want to… | So that… |
|---|-------|-----------|----------|
| US-1 | User in ChatGPT/Claude app | ask "what's on my sprint board?" | I can see current sprint tasks without opening the Atlas UI |
| US-2 | User in ChatGPT/Claude app | ask "show me task #576" | I can get full task detail including status, assignee, notes |
| US-3 | User in ChatGPT/Claude app | say "create a task for fixing the login bug in project Agency" | a task is created in Atlas HQ from conversation |
| US-4 | User in ChatGPT/Claude app | say "move task #580 to in_progress" | I can advance tasks through the board from chat |
| US-5 | User in ChatGPT/Claude app | say "add a note to task #576: spec is approved" | I can annotate tasks without context-switching |
| US-6 | User in ChatGPT/Claude app | ask "what projects do I have?" | I can browse projects and pick one to drill into |
| US-7 | User in ChatGPT/Claude app | ask "what agents are assigned?" | I can see agent/job assignments for a project or sprint |

---

## 3. v1 Scope — Resources & Operations

### 3.1 In-Scope Resources

| Resource | Read | Write | Notes |
|----------|------|-------|-------|
| **Projects** | ✅ List, Get, Metrics | ❌ | Read-only for v1. Create/update/delete is admin-level. |
| **Sprints / Boards** | ✅ List, Get, Metrics | ❌ | Read-only for v1. Sprint lifecycle is admin-level. |
| **Tasks** | ✅ List (filtered), Get detail | ✅ Create, Update fields, Move status | Core MCP surface — see §3.2 for details. |
| **Task Notes** | ✅ List notes for a task | ✅ Add note | Comment/annotation support. |
| **Task Blockers** | ✅ Visible in task detail | ✅ Add blocker, Remove blocker | Unblock tracking from chat. |
| **Task History** | ✅ Get history for a task | — | Audit trail, read-only. |
| **Jobs / Agents** | ✅ List jobs, Get job detail, List agents | ❌ | Read-only. Agent/job config is admin-level. |

### 3.2 Task Write Operations — Detail

| Operation | MCP Tool | Allowed Fields / Behavior |
|-----------|----------|--------------------------|
| **Create task** | `atlas_create_task` | `title` (required), `description`, `project_id` (required), `sprint_id`, `priority`, `task_type`, `story_points` |
| **Update task** | `atlas_update_task` | `title`, `description`, `priority`, `sprint_id`, `task_type`, `story_points`. Cannot change `project_id` after creation. |
| **Move task status** | `atlas_move_task` | `status` — must be a valid transition from current status. Server validates against the workflow transition table. |
| **Add note** | `atlas_add_task_note` | `content` (required), `author` (optional, defaults to "mcp-client") |
| **Add blocker** | `atlas_add_blocker` | `blocked_by_task_id` (required) |
| **Remove blocker** | `atlas_remove_blocker` | `blocker_id` (required) |

### 3.3 Out of Scope for v1

| Resource / Action | Reason |
|-------------------|--------|
| Project create/update/delete | Admin-level, low-frequency, risky from external clients |
| Sprint create/update/close/complete | Admin-level lifecycle management |
| Task delete | Destructive; no undo path |
| Task cancel | Requires understanding of dispatch/instance state; defer |
| Task outcome posting | Agent contract action; not appropriate for external human clients |
| Task evidence (review, QA, deploy) | Internal CI/CD workflow, not user-facing |
| Task attachments | File upload over MCP is unsupported / unreliable in v1 clients |
| Artifact/file management | Internal agent workspace concern |
| Routing / workflow config | Admin-only system config |
| Provider / settings management | Admin-only system config |
| Instance management | Internal dispatch machinery |
| Browser pool | Internal agent tooling |

---

## 4. MCP Tool Definitions

### 4.1 Read Tools

#### `atlas_list_projects`
- **Description:** List all projects in Atlas HQ.
- **Parameters:** None.
- **Returns:** Array of `{ id, name, description, job_count, created_at }`.

#### `atlas_get_project`
- **Description:** Get a project by ID, including metrics.
- **Parameters:** `project_id` (required, number).
- **Returns:** `{ id, name, description, job_count, created_at, metrics: { … } }`.

#### `atlas_list_sprints`
- **Description:** List sprints, optionally filtered by project.
- **Parameters:** `project_id` (optional), `include_closed` (optional, boolean, default false).
- **Returns:** Array of `{ id, name, status, project_id, created_at }`.

#### `atlas_get_sprint`
- **Description:** Get sprint detail and metrics.
- **Parameters:** `sprint_id` (required, number).
- **Returns:** `{ id, name, status, metrics: { … }, jobs: [ … ] }`.

#### `atlas_list_tasks`
- **Description:** List tasks with filters.
- **Parameters:** `project_id` (optional), `sprint_id` (optional), `status` (optional, string), `limit` (optional, default 50, max 100), `offset` (optional, default 0).
- **Returns:** `{ tasks: [ … ], total, hasMore }`. Each task includes: `id, title, status, priority, task_type, story_points, sprint_name, agent_name, created_at, updated_at`.

#### `atlas_get_task`
- **Description:** Get full task detail.
- **Parameters:** `task_id` (required, number).
- **Returns:** Full task object including notes count, blocker info, blocking info, sprint/agent context.

#### `atlas_get_task_notes`
- **Description:** Get notes for a task.
- **Parameters:** `task_id` (required, number).
- **Returns:** Array of `{ id, content, author, created_at }`.

#### `atlas_get_task_history`
- **Description:** Get status/change history for a task.
- **Parameters:** `task_id` (required, number).
- **Returns:** Array of history entries.

#### `atlas_list_jobs`
- **Description:** List jobs (role definitions), optionally by project.
- **Parameters:** `project_id` (optional).
- **Returns:** Array of `{ id, title, agent_id, agent_name, project_id }`.

#### `atlas_list_agents`
- **Description:** List registered agents.
- **Parameters:** None.
- **Returns:** Array of `{ id, name, runtime, status }`.

### 4.2 Write Tools

#### `atlas_create_task`
- **Description:** Create a new task.
- **Parameters:** `title` (required), `project_id` (required), `description` (optional), `sprint_id` (optional), `priority` (optional: low/medium/high/critical, default medium), `task_type` (optional, default "backend"), `story_points` (optional).
- **Returns:** Created task object.

#### `atlas_update_task`
- **Description:** Update fields on an existing task.
- **Parameters:** `task_id` (required), plus any of: `title`, `description`, `priority`, `sprint_id`, `task_type`, `story_points`.
- **Returns:** Updated task object.

#### `atlas_move_task`
- **Description:** Move a task to a new status. The server validates the transition is legal.
- **Parameters:** `task_id` (required), `status` (required, string).
- **Returns:** Updated task object, or error if transition is invalid.

#### `atlas_add_task_note`
- **Description:** Add a note/comment to a task.
- **Parameters:** `task_id` (required), `content` (required), `author` (optional, default "mcp-client").
- **Returns:** Created note object.

#### `atlas_add_blocker`
- **Description:** Mark a task as blocked by another task.
- **Parameters:** `task_id` (required), `blocked_by_task_id` (required).
- **Returns:** Created blocker record.

#### `atlas_remove_blocker`
- **Description:** Remove a blocker relationship.
- **Parameters:** `task_id` (required), `blocker_id` (required).
- **Returns:** `{ ok: true }`.

---

## 5. Response Shaping for Agent Clients

### 5.1 Principles

1. **Flat, predictable structure.** Each tool returns a JSON object with a consistent top-level shape: `{ ok: true, data: … }` on success, `{ ok: false, error: "…" }` on failure.
2. **Agent-friendly field names.** Use snake_case, avoid nested objects where a flat field suffices.
3. **Concise by default.** List endpoints return summary objects; detail endpoints return full objects. No need for separate "summary" vs "full" modes in v1.
4. **Pagination.** List tools that can return large sets include `total`, `hasMore`, `limit`, `offset` in the response envelope.
5. **Error messages are actionable.** Include what went wrong and what the valid options are (e.g., "Invalid status transition from 'todo' to 'done'. Valid transitions: todo → ready, todo → cancelled").

### 5.2 Example Responses

**Success — list:**
```json
{
  "ok": true,
  "data": {
    "tasks": [
      { "id": 576, "title": "Spec Atlas HQ MCP…", "status": "in_progress", "priority": "high" }
    ],
    "total": 42,
    "hasMore": true
  }
}
```

**Success — single:**
```json
{
  "ok": true,
  "data": {
    "id": 576,
    "title": "Spec Atlas HQ MCP…",
    "status": "in_progress",
    "priority": "high",
    "description": "…",
    "notes_count": 3,
    "blockers": [],
    "blocking": [577, 578, 579, 580, 581]
  }
}
```

**Error:**
```json
{
  "ok": false,
  "error": "Task #999 not found."
}
```

---

## 6. Safety & Guardrails

### 6.1 Read Operations
- **No restrictions.** All read tools are safe and idempotent.

### 6.2 Write Operations — Safety Rules

| Rule | Applies to | Behavior |
|------|-----------|----------|
| **Required fields validated** | All writes | Return clear error if required fields missing |
| **Status transition validation** | `atlas_move_task` | Server checks the workflow transition table. Invalid transitions return an error with valid options. |
| **No delete via MCP** | All resources | Delete endpoints are not exposed in v1 |
| **No admin operations** | Projects, Sprints, Routing, Providers, Settings | Not exposed; cannot be reached |
| **No dispatch/instance manipulation** | Instances, Outcomes, Evidence | Agent-internal contract; not exposed |
| **Audit trail** | All writes | Every write tool logs the action to task history with source="mcp" |
| **Rate limiting** | All tools | Server-side rate limit: 60 requests/minute per MCP session (configurable) |

### 6.3 What We Explicitly Do NOT Need in v1

- **Confirmation dialogs / "are you sure?" flows.** MCP tool calls are already user-initiated in ChatGPT/Claude. The AI client handles confirmation UX. Atlas HQ validates transitions server-side; that's sufficient.
- **Per-field write permissions.** Overkill for v1. If you can write to a task, you can update any writable field.
- **Undo / rollback.** Task history provides an audit trail, but no programmatic undo. This matches existing Atlas HQ behavior.

---

## 7. Auth & Transport (Handoff to Task #577)

This spec intentionally **defers** the full auth/security model to Task #577. However, it establishes these product-level constraints for that task:

1. **v1 transport: stdio (local).** The MCP server runs as a local process that ChatGPT/Claude app connects to via stdio. This is the standard MCP client integration pattern.
2. **v1 assumes single-user, local-only access.** No remote/network MCP transport in v1.
3. **No per-user identity in v1.** The MCP server acts as the local user. All writes are attributed to "mcp-client" unless the AI client passes an author name.
4. **Remote transport is a v2 concern.** When/if Atlas HQ MCP needs to serve remote clients, Task #577's auth model becomes critical.

---

## 8. Implementation Guidance

### 8.1 Architecture

```
ChatGPT / Claude app
    ↓ (stdio, MCP protocol)
Atlas HQ MCP Server (Node.js process)
    ↓ (HTTP, localhost)
Atlas HQ API (localhost:3501)
```

- The MCP server is a **thin adapter** — it translates MCP tool calls into Atlas HQ REST API calls.
- It does NOT access the database directly. All reads/writes go through the existing API.
- This keeps the MCP server stateless and easy to test independently.

### 8.2 MCP Server Package

- Use the official `@modelcontextprotocol/sdk` package for Node.js.
- Register tools using the SDK's `server.tool()` pattern.
- Each tool maps to one or two Atlas HQ API calls.

### 8.3 Tool Naming Convention

- Prefix all tools with `atlas_` to namespace them clearly when a user has multiple MCP servers connected.
- Use snake_case: `atlas_list_tasks`, `atlas_get_task`, `atlas_create_task`, etc.

### 8.4 MCP Resources (Read-Only Context)

In addition to tools, the MCP server should expose **MCP Resources** for key reference data:

| Resource URI | Content | Purpose |
|-------------|---------|---------|
| `atlas://workflow/statuses` | List of valid task statuses and their transitions | Helps AI clients understand valid moves |
| `atlas://workflow/task-types` | List of valid task types | Helps AI clients set task_type correctly |
| `atlas://projects/summary` | Compact project list | Quick orientation context |

These are optional for MVP but significantly improve agent accuracy by providing grounding context.

---

## 9. Success Criteria

| Criterion | How to Verify |
|-----------|---------------|
| ChatGPT app can connect to Atlas HQ MCP server | Manual test: configure MCP in ChatGPT settings, verify tool list appears |
| Claude app can connect to Atlas HQ MCP server | Manual test: configure MCP in Claude settings, verify tool list appears |
| All 10 read tools return correct data | Automated or manual smoke tests against a populated Atlas HQ instance |
| All 6 write tools work end-to-end | Create task → update → add note → add blocker → move status → verify in UI |
| Invalid transitions are rejected with clear errors | Attempt illegal status moves, confirm error messages |
| No admin/destructive operations are reachable | Audit tool list: confirm no delete, no config, no evidence endpoints |
| Response format is consistent across all tools | Review all tool responses for `{ ok, data }` / `{ ok, error }` shape |
| Performance: tool calls complete in <2s | Time representative calls; API is local so this should be trivial |

---

## 10. Dependencies & Sequencing

```
#576 (this spec) ──→ #577 (auth/security model)
       │                    │
       └──→ #578 (server foundation + transport) ←──┘
                    │
            ┌───────┴───────┐
            ↓               ↓
       #579 (read tools)  #580 (write tools)
            │               │
            └───────┬───────┘
                    ↓
              #581 (docs)
```

Task #577 (auth) and this spec (#576) can unblock #578 in parallel. Read tools (#579) and write tools (#580) can be worked in parallel after the server foundation is up. Docs (#581) comes last.

---

## 11. Open Questions (for Masiah / stakeholder input)

| # | Question | Recommended Default | Impact if Wrong |
|---|----------|-------------------|-----------------|
| Q1 | Should `atlas_move_task` support skipping statuses (e.g., todo → in_progress) or require strict adjacent transitions? | Allow any valid transition per the workflow table | Low — server already validates |
| Q2 | Should we expose sprint create/close in v1 or keep it admin-only? | Admin-only (defer to v2) | Low — easy to add later |
| Q3 | Should MCP writes trigger the same dispatch/notification hooks as UI writes? | Yes — writes go through the existing API, so hooks fire naturally | Medium — inconsistent behavior if bypassed |

---

## Appendix A: Atlas HQ API Endpoints Mapped to MCP Tools

| MCP Tool | HTTP Method | Atlas HQ Endpoint |
|----------|------------|-------------------|
| `atlas_list_projects` | GET | `/api/v1/projects` |
| `atlas_get_project` | GET | `/api/v1/projects/:id` + `/api/v1/projects/:id/metrics` |
| `atlas_list_sprints` | GET | `/api/v1/sprints?project_id=X` |
| `atlas_get_sprint` | GET | `/api/v1/sprints/:id` + `/api/v1/sprints/:id/metrics` |
| `atlas_list_tasks` | GET | `/api/v1/tasks?project_id=X&sprint_id=Y&limit=N` |
| `atlas_get_task` | GET | `/api/v1/tasks/:id` |
| `atlas_get_task_notes` | GET | `/api/v1/tasks/:id/notes` |
| `atlas_get_task_history` | GET | `/api/v1/tasks/:id/history` |
| `atlas_list_jobs` | GET | `/api/v1/jobs?project_id=X` |
| `atlas_list_agents` | GET | `/api/v1/agents` |
| `atlas_create_task` | POST | `/api/v1/tasks` |
| `atlas_update_task` | PUT | `/api/v1/tasks/:id` |
| `atlas_move_task` | PUT | `/api/v1/tasks/:id` (status field) |
| `atlas_add_task_note` | POST | `/api/v1/tasks/:id/notes` |
| `atlas_add_blocker` | POST | `/api/v1/tasks/:id/blockers` |
| `atlas_remove_blocker` | DELETE | `/api/v1/tasks/:id/blockers/:blocker_id` |
