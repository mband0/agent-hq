# Agent HQ Architecture Overview

This document is the public-facing system overview for Agent HQ. It complements the deeper implementation notes in [INFRASTRUCTURE.md](../INFRASTRUCTURE.md).

## System map

```mermaid
flowchart TB
    Human["Operator / PM"]
    UI["Agent HQ UI<br/>Next.js"]

    subgraph Control["Agent HQ control plane"]
      API["API<br/>Express + TypeScript"]
      Reconciler["Reconciler<br/>find eligible work"]
      Dispatcher["Dispatcher<br/>resolve route + launch run"]
      Watchdog["Watchdog<br/>stale-run recovery"]
    end

    DB[("SQLite<br/>tasks · agents · instances · transcripts")]

    subgraph Runtimes["Agent runtimes"]
      OpenClaw["OpenClaw<br/>local hooks + chat"]
      Claude["Claude Code<br/>local SDK / subprocess"]
    end

    Human --> UI
    UI --> API
    API <--> DB
    API --> Reconciler
    Reconciler --> Dispatcher
    API --> Dispatcher
    API --> Watchdog
    Dispatcher --> OpenClaw
    Dispatcher --> Claude
    OpenClaw --> API
    Claude --> API
```

## Core components

- `UI`: the operator surface for tasks, agents, chat, routing, projects, sprints, logs, and telemetry.
- `API`: the central control plane. It owns task state, lifecycle transitions, transcript persistence, MCP endpoints, and runtime integration.
- `Reconciler`: periodically finds tasks that are eligible to move forward and hands them to the dispatcher.
- `Dispatcher`: resolves the correct execution lane from routing rules, creates job instances, materializes runtime context, and launches the run.
- `Watchdog`: monitors stale or orphaned runs and applies recovery behavior.
- `SQLite`: the durable system of record for projects, tasks, agents, instances, routing, artifacts, and transcripts.

## Runtime model

Agent HQ supports multiple execution backends behind one workflow model:

- `OpenClaw`: local agents with hooks, chat sessions, shell access, and workspace tools.
- `Claude Code`: local SDK/subprocess-based runs with Agent HQ-provided context and callback contracts.
The dispatcher chooses the correct runtime from the agent record. Task lifecycle and routing semantics stay consistent across runtimes.

## Primary data flow

```mermaid
sequenceDiagram
    participant User
    participant UI
    participant API
    participant Reconciler
    participant Dispatcher
    participant Runtime as Agent runtime
    participant DB as SQLite

    User->>UI: Create task or move task to ready
    UI->>API: Persist task change
    API->>DB: Store task state
    Reconciler->>API: Evaluate eligible tasks
    API->>Dispatcher: Resolve route
    Dispatcher->>DB: Create job instance
    Dispatcher->>Runtime: Start run with prompt + contracts
    Runtime->>API: start / heartbeat / outcome / complete
    API->>DB: Persist transcripts, evidence, and lifecycle updates
    API->>UI: Serve updated state to operators
```

## Routing and execution lifecycle

At a high level:

1. A task is created or moved into a routable state such as `ready`.
2. The reconciler evaluates routing rules using sprint, task type, and current status.
3. The dispatcher picks the correct route and launches a job instance.
4. The runtime sends progress and completion signals back to the API.
5. The API records transcripts, evidence, and outcome transitions.
6. The watchdog intervenes if a run becomes stale or orphaned.
