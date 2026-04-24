import { closeDb, getDb } from './client';
import { ensureToolRegistryTables } from './schema';

function resetDb(): void {
  closeDb();
}

function createMinimalAgentsTable(): void {
  getDb().exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );
  `);
}

function toolsTableSql(): string {
  return (getDb().prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tools'`).get() as { sql: string }).sql;
}

describe('ensureToolRegistryTables', () => {
  beforeEach(resetDb);
  afterEach(resetDb);

  it('bootstraps cleanly when the tools table does not exist', () => {
    createMinimalAgentsTable();

    expect(() => ensureToolRegistryTables()).not.toThrow();

    expect(toolsTableSql()).toContain("'shell'");
    expect(toolsTableSql()).toContain("'script'");
    expect(getDb().prepare(`SELECT COUNT(*) AS count FROM tools`).get()).toMatchObject({ count: expect.any(Number) });
  });

  it('migrates a legacy tools table shape without referencing a stale legacy table', () => {
    createMinimalAgentsTable();
    getDb().exec(`
      CREATE TABLE tools (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        name                 TEXT NOT NULL,
        slug                 TEXT NOT NULL UNIQUE,
        description          TEXT NOT NULL DEFAULT '',
        implementation_type  TEXT NOT NULL DEFAULT 'bash' CHECK(implementation_type IN ('bash','mcp','function','http')),
        implementation_body  TEXT NOT NULL DEFAULT '',
        input_schema         TEXT NOT NULL DEFAULT '{}',
        permissions          TEXT NOT NULL DEFAULT 'read_only' CHECK(permissions IN ('read_only','read_write','exec','network')),
        tags                 TEXT NOT NULL DEFAULT '[]',
        enabled              INTEGER NOT NULL DEFAULT 1,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO tools (name, slug, implementation_type, implementation_body, permissions)
      VALUES ('Legacy Bash', 'legacy_bash', 'bash', 'echo legacy', 'exec');
    `);

    expect(() => ensureToolRegistryTables()).not.toThrow();

    expect(toolsTableSql()).toContain("'shell'");
    expect(toolsTableSql()).toContain("'script'");
    expect(getDb().prepare(`SELECT name, slug, implementation_type FROM tools WHERE slug = 'legacy_bash'`).get()).toEqual({
      name: 'Legacy Bash',
      slug: 'legacy_bash',
      implementation_type: 'bash',
    });
    expect(getDb().prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tools_legacy_capability_exec'`).get()).toBeUndefined();
  });

  it('repairs assignment tables left pointing at the stale legacy tools table', () => {
    createMinimalAgentsTable();
    getDb().pragma('foreign_keys = OFF');
    getDb().exec(`
      INSERT INTO agents (id, name) VALUES (1, 'Agent');
      CREATE TABLE tools (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        name                 TEXT NOT NULL,
        slug                 TEXT NOT NULL UNIQUE,
        description          TEXT NOT NULL DEFAULT '',
        implementation_type  TEXT NOT NULL DEFAULT 'bash' CHECK(implementation_type IN ('bash','shell','script','mcp','function','http')),
        implementation_body  TEXT NOT NULL DEFAULT '',
        input_schema         TEXT NOT NULL DEFAULT '{}',
        permissions          TEXT NOT NULL DEFAULT 'read_only' CHECK(permissions IN ('read_only','read_write','exec','network')),
        tags                 TEXT NOT NULL DEFAULT '[]',
        enabled              INTEGER NOT NULL DEFAULT 1,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO tools (id, name, slug, implementation_type, implementation_body)
      VALUES (10, 'Tool', 'tool', 'bash', 'echo ok');
      CREATE TABLE tools_legacy_capability_exec (id INTEGER PRIMARY KEY);
      CREATE TABLE agent_tool_assignments (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id  INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        tool_id   INTEGER NOT NULL REFERENCES "tools_legacy_capability_exec"(id) ON DELETE CASCADE,
        overrides TEXT NOT NULL DEFAULT '{}',
        enabled   INTEGER NOT NULL DEFAULT 1,
        UNIQUE(agent_id, tool_id)
      );
      INSERT INTO agent_tool_assignments (agent_id, tool_id) VALUES (1, 10);
      DROP TABLE tools_legacy_capability_exec;
    `);
    getDb().pragma('foreign_keys = ON');

    expect(() => ensureToolRegistryTables()).not.toThrow();

    const assignmentSql = (getDb().prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_tool_assignments'`).get() as { sql: string }).sql;
    expect(assignmentSql).toContain('REFERENCES tools(id)');
    expect(getDb().prepare(`SELECT agent_id, tool_id FROM agent_tool_assignments WHERE agent_id = 1`).get()).toEqual({
      agent_id: 1,
      tool_id: 10,
    });
  });

  it('is a no-op on the current tools schema', () => {
    createMinimalAgentsTable();

    ensureToolRegistryTables();
    const firstSql = toolsTableSql();

    expect(() => ensureToolRegistryTables()).not.toThrow();
    expect(toolsTableSql()).toEqual(firstSql);
  });
});
