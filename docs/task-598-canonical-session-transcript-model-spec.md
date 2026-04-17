# Spec: Canonical Atlas HQ Session/Transcript Model

**Task:** #598  
**Author:** Wren (agency-pm)  
**Sprint:** Atlas HQ — Canonical Sessions & Transcripts  
**Status:** Draft for review  
**Blocking:** #599 (backend schema), #600 (runtime adapters), #601 (chat refactor), #602 (reflection/telemetry), #603 (rollout plan)

---

## 1. Problem

Today, Atlas HQ stores and retrieves session/transcript data through three divergent paths:

1. **OpenClaw-native** — `chat_messages` table (populated via gateway WebSocket events) + live WS proxy  
2. **Claude Code / ACP** — `.claude/projects/<project>/<uuid>.jsonl` files on disk, with `chat_messages` fallback  
3. **Remote / Veri** — `chat_messages` table (populated by `VeriAgentRuntime`) or remote transcript API  

The `transcriptProvider.ts` abstraction selects the right provider per runtime, but each provider returns data from a different physical source with different schemas. The consumers — Chat tab, telemetry, and future reflection/learning features — must either go through the provider factory every time or deal with format differences.

**What's missing:**
- No single Atlas HQ-owned table that stores sessions as first-class entities (independent of `job_instances`)
- No normalized message schema that supports structured events (tool calls, thoughts, errors) uniformly across runtimes
- Transcript data for Claude Code/ACP sessions is ephemeral (JSONL files that can be deleted or overwritten)
- No clear contract for new runtimes to implement

---

## 2. Design Principles

1. **Atlas HQ owns the canonical data.** Runtime-specific storage is the source, but Atlas HQ maintains a durable, normalized copy.
2. **Sessions exist independently of task instances.** An agent session can exist without a linked task (e.g., ad-hoc chat, cron run without a task). Instance linkage is optional.
3. **Push-primary, pull-on-demand hybrid.** Runtimes push transcript data into Atlas HQ during/after runs. For legacy/migration, Atlas HQ can pull and normalize on first access.
4. **Structured events, not just text.** The canonical message model must support tool calls, tool results, thoughts, system events, and errors as first-class event types — not just role+content strings.
5. **Raw payload preserved.** The original runtime-specific payload is stored verbatim alongside the normalized representation for debugging and future reprocessing.

---

## 3. Canonical Data Model

### 3.1 `sessions` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Atlas HQ internal session ID |
| `external_key` | TEXT NOT NULL UNIQUE | Runtime session key (e.g., `agent:agency-backend:hook:atlas:jobrun:8141`, `claude-code:<uuid>`, `cron:<job-id>:<ts>`) |
| `runtime` | TEXT NOT NULL | Runtime type: `openclaw`, `claude-code`, `cron`, `veri`, `webhook`, `unknown` |
| `agent_id` | INTEGER FK → agents | Agent that owns this session (nullable for system/orphan sessions) |
| `task_id` | INTEGER FK → tasks | Linked task (nullable — sessions can exist without tasks) |
| `instance_id` | INTEGER FK → job_instances | Linked run instance (nullable) |
| `project_id` | INTEGER FK → projects | Project context (nullable, denormalized from task/agent for query convenience) |
| `status` | TEXT NOT NULL DEFAULT 'active' | `active`, `completed`, `failed`, `abandoned` |
| `title` | TEXT DEFAULT '' | Optional human-readable session title (derived from task title, cron job name, etc.) |
| `started_at` | TEXT | When the session actually began |
| `ended_at` | TEXT | When the session ended |
| `message_count` | INTEGER DEFAULT 0 | Denormalized count for list views |
| `token_input` | INTEGER | Aggregate input tokens (denormalized) |
| `token_output` | INTEGER | Aggregate output tokens (denormalized) |
| `metadata` | TEXT DEFAULT '{}' | JSON blob for runtime-specific metadata (model used, workspace path, etc.) |
| `created_at` | TEXT DEFAULT datetime('now') | |
| `updated_at` | TEXT DEFAULT datetime('now') | |

**Indexes:** `external_key` (unique), `agent_id`, `task_id`, `instance_id`, `runtime`, `status`, `started_at DESC`.

**Key decisions:**
- `external_key` is the stable identifier that runtimes use to reference their sessions. For OpenClaw, this is the session key. For Claude Code, this is `claude-code:<uuid>`. For cron runs, `cron:<job-id>:<timestamp>`.
- `instance_id` links to `job_instances` but is not required. A session can exist for ad-hoc chat or exploration that isn't tied to a dispatched task.
- `status` is managed by Atlas HQ, not by the runtime. The adapter/ingestion layer infers status from runtime signals.

