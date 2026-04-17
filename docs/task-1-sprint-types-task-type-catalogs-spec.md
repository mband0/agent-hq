# Task #1 — Sprint Types, Task-Type Catalogs, and Custom Task Field Schema Design

## Status
Final PM/spec artifact aligned to current Atlas HQ behavior.

## Canonical decision
Sprint type becomes the primary configuration boundary for task creation and task configuration, replacing project-type-driven assumptions.

## Core decisions

### 1) Sprint type is the config boundary
- Use sprint type as the primary boundary for task creation/config resolution.
- Sprint type determines the allowed task-type catalog and the baseline field schema.
- Task type remains a per-task classifier selected from the catalog allowed by that sprint type.

### 2) Sprint types should be records, not hardcoded forever
- Sprint types should be admin-configurable records seeded with system defaults.
- Initial seeded defaults:
  - `dev`
  - `ops`
  - `pm`
  - `generic`
- These are system defaults, not a forever-closed enum.

### 3) Task-type catalog resolution
- Allowed task types resolve from sprint type.
- Sprint type gates which task types can be created within that sprint.
- Keep `/api/v1/routing/task-types` as the global superset for admin/debug use.
- Add sprint-aware catalog resolution for task create/edit flows.

### 4) Schema resolution model
Resolve task form schema from:
- `sprint_type + task_type`

Precedence model:
1. Global canonical task model
2. Sprint-type baseline schema
3. Task-type override within that sprint type

Task-type overrides win over sprint-type baseline rows.

### 5) Core evidence/release fields remain first-class task columns
Do **not** move release/evidence fields into JSON.
These remain first-class columns on `tasks`, including fields like:
- `review_*`
- `qa_*`
- `merged_*`
- `deployed_*`
- `live_verified_*`

Sprint/task-type schema controls:
- visibility
- requiredness
- help text

It does **not** change where core evidence is stored.

### 6) Custom fields storage
- Add `tasks.custom_fields_json` for non-core fields only.
- Use it for sprint/task-type-specific metadata that does not belong in canonical top-level task columns.

### 7) Tasks without a sprint
- Tasks with no sprint must use a safe fallback profile.
- Fallback sprint type: `generic`
- This prevents non-dev work from inheriting branch/commit/dev-url assumptions.

### 8) Routing stays project + task_type + status in v1
- Keep routing keyed by:
  - `project_id`
  - `task_type`
  - `status`
- Sprint type is an additive validation/catalog/form layer in v1.
- Do **not** expand routing keys to include sprint type yet.

## Proposed data model additions

### Sprints
Add:
- `sprints.sprint_type_key`

### New config tables
Add:
- `sprint_types`
- `sprint_type_task_types`
- `task_field_schemas`

### Tasks
Add:
- `tasks.custom_fields_json`

## Implementation guidance

### Backend
- Expose sprint type on sprint APIs.
- Add sprint-aware task-type catalog endpoint(s).
- Add resolved field-schema endpoint(s) based on `sprint_type + task_type`.
- Validate task create/update against resolved sprint schema.

### Frontend
- Add sprint type selection/editing on sprint forms.
- Re-resolve allowed task types whenever sprint selection changes.
- Re-resolve dynamic task fields whenever sprint or task type changes.
- Block invalid `task_type` values when moving a task into an incompatible sprint.
- Render stored custom fields in task detail surfaces using schema metadata.

## Migration guidance
- Backfill existing sprints conservatively.
- Prefer `generic` unless there is strong signal for `dev`, `ops`, or `pm`.
- Keep old project-type-driven logic only as a temporary migration bridge.
- Remove project-type-driven task-form behavior after backfill/cutover is complete.

## Live implementation alignment checked during PM handoff
At handoff time:
- `/api/v1/routing/task-types` still returned one global task-type list.
- Sprint APIs did not yet expose sprint type.
- Routing remained project + task_type + status based.

## Result
This spec defines the canonical direction for:
- sprint-type-driven task-type catalogs
- sprint-type-driven custom task field schema resolution
- additive migration away from project-type-driven behavior
- preserving first-class evidence/release fields while enabling dynamic task metadata
