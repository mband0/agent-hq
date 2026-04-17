# Canonical Session/Transcript Rollout Strategy

**Task:** #603  
**Author:** Wren (agency-pm)  
**Sprint:** Atlas HQ — Canonical Sessions & Transcripts  
**Status:** Approved for merge  
**Depends on:** #598 (spec, done), #599 (backend schema, done), #600 (adapters, done), #601 (chat refactor, done), #602 (reflection context, done)

---

## 1. Current State (as of 2026-04-04)

### What has shipped

| Component | Task | Status | Notes |
|-----------|------|--------|-------|
| Canonical spec (`sessions` + `session_messages` schema, adapter contract) | #598 | ✅ done | `docs/task-598-canonical-session-transcript-model-spec.md` |
| DB schema + API (`/api/v1/sessions`) | #599 | ✅ done | `api/src/db/schema.ts`, `api/src/routes/sessions.ts`, `api/src/lib/canonicalSessions.ts` |
| Runtime adapters (OpenClaw, cron, Claude Code/ACP) | #600 | ✅ done | `api/src/lib/sessionAdapters/` |
| Chat tab refactored to canonical sessions API | #601 | ✅ done | Chat no longer branches on runtime; uses `ensureSessionForInstance` + `GET /sessions/:id/messages` |
| Reflection/telemetry context (`reflectionContext.ts`) | #602 | ✅ done | `api/src/lib/reflectionContext.ts` queries `session_messages` directly |

### What is NOT yet done (the gap this task closes)

1. **No dual-write from `chat.ts` into `session_messages`.** The primary OpenClaw write path (`chat.ts` WS proxy) still writes only to `chat_messages`. `session_messages` is populated lazily on first read via `ensureCanonicalSessionForInstance`. This means a live session's canonical store can lag the real transcript by the time the `/sessions/:id/messages` endpoint is first called.

2. **`transcriptProvider.ts` is still alive.** `GET /instances/:id/transcript` remains in service and still drives some consumers (though the Chat tab has moved off it). The old provider path is still the only place that can serve a runtime-optimized view (e.g., JSONL in-progress scan for Claude Code runs).

3. **No explicit `chat_messages` deprecation policy.** The schema comment marks it as a migration-period table but there is no sunset date, no "stop writing here" gate, and no read-consumer audit.

4. **Historical backfill is undefined.** The lazy-pull path works for sessions accessed after the adapter landed, but the volume and feasibility of a bulk historical backfill has not been decided.

5. **Cutover criteria for retiring `transcriptProvider.ts` are not explicit.**

---

## 2. Rollout Plan

The plan proceeds in four phases. Phases 1–2 are low-risk and should be sequenced together. Phases 3–4 are cleanup and can be deferred until the new model is stable in production.

---

### Phase 1: Dual-Write from Chat.ts (Priority: HIGH)

**Goal:** Close the live-session freshness gap. During an active OpenClaw run, messages that flow through the WS proxy should be written to both `chat_messages` (existing) and `session_messages` (canonical).

**What to implement:**
- In `chat.ts`, wherever a `chat_messages` INSERT runs (the three write paths: gateway history batch, rolling stream upsert, finalized assistant message), also call the canonical sessions ingestion layer.
- The write to `session_messages` should be synchronous and in the same DB transaction as the `chat_messages` write where possible, so the two tables stay consistent.
- Use the existing `upsertCanonicalSessionMessages` helper from `canonicalSessions.ts` (or extend it). The session row must already exist at this point (created on instance start via `upsertCanonicalSessionForInstance`).

**Acceptance criteria:**
- [ ] A live OpenClaw WS session writes messages to both `chat_messages` and `session_messages` in real time
- [ ] `GET /sessions/:id/messages` during an active run returns messages consistent with the live WS proxy stream
- [ ] No observable performance regression in the chat proxy path (test with concurrent sessions)

**Risk:** Low. The `chat_messages` write path is already transactional and well-tested. Adding a parallel write is additive. The main risk is a slow or throwing `session_messages` write blocking the WS proxy; guard with try/catch + structured logging, and do not let a canonical session write failure break the chat path.

**Implementation note:** Any proxy-managed runtime with its own transcript write path should receive the same treatment.

---

### Phase 2: Historical Backfill — Lazy-Pull Only (Priority: MEDIUM)

**Goal:** Define the backfill strategy and avoid a costly bulk operation.

**Decision:** **Lazy-pull only. No bulk historical backfill.**

