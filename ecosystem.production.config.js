const path = require('path');
const fs = require('fs');
const os = require('os');

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const repoRoot = __dirname;
const openclawHome = path.join(os.homedir(), '.openclaw');
const rootEnv = parseEnvFile(path.join(repoRoot, '.env'));
const env = { ...rootEnv, ...process.env };

module.exports = {
  apps: [
    {
      name: 'agent-hq-api',
      cwd: path.join(repoRoot, 'api'),
      script: 'node',
      args: 'dist/index.js',
      env: {
        NODE_ENV: env.NODE_ENV || 'production',
        PORT: env.PORT || '3501',
        AGENT_HQ_DB_PATH: env.AGENT_HQ_DB_PATH || path.join(repoRoot, 'agent-hq.db'),
        OPENCLAW_ENABLED: env.OPENCLAW_ENABLED || 'false',
        OPENCLAW_GATEWAY_URL: env.OPENCLAW_GATEWAY_URL || 'https://127.0.0.1:18789',
        OPENCLAW_GATEWAY_TOKEN: env.OPENCLAW_GATEWAY_TOKEN,
        OPENCLAW_HOOKS_TOKEN: env.OPENCLAW_HOOKS_TOKEN,
        OPENCLAW_CONFIG_PATH: env.OPENCLAW_CONFIG_PATH || path.join(openclawHome, 'openclaw.json'),
        OPENCLAW_BIN: env.OPENCLAW_BIN || 'openclaw',
        WORKSPACE_ROOT: env.WORKSPACE_ROOT || path.join(openclawHome, 'workspace'),
        TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
        TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID,
        NODE_TLS_REJECT_UNAUTHORIZED: env.NODE_TLS_REJECT_UNAUTHORIZED || '0'
      },
      autorestart: true,
      watch: false,
      merge_logs: true
    },
    {
      name: 'agent-hq-ui',
      cwd: path.join(repoRoot, 'ui'),
      script: 'npm',
      args: 'run start',
      env: {
        NODE_ENV: env.NODE_ENV || 'production',
        PORT: env.UI_PORT || '3500',
        ATLAS_INTERNAL_BASE_URL: env.ATLAS_INTERNAL_BASE_URL || `http://127.0.0.1:${env.PORT || '3501'}`
      },
      autorestart: true,
      watch: false,
      merge_logs: true
    }
  ]
};
