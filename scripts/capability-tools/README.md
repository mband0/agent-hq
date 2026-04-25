# Capability Tool Templates

This directory contains source-controlled templates for Agent HQ capability tools
whose executable bodies are stored in the Agent HQ database.

## `deploy_dev_worktree`

`deploy_dev_worktree` promotes committed Agent HQ code into a persistent dev
checkout instead of running the dev app from an agent workspace.

Flow:

1. The agent codes in its own Agent HQ workspace/worktree.
2. The agent commits all intended changes.
3. The tool verifies the source checkout is clean.
4. The tool fetches that exact source `HEAD` into `/Users/nordini/agent-hq-dev`.
5. The tool hard-resets the persistent dev checkout to that commit.
6. The tool builds and restarts the PM2 dev services from the persistent dev checkout.

The persistent dev checkout keeps local ignored state such as
`agent-hq-dev.db`, `.env`, and service-local env files, so agents do not need to
copy databases or secrets into their coding workspaces.

Refresh the DB-backed tool body after editing the template:

```sh
node scripts/capability-tools/install-deploy-dev-worktree-tool.mjs
```
