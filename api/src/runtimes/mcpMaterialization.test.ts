import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import {
  ensureOpenClawMcpWorkspaceBundleEnabled,
  materializeAgentMcpConfig,
} from './mcpMaterialization';

function resetDb(): void {
  closeDb();
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createRegistryTables(): void {
  getDb().exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );
    CREATE TABLE tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      implementation_type TEXT NOT NULL DEFAULT 'bash',
      implementation_body TEXT NOT NULL DEFAULT '',
      input_schema TEXT NOT NULL DEFAULT '{}',
      permissions TEXT NOT NULL DEFAULT 'read_only',
      tags TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE agent_tool_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      tool_id INTEGER NOT NULL,
      overrides TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE mcp_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      command TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '[]',
      env TEXT NOT NULL DEFAULT '{}',
      cwd TEXT,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE agent_mcp_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      mcp_server_id INTEGER NOT NULL,
      overrides TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1
    );
  `);
}

describe('materializeAgentMcpConfig', () => {
  beforeEach(resetDb);
  afterEach(resetDb);

  it('does not materialize assigned capability tools as an OpenClaw MCP bridge', () => {
    createRegistryTables();
    getDb().prepare(`INSERT INTO agents (id, name) VALUES (1, 'Agent')`).run();
    getDb().prepare(`INSERT INTO tools (id, name, slug, implementation_type, implementation_body) VALUES (10, 'Tool', 'custom_tool', 'bash', 'echo ok')`).run();
    getDb().prepare(`INSERT INTO agent_tool_assignments (agent_id, tool_id) VALUES (1, 10)`).run();
    const workingDirectory = makeTempDir('agent-hq-mcp-tools-');

    const result = materializeAgentMcpConfig({ db: getDb(), agentId: 1, workingDirectory });

    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
    expect(fs.existsSync(path.join(workingDirectory, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(workingDirectory, '.openclaw', 'extensions', 'agent-hq-mcp', '.mcp.json'))).toBe(false);
  });

  it('still materializes explicitly assigned MCP servers without adding agent-local-tool-mcp', () => {
    createRegistryTables();
    getDb().prepare(`INSERT INTO agents (id, name) VALUES (1, 'Agent')`).run();
    getDb().prepare(`INSERT INTO mcp_servers (id, slug, command, args) VALUES (30, 'agent-hq', 'node', '["server.js"]')`).run();
    getDb().prepare(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (1, 30)`).run();
    const workingDirectory = makeTempDir('agent-hq-mcp-servers-');

    const result = materializeAgentMcpConfig({ db: getDb(), agentId: 1, workingDirectory });
    const config = JSON.parse(fs.readFileSync(path.join(workingDirectory, '.mcp.json'), 'utf8'));
    const bundleConfig = JSON.parse(fs.readFileSync(path.join(workingDirectory, '.openclaw', 'extensions', 'agent-hq-mcp', '.mcp.json'), 'utf8'));

    expect(result.ok).toBe(true);
    expect(config.mcpServers['agent-hq']).toMatchObject({ command: 'node', args: ['server.js'] });
    expect(bundleConfig.mcpServers['agent-hq']).toMatchObject({ command: 'node', args: ['server.js'] });
    expect(config.mcpServers['agent-hq'].env.AGENT_HQ_MCP_API_KEY).toMatch(/^ahq_mcp_/);
    expect(bundleConfig.mcpServers['agent-hq'].env.AGENT_HQ_MCP_API_KEY).toBe(config.mcpServers['agent-hq'].env.AGENT_HQ_MCP_API_KEY);
    expect(config.mcpServers['agent-local-tool-mcp']).toBeUndefined();
    expect(bundleConfig.mcpServers['agent-local-tool-mcp']).toBeUndefined();
  });

  it('reuses an existing valid materialized Agent HQ MCP key for the same agent', () => {
    createRegistryTables();
    getDb().prepare(`INSERT INTO agents (id, name) VALUES (1, 'Agent')`).run();
    getDb().prepare(`INSERT INTO mcp_servers (id, slug, command, args) VALUES (30, 'agent-hq', 'node', '["server.js"]')`).run();
    getDb().prepare(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (1, 30)`).run();
    const workingDirectory = makeTempDir('agent-hq-mcp-reuse-');

    const first = materializeAgentMcpConfig({ db: getDb(), agentId: 1, workingDirectory });
    const firstConfig = JSON.parse(fs.readFileSync(path.join(workingDirectory, '.mcp.json'), 'utf8'));
    const firstKey = firstConfig.mcpServers['agent-hq'].env.AGENT_HQ_MCP_API_KEY;
    const second = materializeAgentMcpConfig({ db: getDb(), agentId: 1, workingDirectory });
    const secondConfig = JSON.parse(fs.readFileSync(path.join(workingDirectory, '.mcp.json'), 'utf8'));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(secondConfig.mcpServers['agent-hq'].env.AGENT_HQ_MCP_API_KEY).toBe(firstKey);
    const keyCount = getDb().prepare(`SELECT COUNT(*) as count FROM mcp_api_keys WHERE agent_id = 1`).get() as { count: number };
    expect(keyCount.count).toBe(1);
  });

  it('enables the OpenClaw workspace MCP bundle plugin idempotently', () => {
    const configPath = path.join(makeTempDir('agent-hq-openclaw-config-'), 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          existing: { enabled: true },
        },
      },
    }), 'utf8');

    const first = ensureOpenClawMcpWorkspaceBundleEnabled(configPath);
    const second = ensureOpenClawMcpWorkspaceBundleEnabled(configPath);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(first.ok).toBe(true);
    expect(first.changed).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
    expect(config.plugins.entries.existing.enabled).toBe(true);
    expect(config.plugins.entries['agent-hq-mcp'].enabled).toBe(true);
  });
});