**Rationale:**
- The lazy-pull path (`ensureCanonicalSessionForInstance`) is already in production. Any consumer that requests a session automatically triggers ingestion. This is the correct behavior for the vast majority of cases.
- A bulk backfill of all historical `chat_messages` rows into `session_messages` provides no practical value: historical sessions are viewed on demand, and on-demand lazy ingestion handles that case correctly.
- The cost of a bulk migration (schema risk, table locking, correctness verification against divergent data) exceeds the benefit.
- Exception: if telemetry/analytics features need to run aggregate queries across the full historical corpus (not just sessions that happen to be viewed), a **bounded backfill** of the last 90 days is appropriate. This is deferred until a telemetry feature explicitly requires it.

**What to implement (Phase 2):**
- Add a scheduled background job (low priority, run once on startup after schema migrations land) that calls `ensureCanonicalSessionForInstance` for all `job_instances` created in the last 90 days that do not yet have a matching `sessions` row.
- Cap the job to avoid startup latency: process max 500 instances per startup run, ordered by recency. Continue on subsequent restarts until backlog is clear.
- Log progress to the existing `logs` table with `level='info'` and `agent_id=NULL`.

**Acceptance criteria:**
- [ ] On API startup, stale/missing sessions from the last 90 days are backfilled in the background (non-blocking)
- [ ] Progress and errors are visible in the Atlas HQ logs view
- [ ] No startup delay introduced (background task is truly async)

---

### Phase 3: Consumer Audit and Legacy Path Hardening (Priority: MEDIUM, after Phase 1–2)

**Goal:** Ensure all Atlas HQ features that read transcript/session data are using the canonical path, and identify any remaining direct consumers of `chat_messages` or `transcriptProvider.ts`.

**Consumers to audit:**

| Consumer | Current path | Target path | Status |
|----------|-------------|-------------|--------|
| Chat tab (UI) | `GET /sessions/:id/messages` via `ensureSessionForInstance` | ✅ Already canonical | Done |
| Reflection (`reflectionContext.ts`) | `session_messages` directly | ✅ Already canonical | Done |
| `GET /instances/:id/transcript` (API) | `transcriptProvider.ts` → `chat_messages` / JSONL | Should delegate to canonical sessions API when available | Not done |
| Telemetry aggregations (future) | TBD | `sessions` + `session_messages` | Not started |
| External callers of `/instances/:id/transcript` | Unknown | Needs audit | Not done |

**What to implement (Phase 3):**
1. **Harden `/instances/:id/transcript`:** When a canonical session exists (`sessions` row found), return data from `session_messages` instead of going through the transcript provider. Fall back to the transcript provider only when no canonical session row exists. This makes the endpoint canonical-first without removing the legacy fallback.
2. **Add a consumer registry comment** in `transcriptProvider.ts` listing known callers. This makes future cleanup explicit.
3. **Do not remove `transcriptProvider.ts` in this phase.** It is the only path for live Claude Code JSONL introspection during an active run.

**Acceptance criteria:**
- [ ] `/instances/:id/transcript` returns `session_messages` data when a canonical session exists
- [ ] Transcript provider is documented with known callers
- [ ] No regression to the Claude Code JSONL path for active runs

---

### Phase 4: Cleanup and Deprecation (Priority: LOW, after Phase 3 stable)

**Goal:** Remove the legacy write paths and table once all consumers are confirmed on the canonical model.

**Cutover criteria for stopping `chat_messages` writes:**

All of the following must be true before dual-write is removed:
1. Phase 1 dual-write has been in production for at least 2 weeks with no data discrepancy reports
2. Phase 3 audit is complete and no unaccounted consumers of `chat_messages` remain
3. `/instances/:id/transcript` has been updated to be canonical-first (Phase 3)
4. No UI or API route directly SELECTs from `chat_messages` in production code (verified by grep audit)

**Cutover criteria for dropping `chat_messages` table:**

Additional gate after write removal:
1. `chat_messages` writes have been stopped for at least 30 days
2. No SELECT queries reference `chat_messages` in any route, lib, or test file
3. A DB migration drops the table and all associated indexes cleanly on the dev environment without error

**Actions in Phase 4:**
- Remove `chat_messages` INSERT calls from `chat.ts` and any proxy-managed runtime writer
- Remove `transcriptProvider.ts` after confirming no remaining callers
- Remove legacy `GET /instances/:id/transcript` endpoint (or mark as permanently deprecated and redirect to `/sessions/by-instance/:id/messages`)
- Write and execute the DROP TABLE migration

