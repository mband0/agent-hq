# Beginner Interactive Tutorial Spec — Agent HQ v2

**Task:** #582 — Beginner interactive Agent HQ tutorial  
**Sprint:** Agent HQ — First-Time Experience  
**Author:** Codex  
**Date:** 2026-04-10  
**Status:** Updated for implementation  
**References:** [Provider Onboarding Gate Spec — Task #572](./onboarding-provider-gate-spec.md), [Provider Research Spec — Task #571](./provider-onboarding-spec.md)

---

## 1. Overview

Agent HQ now needs a first-use tutorial that does two jobs well for non-technical users:

1. Teach them that the **Atlas chat bubble** is the safest place to ask for help
2. Walk them through the main tabs so they understand what each part of the product is for

The tutorial should not feel like documentation. It should feel like a guided product intro with clear `Continue` and `Skip tutorial` options, visible highlights, and a practical finish: using Atlas to personalize sprint definitions and task routing in plain English.

### 1.1 Product direction

The recommended pattern is a **hybrid guided walkthrough**:

- Start on the real dashboard after onboarding
- First highlight the floating **Atlas chat bubble**
- Walk the user through the core tabs with one coachmark per page
- End by returning to the dashboard and opening Atlas with a starter customization prompt

This replaces the older checklist-first concept for v1 implementation. The walkthrough is more direct for non-technical users and better supports the new Atlas-led customization ending.

### 1.2 Goals

1. The user learns within the first minute that Atlas is always available as a help surface
2. The user understands the purpose of the core tabs within 3 to 5 minutes
3. The user sees where sprint structure and routing logic live in the UI
4. The user finishes with a concrete next action: ask Atlas to customize their workspace
5. The flow remains skippable and does not trap experienced users

### 1.3 Non-goals

- Teaching every admin or power-user screen
- Replacing documentation
- Forcing the user to complete configuration changes during the tutorial
- Explaining low-level runtime, telemetry, or model-routing details

---

## 2. Included vs Excluded Areas

### 2.1 Included in the guided tour

| # | Tab / Surface | Why included |
|---|---------------|-------------|
| 1 | **Atlas chat bubble** | First safety net and simplest interaction model |
| 2 | **Dashboard** | Orientation and home base |
| 3 | **Tasks** | Core unit of work |
| 4 | **Projects** | Work container and top-level scoping |
| 5 | **Sprints** | Active work organization |
| 6 | **Sprint Definitions** | Where teams define sprint types, task defaults, and workflow templates |
| 7 | **Agents** | The workers that execute tasks |
| 8 | **Task Routing** | How Atlas decides which agent handles which task |
| 9 | **Chat** | Full chat workspace and history |

### 2.2 Excluded from the guided tour

| Tab / Surface | Why excluded |
|---------------|-------------|
| **Model Routing** | Too advanced for first-run orientation |
| **Telemetry** | Best understood after the user has run history |
| **Capabilities** | Power-user customization |
| **Workspaces** | Secondary to the core workflow |
| **Logs** | Debugging surface, not beginner onboarding |
| **Settings** | Configuration area, not part of the core mental model |

---

## 3. Recommended Tutorial Format

### 3.1 Primary format: guided walkthrough with coachmarks

The tutorial is a **linear, skippable walkthrough** with:

- one highlighted target per step
- a short explanation of what the user is seeing
- `Back`, `Continue`, and `Skip tutorial` controls

This is intentionally simpler than a persistent checklist panel for the initial implementation.

### 3.2 Why this format

- Non-technical users need stronger direction than a passive checklist
- The user can still skip at any point
- Each page only needs one stable highlight target
- The flow can end in Atlas with a prefilled prompt instead of a dead-end completion screen

### 3.3 Anti-patterns to avoid

- A forced multi-tooltip cascade on one page
- A long modal before the dashboard appears
- A mock/demo environment disconnected from the real workspace
- Requiring technical vocabulary before showing the UI

---

## 4. Tour Sequence

### 4.1 Entry step

After onboarding completes, the user lands on the **dashboard**, not the task board.

They immediately see a small start card:

- Title: `Take a quick tour`
- Body: `Learn where everything lives, then let Atlas help customize your workspace.`
- Actions: `Start tour` and `Skip for now`

### 4.2 Guided steps

| # | Route | Target | Purpose |
|---|-------|--------|---------|
| 1 | `/` | Atlas chat bubble | Teach the user where to ask for help |
| 2 | `/` | Dashboard overview area | Explain dashboard as the control center |
| 3 | `/tasks` | Task board area | Explain tasks as the core unit of work |
| 4 | `/projects` | Project list/grid | Explain projects as containers |
| 5 | `/sprints` | Sprint list/grid | Explain active work organization |
| 6 | `/sprint-definitions` | Sprint definitions workspace | Explain sprint types, task defaults, and workflow templates |
| 7 | `/agents` | Agent list/grid | Explain agent roles and responsibilities |
| 8 | `/routing` | Routing rules section | Explain deterministic task assignment |
| 9 | `/chat` | Main chat composer | Explain full chat history and direct interaction |
| 10 | `/` | Atlas chat bubble or Atlas composer | Transition to workspace customization |

### 4.3 Step copy requirements

Every step should answer:

- `What is this page?`
- `Why would I use it?`
- `What can I do here right now?`

Each step should stay short. The copy should be 1 to 3 sentences, not mini-docs.

---

## 5. Sprint Definitions in the Tour

Sprint Definitions is now part of the beginner path and should be described in plain language.

### 5.1 What the user needs to understand

- Sprint Definitions is where the team defines the structure of work before tasks are routed
- Users can define sprint types, allowed task types, default task fields, and workflow templates here
- This page shapes how tasks and sprints are created
- Task Routing is separate and handles live assignment and dispatch

### 5.2 Suggested coachmark copy

`This is where you define how your team plans work. Sprint Definitions control sprint types, task fields, and workflow templates before routing rules decide who executes the work.`

---

## 6. Final Step: Atlas-Led Customization

The tutorial should end with action, not just orientation.

### 6.1 Final transition

After the Chat tab step, the walkthrough returns to the dashboard and opens the **Atlas bubble**.

Atlas is primed with a starter prompt the user can edit.

### 6.2 Starter prompt themes

The tutorial should offer at least these prompt options:

1. `Help me define the sprint types I should use for my team`
2. `Help me set up task routing for the kinds of work we do`
3. `Help me customize sprint definitions and routing for my workflow`

### 6.3 Why this matters

This is where the tutorial shifts from:

- `Here is where things live`

to:

- `Now tell Atlas how your business works`

That is the correct handoff for non-technical users. It keeps the UI educational while letting Atlas translate plain-English needs into product configuration.

---

## 7. State, Skipping, and Replay

### 7.1 State storage

For v1, tutorial state is client-side only:

- `not_started`
- `active`
- `dismissed`
- `completed`

The current step index is also stored client-side so route changes survive page transitions during the walkthrough.

### 7.2 Skip behavior

- The user can skip from any step
- Skipping marks the tutorial as dismissed
- Skipping does not block the product

### 7.3 Replay behavior

The user should be able to restart the tour from a persistent UI entry point such as a sidebar help or guide button.

---

## 8. Implementation Notes

### 8.1 Required implementation pieces

1. A client-side tutorial state manager backed by `localStorage`
2. Stable `data-*` targets in the sidebar, pages, chat bubble, and chat input
3. A fixed-position coachmark overlay that can navigate across routes
4. A small global event bridge for Atlas chat bubble actions:
   - open
   - close
   - prime draft text
5. Onboarding handoff logic that routes to `/` and starts the tutorial instead of routing straight to `/tasks`

### 8.2 Mobile

The implementation may ship desktop-first, but should degrade safely on mobile:

- if a target is off-screen or unavailable, fall back to a centered coachmark card
- the tutorial must remain skippable

---

## 9. Acceptance Criteria

- [x] The tutorial spec now includes **Sprint Definitions**
- [x] The tutorial starts from the **dashboard**, not the task board
- [x] The **Atlas chat bubble** is the first guided step
- [x] The walkthrough includes `Continue` and `Skip tutorial`
- [x] The walkthrough covers Dashboard, Tasks, Projects, Sprints, Sprint Definitions, Agents, Task Routing, and Chat
- [x] The tutorial ends by prompting the user to use **Atlas** for workspace customization
- [x] Replay is supported through a persistent UI control

