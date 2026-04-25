import {
  VALID_TASK_PRIORITIES,
  VALID_TASK_STATUSES,
  VALID_TASK_STORY_POINTS,
  VALID_TASK_TYPES,
} from './apiClient';

export interface McpCatalogArg {
  name: string;
  required: boolean;
  description?: string;
  schema?: unknown;
}

export interface McpCatalogTool {
  canonical_name: string;
  aliases: string[];
  description: string;
  args: McpCatalogArg[];
  domain: string;
  rest_paths?: string[];
}

export interface McpCatalogResource {
  id: string;
  uri: string;
  description: string;
}

const tools: McpCatalogTool[] = [];
const resources: McpCatalogResource[] = [
  {
    id: 'agent-hq-workflow-statuses',
    uri: 'agent-hq://workflow/statuses',
    description: 'Canonical workflow statuses and pipeline semantics.',
  },
  {
    id: 'atlas-workflow-statuses',
    uri: 'atlas://workflow/statuses',
    description: 'Alias URI for workflow statuses.',
  },
  {
    id: 'agent-hq-workflow-task-types',
    uri: 'agent-hq://workflow/task-types',
    description: 'Canonical task types, priorities, and story points.',
  },
  {
    id: 'atlas-workflow-task-types',
    uri: 'atlas://workflow/task-types',
    description: 'Alias URI for task types, priorities, and story points.',
  },
  {
    id: 'agent-hq-projects-summary',
    uri: 'agent-hq://projects/summary',
    description: 'Live project summary snapshot.',
  },
  {
    id: 'atlas-projects-summary',
    uri: 'atlas://projects/summary',
    description: 'Alias URI for project summary snapshot.',
  },
  {
    id: 'agent-hq-catalog',
    uri: 'agent-hq://catalog',
    description: 'Typed MCP capability catalog for Agent HQ.',
  },
  {
    id: 'atlas-catalog',
    uri: 'atlas://catalog',
    description: 'Alias URI for the typed MCP capability catalog.',
  },
];

function cloneSchema(schema: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify(schema, (_key, value) => {
    if (typeof value === 'function') return undefined;
    if (value instanceof RegExp) return value.toString();
    return value;
  }));
}

export function registerCatalogTool(def: {
  names: string[];
  description: string;
  schema: Record<string, unknown>;
  domain: string;
  rest_paths?: string[];
}) {
  const [canonical_name, ...aliases] = def.names;
  tools.push({
    canonical_name,
    aliases,
    description: def.description,
    args: Object.entries(def.schema).map(([name, value]) => ({
      name,
      required: false,
      schema: cloneSchema(value as Record<string, unknown>),
    })),
    domain: def.domain,
    rest_paths: def.rest_paths,
  });
}

export function getMcpCatalog() {
  return {
    server: {
      name: 'agent-hq',
      version: '1.0.0',
      transport: 'stdio',
      discoverability: {
        catalog_endpoint: '/api/v1/mcp/catalog',
        health_endpoint: '/api/v1/mcp/catalog/health',
        notes: [
          'This catalog enumerates the typed Agent HQ MCP tools and resources exposed by the bundled MCP server.',
          'Aliases are provided for compatibility, but canonical_name is the preferred name for clients.',
          'rest_paths are informational mappings to the backing Agent HQ API surface. Clients should prefer typed MCP tools when available.',
        ],
      },
    },
    domains: [
      'projects',
      'sprints',
      'tasks',
      'routing_rules',
      'routing_transitions',
      'model_routing',
      'task_definitions',
      'agents',
      'skills',
      'tools',
      'mcp_servers',
      'advanced',
    ],
    enums: {
      task_statuses: VALID_TASK_STATUSES,
      task_priorities: VALID_TASK_PRIORITIES,
      task_story_points: VALID_TASK_STORY_POINTS,
      task_types: VALID_TASK_TYPES,
    },
    resources,
    tools: [...tools].sort((a, b) => a.canonical_name.localeCompare(b.canonical_name)),
  };
}