### 3.2 `session_messages` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment ID |
| `session_id` | INTEGER FK → sessions NOT NULL | Parent session |
| `ordinal` | INTEGER NOT NULL | Sequence number within session (0-indexed, monotonically increasing) |
| `role` | TEXT NOT NULL | `user`, `assistant`, `system`, `tool` |
| `event_type` | TEXT NOT NULL DEFAULT 'text' | `text`, `thought`, `tool_call`, `tool_result`, `turn_start`, `turn_end`, `system`, `error` |
| `content` | TEXT NOT NULL DEFAULT '' | Normalized plain-text content |
| `event_meta` | TEXT DEFAULT '{}' | JSON blob: tool name, args, output, turn number, model, etc. |
| `raw_payload` | TEXT | Original runtime-specific message payload (JSON string, verbatim) |
| `timestamp` | TEXT NOT NULL | Original message timestamp from runtime |
| `created_at` | TEXT DEFAULT datetime('now') | When Atlas HQ ingested this message |

**Indexes:** `(session_id, ordinal)` unique, `session_id + timestamp`, `event_type`.

**Key decisions:**
- `ordinal` provides a deterministic ordering within a session, independent of timestamp precision issues.
- `role` is limited to four values. Runtime-specific roles (e.g., Claude Code's `result` type) are mapped to `tool` + `event_type=tool_result`.
- `raw_payload` stores the exact JSON line/object from the source runtime. This enables re-normalization if the mapping logic changes, and supports debugging. For space efficiency, `raw_payload` can be NULL for messages that originate inside Atlas HQ (e.g., system events).
- `content` always contains human-readable text. For tool calls, it contains a summary (e.g., "Called `read_file` on `/path/to/file`"). The full structured data lives in `event_meta`.

### 3.3 Event Type Taxonomy

| `event_type` | `role` | Description |
|--------------|--------|-------------|
| `text` | user/assistant/system | Normal conversational message |
| `thought` | assistant | Extended thinking / chain-of-thought block |
| `tool_call` | assistant | Agent invoked a tool. `event_meta`: `{ tool: string, args: object, call_id?: string }` |
| `tool_result` | tool | Tool execution result. `event_meta`: `{ tool: string, call_id?: string, success: bool, output_truncated?: bool }` |
| `turn_start` | system | Marks the beginning of an agent turn. `event_meta`: `{ turn: number, model?: string }` |
| `turn_end` | system | Marks the end of an agent turn. `event_meta`: `{ turn: number, tokens_in?: number, tokens_out?: number }` |
| `system` | system | System event (heartbeat, dispatch signal, status change) |
| `error` | system | Runtime error or failure |

### 3.4 Relationship to Existing Tables

```
sessions
  ├── session_messages[]         (1:N — the transcript)
  ├── → agents.id                (N:1 — which agent)
  ├── → tasks.id                 (N:1 — which task, optional)
  ├── → job_instances.id         (N:1 — which run instance, optional)
  └── → projects.id              (N:1 — which project, denormalized)

chat_messages (existing)
  └── Deprecated for new reads.
      Migration: backfill into session_messages.
      Kept for backward compatibility during rollout.
```

**`chat_messages` disposition:** The existing `chat_messages` table is the precursor to `session_messages`. During the migration period, both tables coexist. New writes go to `session_messages`; the adapter layer also writes to `chat_messages` for backward compatibility until all consumers are migrated. After rollout, `chat_messages` is read-only and eventually dropped.

---

## 4. Runtime Adapter Contract

Each runtime adapter must implement the `SessionAdapter` interface:

```typescript
interface SessionAdapter {
  /** Runtime identifier (matches sessions.runtime) */
  readonly runtime: string;

  /**
   * Ingest: convert a runtime-specific session into canonical form.
   * Called during push (real-time event stream) or pull (on-demand import).
   *
   * Returns the canonical session + messages to upsert.
   * Atlas HQ handles the actual DB writes.
   */
  ingest(source: AdapterSource): Promise<IngestResult>;

  /**
   * Stream: subscribe to real-time events from the runtime.
   * Returns an async iterable of normalized messages.
   * Optional — not all runtimes support streaming.
   */
  stream?(sessionKey: string): AsyncIterable<SessionMessageInput>;

  /**
   * Resolve live chat capability for a session.
   * Returns the WebSocket endpoint info if live chat is available.
   */
  resolveLiveChat(sessionId: number): Promise<LiveChatInfo | null>;
}

interface AdapterSource {
  /** Runtime-specific session identifier */
  externalKey: string;
  /** Optional: if we already know the instance */
  instanceId?: number;
  /** Optional: if we already know the agent */
  agentId?: number;
}

interface IngestResult {
  session: SessionUpsert;
  messages: SessionMessageInput[];
}

interface SessionUpsert {
  externalKey: string;
  runtime: string;
  agentId?: number | null;
  taskId?: number | null;
  instanceId?: number | null;
  projectId?: number | null;
  status: 'active' | 'completed' | 'failed' | 'abandoned';
  title?: string;
  startedAt?: string;
  endedAt?: string;
  tokenInput?: number;
  tokenOutput?: number;
  metadata?: Record<string, unknown>;
}

interface SessionMessageInput {
  ordinal: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  eventType: string;
  content: string;
  eventMeta?: Record<string, unknown>;
  rawPayload?: string;
  timestamp: string;
}

interface LiveChatInfo {
  /** WebSocket URL to connect to for live streaming */
  wsUrl: string;
  /** Session key to pass to the gateway */
  sessionKey: string;
  /** Whether the session supports sending messages (interactive) */
  interactive: boolean;
}
```

### 4.1 Adapter: OpenClaw-native

- **Push model:** Primary. The existing `chat_messages` write path (in `chat.ts` / WebSocket proxy and `runObservability`) is extended to also write to `session_messages`.
- **Session creation:** On instance start (`PUT /instances/:id/start`), create a `sessions` row with `runtime='openclaw'`.
- **Message ingestion:** Each chat event received via the WS proxy is normalized and appended to `session_messages`.
- **Live chat:** Fully supported — `resolveLiveChat` returns the gateway WS URL for the session's agent (including container routing via `hooks_url`).
- **Pull fallback:** For sessions created before migration, the adapter reads from `chat_messages` and backfills `session_messages` on first access.

### 4.2 Adapter: Cron Runs

- **Push model:** Primary. Cron runs that use `agentTurn` dispatch go through the same OpenClaw gateway path. The adapter tags them with `runtime='cron'` and derives `externalKey` from the cron job ID + timestamp.
- **Session creation:** When the cron scheduler dispatches an isolated run, create a `sessions` row with `runtime='cron'`.
- **Live chat:** Not applicable (`resolveLiveChat` returns null). Cron runs are non-interactive.
- **Transcript:** Same as OpenClaw-native (messages flow through the gateway and are captured).

### 4.3 Adapter: Claude Code / ACP

- **Hybrid model:** Push where possible, pull for historical.
- **Push:** When Atlas HQ dispatches a Claude Code run (`ClaudeCodeRuntime.dispatch`), the runtime creates a `sessions` row and, upon completion, reads the JSONL file and ingests all messages.
- **Pull:** For historical JSONL files (pre-migration or external runs), the adapter scans `~/.claude/projects/` and ingests on demand.
- **JSONL normalization:**
  - `type: 'user'` → `role: 'user'`, `event_type: 'text'`
  - `type: 'assistant'` with text content → `role: 'assistant'`, `event_type: 'text'`
  - `type: 'assistant'` with tool_use blocks → `role: 'assistant'`, `event_type: 'tool_call'`
  - `type: 'result'` → `role: 'tool'`, `event_type: 'tool_result'`
  - Thinking blocks → `role: 'assistant'`, `event_type: 'thought'`
- **Live chat:** Not supported for completed sessions. Running ACP sessions may support it if there's a gateway WS endpoint.

### 4.4 Adapter: Remote / Veri

- **Push model:** Primary. The `VeriAgentRuntime` already writes to `chat_messages`. Extend to also write to `session_messages`.
- **Pull fallback:** If a remote transcript API is configured (`runtime_config.transcriptApiUrl`), the adapter can fetch and ingest.
- **Live chat:** Supported when `hooks_url` is set on the agent.

### 4.5 Future Runtimes

New runtimes implement the `SessionAdapter` interface and register with the adapter factory. Required:
1. Define how `externalKey` is derived (must be unique and stable).
2. Implement `ingest()` with correct role/event_type mapping.
3. Declare live chat support (or not).
4. Register in the adapter factory (`resolveSessionAdapter(runtime: string)`).

---

## 5. Data Flow: Push vs. Pull

### 5.1 Push Path (preferred for new data)

```
Runtime Event → Atlas HQ Ingestion Layer → session_messages INSERT
                                         → sessions UPDATE (message_count, token aggregates, status)
```

**Trigger points:**
- Instance start callback (`PUT /instances/:id/start`) → create session
- Chat message received (WS proxy / runtime callback) → append message
- Instance check-in (`POST /instances/:id/check-in`) → update session status/metadata
- Instance completion/outcome → finalize session (set `status`, `ended_at`)

### 5.2 Pull Path (for migration / lazy import)

```
Consumer requests session data
  → Atlas HQ checks sessions table
  → If not found or stale, call adapter.ingest(externalKey)
  → Write to sessions + session_messages
  → Return normalized data
```

**When pull is used:**
- First access of a pre-migration session
- Claude Code JSONL files that weren't ingested during the run (e.g., external `claude` CLI usage)
- Remote agent transcripts that weren't pushed

### 5.3 Freshness Guarantee

For live sessions (`status='active'`), the push path ensures near-real-time data. For completed sessions, the data is final after ingestion. Consumers can check `sessions.status` and `sessions.updated_at` to determine freshness.

---

## 6. Consumer Contracts

### 6.1 Chat Tab

**Current behavior:** Chat tab uses a WebSocket proxy for live sessions and the transcript provider (`GET /instances/:id/transcript`) for historical sessions. The UI does runtime-specific parsing in `parseTranscriptMessages()`.

**Target behavior:**
- **Live sessions:** Continue using WS proxy for real-time streaming. The WS proxy also writes to `session_messages` so the canonical store stays current.
- **Historical sessions:** `GET /sessions/:id/messages` returns normalized `session_messages` data. No runtime branching in the UI.
- **Session list:** `GET /sessions?agent_id=X` replaces the current pattern of inferring sessions from `job_instances` + `chat_messages`.

**New API endpoints:**
- `GET /api/v1/sessions` — list sessions with filters (agent, task, project, runtime, status, date range)
- `GET /api/v1/sessions/:id` — session detail
- `GET /api/v1/sessions/:id/messages` — paginated messages with optional event_type filter
- `GET /api/v1/sessions/by-key/:externalKey` — lookup by runtime key

### 6.2 Telemetry

Telemetry queries can aggregate across `sessions` and `session_messages`:
- Sessions per agent, per project, per sprint
- Message volume by role/event_type
- Token usage aggregated from sessions (not just instances)
- Tool usage frequency from `event_type='tool_call'` messages
- Error frequency from `event_type='error'` messages

### 6.3 Reflection / Learning

Reflection subagents query sessions linked to a task or agent to:
- Review what happened in prior runs (success and failure)
- Extract patterns from tool usage
- Compare approaches across retry attempts (multiple sessions for the same task)
- Build agent-specific learning from their own session history

**Query pattern:** `GET /sessions?task_id=X&include_messages=true` or `GET /sessions?agent_id=X&status=completed&limit=10`.

---

## 7. Migration Strategy

### Phase 1: Schema + Dual-Write
- Add `sessions` and `session_messages` tables
- Extend the push path to write to both `chat_messages` (existing) and `session_messages` (new)
- Create session rows from instance start callbacks
- All existing consumers continue reading from `chat_messages` — no behavior change

### Phase 2: New API + Lazy Backfill
- Add the new `/sessions` API endpoints
- Implement lazy backfill: when a session is requested that doesn't exist in `sessions`, pull from the adapter and create it
- Chat tab adds new code path to read from `/sessions/:id/messages` alongside the old transcript path

### Phase 3: Consumer Migration
- Chat tab fully switches to `/sessions` API
- Telemetry and reflection features use `sessions` + `session_messages` exclusively
- Remove runtime-specific transcript parsing from UI

### Phase 4: Cleanup
- Stop dual-writing to `chat_messages`
- Mark `chat_messages` as deprecated
- Eventually drop `chat_messages` table (after confirming no consumers remain)

---

## 8. Open Questions for Product Decision

1. **Raw payload retention policy:** Should `raw_payload` be kept indefinitely, or aged out after N days? Recommendation: keep for 90 days, then NULL out to save space. Configurable via `app_settings`.

2. **Session title derivation:** Should session titles auto-derive from task title, or should agents/runtimes explicitly set them? Recommendation: auto-derive from task title if linked, otherwise from agent name + timestamp. Allow override.

3. **Message pagination default:** What page size for `/sessions/:id/messages`? Recommendation: 100 messages per page, with `?limit=` and `?offset=` params. Max 500.

4. **Thought/tool_call visibility in Chat tab:** Should the Chat tab show `thought` and `tool_call` events by default, or only `text` events? Recommendation: show `text` by default with a toggle for "show all events". This is a UI decision for task #601.

---

## 9. Acceptance Criteria

- [ ] `sessions` table schema defined with all required fields, FKs, and indexes
- [ ] `session_messages` table schema defined with event type taxonomy
- [ ] `SessionAdapter` TypeScript interface defined with `ingest`, optional `stream`, and `resolveLiveChat` methods
- [ ] Adapter contracts specified for: OpenClaw-native, cron, Claude Code/ACP, remote/Veri
- [ ] Data flow documented: push path triggers, pull path triggers, freshness guarantees
- [ ] Consumer contracts defined: Chat tab, telemetry, reflection
- [ ] API endpoints specified: list sessions, get session, get messages, lookup by key
- [ ] Migration strategy defined: dual-write → lazy backfill → consumer migration → cleanup
- [ ] Relationship to existing `chat_messages` table explicitly documented
- [ ] Backend (#599) and frontend (#601) teams can implement without ambiguity
