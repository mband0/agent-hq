# Atlas HQ MCP Server — Auth & Security Model

**Task:** #577  
**Author:** Forge (Agency Backend)  
**Date:** 2026-04-04  
**Sprint:** Atlas HQ — MCP Support  
**Depends on:** #576 (MCP v1 Product & Technical Spec)  
**Unblocks:** #578 (Server Foundation & Transport)  
**Status:** Implementation-ready

---

## 1. Summary

The Atlas HQ MCP server v1 uses a **local-only, stdio transport** with **no explicit authentication layer**. Security is enforced by the OS process model and network isolation. Remote transport and multi-user authentication are v2 concerns.

This document defines:
- The v1 auth and transport model
- What the trust boundaries are and why they are sufficient for v1
- The write authorization model (what is allowed, what is blocked)
- Guardrails for state-changing operations
- The v2 upgrade path for remote/multi-user scenarios

---

## 2. v1 Transport: Local stdio

### 2.1 Architecture

```
ChatGPT app / Claude app
    │ (stdio — local process pipe)
    ↓
atlas-hq-mcp  ←─── spawned by AI client as a local subprocess
    │ (HTTP — localhost only)
    ↓
Atlas HQ API (http://localhost:3501)
    │
    ↓
SQLite (atlas-hq.db)
```

The MCP server is a **local Node.js process** launched by the AI client application (ChatGPT desktop, Claude desktop) via their MCP host configuration. Communication happens over stdio (stdin/stdout) using the MCP protocol. No network port is opened by the MCP server itself.

### 2.2 Why stdio is secure for v1

| Property | Explanation |
|----------|-------------|
| **OS process isolation** | The AI client spawns `atlas-hq-mcp` as a child process. Only the spawning process can communicate with it via stdio. No remote attacker can reach it. |
| **No listening socket** | The MCP server does not bind to any port. There is no surface for remote connections, port scans, or localhost socket attacks. |
| **Same user context** | The MCP server runs as the same OS user as the AI client. The trust level is identical to the user opening a terminal and calling the Atlas HQ API directly. |
| **Local API only** | The Atlas HQ API already binds to `localhost:3501` with no authentication (by design, for local single-user deployments). The MCP server is just another local caller. |

**Conclusion:** For v1 single-user, local installations, OS process boundaries provide sufficient isolation. No additional credential layer is required.

### 2.3 What v1 does NOT support

- Remote MCP transport (SSE, WebSocket, HTTP)
- Multi-user access with per-user identity
- External/cloud-hosted Atlas HQ instances accessed over the network
- Per-session API keys or bearer tokens

These are v2 concerns (see §7).

---

## 3. v1 Authentication Model: None Required

**v1 auth model: No authentication.**

The MCP server makes unauthenticated HTTP calls to `http://localhost:3501`. This is consistent with how the Atlas HQ UI, CLI, and all existing integrations currently operate — the API is a trusted local service with no auth layer.

### 3.1 Rationale

The existing Atlas HQ API does not authenticate requests. Adding authentication to the MCP server in isolation would create a false sense of security: an attacker with access to the local machine could call the API directly without going through MCP. Auth at the MCP layer only makes sense when the backend itself requires authentication.

The correct place to add authentication is at the **API level**, gated by a configuration flag, not at any individual integration layer. The MCP server should pass credentials through to the API when the API requires them — but since the API does not require them for v1, neither does the MCP server.

### 3.2 MCP Client Identity

Write operations attribute actions to `"mcp-client"` by default (per the product spec, §3.2). The AI client may optionally pass an `author` field when calling write tools (e.g., `atlas_add_task_note`). This is for human-readable audit trail only — it is not an authentication identity.

---

## 4. v1 Authorization Model: Scope by Tool Exposure

Authorization in v1 is **structural**: the MCP server exposes a scoped subset of the Atlas HQ API. What is not in the tool list is not reachable from MCP.

### 4.1 Allowed Operations

