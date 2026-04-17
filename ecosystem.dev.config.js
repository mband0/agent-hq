/**
 * ecosystem.dev.config.js — PM2 config for the Agent HQ dev environment.
 *
 * Dev environment: UI on :3510, API on :3511, isolated agent-hq-dev.db
 * Production remains on :3500/:3501 with agent-hq.db — completely separate.
 *
 * Usage:
 *   pm2 start ecosystem.dev.config.js
 *   pm2 stop  ecosystem.dev.config.js
 *   pm2 delete ecosystem.dev.config.js
 *
 * Seed dev DB first:
 *   cd api && AGENT_HQ_DB_PATH=$PWD/../agent-hq-dev.db npx tsx src/db/seed-dev.ts
 */

const REPO = __dirname;

module.exports = {
  apps: [
    {
      name: 'agent-hq-dev-api',
      cwd: `${REPO}/api`,
      script: 'npm',
      args: 'start',
      env: {
        PORT: '3511',
        AGENT_HQ_DB_PATH: process.env.AGENT_HQ_DB_PATH || `${REPO}/agent-hq-dev.db`,
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        GATEWAY_URL: 'https://localhost:18789',
        GATEWAY_WS_URL: 'wss://127.0.0.1:18789',
        GATEWAY_TOKEN: 'REDACTED_GATEWAY_TOKEN',
        OPENCLAW_HOOKS_TOKEN: 'REDACTED_HOOKS_TOKEN',
        OPENCLAW_GATEWAY_URL: 'https://127.0.0.1:18789',
        TELEGRAM_BOT_TOKEN: 'REDACTED_TELEGRAM_BOT_TOKEN',
        TELEGRAM_CHAT_ID: 'REDACTED_TELEGRAM_CHAT_ID',
      },
      autorestart: true,
      watch: false,
      merge_logs: true,
    },
    {
      name: 'agent-hq-dev-ui',
      cwd: `${REPO}/ui`,
      script: 'npm',
      args: 'run start-dev',
      env: {
        NEXT_PUBLIC_API_URL: 'http://localhost:3511',
      },
      autorestart: true,
      watch: false,
      merge_logs: true,
    },
  ],
};
