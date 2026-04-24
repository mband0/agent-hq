# Agent HQ MCP Server

Connect Agent HQ to ChatGPT desktop, Claude desktop, or any MCP-compatible client over stdio.

---

## Overview

The Agent HQ MCP server is a thin adapter between MCP clients and the local Agent HQ API.

Architecture:

```text
MCP client (ChatGPT / Claude / other)
  -> stdio
Agent HQ MCP server
  -> HTTP localhost
Agent HQ API
```

Design goals:
- expose Agent HQ projects, sprints, tasks, notes, blockers, jobs, and agents to MCP clients
- allow safe task-oriented writes from chat
- keep the server stateless by routing all operations through the existing API
- use Agent HQ naming throughout

v1 assumptions:
- local stdio transport only
- single-user local install
- no remote transport
- no direct database access from the MCP server

---

## What You Can Do

Once connected, you can ask things like:
- "What’s on my sprint board?"
- "Show me task #576"
- "Create a task for fixing the login bug in Agency"
- "Move task #580 to in_progress"
- "Add a note to task #576: spec is approved"

---

## Scope

### In scope for v1

| Resource | Read | Write | Notes |
|---|---|---|---|
| Projects | Yes | No | Read-only in v1 |
| Sprints / Boards | Yes | Limited | Sprint create exists in current implementation; broader sprint lifecycle stays out of scope |
| Tasks | Yes | Yes | Create, update, move status |
| Task Notes | Yes | Yes | Add notes/comments |
| Task Blockers | Yes | Yes | Add and remove blocker relationships |
| Task History | Yes | No | Audit trail / history only |
| Jobs | Yes | No | Read-only |
| Agents | Yes | No | Read-only |

### Out of scope for v1

- project create/update/delete
- sprint close/complete/admin lifecycle actions
- task delete
- task cancellation semantics that depend on dispatch/instance state
- task outcomes and evidence posting
- instance management
- routing / provider / settings management
- attachments and file upload workflows
- browser pool or other internal agent runtime concerns

---

## Tool Surface

Primary tool names use the `agent_hq_*` namespace.
Legacy `atlas_*` aliases may still exist for backward compatibility, but new docs and client configs should use `agent_hq_*` only.

### Read tools

| Tool | Description |
|---|---|
| `agent_hq_list_projects` | List all projects |
| `agent_hq_get_project` | Get a project by ID |
| `agent_hq_list_sprints` | List sprints, optionally filtered by project |
| `agent_hq_get_sprint` | Get sprint detail and metrics |
| `agent_hq_list_tasks` | List tasks with filters |
| `agent_hq_get_task` | Get full task detail |
| `agent_hq_get_task_notes` | Get notes for a task |
| `agent_hq_get_task_history` | Get task history |
| `agent_hq_list_jobs` | List jobs |
| `agent_hq_list_agents` | List registered agents |

### Write tools

| Tool | Description |
|---|---|
| `agent_hq_create_task` | Create a new task |
| `agent_hq_update_task` | Update writable task fields |
| `agent_hq_move_task` | Move a task to a new status |
| `agent_hq_add_task_note` | Add a note to a task |
| `agent_hq_add_blocker` | Add a blocker relationship |
| `agent_hq_remove_blocker` | Remove a blocker relationship |
| `agent_hq_create_sprint` | Create a sprint |

### MCP resources

| Resource URI | Description |
|---|---|
| `agent-hq://workflow/statuses` | Valid task statuses and pipeline order |
| `agent-hq://workflow/task-types` | Valid task types |
| `agent-hq://projects/summary` | Compact project list |

---

## Task Write Behavior

### Create task

Tool: `agent_hq_create_task`

Typical writable fields:
- `title` (required)
- `project_id` (required)
- `description`
- `sprint_id`
- `priority`
- `task_type`
- `story_points`

### Update task

Tool: `agent_hq_update_task`

Typical writable fields:
- `title`
- `description`
- `priority`
- `sprint_id`
- `task_type`
- `story_points`

`project_id` should not be changed after creation.

### Move task

Tool: `agent_hq_move_task`

- accepts `task_id` and target `status`
- server validates that the status transition is legal
- invalid transitions should return a clear error with valid options

### Notes and blockers

- `agent_hq_add_task_note` adds a note/comment to a task
- `agent_hq_add_blocker` creates a blocker relationship
- `agent_hq_remove_blocker` removes a blocker relationship

---

## Response Format

All tools should return a consistent envelope.

Success:

```json
{
  "ok": true,
  "data": {}
}
```

Error:

```json
{
  "ok": false,
  "error": "Descriptive error message"
}
```

Response shaping rules:
- use snake_case
- keep list responses concise
- return full detail only from detail tools
- include pagination metadata where relevant (`total`, `hasMore`, `limit`, `offset`)
- make errors actionable

Example invalid transition error:

```json
{
  "ok": false,
  "error": "Invalid status transition from 'todo' to 'done'. Valid transitions: todo -> ready, todo -> cancelled"
}
```

---

## Safety and Guardrails

### Safe by default

- read tools are idempotent and unrestricted
- destructive delete operations are not exposed
- admin/system configuration operations are not exposed
- dispatch, instance, evidence, and outcome internals are not exposed to MCP clients

### Write guardrails

- required fields must be validated
- task status transitions must be validated server-side
- writes should be recorded in history/audit surfaces with MCP source attribution
- rate limiting should apply server-side

