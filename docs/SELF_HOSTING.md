# Self-Hosting Agent HQ

This guide covers production-grade self-hosting of Agent HQ: custom ports, external data directories, reverse proxy setup, and optional OpenClaw agent integration.

For a basic local quickstart, see the [README](../README.md).

---

## Table of contents

1. [Requirements](#requirements)
2. [Installation methods](#installation-methods)
3. [Custom ports](#custom-ports)
4. [Custom data directory](#custom-data-directory)
5. [Docker Compose (recommended)](#docker-compose-recommended)
6. [Bare-metal / PM2](#bare-metal--pm2)
7. [Reverse proxy](#reverse-proxy)
8. [Environment variable reference](#environment-variable-reference)
9. [Database](#database)
10. [OpenClaw integration](#openclaw-integration)
11. [Agent fleet setup](#agent-fleet-setup)
12. [Backups](#backups)
13. [Upgrading](#upgrading)

---

## Requirements

| Requirement | Minimum version |
|---|---|
| Node.js | v20 LTS |
| npm | v9 |
| SQLite | bundled via `better-sqlite3` |
| Docker (optional) | 20.10+ |
| Docker Compose (optional) | v2.x |

---

## Installation methods

### Option A — npx (public CLI)

```bash
npx agent-hq start
```

This is the supported public CLI entrypoint.

- If Docker is available, it starts the Docker stack.
- If Docker is not available, it falls back to local Node.js mode automatically.
- To force local mode, run `npx agent-hq start --no-docker`.

### Option B — Docker Compose (recommended for persistent installs)

```bash
git clone https://github.com/mband0/agent-hq.git
cd agent-hq
docker compose up -d
```

### Option C — Bare-metal with PM2

Clone the repo, build, and manage with PM2 (see [Bare-metal / PM2](#bare-metal--pm2) below).

---

## Custom ports

All ports are controlled by environment variables.

### API port

```bash
PORT=4501 node dist/index.js
```

### UI port

The UI port is set at both build time and runtime.

**Build time** (required for Docker — bakes the API URL into the Next.js bundle):
```bash
NEXT_PUBLIC_API_URL=http://my-server:4501 npm run build
```

**Runtime:**
```bash
PORT=4500 npm start
```

### .env file example

For Docker Compose installs, copy the root example file and edit the supported overrides:

```bash
# .env
AGENT_HQ_API_PORT=3501
AGENT_HQ_UI_PORT=3500
NEXT_PUBLIC_API_URL=http://localhost:3501
```

---

## Custom data directory

By default the SQLite database is written to the repo root as `agent-hq.db`.

To use a different path:

```bash
AGENT_HQ_DB_PATH=/var/data/agent-hq/agent-hq.db node dist/index.js
```

Or set a base directory (database file will be `agent-hq.db` inside it):

```bash
AGENT_HQ_DATA_DIR=/var/data/agent-hq node dist/index.js
```

`AGENT_HQ_DB_PATH` takes precedence over `AGENT_HQ_DATA_DIR` when both are set.

The API creates the database file and its parent directory automatically on first startup.

---

## Docker Compose (recommended)

### Basic setup

```yaml
# docker-compose.yml (simplified example)
services:
  api:
    image: nordinit/agent-hq-api:latest
    ports:
      - "3501:3501"
    environment:
      PORT: 3501
      AGENT_HQ_DB_PATH: /data/agent-hq.db
    volumes:
      - agent-hq-data:/data

  ui:
    image: nordinit/agent-hq-ui:latest
    ports:
      - "3500:3500"
    environment:
      PORT: 3500
    depends_on:
      - api

volumes:
  agent-hq-data:
```

### Custom ports via .env file

```bash
# .env
AGENT_HQ_API_PORT=4501
AGENT_HQ_UI_PORT=4500
NEXT_PUBLIC_API_URL=http://localhost:4501
```

```yaml
# docker-compose.yml
services:
  api:
    image: nordinit/agent-hq-api:latest
    ports:
      - "${AGENT_HQ_API_PORT:-3501}:3501"
    environment:
      PORT: "3501"
      AGENT_HQ_DB_PATH: /data/agent-hq.db
    volumes:
      - agent-hq-data:/data

  ui:
    image: nordinit/agent-hq-ui:latest
    build:
      args:
        NEXT_PUBLIC_API_URL: "${NEXT_PUBLIC_API_URL:-http://localhost:3501}"
    ports:
      - "${AGENT_HQ_UI_PORT:-3500}:3500"
    environment:
      PORT: "3500"
    depends_on:
      - api

volumes:
  agent-hq-data:
```

Start:
```bash
docker compose --env-file .env up -d
```

---

## Bare-metal / PM2

Install PM2 globally if you haven't:

```bash
npm install -g pm2
```

### Build

```bash
# API
cd api && npm install && npm run build

# UI
cd ../ui && npm install && npm run build
```

### Start with PM2

```bash
# API
PORT=3501 AGENT_HQ_DB_PATH=/var/data/agent-hq/agent-hq.db \
  pm2 start api/dist/index.js --name agent-hq-api

# UI
PORT=3500 NEXT_PUBLIC_API_URL=http://localhost:3501 \
  pm2 start "npm run start" --name agent-hq-ui --cwd ui
```

### PM2 ecosystem file

For production, define an ecosystem file:

```js
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'agent-hq-api',
      script: './api/dist/index.js',
      env: {
        PORT: 3501,
        AGENT_HQ_DB_PATH: '/var/data/agent-hq/agent-hq.db',
        NODE_ENV: 'production',
      },
    },
    {
      name: 'agent-hq-ui',
      script: 'npm',
      args: 'run start',
      cwd: './ui',
      env: {
        PORT: 3500,
        NODE_ENV: 'production',
      },
    },
  ],
};
```

Start:
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # configure PM2 to launch on boot
```

---

## Reverse proxy

### nginx

Proxy both UI and API behind a single domain:

```nginx
server {
    listen 80;
    server_name agenthq.example.com;

    # UI
    location / {
        proxy_pass http://localhost:3500;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # API
    location /api/ {
        proxy_pass http://localhost:3501;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

> **Note:** When the API is served under `/api/` via the reverse proxy, configure the UI to point `NEXT_PUBLIC_API_URL` at the proxied path (`https://agenthq.example.com/api`) rather than the direct port.

### Caddy

```caddyfile
agenthq.example.com {
    handle /api/* {
        reverse_proxy localhost:3501
    }
    handle {
        reverse_proxy localhost:3500
    }
}
```

---

## Environment variable reference

### API environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3501` | API server port |
| `AGENT_HQ_DB_PATH` | `<repo-root>/agent-hq.db` | Absolute path to the SQLite database file |
| `AGENT_HQ_DATA_DIR` | `<repo-root>` | Base directory for the database (used when `AGENT_HQ_DB_PATH` is not set) |
| `OPENCLAW_BIN` | `openclaw` | Path or name of the OpenClaw CLI binary |
| `OPENCLAW_CONFIG_PATH` | `~/.openclaw/openclaw.json` | Path to the OpenClaw gateway config file |
| `WORKSPACE_ROOT` | `~/.openclaw/workspace` | Root directory for agent workspaces |
| `OPENCLAW_NODE_BIN` | _(auto-detected)_ | Node binary directory; used when spawning `openclaw` CLI subprocess |
| `NODE_ENV` | `production` | Node environment |

### UI environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3500` | UI server port |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3501` | Agent HQ API base URL — **must be set at build time** for Docker images |
| `NODE_ENV` | `production` | Node environment |

---

## Database

Agent HQ uses SQLite via `better-sqlite3`. The database schema is created automatically on first startup.

### Default location

```
<repo-root>/agent-hq.db
```

Override with `AGENT_HQ_DB_PATH` (see above).

### SQLite WAL mode

The API runs in WAL (Write-Ahead Logging) mode by default, enabling concurrent read performance without blocking writes.

### Backups

Because SQLite is a single file, backups are straightforward:

```bash
# Hot backup using SQLite's online backup API (safe while running)
sqlite3 /var/data/agent-hq/agent-hq.db ".backup /var/backups/agent-hq-$(date +%Y%m%d).db"

# Or simply copy the file while the API is stopped
cp /var/data/agent-hq/agent-hq.db /var/backups/agent-hq-$(date +%Y%m%d).db
```

Automate with a cron job:

```bash
# /etc/cron.d/agent-hq-backup
0 3 * * * root sqlite3 /var/data/agent-hq/agent-hq.db ".backup /var/backups/agent-hq-$(date +\%Y\%m\%d).db"
```

---

## OpenClaw integration

Agent HQ dispatches AI agent runs through an [OpenClaw](https://github.com/openclaw/openclaw) gateway as the normal orchestration path.

### Run with OpenClaw

```bash
OPENCLAW_BIN=/usr/local/bin/openclaw \
OPENCLAW_CONFIG_PATH=/home/user/.openclaw/openclaw.json \
  node dist/index.js
```

### What it enables

When the OpenClaw gateway and config are available:
- Agent HQ dispatches job runs to configured OpenClaw agent sessions
- The `/api/v1/chat` proxy endpoints are functional
- The `/api/v1/skills` and `/api/v1/artifacts` endpoints are functional
- Live run session keys, heartbeats, and lifecycle signals flow between Agent HQ and OpenClaw

### OpenClaw config

Agent HQ reads the OpenClaw config file at `OPENCLAW_CONFIG_PATH` to resolve agent session endpoints, hooks tokens, and gateway auth. Configure OpenClaw separately per its documentation.

Assigned OpenClaw tools use the Agent HQ capability tools plugin. Agent HQ local startup configures this automatically. For manual installs, loading the plugin is not enough by itself: the OpenClaw tool policy must also allow the plugin id, for example:

```json
{
  "plugins": {
    "entries": {
      "agent-hq-capability-tools": {
        "enabled": true
      }
    },
    "load": {
      "paths": ["/path/to/agent-hq/plugins/openclaw-capability-tools"]
    }
  },
  "tools": {
    "profile": "coding",
    "alsoAllow": ["agent-hq-capability-tools"]
  }
}
```

See [../plugins/openclaw-capability-tools/README.md](../plugins/openclaw-capability-tools/README.md) for the full plugin configuration.

### Without OpenClaw

Without a working OpenClaw gateway/config, Agent HQ cannot launch OpenClaw-backed agent runs. In that state, dispatch should fail with a direct runtime or gateway error instead of succeeding behind a feature flag.

Agents can still call back to Agent HQ over HTTP from any runtime, but OpenClaw-backed orchestration depends on the gateway actually being reachable and configured.

---

## Agent fleet setup

To run the full agent fleet in Docker containers (requires OpenClaw):

```bash
# 1. Copy and fill in secrets
cp docker/.env.agents.example .env.agents
$EDITOR .env.agents   # required: ANTHROPIC_API_KEY, HOOKS_TOKEN, GATEWAY_AUTH_TOKEN
                          # optional: OPENCLAW_MODEL, AGENT_HQ_API_URL

# 2. Generate SSH keys for each agent (optional — for git access)
./scripts/provision-agent-ssh-key.sh agency-backend
./scripts/provision-agent-ssh-key.sh agency-frontend

# 3. Build and start
docker compose -f docker/docker-compose.agents.yml --env-file .env.agents build
docker compose -f docker/docker-compose.agents.yml --env-file .env.agents up -d

# 4. Check logs
docker compose -f docker/docker-compose.agents.yml logs -f forge
```

See [docker/README.md](../docker/README.md) for full agent fleet documentation, port map, and per-agent configuration layout.

---

## Upgrading

### Docker

```bash
docker compose pull
docker compose up -d
```

For local builds (from git):

```bash
git pull origin main
docker compose build --no-cache
docker compose up -d
```

### Bare-metal / PM2

```bash
git pull origin main

# Rebuild API
cd api && npm install && npm run build
pm2 restart agent-hq-api

# Rebuild UI
cd ../ui && npm install && npm run build
pm2 restart agent-hq-ui
```

The API applies any new schema migrations automatically on startup.

---

## Troubleshooting

### API won't start — database error

Check that the parent directory for `AGENT_HQ_DB_PATH` is writable. The API creates the database file and its parent directory automatically on first startup.

If startup still fails, verify the path resolves somewhere the process can create directories and files.

### UI shows "Failed to fetch" errors

The `NEXT_PUBLIC_API_URL` variable must match the URL the browser uses to reach the API — not the container-internal URL. If you are behind a reverse proxy, set it to the public URL.

### Port conflicts

Change the port via the `PORT` environment variable. Make sure `NEXT_PUBLIC_API_URL` also reflects the updated API port.

### OpenClaw dispatch not working

1. Confirm `OPENCLAW_BIN` points to the actual `openclaw` binary (`which openclaw`).
2. Confirm `OPENCLAW_CONFIG_PATH` points to a valid `openclaw.json` with a running gateway.
3. Confirm the configured OpenClaw gateway URL is reachable from the API process.
