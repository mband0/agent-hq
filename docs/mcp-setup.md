# Agent HQ MCP Server — Setup Guide

Connect ChatGPT desktop, Claude desktop, or any MCP-compatible AI client to Agent HQ.

---

## What This Gives You

Once connected, you can ask your AI assistant things like:
- "What's on my sprint board?"
- "Show me task #576"
- "Create a task for fixing the login bug in the Agency project"
- "Move task #580 to in_progress"
- "Add a note to task #576: spec is approved"

---

## Prerequisites

- Agent HQ is installed and running locally (`npm run dev` or PM2)
- Node.js ≥ 18 installed
- The Agent HQ API is reachable at `http://localhost:3501` (or your configured port)

---

## Build the MCP Server

```bash
cd /path/to/agent-hq/api
npm install
npm run build
```

This compiles the MCP server to `api/dist/mcp/server.js`.

---

## Connect to Claude Desktop

Add this to your Claude desktop MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

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

Restart Claude desktop. You should see "Agent HQ" appear in the MCP server list and all tools will be available.

---

## Connect to ChatGPT Desktop

In ChatGPT desktop settings → Integrations → MCP:

- **Command:** `node`
- **Args:** `/absolute/path/to/agent-hq/api/dist/mcp/server.js`

---

## Connect Using `npx` (Alternate)

If you have the `agent-hq` npm package installed globally or in your project:

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

The MCP server uses sensible defaults. Override via environment variables or `~/.agent-hq/mcp.json`.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_HQ_API_URL` | `http://localhost:3501` | Agent HQ API base URL |
| `MCP_RATE_LIMIT_RPM` | `60` | Max requests per minute |

**Example — custom port:**
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

### Config File

Create `~/.agent-hq/mcp.json` for persistent config:

```json
{
  "api_url": "http://localhost:3501",
  "rate_limit_rpm": 120
}
```

Environment variables take precedence over the config file.

Legacy compatibility:
- `~/.atlas-hq/mcp.json` is still read as a fallback
- `ATLAS_HQ_API_URL` is still accepted as a fallback env var

---

## Smoke Test

Verify the server works by running it manually and sending a `tools/list` request:

```bash
cd /path/to/agent-hq/api

# Send initialize + tools/list over stdio
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' \
  | node dist/mcp/server.js
```

Expected output: JSON-RPC responses including the Agent HQ tool set, with legacy Atlas aliases also present for compatibility.

---

## Available Tools

### Read Tools (10)

Primary tool IDs now use the `agent_hq_*` namespace. Legacy `atlas_*` aliases remain available for backward compatibility.

| Tool | Description |
|------|-------------|
| `agent_hq_list_projects` | List all projects |
| `agent_hq_get_project` | Get project by ID |
| `agent_hq_list_sprints` | List sprints (optionally filter by project) |
| `agent_hq_get_sprint` | Get sprint detail and metrics |
| `agent_hq_list_tasks` | List tasks with filters (project, sprint, status, limit, offset) |
| `agent_hq_get_task` | Get full task detail |
| `agent_hq_get_task_notes` | Get notes/comments for a task |
| `agent_hq_get_task_history` | Get status change history for a task |
| `agent_hq_list_jobs` | List job definitions |
| `agent_hq_list_agents` | List registered agents |

### Write Tools (7)

| Tool | Description |
|------|-------------|
| `agent_hq_create_task` | Create a new task |
| `agent_hq_update_task` | Update task fields |
| `agent_hq_move_task` | Move task to a new status |
| `agent_hq_add_task_note` | Add a note to a task |
| `agent_hq_add_blocker` | Mark task as blocked by another task |
| `agent_hq_remove_blocker` | Remove a blocker relationship |
| `agent_hq_create_sprint` | Create a sprint |

### Resources (3)

| Resource URI | Description |
|-------------|-------------|
| `agent-hq://workflow/statuses` | Valid task statuses and pipeline order |
| `agent-hq://workflow/task-types` | Valid task types |
| `agent-hq://projects/summary` | Compact project list for orientation |

---

## Response Format

All tools return:

**Success:**
```json
{ "ok": true, "data": { ... } }
```

**Error:**
```json
{ "ok": false, "error": "Descriptive error message" }
```

---

## Security Notes

The v1 MCP server uses **stdio transport only**. It:
- Opens no network ports
- Makes unauthenticated calls to the local Agent HQ API (consistent with how the UI works)
- Runs as a subprocess of your AI client, isolated by OS process boundaries

This is secure for single-user, local installations. Remote/multi-user support is a v2 concern.

---

## Debugging

Server logs go to **stderr** (so they don't interfere with the MCP stdio protocol):

```bash
# Run with stderr visible
node dist/mcp/server.js 2>&1 1>/dev/null
```

You'll see:
```
[agent-hq-mcp] Starting, API: http://localhost:3501 | Rate limit: 60 req/min
[agent-hq-mcp] MCP server connected, ready for tool calls via stdio.
```

---

## Rate Limiting

Default: 60 requests per minute (token bucket, process-level). Exceeding this returns:

```json
{ "ok": false, "error": "Rate limit exceeded. Maximum 60 requests per minute." }
```

Increase via `MCP_RATE_LIMIT_RPM` env var if needed for heavy usage.