| Category | Operations |
|----------|------------|
| **Read — all** | Projects, sprints, tasks, notes, history, jobs, agents |
| **Task writes** | Create, update fields, move status |
| **Task annotation** | Add note, add blocker, remove blocker |

### 4.2 Blocked Operations (not exposed in v1)

| Category | Why blocked |
|----------|------------|
| Task delete | Destructive, no undo path |
| Task cancel / outcome posting | Agent contract operations, not user-facing |
| Task evidence (review, QA, deploy) | CI/CD workflow, internal only |
| Project create/update/delete | Admin-level, low-frequency, high-risk from external clients |
| Sprint create/close/complete | Admin-level lifecycle management |
| Routing / workflow config | System configuration, admin-only |
| Provider / settings management | System configuration, admin-only |
| Instance management | Internal dispatch machinery |
| Artifact / file operations | Internal agent workspace |
| Browser pool | Internal agent tooling |

### 4.3 Status Transition Enforcement

The `atlas_move_task` tool accepts a `status` field. The Atlas HQ API already validates status transitions against the workflow table. The MCP server does not need to re-implement this — it delegates to the API and passes through any transition errors.

Error responses for invalid transitions must include the current status and the valid next states (see the product spec §5.2 error format).

---

## 5. Guardrails for State-Changing Operations

### 5.1 Why v1 does not need client-side confirmation dialogs