What v1 does not need:
- custom confirmation flows inside the MCP server
- undo / rollback support
- per-field ACL complexity beyond normal writable field validation

---

## Prerequisites

- Agent HQ is installed and running locally
- Node.js 18+ installed
- Agent HQ API reachable at `http://localhost:3501` or your configured local port

---

## Build

```bash
cd /path/to/agent-hq/api
npm install
npm run build
```

This builds the MCP server to:

```text
api/dist/mcp/server.js
```

---

## Client Setup

### Claude Desktop

Add to Claude desktop config:

macOS path:
`~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "agent-hq": {
      "command": "node",
      "args": ["/absolute/path/to/agent-hq/api/dist/mcp/server.js"]
    }
  }
}
```

Restart Claude Desktop after saving.

### ChatGPT Desktop

In ChatGPT Desktop settings, add an MCP integration with:

- Command: `node`
- Args: `/absolute/path/to/agent-hq/api/dist/mcp/server.js`

### Alternate `npx` setup

```json
{
  "mcpServers": {
    "agent-hq": {
      "command": "npx",
      "args": ["--yes", "agent-hq-mcp"]
    }
  }
}
```

---

## Configuration

The MCP server supports config via environment variables and optional local config file.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `AGENT_HQ_API_URL` | `http://localhost:3501` | Agent HQ API base URL |
| `MCP_RATE_LIMIT_RPM` | `60` | Max requests per minute |

Example:

```json
{
  "mcpServers": {
    "agent-hq": {
      "command": "node",
      "args": ["/path/to/agent-hq/api/dist/mcp/server.js"],
      "env": {
        "AGENT_HQ_API_URL": "http://localhost:9999"
      }
    }
  }
}
```

### Config file

Create:

```text
~/.agent-hq/mcp.json
```

Example:

```json
{
  "api_url": "http://localhost:3501",
  "rate_limit_rpm": 120
}
```

Environment variables take precedence over config file values.

### Legacy compatibility

Current implementation may still read legacy Atlas-era fallbacks for backward compatibility, but new configuration should use Agent HQ names only.

---

## Smoke Test

Run the MCP server manually and send `initialize` plus `tools/list` over stdio:

```bash
cd /path/to/agent-hq/api

printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' \
  | node dist/mcp/server.js
```

Expected result:
- valid JSON-RPC responses
- Agent HQ tool list returned
- server ready over stdio

---

## Debugging

MCP protocol traffic uses stdout, so logs should go to stderr.

Example:

```bash
node dist/mcp/server.js 2>&1 1>/dev/null
```

Expected log shape:

```text
[agent-hq-mcp] Starting, API: http://localhost:3501 | Rate limit: 60 req/min
[agent-hq-mcp] MCP server connected, ready for tool calls via stdio.
```

Useful checks:
- confirm `api/dist/mcp/server.js` exists
- confirm the API is reachable at `AGENT_HQ_API_URL`
- confirm the client config points at the built server path
- confirm the client was restarted after config changes

---

## Rate Limiting

Default rate limit:
- 60 requests per minute
- process-level token bucket

Typical rate limit error:

```json
{
  "ok": false,
  "error": "Rate limit exceeded. Maximum 60 requests per minute."
}
```

---

## API Mapping

| MCP Tool | HTTP Method | Endpoint |
|---|---|---|
| `agent_hq_list_projects` | GET | `/api/v1/projects` |
| `agent_hq_get_project` | GET | `/api/v1/projects/:id` plus metrics endpoint if needed |
| `agent_hq_list_sprints` | GET | `/api/v1/sprints` |
| `agent_hq_get_sprint` | GET | `/api/v1/sprints/:id` plus metrics endpoint if needed |
| `agent_hq_list_tasks` | GET | `/api/v1/tasks` |
| `agent_hq_get_task` | GET | `/api/v1/tasks/:id` |
| `agent_hq_get_task_notes` | GET | `/api/v1/tasks/:id/notes` |
| `agent_hq_get_task_history` | GET | `/api/v1/tasks/:id/history` |
| `agent_hq_list_jobs` | GET | `/api/v1/jobs` |
| `agent_hq_list_agents` | GET | `/api/v1/agents` |
| `agent_hq_create_task` | POST | `/api/v1/tasks` |
| `agent_hq_update_task` | PUT | `/api/v1/tasks/:id` |
| `agent_hq_move_task` | PUT | `/api/v1/tasks/:id` |
| `agent_hq_add_task_note` | POST | `/api/v1/tasks/:id/notes` |
| `agent_hq_add_blocker` | POST | `/api/v1/tasks/:id/blockers` |
| `agent_hq_remove_blocker` | DELETE | `/api/v1/tasks/:id/blockers/:blocker_id` |

---

## Naming Guidance

Use these names in docs, config, and user-facing communication:
- Agent HQ MCP server
- `agent_hq_*` tool names
- `agent-hq://...` resource URIs
- `AGENT_HQ_API_URL`
- `~/.agent-hq/mcp.json`

Avoid Atlas-era naming in new docs.

---

## Summary

Agent HQ MCP is a local stdio MCP server that exposes a safe, practical subset of Agent HQ to AI clients. It is designed for local single-user use, routes everything through the existing API, and supports both board visibility and core task actions without exposing admin or runtime-internal operations.
