/**
 * runtimes/toolInjection.ts — Fetch agent tool assignments and convert them
 * into SDK-compatible MCP tool definitions for runtime injection.
 *
 * Task #559: Runtime injection — fetch agent tool assignments and inject
 * into Claude SDK dispatch.
 *
 * The module provides:
 *   - fetchAgentTools(): reads tool assignments from the DB
 *   - createAgentToolServer(): creates an in-process MCP server with the tools
 *   - executeToolImplementation(): runs a tool's implementation (bash/function)
 */

import type Database from 'better-sqlite3';
import { execSync } from 'child_process';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentToolRecord {
  id: number;
  assignment_id: number;
  name: string;
  slug: string;
  description: string;
  implementation_type: 'bash' | 'shell' | 'script' | 'mcp' | 'function' | 'http';
  implementation_body: string;
  input_schema: string; // JSON string
  permissions: 'read_only' | 'read_write' | 'exec' | 'network';
  tags: string; // JSON array string
  enabled: number;
  overrides: string; // JSON string
  assignment_enabled: number;
}

// ── DB fetch ─────────────────────────────────────────────────────────────────

/**
 * fetchAgentTools — query the DB for all enabled tools assigned to an agent.
 * Returns only tools where both the tool and the assignment are enabled.
 */
export function fetchAgentTools(db: Database.Database, agentId: number): AgentToolRecord[] {
  return db.prepare(`
    SELECT ata.id as assignment_id, ata.overrides, ata.enabled as assignment_enabled,
           t.*
    FROM agent_tool_assignments ata
    JOIN tools t ON t.id = ata.tool_id
    WHERE ata.agent_id = ?
      AND ata.enabled = 1
      AND t.enabled = 1
    ORDER BY t.name ASC
  `).all(agentId) as AgentToolRecord[];
}

// ── Tool execution ───────────────────────────────────────────────────────────

/**
 * executeToolImplementation — run a tool's implementation and return the result.
 *
 * For bash tools: executes the implementation_body as a shell command in the
 * agent's workspace directory, with tool input passed as TOOL_INPUT env var.
 *
 * Errors are caught and returned as structured error messages, never thrown.
 */
export function executeToolImplementation(
  toolRecord: AgentToolRecord,
  input: Record<string, unknown>,
  workingDirectory?: string,
): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  try {
    switch (toolRecord.implementation_type) {
      case 'bash': {
        const command = toolRecord.implementation_body;
        if (!command) {
          return {
            content: [{ type: 'text', text: 'Error: tool has no implementation body' }],
            isError: true,
          };
        }

        const result = execSync(command, {
          encoding: 'utf-8',
          timeout: 30_000,
          cwd: workingDirectory || process.cwd(),
          env: {
            ...process.env,
            TOOL_INPUT: JSON.stringify(input),
            // Also provide individual input fields as env vars for convenience
            ...Object.fromEntries(
              Object.entries(input).map(([k, v]) => [
                `TOOL_${k.toUpperCase()}`,
                typeof v === 'string' ? v : JSON.stringify(v),
              ]),
            ),
          },
          maxBuffer: 1024 * 1024, // 1MB
        });

        return { content: [{ type: 'text', text: result }] };
      }

      case 'function': {
        return {
          content: [{ type: 'text', text: `Error: function tools are not yet supported at runtime` }],
          isError: true,
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Error: unsupported implementation type "${toolRecord.implementation_type}"` }],
          isError: true,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = (err as any)?.stderr;
    const errorText = stderr ? `${message}\n\nStderr:\n${stderr}` : message;

    return {
      content: [{ type: 'text', text: `Error executing tool "${toolRecord.slug}": ${errorText}` }],
      isError: true,
    };
  }
}

// ── SDK MCP server creation ──────────────────────────────────────────────────

/**
 * createAgentToolServer — build an in-process MCP server containing all
 * assigned tools for an agent, suitable for injection into the Claude Code SDK.
 *
 * Each tool's input_schema is passed in the description since the SDK requires
 * Zod schemas and our DB stores JSON Schema. A permissive Zod schema accepts
 * any input; the tool description includes the expected schema for the model.
 *
 * @param tools - Tool records from fetchAgentTools()
 * @param workingDirectory - Working directory for bash tool execution
 * @param hardcodedToolSlugs - Set of slugs that are already built-in; skip these
 * @returns MCP server config, or null if no tools to inject
 */
export function createAgentToolServer(
  tools: AgentToolRecord[],
  workingDirectory?: string,
  hardcodedToolSlugs?: Set<string>,
) {
  // Filter out tools that conflict with hardcoded tools
  const filteredTools = tools.filter(t => {
    if (hardcodedToolSlugs?.has(t.slug.toLowerCase())) {
      console.log(`[toolInjection] Skipping registry tool "${t.slug}" — hardcoded tool takes precedence`);
      return false;
    }
    return true;
  });

  if (filteredTools.length === 0) return null;

  const sdkTools = filteredTools.map(t => {
    let schemaDescription = '';
    try {
      const parsed = JSON.parse(t.input_schema || '{}');
      if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
        schemaDescription = `\n\nInput schema: ${JSON.stringify(parsed)}`;
      }
    } catch { /* ignore parse errors */ }

    return tool(
      t.slug,
      `${t.description}${schemaDescription}`,
      z.object({}).passthrough() as any,
      async (args: Record<string, unknown>) => {
        const result = executeToolImplementation(t, args, workingDirectory);
        return result;
      },
    );
  });

  const server = createSdkMcpServer({
    name: 'atlas-hq-agent-tools',
    version: '1.0.0',
    tools: sdkTools,
  });

  console.log(
    `[toolInjection] Created MCP server with ${sdkTools.length} tool(s): ${filteredTools.map(t => t.slug).join(', ')}`,
  );

  return server;
}
