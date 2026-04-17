export const OPENCLAW_HOOK_PREFIX = 'hook:atlas:jobrun:';
export const OPENCLAW_DIRECT_KIND = 'direct';
export const OPENCLAW_MAIN_SCOPE = 'main';

export interface AgentSessionIdentity {
  name?: string | null;
  role?: string | null;
  session_key?: string | null;
  openclaw_agent_id?: string | null;
  system_role?: string | null;
}

export interface ParsedAgentSessionKey {
  raw: string;
  format: 'legacy' | 'canonical';
  scope: 'main' | 'direct' | 'hook' | 'unknown';
  runtimeSlug: string | null;
  projectSlug: string | null;
  agentNameSlug: string | null;
  roleSlug: string | null;
  channel: string | null;
  uniqueId: string | null;
  hookSessionKey: string | null;
  instanceId: number | null;
}

function normalized(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function normalizeAgentRoleLabel(value: string | null | undefined, fallback = 'Agent'): string {
  const trimmed = normalized(value);
  if (!trimmed) return fallback;

  const compact = trimmed.replace(/\s+/g, ' ').trim();
  const lower = compact.toLowerCase();

  const rolePatterns: Array<[RegExp, string]> = [
    [/\b(project manager|program manager|product manager|pm)\b/, 'Project Manager'],
    [/\b(devops|release engineer|release owner|site reliability|sre)\b/, 'DevOps Engineer'],
    [/\b(qa|quality assurance|test automation|tos validation|validation)\b/, 'QA Engineer'],
    [/\b(full[- ]?stack)\b/, 'Fullstack Engineer'],
    [/\b(frontend|front-end|ui engineer|react|next\.js)\b/, 'Frontend Engineer'],
    [/\b(backend|back-end|api|service|airflow|data pipeline)\b/, 'Backend Engineer'],
    [/\b(business central)\b/, 'Implementation Specialist'],
    [/\b(performance marketing|meta ads|google ads|ads manager)\b/, 'Performance Marketer'],
    [/\b(business development|sales|lead generation|proposals|bids)\b/, 'Business Development'],
    [/\b(trader|operator-analyst|strategy correctness|risk-control)\b/, 'Trading Operator'],
    [/\b(assistant)\b/, 'General Assistant'],
  ];

  for (const [pattern, label] of rolePatterns) {
    if (pattern.test(lower)) return label;
  }

  const firstClause = compact.split(/[—–:;,]/)[0]?.trim() ?? compact;
  const words = firstClause.split(/\s+/).filter(Boolean);
  if (words.length <= 5 && firstClause.length <= 48) {
    return toTitleCase(firstClause);
  }

  const shortened = words.slice(0, 4).join(' ').trim();
  return shortened ? toTitleCase(shortened) : fallback;
}

export function slugifySessionKeyPart(value: string | null | undefined, fallback = 'unknown'): string {
  const trimmed = normalized(value);
  if (!trimmed) return fallback;
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

export function buildHookSessionKey(instanceId: number): string {
  return `${OPENCLAW_HOOK_PREFIX}${instanceId}`;
}

export function parseHookSessionKey(sessionKey: string | null | undefined): {
  shortKey: string;
  instanceId: number;
} | null {
  const key = normalized(sessionKey);
  if (!key) return null;
  const match = key.match(/hook:atlas:jobrun:(\d+)$/);
  if (!match) return null;
  return {
    shortKey: `${OPENCLAW_HOOK_PREFIX}${match[1]}`,
    instanceId: Number(match[1]),
  };
}

export function buildLegacyAgentMainSessionKey(runtimeSlug: string): string {
  return `agent:${runtimeSlug}:${OPENCLAW_MAIN_SCOPE}`;
}

export function buildCanonicalAgentMainSessionKey(params: {
  projectName?: string | null;
  projectSlug?: string | null;
  agentName?: string | null;
  agentNameSlug?: string | null;
  role?: string | null;
  roleSlug?: string | null;
}): string {
  const projectSlug = params.projectSlug ?? slugifySessionKeyPart(params.projectName, 'unassigned');
  const agentNameSlug = params.agentNameSlug ?? slugifySessionKeyPart(params.agentName, 'agent');
  const roleSlug = params.roleSlug ?? slugifySessionKeyPart(normalizeAgentRoleLabel(params.role, 'Agent'), 'agent');
  return `agent:${projectSlug}:${agentNameSlug}:${roleSlug}:${OPENCLAW_MAIN_SCOPE}`;
}

export function parseAgentSessionKey(sessionKey: string | null | undefined): ParsedAgentSessionKey | null {
  const raw = normalized(sessionKey);
  if (!raw || !raw.startsWith('agent:')) return null;

  const parts = raw.split(':');
  if (parts.length === 3 && parts[2] === OPENCLAW_MAIN_SCOPE) {
    return {
      raw,
      format: 'legacy',
      scope: 'main',
      runtimeSlug: parts[1] || null,
      projectSlug: null,
      agentNameSlug: parts[1] || null,
      roleSlug: null,
      channel: null,
      uniqueId: null,
      hookSessionKey: null,
      instanceId: null,
    };
  }

  if (parts.length === 5 && parts[3] === OPENCLAW_DIRECT_KIND) {
    return {
      raw,
      format: 'legacy',
      scope: 'direct',
      runtimeSlug: parts[1] || null,
      projectSlug: null,
      agentNameSlug: parts[1] || null,
      roleSlug: null,
      channel: parts[2] || null,
      uniqueId: parts[4] || null,
      hookSessionKey: null,
      instanceId: null,
    };
  }

  const hook = parseHookSessionKey(raw);
  if (parts.length === 6 && parts[2] === 'hook' && parts[3] === 'atlas' && parts[4] === 'jobrun' && hook) {
    return {
      raw,
      format: 'legacy',
      scope: 'hook',
      runtimeSlug: parts[1] || null,
      projectSlug: null,
      agentNameSlug: parts[1] || null,
      roleSlug: null,
      channel: null,
      uniqueId: String(hook.instanceId),
      hookSessionKey: hook.shortKey,
      instanceId: hook.instanceId,
    };
  }

  if (parts.length === 5 && parts[4] === OPENCLAW_MAIN_SCOPE) {
    return {
      raw,
      format: 'canonical',
      scope: 'main',
      runtimeSlug: null,
      projectSlug: parts[1] || null,
      agentNameSlug: parts[2] || null,
      roleSlug: parts[3] || null,
      channel: null,
      uniqueId: null,
      hookSessionKey: null,
      instanceId: null,
    };
  }

  if (parts.length === 8 && parts[4] === 'hook' && parts[5] === 'atlas' && parts[6] === 'jobrun' && hook) {
    return {
      raw,
      format: 'canonical',
      scope: 'hook',
      runtimeSlug: null,
      projectSlug: parts[1] || null,
      agentNameSlug: parts[2] || null,
      roleSlug: parts[3] || null,
      channel: null,
      uniqueId: String(hook.instanceId),
      hookSessionKey: hook.shortKey,
      instanceId: hook.instanceId,
    };
  }

  if (parts.length === 7 && parts[5] === OPENCLAW_DIRECT_KIND) {
    return {
      raw,
      format: 'canonical',
      scope: 'direct',
      runtimeSlug: null,
      projectSlug: parts[1] || null,
      agentNameSlug: parts[2] || null,
      roleSlug: parts[3] || null,
      channel: parts[4] || null,
      uniqueId: parts[6] || null,
      hookSessionKey: null,
      instanceId: null,
    };
  }

  return {
    raw,
    format: 'legacy',
    scope: 'unknown',
    runtimeSlug: parts[1] || null,
    projectSlug: parts[1] || null,
    agentNameSlug: parts.length > 2 ? parts[2] || null : null,
    roleSlug: parts.length > 3 ? parts[3] || null : null,
    channel: null,
    uniqueId: null,
    hookSessionKey: hook?.shortKey ?? null,
    instanceId: hook?.instanceId ?? null,
  };
}

export function resolveRuntimeAgentSlug(agent: AgentSessionIdentity | null | undefined): string | null {
  if (!agent) return null;
  const openclawAgentId = normalized(agent.openclaw_agent_id);
  if (openclawAgentId) return openclawAgentId;

  const parsed = parseAgentSessionKey(agent.session_key);
  if (parsed?.runtimeSlug) return parsed.runtimeSlug;
  if (parsed?.agentNameSlug) return parsed.agentNameSlug;

  return normalized(slugifySessionKeyPart(agent.name ?? null, ''));
}

export function buildGatewayMainSessionKey(agent: AgentSessionIdentity | null | undefined): string | null {
  const slug = resolveRuntimeAgentSlug(agent);
  return slug ? buildLegacyAgentMainSessionKey(slug) : null;
}

export function buildGatewayDirectSessionKey(
  agent: AgentSessionIdentity | null | undefined,
  channel: string,
  uniqueId: string,
): string | null {
  const slug = resolveRuntimeAgentSlug(agent);
  const normalizedChannel = slugifySessionKeyPart(channel, 'web');
  const normalizedId = normalized(uniqueId);
  if (!slug || !normalizedId) return null;
  return `agent:${slug}:${normalizedChannel}:${OPENCLAW_DIRECT_KIND}:${normalizedId}`;
}

export function buildGatewayRunSessionKey(
  agent: AgentSessionIdentity | null | undefined,
  shortHookKey: string,
): string | null {
  const slug = resolveRuntimeAgentSlug(agent);
  const hook = parseHookSessionKey(shortHookKey);
  if (!slug || !hook) return null;
  return `agent:${slug}:${hook.shortKey}`;
}

export function toGatewaySessionKey(
  sessionKey: string | null | undefined,
  agent: AgentSessionIdentity | null | undefined,
): string | null {
  const key = normalized(sessionKey);
  if (!key) return null;
  const hook = parseHookSessionKey(key);
  if (hook && !key.startsWith('agent:')) return hook.shortKey;

  const parsed = parseAgentSessionKey(key);
  if (!parsed) return key;

  if (parsed.scope === 'main') {
    return buildGatewayMainSessionKey(agent) ?? key;
  }

  if (parsed.scope === 'direct') {
    return buildGatewayDirectSessionKey(agent, parsed.channel ?? 'web', parsed.uniqueId ?? '') ?? key;
  }

  if (parsed.scope === 'hook') {
    return buildGatewayRunSessionKey(agent, parsed.hookSessionKey ?? key) ?? key;
  }

  return key;
}
