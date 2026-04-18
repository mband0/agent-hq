import type { CanonicalMessage, ChatEventType, ChatMessage } from './api';

const CHAT_EVENT_TYPES = new Set<ChatEventType>([
  'text',
  'thought',
  'tool_call',
  'tool_result',
  'turn_start',
  'system',
  'error',
]);

function parseEventMeta(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

function normalizeEventType(raw: unknown): ChatEventType {
  return CHAT_EVENT_TYPES.has(raw as ChatEventType) ? raw as ChatEventType : 'text';
}

function normalizeRole(raw: unknown): ChatMessage['role'] {
  if (raw === 'user' || raw === 'system') return raw;
  return 'assistant';
}

function normalizeTimestamp(raw: unknown): string {
  if (typeof raw === 'string' && raw) return raw;
  return new Date().toISOString();
}

function normalizeChatMessage(
  raw: Record<string, unknown>,
  fallbackId: string,
): ChatMessage | null {
  const eventType = normalizeEventType(raw.event_type);
  const content = typeof raw.content === 'string' ? raw.content : '';
  if (!content && eventType === 'text') return null;

  return {
    id: typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id) : fallbackId,
    role: normalizeRole(raw.role),
    content,
    timestamp: normalizeTimestamp(raw.timestamp),
    event_type: eventType,
    meta: parseEventMeta(raw.event_meta ?? raw.meta),
  };
}

export function parseCanonicalMessages(rows: CanonicalMessage[]): ChatMessage[] {
  return rows.reduce<ChatMessage[]>((acc, row, index) => {
    const normalized = normalizeChatMessage({
      id: row.id,
      role: row.role,
      content: row.content ?? '',
      timestamp: row.timestamp,
      event_type: row.event_type,
      event_meta: row.event_meta,
    }, `canonical-${index}`);
    if (normalized) acc.push(normalized);
    return acc;
  }, []);
}

export function parseStoredChatMessages(rows: Array<Record<string, unknown> | ChatMessage>): ChatMessage[] {
  return rows.reduce<ChatMessage[]>((acc, row, index) => {
    const normalized = normalizeChatMessage(row as Record<string, unknown>, `stored-${index}`);
    if (normalized) acc.push(normalized);
    return acc;
  }, []);
}

export function parseGatewayHistoryMessages(rows: Array<Record<string, unknown>>): ChatMessage[] {
  return rows.reduce<ChatMessage[]>((acc, row, index) => {
    const baseId = typeof row.id === 'string' || typeof row.id === 'number'
      ? String(row.id)
      : `hist-${index}`;

    const primary = normalizeChatMessage(row, baseId);
    if (primary) acc.push(primary);

    const extraEvents = Array.isArray(row.extra_events) ? row.extra_events : [];
    extraEvents.forEach((extra, extraIndex) => {
      if (!extra || typeof extra !== 'object') return;
      const normalized = normalizeChatMessage({
        id: `${baseId}-extra-${extraIndex + 1}`,
        role: row.role,
        content: '',
        timestamp: row.timestamp,
        ...extra as Record<string, unknown>,
      }, `${baseId}-extra-${extraIndex + 1}`);
      if (normalized) acc.push(normalized);
    });

    return acc;
  }, []);
}