**Acceptance criteria:**
- [ ] `chat_messages` no longer receives new writes
- [ ] `transcriptProvider.ts` deleted or unreferenced
- [ ] `chat_messages` table dropped after confirmation window
- [ ] All transcript/session consumers read exclusively from `sessions` + `session_messages`

---

## 3. Data Migration Validation Checks

These checks should run as part of Phase 1 and Phase 2 rollout and should be executable via the Atlas HQ API or a one-off script:

### 3.1 Session coverage check
```sql
-- How many job_instances in the last 90 days have no canonical session?
SELECT COUNT(*) as missing_sessions
FROM job_instances ji
LEFT JOIN sessions s ON s.instance_id = ji.id
WHERE ji.created_at >= datetime('now', '-90 days')
  AND s.id IS NULL;
```
**Target:** 0 after Phase 2 backfill job runs.

### 3.2 Message count drift check
```sql
-- Sessions where canonical message_count diverges from chat_messages row count
SELECT s.id, s.external_key, s.message_count as canonical_count,
       COUNT(cm.id) as chat_messages_count
FROM sessions s
LEFT JOIN chat_messages cm ON cm.instance_id = s.instance_id
GROUP BY s.id
HAVING ABS(canonical_count - chat_messages_count) > 5;
```
**Target:** 0 after Phase 1 dual-write lands. Acceptable drift threshold is ±5 messages (covers edge cases like stream upsert deduplication).

### 3.3 Orphaned `chat_messages` rows
```sql
-- chat_messages rows that have no corresponding session_messages row
-- (approximate: check by instance_id)
SELECT COUNT(*) as orphaned
FROM chat_messages cm
LEFT JOIN sessions s ON s.instance_id = cm.instance_id
WHERE s.id IS NULL;
```
**Target:** Decreasing over time. After Phase 2 backfill, should be near 0 for the last-90-days window.

### 3.4 Live-session freshness check
After Phase 1 lands, add a CI/integration test:
- Dispatch a test agent run
- Verify that `GET /api/v1/sessions/by-key/:externalKey/messages` returns the latest messages within 1 second of the WS proxy writing them
- Assert that `session.message_count` matches `session_messages` row count for the session

---

## 4. Rollout Order Summary

| Phase | Task | Priority | Depends on | Effort |
|-------|------|----------|------------|--------|
| 1 | Dual-write chat_messages → session_messages in chat.ts + proxy-managed runtime writer | HIGH | #599, #600 | 3 sp |
| 2 | Background startup backfill job (90d window, 500/run) | MEDIUM | Phase 1 | 2 sp |
| 3 | Harden /instances/:id/transcript to prefer canonical; consumer audit | MEDIUM | Phase 2 stable | 3 sp |
| 4 | Remove dual-write, deprecate transcriptProvider.ts, drop chat_messages | LOW | Phase 3 + 2w stable | 2 sp |

---

## 5. Open Decisions Resolved

| Question | Decision | Rationale |
|----------|----------|-----------|
| Bulk historical backfill vs lazy-pull? | Lazy-pull only, bounded background pass for 90d window | No feature requires full historical corpus today; lazy-pull handles on-demand access |
| Rollout order for Chat, telemetry, reflection? | Chat: done (#601). Reflection/telemetry: done (#602). Remaining: live write gap (Phase 1) and legacy API hardening (Phase 3) | Highest-traffic consumer (Chat) shipped first; lower-traffic reflection/analytics followed |
| Dual-write removal gate? | 2 weeks stable + consumer audit complete + canonical-first transcript endpoint live | Avoids data loss risk from premature cleanup |
| `chat_messages` drop gate? | 30 days post write-removal + confirmed zero SELECT references | Extra buffer for undetected consumers |
| `transcriptProvider.ts` retirement? | After Phase 3: keep as fallback for live Claude Code JSONL runs until native push covers that case | Claude Code adapter is pull-based; live JSONL introspection still needs the file-scan path during active runs |

---

## 6. Acceptance Criteria (this task)

- [x] Safe migration/rollout plan exists: phases, ordering, and priorities are explicit
- [x] Existing features can move over incrementally without breaking runtime support (Phase 1 is additive; no breaking changes)
- [x] Cutover/deprecation criteria are explicit (Section 4, Phase 4)
- [x] Historical backfill strategy is decided (lazy-pull + bounded 90d background pass)
- [x] Data validation checks defined for migration correctness verification
- [x] Open product questions (bulk vs lazy, rollout order, removal gates) are resolved
