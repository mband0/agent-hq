import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDb } from '../db/client';
import { executeToolImplementation, fetchAgentTools, type AgentToolRecord } from '../runtimes/toolInjection';

const BUILTIN_OPENCLAW_TOOL_NAMES = new Set([
  'exec',
  'process',
  'bash',
  'code_execution',
  'browser',
  'web_search',
  'x_search',
  'web_fetch',
  'read',
  'write',
  'edit',
  'apply_patch',
  'message',
  'canvas',
  'nodes',
  'cron',
  'gateway',
  'image',
  'image_generate',
  'music_generate',
  'video_generate',
  'tts',
  'sessions_list',
  'sessions_history',
  'sessions_send',
  'sessions_spawn',
  'sessions_yield',
  'subagents',
  'agents_list',
  'session_status',
]);

function requireAgentId(): number {
  const raw = process.env.AGENT_HQ_AGENT_ID ?? process.env.ATLAS_HQ_AGENT_ID;
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('AGENT_HQ_AGENT_ID must be set to a positive integer');
  }
  return parsed;
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.any();
  const record = schema as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : null;

  if (type === 'string') return z.string();
  if (type === 'number') return z.number();
  if (type === 'integer') return z.number().int();
  if (type === 'boolean') return z.boolean();
  if (type === 'array') return z.array(jsonSchemaToZod(record.items));
  if (type === 'object' || record.properties) {
    const properties = record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)
      ? record.properties as Record<string, unknown>
      : {};
    const required = Array.isArray(record.required)
      ? new Set(record.required.filter((entry): entry is string => typeof entry === 'string'))
      : new Set<string>();
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(properties)) {
      const field = jsonSchemaToZod(value);
      shape[key] = required.has(key) ? field : field.optional();
    }
    return z.object(shape).passthrough();
  }

  return z.any();
}

function buildInputSchema(toolRecord: AgentToolRecord): z.ZodTypeAny {
  const parsed = parseJsonRecord(toolRecord.input_schema);
  if (Object.keys(parsed).length === 0) return z.object({}).passthrough();
  const converted = jsonSchemaToZod(parsed);
  return converted instanceof z.ZodObject ? converted.passthrough() : z.object({ input: converted }).passthrough();
}

function buildDescription(toolRecord: AgentToolRecord): string {
  let schemaDescription = '';
  try {
    const parsed = JSON.parse(toolRecord.input_schema || '{}');
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
      schemaDescription = `\n\nInput schema: ${JSON.stringify(parsed)}`;
    }
  } catch {
    // ignore malformed stored schemas
  }

  return `${toolRecord.description}${schemaDescription}`.trim();
}

function loadAssignedTools(agentId: number, db = getDb()): AgentToolRecord[] {
  return fetchAgentTools(db, agentId).filter((tool) => !BUILTIN_OPENCLAW_TOOL_NAMES.has(tool.slug.toLowerCase()));
}

async function main() {
  const agentId = requireAgentId();
  const workspacePath = process.cwd();
  const db = getDb();
  const assignedTools = loadAssignedTools(agentId, db);

  const server = new McpServer({
    name: 'agent-local-tool-mcp',
    version: '1.0.0',
  });

  for (const toolRecord of assignedTools) {
    server.registerTool(
      toolRecord.slug,
      {
        description: buildDescription(toolRecord),
        inputSchema: buildInputSchema(toolRecord),
      },
      async (args: unknown) => {
        const safeArgs = args && typeof args === 'object' && !Array.isArray(args)
          ? args as Record<string, unknown>
          : {};
        const liveToolRecord = loadAssignedTools(agentId, db).find((tool) => tool.id === toolRecord.id || tool.slug === toolRecord.slug);
        if (!liveToolRecord) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  error: `Tool ${toolRecord.slug} is no longer assigned to agent #${agentId}`,
                }),
              },
            ],
            isError: true,
          };
        }
        const result = executeToolImplementation(liveToolRecord, safeArgs, workspacePath);
        return result;
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[agent-local-tool-mcp] connected for agent #${agentId} with ${assignedTools.length} tool(s) in ${workspacePath}; assignments loaded at connection time`,
  );

  const shutdown = async (signal: string) => {
    console.error(`[agent-local-tool-mcp] Received ${signal}, shutting down...`);
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[agent-local-tool-mcp] Fatal error:', err);
  process.exit(1);
});
