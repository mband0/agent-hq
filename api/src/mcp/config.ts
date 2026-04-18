/**
 * Agent HQ MCP Server — Configuration
 *
 * Reads optional config from ~/.agent-hq/mcp.json.
 * Legacy Atlas config paths are still accepted as a fallback.
 * All values can be overridden via environment variables.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export interface McpConfig {
  /** Agent HQ API base URL. Default: http://localhost:3501 */
  apiUrl: string;
  /** Rate limit: max requests per minute. Default: 60 */
  rateLimitRpm: number;
}

function loadFileConfig(): Partial<McpConfig> {
  const configPaths = [
    path.join(os.homedir(), '.agent-hq', 'mcp.json'),
    path.join(os.homedir(), '.atlas-hq', 'mcp.json'),
  ];

  for (const configPath of configPaths) {
    if (!fs.existsSync(configPath)) continue;
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        apiUrl:
          typeof parsed.apiUrl === 'string'
            ? parsed.apiUrl
            : typeof parsed.api_url === 'string'
              ? parsed.api_url
              : undefined,
        rateLimitRpm:
          typeof parsed.rateLimitRpm === 'number'
            ? parsed.rateLimitRpm
            : typeof parsed.rate_limit_rpm === 'number'
              ? parsed.rate_limit_rpm
              : undefined,
      };
    } catch {
      console.error(`[agent-hq-mcp] Warning: could not parse ${configPath}, using defaults.`);
      return {};
    }
  }

  return {};
}

export function loadConfig(): McpConfig {
  const file = loadFileConfig();

  const apiUrl =
    process.env.AGENT_HQ_API_URL ??
    process.env.AGENT_HQ_INTERNAL_BASE_URL ??
    process.env.ATLAS_HQ_API_URL ??
    process.env.ATLAS_INTERNAL_BASE_URL ??
    file.apiUrl ??
    'http://localhost:3501';

  const rateLimitRpm = (() => {
    if (process.env.MCP_RATE_LIMIT_RPM) {
      const n = parseInt(process.env.MCP_RATE_LIMIT_RPM, 10);
      if (!isNaN(n) && n > 0) return n;
    }
    if (typeof file.rateLimitRpm === 'number' && file.rateLimitRpm > 0) {
      return file.rateLimitRpm;
    }
    return 60;
  })();

  return { apiUrl, rateLimitRpm };
}
