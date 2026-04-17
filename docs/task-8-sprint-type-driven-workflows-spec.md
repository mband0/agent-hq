# Task #8 — Sprint-Type-Driven Workflow Statuses, Task Types, and Migration Strategy

## Status
Final PM/spec artifact for sprint #39 *Atlas HQ — Configurable Sprint Workflows*. Implementation tracks: tasks #9, #10, #11, #12, #13, #14.

## Goal
Make a sprint's **sprint type** the configuration boundary for workflow shape: which statuses/columns appear on its board, which transitions are valid for tasks on that board, which outcomes are accepted, and which task types are allowed. Today this is implicit and project-shaped; this spec moves it to explicit per-sprint-type config without breaking the existing protected release pipeline.

## Anchored to current Atlas HQ behavior
Verified at the time of writing:

- `task_statuses` is global, system-seeded, and currently the only source of board columns. System rows are flagged `is_system=1`. `allowed_transitions` is stored per status.
- `routing_transitions` is keyed by `(project_id, task_type, from_status, outcome) → to_status`. It already supports per-`task_type` priority overrides (PM family already overrides `approved_for_merge` to skip QA). The release pipeline rows are flagged `is_protected=1` and remain code-enforced regardless of row enable/disable state.
- `transition_requirements` provides per-(`task_type`, `outcome`) evidence/field gates and is consumed by `requireReleaseGate()`.
- `sprint_types`, `sprint_type_task_types`, and `task_field_schemas` already exist (Task #1). `sprints.sprint_type` already drives task-type catalogs and custom-field schemas in `resolveTaskFieldSchema()`. **Task-type catalog by sprint type is already in place** — this spec extends the same model to status sets, transitions, and board columns without re-keying routing.
- `services/contracts/workflowContract.ts` is the canonical lane resolver and currently keys lanes off `taskStatus` and `task_type` only. It does not consult sprint type yet.

## Canonical decisions

### D1. Sprint type owns workflow shape; routing stays additive
- Sprint type drives **status visibility, allowed transitions, board columns, and accepted outcomes** for tasks within that sprint.
- Routing keys stay `(project_id, task_type, from_status, outcome)` in v1 (per MEMORY lesson). Sprint type acts as a **filter and validation boundary on top of routing**, not a new routing dimension.
- Protected release-pipeline rows in `routing_transitions` (`is_protected=1`) remain enforced for every sprint type that opts into the release lane. Sprint-type config can hide or disable optional rows but **cannot override protected ones**.

### D2. Workflow templates are first-class records, sprint type points at one
- Introduce `workflow_templates` as the unit of "a workflow." A template is a named bundle of: ordered status set, board columns, valid transitions, and accepted outcomes.
- Each `sprint_types` row gets a `default_workflow_template_key`. When a sprint is created, that template is copied/linked into the sprint's effective workflow.
- Templates are seeded as `is_system=1` and editable/clonable from admin UI. New sprint types can be admin-created (per Task #1 decision) and assigned a template.

### D3. Workflow-effective state lives on the sprint, not on tasks
- `sprints.workflow_template_key` (nullable) points at the resolved template at sprint create time.
- Resolution order at any read: `sprint.workflow_template_key` → `sprint_type.default_workflow_template_key` → `default` template (`generic`).
- Tasks do **not** carry workflow config. They keep `status`, `task_type`, and `sprint_id`. Validation reads the sprint-resolved workflow.

### D4. Status records are global; visibility/order is per template
- `task_statuses` stays the **single global registry** of status names, labels, colors, and `is_system` flags. Adding/removing statuses globally is still admin-controlled and remains a separate concern from per-sprint visibility.
- A workflow template references statuses by name and adds **per-template metadata**: `column_order`, `column_label_override` (optional), and a `visible` flag.
- A task transitioning out of a non-visible status (e.g. legacy data) is allowed and routes to the nearest visible status per the template's transition rules.

### D5. Transitions are template-scoped, not status-scoped
- `task_statuses.allowed_transitions` becomes a **legacy fallback only**. New behavior consults the template's transition table.
- Each template has a transition table: `(from_status, outcome) → to_status` with optional `task_type` override and `priority`. Same shape as `routing_transitions` so engine reuse is trivial.
- Protected release transitions (the `is_protected=1` set) are **always merged in** for any template that includes any of: `qa_pass`, `ready_to_merge`, `deployed`, `done`. Templates that omit those statuses simply do not gain those rows.

### D6. Task-type eligibility per sprint type is already real and stays as-is
- `sprint_type_task_types` continues to define allowed task types per sprint type. No schema change there.
- `workflow_templates` may further narrow what task types appear in this template via an optional `allowed_task_types` JSON column. If null → inherit from `sprint_type_task_types`.
- Validation order at task create/edit: `workflow_templates.allowed_task_types` → `sprint_type_task_types` → global superset.

### D7. Outcome catalog is template-scoped
- A template's transition table implicitly defines the **set of valid outcomes** for that template.
- `workflowContract.resolveWorkflowLane()` becomes sprint-aware: it resolves the active template for the task's sprint and returns only outcomes that have a matching transition in the template.
- Hardcoded lane resolution (`PM_TASK_TYPES`, `isReviewLane`, etc.) becomes a fallback when no template is resolvable.

### D8. Backwards-compatible default
- A `default` workflow template ships pre-seeded with **the current global pipeline**: `todo → ready → dispatched → in_progress → review → qa_pass → ready_to_merge → deployed → done` plus `needs_attention`, `stalled`, `cancelled`, `failed`.
- All existing sprint types (`generic`, `dev`, `ops`, `pm`) get their `default_workflow_template_key` set to `default` at migration time. Net behavior change: zero.

## Workflow template model

### Template record
| field | type | notes |
|---|---|---|
| `key` | TEXT PK | e.g. `default`, `pm_lite`, `ops_incident` |
| `name` | TEXT | display |
| `description` | TEXT | |
| `is_system` | INTEGER | system templates cannot be deleted |
| `allowed_task_types` | TEXT (JSON array) NULL | optional narrowing on top of `sprint_type_task_types` |
| `created_at` / `updated_at` | TEXT | |

### Template status set
| field | type | notes |
|---|---|---|
| `template_key` | TEXT FK | |
| `status_name` | TEXT FK → `task_statuses.name` | |
| `column_order` | INTEGER | board order (ascending) |
| `column_label_override` | TEXT NULL | optional per-template label |
| `is_visible_on_board` | INTEGER (0/1) | hidden statuses still legal in transitions but not rendered as columns |
| UNIQUE | (`template_key`, `status_name`) | |

### Template transitions
| field | type | notes |
|---|---|---|
| `id` | INTEGER PK | |
| `template_key` | TEXT FK | |
| `task_type` | TEXT NULL | optional per-task-type override (matches existing routing pattern) |
| `from_status` | TEXT | |
| `outcome` | TEXT | |
| `to_status` | TEXT | |
| `priority` | INTEGER | higher wins; matches `routing_transitions` semantics |
| `is_system` | INTEGER | seeded protected rows stay flagged |
| `enabled` | INTEGER | system protected rows ignore disable in code (mirrors `is_protected` behavior) |

### Sprint linkage
- `sprints` adds nullable `workflow_template_key`. Backfilled from `sprint_types.default_workflow_template_key`.
- `sprint_types` adds nullable `default_workflow_template_key`. Backfilled to `default`.

## Resolver model

### `resolveSprintWorkflow(sprint_id)` (new)
1. Fetch sprint. If missing → return `default` template.
2. If `sprint.workflow_template_key` set → use it.
3. Else use `sprint_types.default_workflow_template_key` for the sprint's `sprint_type`.
4. Else fall back to `default`.
5. Load template + status set + transitions.
6. Merge protected release transitions from `routing_transitions WHERE is_protected=1` if the template's status set includes any release stages.

### `resolveWorkflowLane()` (extended)
- Accept optional `sprint_id` (or `workflowTemplate`) argument.
- If a template is provided/resolvable, derive `validOutcomes` from the template's transition table at the task's `from_status` (filtered by `task_type` override if present).
- If not resolvable → fall back to current hardcoded lane resolver. PM family heuristic stays as fallback only.

### Transition validation (Task #13 enabling)
- New service `assertTransitionAllowed({ task, outcome })` consults `resolveSprintWorkflow(task.sprint_id)`, looks up `(task.status, outcome) → to_status`, applies `task_type` override priority, then layers `transition_requirements` evidence checks via `requireReleaseGate()`.
- Protected release rows remain authoritative even if a template tries to disable them. The validator must hard-enforce `is_protected=1` rows for any template that exposes the corresponding statuses.

## Task-type eligibility per sprint type (already in place + small polish)
- `sprint_type_task_types` is the canonical source of allowed task types per sprint type.
- Add nullable `workflow_templates.allowed_task_types` for templates that need to be narrower than the sprint type allows (e.g. an `ops_incident` template that only allows `ops` and `pm_operational`).
- Resolution: `workflow_templates.allowed_task_types ?? sprint_type_task_types`.
- Task create/edit must reject any `task_type` not in the resolved list, with a clear error code (`task_type_not_allowed_for_sprint_workflow`). This is already partially done via `getAllowedTaskTypesForSprintType()`; this spec extends the resolver to also consider `workflow_templates.allowed_task_types`.

## Seeded templates (v1)
1. **`default`** — current global pipeline. All statuses visible. Used by every existing sprint type at migration.
2. **`pm_lite`** — `todo → ready → dispatched → in_progress → review → ready_to_merge → done` plus `needs_attention`, `stalled`, `cancelled`. Allowed task types: `pm`, `pm_analysis`, `pm_operational`. Skips `qa_pass` and `deployed` columns. Uses existing PM-family routing override (`approved_for_merge` → `ready_to_merge`).
3. **`ops_incident`** — `todo → in_progress → resolved → closed` plus `needs_attention`. Allowed task types: `ops`. Resolved/closed are simple terminal states; release pipeline rows are not merged because the status set has no release stages.
4. **`generic`** — alias for `default`. Documented as the safe fallback.

These cover the four seeded sprint types and give backend a concrete seed list for Task #9.

## Migration strategy

### Phase 0 — additive schema (Task #9)
- Add tables: `workflow_templates`, `workflow_template_statuses`, `workflow_template_transitions`.
- Add columns: `sprints.workflow_template_key`, `sprint_types.default_workflow_template_key`, `workflow_templates.allowed_task_types`.
- All new columns nullable; no behavior change yet.

### Phase 1 — seed default templates (Task #9)
- Seed `default`, `pm_lite`, `ops_incident`, `generic` as `is_system=1`.
- Seed each existing `sprint_types` row with `default_workflow_template_key='default'` (except `pm` which can point at `pm_lite` if the team is comfortable; otherwise leave on `default` and revisit).
- Backfill `sprints.workflow_template_key` to whatever its sprint type's default resolves to. This is a one-time migration UPDATE.

### Phase 2 — resolver layer (Task #10)
- Add `resolveSprintWorkflow()` and feed it into routing/lane code paths.
- `workflowContract.resolveWorkflowLane()` accepts an optional resolved workflow and produces `validOutcomes` from template transitions, falling back to existing logic when nothing is resolvable.
- This phase is read-only — no validation changes yet. Prove the resolver returns identical lanes to today's hardcoded path for all current tasks.

### Phase 3 — frontend wiring (Tasks #11, #12)
- Sprint create/edit form gains a workflow template picker (Task #11). Only `is_system` templates in v1; admin clone-and-edit is a v2 stretch.
- Board page renders columns from `resolveSprintWorkflow(sprint_id)` instead of the global `task_statuses` list (Task #12). Hidden statuses become uncolumned but still legal.
- TaskDetailPanel's outcome dropdown sources `validOutcomes` from the resolved template via the extended `resolveWorkflowLane()`.

### Phase 4 — enforcement (Task #13)
- Add `assertTransitionAllowed()` and call it from task status updates and outcome posting.
- Reject invalid transitions with `transition_not_allowed_for_workflow` error code; preserve existing `requireReleaseGate()` evidence error codes.
- Protected release rows are hard-enforced regardless of template.

### Phase 5 — cleanup
- Mark `task_statuses.allowed_transitions` as legacy in code comments. Do **not** drop; reconciler and ad-hoc tooling may still read it.
- Plan to remove project-scoped workflow assumptions from `services/contracts/workflowContract.ts`'s hardcoded lane logic in a follow-up after telemetry confirms the resolver covers every live sprint.

## Edge cases

1. **Task with no sprint** → `resolveSprintWorkflow` returns the `default` template. Lanes resolve as today.
2. **Sprint with `workflow_template_key` pointing at a deleted template** → fall back to `sprint_types.default_workflow_template_key`, then to `default`. Surface a warning in admin UI but never block task work.
3. **Template tries to omit a release stage that the task is currently in** (e.g. switching a sprint from `default` to `pm_lite` while a task is at `qa_pass`) → existing tasks remain valid; the template change applies forward only. Do not retroactively move tasks. Phase 4 validator must allow legacy transitions out of stages the template no longer exposes.
4. **Protected release transition disabled in template** → ignored. `is_protected=1` rows are always merged in by the resolver.
5. **Task type incompatible with new template** when re-pointing a sprint → block the sprint workflow change with a clear "tasks of type X are no longer allowed by this workflow" error and a list of offending task IDs. Do not auto-rewrite tasks.
6. **Custom (non-system) status added globally** → not visible on any template by default. Admin must add it to a template's status set explicitly.
7. **Task moved to a different sprint with a different template** → re-validate the task's status against the new template. If the current status is not in the new template's status set, place the task in `needs_attention` with a system note explaining the mismatch.
8. **Outcome valid in template A but not in template B during the same task lifecycle** (sprint reassignment) → current outcome history is preserved; future outcomes are validated only against the active template at the time of posting.
9. **Concurrent template edits** → templates are versioned implicitly via `updated_at`. v1 does not need optimistic locking; admin edits are infrequent and only system templates ship at launch.
10. **Reconciler / Needs Attention safety net** → `needs_attention` status must be in every system template's status set to keep `getNeedsAttentionEligibleStatuses()` and the immediate fallback path functional.
11. **`failed` and `stalled` semantics** → both must remain reachable in every system template. Recovery transitions (`failed:<class>` → `ready`) are merged in like protected rows when the template includes `failed`.
12. **`generic` sprint type** → ships pointing at `default`. Anything created with no explicit sprint type stays on the broadest workflow.
13. **Telemetry drift** → log every resolver fallback (`template_missing`, `sprint_type_missing`) so we can see whether any sprint is silently riding the `default` fallback after Phase 1.

## Acceptance criteria (mapped to task brief)

- [x] **Spec defines sprint-type-driven workflow model** → Decisions D1, D2, D3, D4 plus the workflow template model section.
- [x] **Spec defines transition-rule model** → Decision D5 plus the `workflow_template_transitions` schema and the resolver model section.
- [x] **Spec defines task-type eligibility by sprint type** → Decision D6 plus the task-type eligibility section. Routing keys are not expanded; eligibility resolves in template → sprint_type_task_types order.
- [x] **Spec defines migration strategy clearly** → Five-phase migration above with explicit task ownership.

## Open questions for Atlas
1. Does `pm` sprint type ship pointing at `default` or `pm_lite` at Phase 1? Recommendation: ship at `default` to avoid surprising the existing PM team, then flip to `pm_lite` once the board renderer is verified.
2. Should admin clone-and-edit of system templates ship in v1 or be deferred? Recommendation: defer. v1 ships only seeded system templates.
3. Should we expose a "workflow template" column on the sprints list page so we can see at a glance which sprint runs which workflow? Recommendation: yes, low cost and high value.

## Implementation track handoff

- **Task #9 (backend, ready)** — own Phase 0 schema and Phase 1 seeds. Seed all four templates above. Backfill `sprint_types.default_workflow_template_key='default'`. Backfill `sprints.workflow_template_key`. Add API endpoints `GET /api/v1/workflow-templates`, `GET /api/v1/workflow-templates/:key`, and `GET /api/v1/sprints/:id/workflow` returning the resolved template.
- **Task #10 (backend, ready)** — own Phase 2 resolver. Add `resolveSprintWorkflow()` in `lib/sprintWorkflow.ts`. Extend `services/contracts/workflowContract.ts::resolveWorkflowLane` to accept and prefer a resolved workflow. No enforcement yet; resolver must produce identical lanes for every existing live task (write a verification test using current task fixtures).
- **Task #11 (frontend, ready)** — sprint create/edit form picks a workflow template. Use `GET /api/v1/workflow-templates`. Default to the sprint type's default. Display selected template's status set inline as a confirmation strip.
- **Task #12 (frontend, ready)** — board page columns come from `GET /api/v1/sprints/:id/workflow`. Hide statuses with `is_visible_on_board=0`. Render `column_label_override` when set.
- **Task #13 (backend, ready)** — Phase 4 enforcement. Add `assertTransitionAllowed()` and wire it into task status updates and `applyTaskOutcome()`. Preserve existing `requireReleaseGate()` evidence checks. Add error codes `transition_not_allowed_for_workflow` and `task_type_not_allowed_for_sprint_workflow`. Hard-enforce `is_protected=1` regardless of template state.
- **Task #14 (qa, todo)** — end-to-end QA. Verify: (1) every existing sprint behaves identically after migration; (2) `pm_lite` template hides QA columns; (3) `ops_incident` template prevents non-ops task types; (4) protected release rows cannot be bypassed; (5) reassigning a task across sprints with incompatible templates puts it in `needs_attention`.

## Result
This spec defines a sprint-type-driven workflow model that:
- Adds an explicit workflow template layer between `sprint_types` and tasks.
- Reuses existing routing semantics and protected release pipeline without expanding routing keys.
- Lets each sprint type own its own status set, board columns, transitions, and task-type narrowing.
- Migrates additively: every existing sprint lands on the `default` template with zero behavioral change.
- Hands the implementation tracks (#9–#14) clean, sequenced work.