Per the product spec (§6.3): MCP tool calls are initiated by the user in the ChatGPT or Claude app. The AI client handles confirmation UX at the model layer (the model typically describes what it's about to do and asks the user to confirm before calling a write tool). Atlas HQ validates transitions server-side. This two-layer model is sufficient for v1.

Atlas HQ does **not** add its own "are you sure?" prompts at the MCP tool layer.

### 5.2 Server-side guardrails that ARE enforced

| Guardrail | Mechanism |
|-----------|-----------|
| Required field validation | API rejects writes with missing required fields |
| Status transition validation | API enforces the workflow transition table |
| Write scope enforcement | MCP server only exposes the allowed tool set; blocked operations cannot be reached |
| Audit trail | Every write is logged to task history with `source: "mcp"` |
| Rate limiting | 60 requests/minute per MCP process (configurable via `MCP_RATE_LIMIT_RPM` env var) |

### 5.3 Write Attribution

All writes made via MCP must include `source: "mcp"` in the task history record. The Atlas HQ API's history-recording layer must accept this source field. If the existing API does not support a `source` field on history entries, the MCP server should add it as a note on the task (e.g., auto-append `"[via MCP]"` to the author field).

Recommended implementation: extend the task history model to accept an optional `source` field (`"ui"`, `"api"`, `"mcp"`, `"agent"`, etc.). This is a low-risk schema addition that improves auditability across all clients.

---

## 6. Credential Lifecycle (v1: N/A)

Since v1 uses no credentials, there are no rotation or revocation concerns.

For completeness, if a future version adds API key auth:
- Keys should be stored in `~/.atlas-hq/mcp-key` (chmod 600) or in the OS keychain.
- The MCP server should read the key from the environment or a config file — never hardcoded.
- Rotation should be possible via a CLI command (`atlas-hq mcp rotate-key`) without restarting the server.
- Revocation should take effect immediately on the API side (no caching of revoked keys).

---

## 7. v2 Upgrade Path: Remote Transport & Multi-User Auth

When Atlas HQ needs to serve remote MCP clients (e.g., cloud-hosted Atlas HQ, team instances), the following auth model is recommended:

### 7.1 Transport

Switch from stdio to **MCP Streamable HTTP transport** (the current MCP standard for remote servers). This opens an HTTP endpoint on a configured port.

### 7.2 Authentication

Use **Bearer token / API key** authentication:

```
Authorization: Bearer <atlas-hq-api-key>
```

- The API key is generated per-user at the Atlas HQ settings UI.
- The API validates the bearer token on every request via middleware.
- The Atlas HQ API's existing unauthenticated mode remains available for local installs (toggled via `AUTH_REQUIRED=false` env var, which is the default).

### 7.3 Per-User Identity

- Each API key maps to a user identity in Atlas HQ.
- Write operations are attributed to the authenticated user, not `"mcp-client"`.
- Permission scopes can be attached to API keys (`read_only`, `read_write`, `admin`) when fine-grained access is needed.

### 7.4 TLS

Remote transport must use TLS. A reverse proxy (nginx, Caddy) handles TLS termination. The MCP server speaks plain HTTP behind the proxy (same pattern as the existing Atlas HQ API).

### 7.5 What does NOT change between v1 and v2

- The tool surface (same tools, same parameters)
- Server-side validation and guardrails
- Write attribution and audit trail
- Rate limiting (adjustable limits)
- The blocked operations list

The auth layer slots in at the HTTP middleware level without requiring changes to tool implementations.

---

## 8. Implementation Requirements for Task #578

The following requirements must be met by the MCP server foundation (task #578):

| Requirement | Detail |
|-------------|--------|
| **Transport** | stdio only. No TCP/HTTP listener. Use `@modelcontextprotocol/sdk` `StdioServerTransport`. |
| **API target** | `http://localhost:3501` (configurable via `ATLAS_HQ_API_URL` env var; default to `http://localhost:3501`). |
| **No credentials** | The MCP server makes unauthenticated requests to the Atlas HQ API. No `Authorization` header in v1. |
| **Rate limiting** | Implement token-bucket rate limiter: default 60 req/min, configurable via `MCP_RATE_LIMIT_RPM` env var. Rate limit applies to the whole MCP process (single user, single connection in stdio model). |
| **Write attribution** | Pass `author: "mcp-client"` (or the AI client's supplied author) in note/write calls. |
| **Source tagging** | Pass `source: "mcp"` in history entries for all write operations. |
| **Error format** | Return `{ ok: false, error: "<message>" }` for all failures. Never expose raw stack traces or internal API errors to MCP clients. |
| **Config file** | MCP server reads optional `~/.atlas-hq/mcp.json` for config overrides (api_url, rate_limit_rpm). This is the hook point for v2 API key config. |
| **Graceful shutdown** | Handle SIGTERM/SIGINT cleanly — close stdio transport, drain in-flight requests, exit 0. |

---

## 9. Security Risks and Mitigations (v1)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Another local process hijacks stdio | Very Low | Medium | OS enforces process ownership; stdio is not a shared resource |
| Local port scan discovers Atlas HQ API | Medium | Low | API is already local-only; attacker already has machine access if they reach it |
| Malicious MCP server impersonates Atlas HQ | Low | Medium | Out of scope for MCP protocol itself; AI clients validate server identity via config, not cert |
| AI client executes unintended write | Low | Low | Server-side validation catches invalid transitions; no delete operations exposed |
| Rate limit exhaustion (accidental) | Low | Low | 60 req/min limit prevents runaway AI loops from hammering the API |

**Overall v1 risk level: Low.** The threat model is constrained to a single authenticated OS user on a local machine. The existing Atlas HQ API already operates under these assumptions.

---

## 10. Summary Decision Table

| Decision | v1 Choice | v2 Path |
|----------|----------|---------|
| Transport | stdio | Streamable HTTP |
| Auth | None (OS isolation) | Bearer token / API key |
| Identity | `"mcp-client"` (shared) | Per-user API key identity |
| Write scope | Enforced by tool exposure | Same + optional per-key scope |
| TLS | N/A (stdio) | Required for remote transport |
| Rate limiting | 60 req/min (process-level) | Per-key rate limits |
| Credentials stored | N/A | `~/.atlas-hq/mcp.json` or OS keychain |
| Config toggle | `ATLAS_HQ_API_URL` | `ATLAS_HQ_API_KEY`, `ATLAS_HQ_MCP_URL` |
