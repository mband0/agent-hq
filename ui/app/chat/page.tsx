'use client';

import { useEffect, useState, useRef, useCallback, Suspense, memo } from 'react';
import { useSearchParams } from 'next/navigation';
import { formatTime, timeAgo } from '@/lib/date';
import { findAtlasAgent } from '@/lib/atlas';

// crypto.randomUUID() requires a secure context (HTTPS); fall back for plain HTTP
function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
import { api, Agent, CanonicalMessage, CanonicalSession, ChatMessage, ChatConfig, ChatEventType, JobInstance } from '@/lib/api';

/** Convert canonical session_messages rows into ChatMessage[] for rendering. */
function parseCanonicalMessages(rows: CanonicalMessage[]): ChatMessage[] {
  return rows.reduce<ChatMessage[]>((acc, m) => {
    const eventType = (m.event_type as ChatEventType) || 'text';
    let eventMeta: Record<string, unknown> = {};
    try {
      eventMeta = m.event_meta ? JSON.parse(m.event_meta) : {};
    } catch { /* ignore parse errors */ }

    const text = m.content ?? '';
    // Skip empty text-only messages but keep event bubbles (thought, tool_call, etc.)
    if (!text && eventType === 'text') return acc;

    acc.push({
      id: String(m.id),
      role: m.role,
      content: text,
      timestamp: m.timestamp,
      event_type: eventType,
      meta: eventMeta,
    });
    return acc;
  }, []);
}
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Link from 'next/link';
import { Bot, MessageSquare, Send, Loader2, Square, Clock, Tag, StopCircle, SquarePen } from 'lucide-react';
import { ThoughtBubble, ToolCallBubble, ToolResultBubble, TurnStartDivider, ErrorBubble } from '@/components/chat/EventBubbles';
import {
  PendingAttachment,
  AttachmentUploadButton,
  AttachmentPreviewStrip,
  validateFile,
  useDragDrop,
} from '@/components/chat/ChatAttachments';

// How many historical messages to load (older ones need "load more")
const HISTORY_LIMIT = 80;
const DIRECT_SESSION_STORAGE_PREFIX = 'agent-hq:direct-chat-session:';
const CHAT_RESPONSE_STALL_MS = 45000;

function sessionSlug(sessionKey: string | null | undefined, runtimeSlug?: string | null): string | null {
  if (runtimeSlug) return runtimeSlug;
  if (!sessionKey) return null;
  const parts = sessionKey.split(':');
  if (parts[0] !== 'agent') return null;
  if (parts.length === 5 && parts[4] === 'main') return parts[2] || null;
  return parts[1] || null;
}

function buildDirectSessionKey(baseSessionKey: string, runtimeSlug?: string | null, channel = 'web'): string {
  const slug = sessionSlug(baseSessionKey, runtimeSlug);
  if (!slug) return baseSessionKey;
  return `agent:${slug}:${channel}:direct:${generateId()}`;
}

function resolveInitialDirectSessionKey(
  baseSessionKey: string,
  storedSessionKey: string | null,
  runtimeSlug?: string | null,
  channel = 'web',
): string {
  const slug = sessionSlug(baseSessionKey, runtimeSlug);
  if (!slug) return storedSessionKey ?? baseSessionKey;
  if (storedSessionKey && storedSessionKey !== baseSessionKey && storedSessionKey.startsWith(`agent:${slug}:`)) {
    return storedSessionKey;
  }
  return buildDirectSessionKey(baseSessionKey, runtimeSlug, channel);
}

function getStoredDirectSessionKey(agentId: number): string | null {
  try {
    return localStorage.getItem(`${DIRECT_SESSION_STORAGE_PREFIX}${agentId}`);
  } catch {
    return null;
  }
}

function setStoredDirectSessionKey(agentId: number, sessionKey: string): void {
  try {
    localStorage.setItem(`${DIRECT_SESSION_STORAGE_PREFIX}${agentId}`, sessionKey);
  } catch {
    // ignore storage failures
  }
}

// ─── Chat Bubble — memoized so it never re-renders unless its own msg changes ─
const ChatBubble = memo(function ChatBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shrink-0 mr-2 mt-0.5">
          <Bot className="w-3.5 h-3.5 text-amber-400" />
        </div>
      )}
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm ${
          isUser
            ? 'bg-amber-500/20 border border-amber-500/30 text-amber-100 rounded-tr-sm'
            : 'bg-slate-700/60 border border-slate-600/50 text-slate-200 rounded-tl-sm'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{msg.content}</p>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none
            prose-p:my-1 prose-p:text-slate-200
            prose-headings:text-white prose-headings:my-2
            prose-code:text-amber-300 prose-code:text-xs prose-code:bg-slate-800 prose-code:px-1 prose-code:rounded
            prose-pre:bg-slate-900 prose-pre:border prose-pre:border-slate-700 prose-pre:my-2
            prose-a:text-amber-400 prose-strong:text-white
            prose-li:text-slate-200 prose-li:my-0.5
            prose-ul:my-1 prose-ol:my-1
          ">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {msg.content}
            </ReactMarkdown>
          </div>
        )}
        <p className="text-xs text-slate-600 mt-1 text-right">
          {formatTime(msg.timestamp)}
        </p>
      </div>
      {isUser && (
        <div className="w-7 h-7 rounded-full bg-slate-600/40 border border-slate-600/50 flex items-center justify-center shrink-0 ml-2 mt-0.5">
          <span className="text-xs text-slate-400">You</span>
        </div>
      )}
    </div>
  );
});

// ─── Event dispatcher — routes to the right bubble based on event_type ────────
const EventMessage = memo(function EventMessage({ msg }: { msg: ChatMessage }) {
  switch (msg.event_type) {
    case 'thought':
      return <ThoughtBubble msg={msg} />;
    case 'tool_call':
      return <ToolCallBubble msg={msg} />;
    case 'tool_result':
      return <ToolResultBubble msg={msg} />;
    case 'turn_start':
      return <TurnStartDivider msg={msg} />;
    case 'error':
      return <ErrorBubble msg={msg} />;
    case 'text':
    default:
      return <ChatBubble msg={msg} />;
  }
});

// ─── Streaming bubble — live updating, separated from the stable messages list ─
const StreamingBubble = memo(function StreamingBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-start mb-3">
      <div className="w-7 h-7 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shrink-0 mr-2 mt-0.5">
        <Bot className="w-3.5 h-3.5 text-amber-400" />
      </div>
      <div className="max-w-[75%] rounded-2xl px-4 py-2.5 text-sm bg-slate-700/60 border border-slate-600/50 text-slate-200 rounded-tl-sm">
        <div className="prose prose-invert prose-sm max-w-none
          prose-p:my-1 prose-p:text-slate-200
          prose-headings:text-white prose-headings:my-2
          prose-code:text-amber-300 prose-code:text-xs prose-code:bg-slate-800 prose-code:px-1 prose-code:rounded
          prose-pre:bg-slate-900 prose-pre:border prose-pre:border-slate-700 prose-pre:my-2
          prose-a:text-amber-400 prose-strong:text-white
          prose-li:text-slate-200 prose-li:my-0.5
          prose-ul:my-1 prose-ol:my-1
        ">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
        <span className="inline-block w-1.5 h-3.5 bg-amber-400 animate-pulse ml-0.5 align-text-bottom" />
      </div>
    </div>
  );
});

// ─── Status dot for job instance ─────────────────────────────────────────────
function InstanceStatusDot({ status }: { status: JobInstance['status'] }) {
  const cls: Record<JobInstance['status'], string> = {
    queued:     'bg-slate-400',
    dispatched: 'bg-blue-400',
    running:    'bg-amber-400 animate-pulse',
    done:       'bg-green-400',
    failed:     'bg-red-400',
  };
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${cls[status]}`} />;
}

// ─── Main Chat Page ───────────────────────────────────────────────────────────
function ChatPageInner() {
  const searchParams = useSearchParams();
  const overrideSessionKeyParam = searchParams.get('sessionKey');
  const overrideInstanceId = searchParams.get('instanceId');
  const deepLinkAgentId = searchParams.get('agentId');

  // Resolved override session key (for ?instanceId= links without agentId)
  const [overrideResolvedKey, setOverrideResolvedKey] = useState<string | null>(null);
  // When agentId is provided alongside instanceId, use the 3-column layout (not the override)
  const overrideSessionKey = deepLinkAgentId ? null : (overrideSessionKeyParam ?? overrideResolvedKey);

  // ── Agent list ──
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);

  // ── Run sessions (col 2) ──
  const [agentInstances, setAgentInstances] = useState<JobInstance[]>([]);
  const [instancesLoading, setInstancesLoading] = useState(false);
  const [selectedInstanceId, setSelectedInstanceId] = useState<number | null>(null);

  // ── Chat state ──
  // messages = committed (historical + finalized agent replies)
  // streamContent = live buffer for the currently streaming assistant message
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamContent, setStreamContent] = useState<string | null>(null); // null = not streaming
  const [historyTotal, setHistoryTotal] = useState(0); // total msgs available in session

  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [chatConfig, setChatConfig] = useState<ChatConfig | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamBufRef = useRef<string>('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollPendingRef = useRef(false); // throttle: only scroll after new committed message
  const pendingResponseRef = useRef(false);
  const responseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resolved session key (for direct-chat mode — not job runs)
  const [resolvedSessionKey, setResolvedSessionKey] = useState<string | null>(null);

  // Canonical session for the selected job-run instance (from /api/v1/sessions)
  const [canonicalSession, setCanonicalSession] = useState<CanonicalSession | null>(null);

  // The active session key: URL override → resolved key → selected instance → null
  const selectedInstance = agentInstances.find(i => i.id === selectedInstanceId) ?? null;
  const activeSessionKey: string | null = overrideSessionKey
    ?? resolvedSessionKey
    ?? selectedInstance?.session_key
    ?? selectedInstance?.agent_session_key
    ?? null;

  const streaming = streamContent !== null;

  const clearResponseWatchdog = useCallback(() => {
    if (responseTimeoutRef.current) {
      clearTimeout(responseTimeoutRef.current);
      responseTimeoutRef.current = null;
    }
  }, []);

  const clearPendingResponse = useCallback((message?: string | null) => {
    pendingResponseRef.current = false;
    clearResponseWatchdog();
    streamBufRef.current = '';
    setStreamContent(null);
    setSending(false);
    if (message) {
      setSendError(message);
    }
  }, [clearResponseWatchdog]);

  const armResponseWatchdog = useCallback(() => {
    clearResponseWatchdog();
    responseTimeoutRef.current = setTimeout(() => {
      if (!pendingResponseRef.current) return;
      clearPendingResponse('Atlas did not return a response. Check the OpenClaw/provider logs, then retry.');
    }, CHAT_RESPONSE_STALL_MS);
  }, [clearPendingResponse, clearResponseWatchdog]);

  // ── Stop instance state ──
  const [stopConfirming, setStopConfirming] = useState(false);
  const [stopLoading, setStopLoading] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [stopResult, setStopResult] = useState<string | null>(null);

  const isActiveInstance = selectedInstance && ['queued', 'dispatched', 'running'].includes(selectedInstance.status);

  const handleStopInstance = async () => {
    if (!selectedInstance) return;
    if (!stopConfirming) {
      setStopConfirming(true);
      setStopError(null);
      setStopResult(null);
      return;
    }
    setStopLoading(true);
    setStopError(null);
    try {
      const res = await api.stopInstance(selectedInstance.id, 'stop');
      // Update instance status locally
      setAgentInstances(prev =>
        prev.map(i => i.id === selectedInstance.id ? { ...i, status: 'failed' as const } : i)
      );
      setStopConfirming(false);
      const msg = res.runtimeUncertain
        ? 'Stopped (runtime state uncertain)'
        : 'Stopped successfully';
      setStopResult(msg);
      setTimeout(() => setStopResult(null), 4000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Stop failed';
      setStopError(message);
    } finally {
      setStopLoading(false);
    }
  };

  const cancelStopConfirm = () => {
    setStopConfirming(false);
    setStopError(null);
  };

  // Reset stop state when switching instances
  useEffect(() => {
    setStopConfirming(false);
    setStopLoading(false);
    setStopError(null);
    setStopResult(null);
  }, [selectedInstanceId]);

  // Track deep-link target so we can auto-select agent + instance after loading
  const deepLinkAgentIdRef = useRef<number | null>(null);
  const deepLinkInstanceIdRef = useRef<number | null>(null);

  // ── Resolve ?instanceId= to a session key + agent context ──
  useEffect(() => {
    if (!overrideInstanceId) return;
    const numericId = Number(overrideInstanceId);
    deepLinkInstanceIdRef.current = numericId;
    api.resolveSessionKey(numericId)
      .then(result => {
        if (result.sessionKey) {
          setOverrideResolvedKey(result.sessionKey);
        }
        if (result.agentId) {
          deepLinkAgentIdRef.current = result.agentId;
          // Auto-select the agent so instances load for the correct agent
          setSelectedAgentId(result.agentId);
        }
      })
      .catch(console.error);
  }, [overrideInstanceId]);

  // ── Load agents + chat config on mount ──
  useEffect(() => {
    api.getAgents()
      .then(data => {
        setAgents(data);
        // If a deep-link already set the agent, don't override it
        if (!deepLinkAgentIdRef.current) {
          const atlas = findAtlasAgent(data);
          if (atlas) setSelectedAgentId(atlas.id);
          else if (data.length > 0) setSelectedAgentId(data[0].id);
        }
      })
      .catch(console.error)
      .finally(() => setAgentsLoading(false));

    // Use a server-side proxy endpoint so both token and WS base are runtime-configurable.
    fetch('/api/chat-config', { cache: 'no-store' })
      .then(r => r.json())
      .then((data: { token: string; gatewayUrl: string }) => {
        setChatConfig({ gatewayUrl: data.gatewayUrl, token: data.token });
      })
      .catch(err => console.error('[chat] Failed to load config:', err));
  }, []);

  // ── Scroll to bottom only when a new committed message lands ──
  useEffect(() => {
    if (!scrollPendingRef.current) return;
    scrollPendingRef.current = false;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Fetch instances when selected agent changes ──
  useEffect(() => {
    if (!selectedAgentId) return;
    setAgentInstances([]);
    setSelectedInstanceId(null);
    setResolvedSessionKey(null);
    setInstancesLoading(true);

    api.getAgentInstances(selectedAgentId)
      .then(instances => {
        const sorted = [...instances].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        setAgentInstances(sorted);
        const currentAgent = agents.find(agent => agent.id === selectedAgentId) ?? null;

        // If we have a deep-link target instance, select it; otherwise pick the first with a session key
        const deepTarget = deepLinkInstanceIdRef.current;
        const targetInstance = deepTarget ? sorted.find(i => i.id === deepTarget) : null;
        if (targetInstance) {
          setSelectedInstanceId(targetInstance.id);
          // Clear the deep-link ref so subsequent agent switches use default behavior
          deepLinkInstanceIdRef.current = null;
        } else {
          const first = sorted.find(i => i.session_key || i.agent_session_key);
          if (first) {
            setSelectedInstanceId(first.id);
          } else if (currentAgent?.session_key) {
            // Atlas-style direct chat sessions have no job_instances row.
            setResolvedSessionKey(
              resolveInitialDirectSessionKey(
                currentAgent.session_key,
                getStoredDirectSessionKey(currentAgent.id),
                currentAgent.openclaw_agent_id,
              )
            );
          }
        }
      })
      .catch(console.error)
      .finally(() => setInstancesLoading(false));
  }, [agents, selectedAgentId]);

  // ── Resolve real session key when instance changes (for direct-chat fallback) ──
  useEffect(() => {
    setResolvedSessionKey(null);
    setCanonicalSession(null);
    if (!selectedInstanceId) return;
    api.resolveSessionKey(selectedInstanceId)
      .then(result => {
        if (result.sessionKey) {
          setResolvedSessionKey(result.sessionKey);
          // Also update the instance in local state so the key persists
          setAgentInstances(prev =>
            prev.map(inst =>
              inst.id === selectedInstanceId
                ? { ...inst, session_key: result.sessionKey }
                : inst
            )
          );
        }
      })
      .catch(console.error);
  }, [selectedInstanceId]);

  // ── Derived instance state ──
  const instanceIsFinished = selectedInstance ? ['done', 'failed'].includes(selectedInstance.status) : false;
  const instanceIsRunning = selectedInstance?.status === 'running';
  // Use canonical sessions API for all job-run instances
  const useCanonical = !!selectedInstanceId;

  // ── Canonical session loader: ensure + fetch messages when instance is selected ──
  useEffect(() => {
    if (!useCanonical || !selectedInstanceId) return;

    const instanceId = selectedInstanceId;
    // Ensure the canonical session exists in Atlas HQ (creates/updates it via adapter)
    api.ensureSessionForInstance(instanceId)
      .then(session => {
        setCanonicalSession(session);
        if (session.message_count === 0) return [];
        return api.getSessionMessages(session.id, { limit: 500 });
      })
      .then(messages => {
        if (!Array.isArray(messages)) return;
        const parsed = parseCanonicalMessages(messages);
        setMessages(parsed);
        setHistoryTotal(parsed.length);
        scrollPendingRef.current = parsed.length > 0;
      })
      .catch(err => console.warn('[chat] Failed to load canonical session:', err));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useCanonical, selectedInstanceId]);

  // ── Live polling for in-progress instances via canonical sessions ──
  useEffect(() => {
    if (!instanceIsRunning || !selectedInstanceId) return;

    const instanceId = selectedInstanceId;
    let stopped = false;
    // Poll canonical session messages — same interval for all runtimes since
    // the canonical sessions API normalizes the underlying storage differences.
    const POLL_MS = 3000;

    const poll = () => {
      if (stopped) return;
      // Get current canonical session for this instance
      api.getSessions({ instance_id: instanceId, limit: 1 })
        .then(sessions => {
          if (stopped || sessions.length === 0) return;
          const session = sessions[0];
          return api.getSessionMessages(session.id, { limit: 500 });
        })
        .then(msgs => {
          if (stopped || !msgs || !Array.isArray(msgs)) return;
          const parsed = parseCanonicalMessages(msgs as import('@/lib/api').CanonicalMessage[]);
          setMessages(prev => {
            const existingIds = new Set(prev.map(m => m.id));
            const newMsgs = parsed.filter(m => !existingIds.has(m.id));
            const updatedPrev = prev.map(existing => {
              const updated = parsed.find(p => p.id === existing.id);
              return updated && updated.content !== existing.content ? updated : existing;
            });
            if (newMsgs.length === 0 && updatedPrev.every((m, i) => m === prev[i])) return prev;
            scrollPendingRef.current = newMsgs.length > 0;
            return [...updatedPrev, ...newMsgs];
          });
          setHistoryTotal(parsed.length);
        })
        .catch(err => console.warn('[chat] Canonical live poll failed:', err));
    };

    const interval = setInterval(poll, POLL_MS);

    // Also check instance status to stop polling when done
    const statusInterval = setInterval(() => {
      if (stopped) return;
      api.getAgentInstances(selectedAgentId!)
        .then(instances => {
          const inst = instances.find(i => i.id === instanceId);
          if (inst && ['done', 'failed'].includes(inst.status)) {
            setAgentInstances(prev =>
              prev.map(i => i.id === instanceId ? { ...i, status: inst.status } : i)
            );
          }
        })
        .catch(() => {});
    }, 10000);

    return () => {
      stopped = true;
      clearInterval(interval);
      clearInterval(statusInterval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceIsRunning, selectedInstanceId]);

  // ── WebSocket connection ──
  const connectWs = useCallback((sessionKey: string, config: ChatConfig) => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const ws = new WebSocket(config.gatewayUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Clear any stale send error from a previous failed connection
      setSendError(null);
      ws.send(JSON.stringify({
        id: generateId(),
        type: 'connect',
        params: { auth: { token: config.token } },
      }));
      // Request with a limit to avoid loading thousands of messages
      ws.send(JSON.stringify({
        id: generateId(),
        type: 'chat.history',
        sessionKey,
        limit: HISTORY_LIMIT,
      }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>;
        handleWsMessage(data);
      } catch (err) {
        console.warn('[chat] Failed to parse WS message:', err);
      }
    };

    ws.onerror = (err) => {
      // Log the error but do not surface it as a banner — transient WS errors
      // are common (e.g. during reconnect) and do not necessarily block the user.
      // A real send failure is caught at send-time in handleSend().
      console.warn('[chat] WebSocket error (non-blocking):', err);
    };

    ws.onclose = () => {
      if (pendingResponseRef.current) {
        clearPendingResponse('Connection to Atlas was interrupted before a response completed. Retry.');
      }
      console.log('[chat] WebSocket closed');
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearPendingResponse]);

  const handleWsMessage = useCallback((data: Record<string, unknown>) => {
    const type = data.type as string;

    if (type === 'chat.history') {
      const historyMsgs = (data.messages as Array<Record<string, unknown>>) || [];
      const total = (data.total as number) ?? historyMsgs.length;
      const parsed: ChatMessage[] = historyMsgs.map((m, i) => ({
        id: (m.id as string) || `hist-${i}`,
        role: (m.role as 'user' | 'assistant' | 'system') || 'assistant',
        content: (m.content as string) || '',
        timestamp: (m.timestamp as string) || new Date().toISOString(),
      }));
      clearPendingResponse();
      setHistoryTotal(total);
      setMessages(parsed);
      // Scroll to bottom after history loads
      scrollPendingRef.current = true;

    } else if (type === 'chat') {
      const role = (data.role as string) || 'assistant';
      const delta = (data.delta as string) || '';
      const done = data.done as boolean;

      if (role === 'assistant') {
        if (done) {
          pendingResponseRef.current = false;
          clearResponseWatchdog();
          // Commit the streamed content into the messages list
          const finalContent = streamBufRef.current;
          streamBufRef.current = '';
          setStreamContent(null);
          if (finalContent) {
            const committedMsg: ChatMessage = {
              id: `stream-${Date.now()}`,
              role: 'assistant',
              content: finalContent,
              timestamp: new Date().toISOString(),
            };
            scrollPendingRef.current = true;
            setMessages(prev => [...prev, committedMsg]);
          }
        } else if (delta) {
          pendingResponseRef.current = true;
          armResponseWatchdog();
          streamBufRef.current += delta;
          // Update only the streaming bubble — does NOT touch messages array
          setStreamContent(streamBufRef.current);
        }
      }

    } else if (type === 'chat.send') {
      pendingResponseRef.current = true;
      armResponseWatchdog();
      setSending(false);
      streamBufRef.current = '';
      setStreamContent(''); // start streaming (empty string = streaming started)
    } else if (type === 'chat.new') {
      const nextSessionKey = typeof data.sessionKey === 'string' ? data.sessionKey : null;
      if (!nextSessionKey) return;
      setPendingAttachments(prev => {
        prev.forEach(att => { if (att.previewUrl) URL.revokeObjectURL(att.previewUrl); });
        return [];
      });
      setMessages([]);
      clearPendingResponse();
      setHistoryTotal(0);
      setSendError(null);
      setSelectedInstanceId(null);
      setResolvedSessionKey(nextSessionKey);
    } else if (type === 'error') {
      pendingResponseRef.current = false;
      clearResponseWatchdog();
      setSendError((data.message as string) || 'Gateway error');
      setSending(false);
      streamBufRef.current = '';
      setStreamContent(null);
    }
  }, [armResponseWatchdog, clearPendingResponse, clearResponseWatchdog]);

  useEffect(() => {
    if (!selectedAgentId || selectedInstanceId !== null || !resolvedSessionKey) return;
    setStoredDirectSessionKey(selectedAgentId, resolvedSessionKey);
  }, [resolvedSessionKey, selectedAgentId, selectedInstanceId]);

  // ── Reconnect when session/config changes ──
  useEffect(() => {
    // Only clear messages for WebSocket-driven (direct-chat) sessions.
    // Canonical-session-backed runs load messages via their own effect and
    // must not be wiped here.
    if (!useCanonical) {
      setMessages([]);
    }
    setStreamContent(null);
    setSendError(null);
    setInputText('');
    setSending(false);
    streamBufRef.current = '';
    scrollPendingRef.current = false;

    // Only open a WebSocket for direct-chat sessions (no job run instance selected)
    if (activeSessionKey && chatConfig && !useCanonical) {
      connectWs(activeSessionKey, chatConfig);
    } else if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    return () => {
      clearResponseWatchdog();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [activeSessionKey, chatConfig, connectWs, clearResponseWatchdog]);

  // ── Attachment state ──
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);

  const uploadFile = async (file: File): Promise<PendingAttachment> => {
    const localId = `att-${Date.now()}-${Math.random()}`;
    const isImage = file.type.startsWith('image/');
    const previewUrl = isImage ? URL.createObjectURL(file) : undefined;

    const error = validateFile(file);
    if (error) return { id: localId, file, previewUrl, error };

    const pending: PendingAttachment = { id: localId, file, previewUrl, uploading: true };
    setPendingAttachments(prev => [...prev, pending]);

    try {
      const fd = new FormData();
      fd.append('file', file);
      if (selectedInstanceId) fd.append('instance_id', String(selectedInstanceId));
      const res = await fetch('/api/v1/chat/attachments', { method: 'POST', body: fd });
      const data = await res.json() as { ok: boolean; attachment?: { id: number }; error?: string };
      if (!data.ok || !data.attachment) throw new Error(data.error ?? 'Upload failed');
      setPendingAttachments(prev =>
        prev.map(a => a.id === localId ? { ...a, uploading: false, uploadedId: data.attachment!.id } : a)
      );
      return { ...pending, uploading: false, uploadedId: data.attachment.id };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Upload failed';
      setPendingAttachments(prev =>
        prev.map(a => a.id === localId ? { ...a, uploading: false, error: errMsg } : a)
      );
      return { ...pending, uploading: false, error: errMsg };
    }
  };

  const addFiles = (files: File[]) => {
    for (const file of files) {
      uploadFile(file);
    }
  };

  const removeAttachment = (id: string) => {
    setPendingAttachments(prev => {
      const att = prev.find(a => a.id === id);
      if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
      return prev.filter(a => a.id !== id);
    });
  };

  const handleSend = () => {
    const text = inputText.trim();
    const readyAttachments = pendingAttachments.filter(a => a.uploadedId && !a.error);
    if ((!text && readyAttachments.length === 0) || sending || streaming) return;

    setInputText('');
    setSendError(null);
    setPendingAttachments([]);
    // revoke object URLs
    pendingAttachments.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });

    const displayText = text || readyAttachments.map(a => `[${a.file.name}]`).join(' ');
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: displayText,
      timestamp: new Date().toISOString(),
    };
    scrollPendingRef.current = true;
    setMessages(prev => [...prev, userMsg]);
    setSending(true);

    // Use REST endpoint when viewing a job run instance (canonical path)
    if (useCanonical && selectedInstanceId) {
      fetch(`/api/v1/chat/instances/${selectedInstanceId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          attachment_ids: readyAttachments.map(a => a.uploadedId!),
        }),
      })
        .then(r => r.json())
        .then(data => {
          if (!(data as { ok: boolean }).ok) setSendError((data as { error?: string }).error ?? 'Send failed');
        })
        .catch(err => setSendError((err as Error).message ?? 'Send failed'))
        .finally(() => {
          clearPendingResponse();
          setSending(false);
        });
      return;
    }

    // Fallback: Direct Chat via WebSocket (attachments appended to text)
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeSessionKey) {
      setSendError('WebSocket not connected');
      setSending(false);
      return;
    }

    const wsMessage = readyAttachments.length > 0
      ? [text, ...readyAttachments.map(a => `[Attachment: ${a.file.name} — /api/v1/chat/attachments/${a.uploadedId}/download]`)].filter(Boolean).join('\n')
      : text;

    pendingResponseRef.current = true;
    armResponseWatchdog();
    ws.send(JSON.stringify({
      id: generateId(),
      type: 'chat.send',
      sessionKey: activeSessionKey,
      message: wsMessage,
      idempotencyKey: generateId(),
    }));
  };

  const handleAbort = () => {
    // Use REST endpoint when viewing a job run instance (canonical path)
    if (useCanonical && selectedInstanceId) {
      fetch(`/api/v1/chat/instances/${selectedInstanceId}/abort`, { method: 'POST' })
        .catch(err => console.warn('[chat] Abort failed:', err));
      clearPendingResponse();
      return;
    }

    // Direct Chat via WebSocket
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeSessionKey) return;

    ws.send(JSON.stringify({
      id: generateId(),
      type: 'chat.abort',
      sessionKey: activeSessionKey,
    }));
    clearPendingResponse();
  };

  const handleNewDirectChat = () => {
    if (selectedInstanceId !== null || !activeSessionKey) return;
    if (messages.length > 0 && !window.confirm('Start a new direct chat? Current conversation will be cleared.')) {
      return;
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setSendError('WebSocket not connected');
      return;
    }
    setPendingAttachments(prev => {
      prev.forEach(att => { if (att.previewUrl) URL.revokeObjectURL(att.previewUrl); });
      return [];
    });
    clearPendingResponse();
    setSendError(null);
    ws.send(JSON.stringify({
      id: generateId(),
      type: 'chat.new',
      sessionKey: activeSessionKey,
      channel: 'web',
    }));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const fileItems = items.filter(item => item.kind === 'file');
    if (fileItems.length === 0) return;
    e.preventDefault();
    const files = fileItems.map(item => item.getAsFile()).filter(Boolean) as File[];
    addFiles(files);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInstanceId, pendingAttachments]);

  const loadOlderMessages = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeSessionKey || !chatConfig) return;
    // Request the next batch offset by current count
    ws.send(JSON.stringify({
      id: generateId(),
      type: 'chat.history',
      sessionKey: activeSessionKey,
      limit: HISTORY_LIMIT,
      offset: messages.length,
    }));
  };

  const selectedAgent = agents.find(a => a.id === selectedAgentId);
  const hasMoreHistory = historyTotal > messages.length;

  // ── URL override: 2-col layout ──
  if (overrideSessionKey) {
    return (
      <div className="flex h-full">
        <div className="w-48 shrink-0 bg-slate-800/40 border-r border-slate-700/50 flex flex-col">
          <div className="px-4 py-3 border-b border-slate-700/50">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-amber-400" />
              <h2 className="font-semibold text-white text-sm">Agents</h2>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto py-2">
            {agentsLoading ? (
              <div className="flex items-center justify-center h-16">
                <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
              </div>
            ) : agents.map(agent => (
              <button
                key={agent.id}
                onClick={() => { window.location.href = `/chat`; }}
                className="w-full text-left px-4 py-3 flex items-center gap-2 transition-colors hover:bg-slate-700/40 border-l-2 border-transparent"
              >
                <Bot className="w-4 h-4 text-slate-400 shrink-0" />
                <span className="text-slate-300 text-sm truncate">{agent.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          <div className="px-5 py-3 border-b border-slate-700/50 flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-1.5 text-xs text-amber-300 w-full">
              <span className="font-semibold shrink-0">Job Session:</span>
              <span className="font-mono truncate text-amber-200">{overrideInstanceId ? `Instance #${overrideInstanceId}` : overrideSessionKey}</span>
              <a href="/chat" className="ml-auto shrink-0 text-slate-400 hover:text-white underline">← back</a>
            </div>
          </div>
          <ChatPanel
            messages={messages}
            streamContent={streamContent}
            messagesEndRef={messagesEndRef}
            inputText={inputText}
            setInputText={setInputText}
            handleSend={handleSend}
            handleAbort={handleAbort}
            handleKeyDown={handleKeyDown}
            handlePaste={handlePaste}
            sending={sending}
            streaming={streaming}
            sendError={sendError}
            agentName="Session"
            hasSession={true}
            hasMoreHistory={hasMoreHistory}
            onLoadOlder={loadOlderMessages}
            pendingAttachments={pendingAttachments}
            onAddFiles={addFiles}
            onRemoveAttachment={removeAttachment}
          />
        </div>
      </div>
    );
  }

  // ── Normal 3-column layout ──
  return (
    <div className="flex h-full">
      {/* ── Col 1: Agent list ── */}
      <div className="w-48 shrink-0 bg-slate-800/40 border-r border-slate-700/50 flex flex-col">
        <div className="px-4 py-3 border-b border-slate-700/50">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-white text-sm">Agents</h2>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {agentsLoading ? (
            <div className="flex items-center justify-center h-16">
              <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
            </div>
          ) : agents.length === 0 ? (
            <p className="px-4 text-slate-500 text-xs mt-3">No agents yet</p>
          ) : (
            agents.map(agent => (
              <button
                key={agent.id}
                onClick={() => setSelectedAgentId(agent.id)}
                className={`w-full text-left px-4 py-3 flex items-center gap-2 transition-colors hover:bg-slate-700/40 ${
                  selectedAgentId === agent.id
                    ? 'bg-slate-700/60 border-l-2 border-amber-400'
                    : 'border-l-2 border-transparent'
                }`}
              >
                <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                  selectedAgentId === agent.id
                    ? 'bg-amber-500/20 border border-amber-500/30'
                    : 'bg-slate-700/60 border border-slate-600/50'
                }`}>
                  <Bot className={`w-3.5 h-3.5 ${selectedAgentId === agent.id ? 'text-amber-400' : 'text-slate-400'}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className={`font-medium text-sm truncate ${selectedAgentId === agent.id ? 'text-white' : 'text-slate-300'}`}>
                    {agent.name}
                  </p>
                  <p className="text-slate-500 text-xs truncate">{agent.role}</p>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Col 2: Run sessions ── */}
      <div className="w-60 shrink-0 bg-slate-800/20 border-r border-slate-700/50 flex flex-col">
        <div className="px-3 py-3 border-b border-slate-700/50">
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-slate-400" />
            <h2 className="font-semibold text-slate-300 text-xs uppercase tracking-wide">
              {selectedAgent ? `${selectedAgent.name} Runs` : 'Runs'}
            </h2>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {/* Direct chat entry — always shown when agent has a session key */}
          {selectedAgent?.session_key && (
            <button
              onClick={() => {
                setSelectedInstanceId(null);
                setResolvedSessionKey(
                  resolveInitialDirectSessionKey(
                    selectedAgent.session_key,
                    getStoredDirectSessionKey(selectedAgent.id),
                    selectedAgent.openclaw_agent_id,
                  )
                );
                setMessages([]);
                setStreamContent(null);
              }}
              className={`w-full text-left px-3 py-2.5 flex flex-col gap-1 transition-colors border-l-2 mb-1 ${
                selectedInstanceId === null && !!resolvedSessionKey
                  ? 'bg-amber-500/10 border-amber-400'
                  : 'border-amber-400/30 hover:bg-slate-700/30'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <MessageSquare className="w-3 h-3 text-amber-400 shrink-0" />
                <span className="text-amber-300 text-xs font-medium">Direct Chat</span>
              </div>
              <p className="text-slate-500 text-xs truncate pl-4">{resolvedSessionKey ?? selectedAgent.session_key}</p>
            </button>
          )}
          {!selectedAgentId ? (
            <p className="px-3 text-slate-500 text-xs mt-3">Select an agent</p>
          ) : instancesLoading ? (
            <div className="flex items-center justify-center h-16">
              <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
            </div>
          ) : agentInstances.length === 0 ? (
            <p className="px-3 text-slate-500 text-xs mt-3">No runs yet</p>
          ) : (
            agentInstances.map(instance => {
              const resolvedKey = instance.session_key ?? instance.agent_session_key ?? null;
              return (
              <button
                key={instance.id}
                onClick={() => {
                  if (resolvedKey) setSelectedInstanceId(instance.id);
                }}
                disabled={!resolvedKey}
                title={resolvedKey ?? 'No session key — agent never registered'}
                className={`w-full text-left px-3 py-2.5 flex flex-col gap-1 transition-colors border-l-2 ${
                  selectedInstanceId === instance.id
                    ? 'bg-slate-700/60 border-amber-400'
                    : 'border-transparent hover:bg-slate-700/30'
                } ${!resolvedKey ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <div className="flex items-center gap-1.5 w-full min-w-0">
                  <InstanceStatusDot status={instance.status} />
                  <span className={`text-xs font-medium truncate flex-1 ${
                    selectedInstanceId === instance.id ? 'text-white' : 'text-slate-300'
                  }`}>
                    {instance.job_title || instance.agent_name || `Run #${instance.id}`}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 pl-3.5">
                  <Badge variant={instance.status}>{instance.status}</Badge>
                  <span className="text-slate-500 text-xs ml-auto">{timeAgo(instance.created_at)}</span>
                </div>
                {instance.task_id && (
                  <div className="pl-3.5" onClick={e => e.stopPropagation()}>
                    <Link
                      href={`/tasks?id=${instance.task_id}`}
                      className="inline-flex items-center gap-1 text-xs text-amber-400/80 hover:text-amber-300 hover:underline truncate max-w-full"
                      title={instance.task_title ? `Task #${instance.task_id}: ${instance.task_title}` : `Task #${instance.task_id}`}
                    >
                      <Tag className="w-2.5 h-2.5 shrink-0" />
                      <span className="truncate">#{instance.task_id}{instance.task_title ? ` ${instance.task_title}` : ''}</span>
                    </Link>
                  </div>
                )}
              </button>
              );
            })
          )}
        </div>
      </div>

      {/* ── Col 3: Chat panel ── */}
      <div className="flex-1 flex flex-col min-w-0" data-tour-target="chat-main-panel">
        <div className="px-5 py-3 border-b border-slate-700/50 flex items-center gap-3 shrink-0 min-w-0">
          {selectedInstance ? (
            <>
              <div className="w-8 h-8 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shrink-0">
                <Bot className="w-4 h-4 text-amber-400" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-white text-sm truncate">
                  {selectedAgent?.name} — {selectedInstance.job_title || selectedInstance.agent_name || `Run #${selectedInstance.id}`}
                </p>
                <p className="text-slate-500 text-xs font-mono truncate">
                  {activeSessionKey}
                </p>
                {selectedInstance.task_id && (
                  <Link
                    href={`/tasks?id=${selectedInstance.task_id}`}
                    className="inline-flex items-center gap-1 text-xs text-amber-400/70 hover:text-amber-300 hover:underline mt-0.5"
                    title={selectedInstance.task_title ? `Task #${selectedInstance.task_id}: ${selectedInstance.task_title}` : `Task #${selectedInstance.task_id}`}
                  >
                    <Tag className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate">Task #{selectedInstance.task_id}{selectedInstance.task_title ? `: ${selectedInstance.task_title}` : ''}</span>
                  </Link>
                )}
              </div>
              {streaming && (
                <div className="ml-auto shrink-0 flex items-center gap-1.5 text-xs text-amber-400">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Streaming…
                </div>
              )}
              {instanceIsRunning && !streaming && (
                <div className="shrink-0 flex items-center gap-1.5 text-xs text-emerald-400 ml-auto">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                  Live
                </div>
              )}
              {/* Stop button for active instances */}
              {isActiveInstance && (
                <div className={`shrink-0 flex items-center gap-2 ${!instanceIsRunning || streaming ? 'ml-auto' : ''}`}>
                  {stopConfirming ? (
                    <>
                      <span className="text-xs text-red-400">Stop this run?</span>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={handleStopInstance}
                        loading={stopLoading}
                        className="h-7 text-xs px-2"
                      >
                        Confirm
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={cancelStopConfirm}
                        disabled={stopLoading}
                        className="h-7 text-xs px-2"
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={handleStopInstance}
                      className="h-7 text-xs px-2 gap-1"
                    >
                      <StopCircle className="w-3 h-3" />
                      Stop
                    </Button>
                  )}
                </div>
              )}
              {stopError && (
                <span className="text-xs text-red-400 shrink-0">{stopError}</span>
              )}
              {stopResult && (
                <span className="text-xs text-green-400 shrink-0">{stopResult}</span>
              )}
            </>
          ) : selectedAgent && activeSessionKey ? (
            <>
              <div className="w-8 h-8 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shrink-0">
                <Bot className="w-4 h-4 text-amber-400" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-white text-sm truncate">
                  {selectedAgent.name} Direct Chat
                </p>
                <p className="text-slate-500 text-xs font-mono truncate">
                  {activeSessionKey}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleNewDirectChat}
                className="ml-auto h-7 text-xs px-2 gap-1"
              >
                <SquarePen className="w-3 h-3" />
                New chat
              </Button>
            </>
          ) : (
            <p className="text-slate-500 text-sm">
              {selectedAgent ? 'Select a run from the list' : 'Select an agent to start'}
            </p>
          )}
        </div>

        <ChatPanel
          messages={messages}
          streamContent={streamContent}
          messagesEndRef={messagesEndRef}
          inputText={inputText}
          setInputText={setInputText}
          handleSend={handleSend}
          handleAbort={handleAbort}
          handleKeyDown={handleKeyDown}
          handlePaste={handlePaste}
          sending={sending}
          streaming={streaming}
          sendError={sendError}
          agentName={selectedAgent?.name}
          hasSession={!!activeSessionKey || useCanonical}
          hasMoreHistory={hasMoreHistory}
          onLoadOlder={loadOlderMessages}
          pendingAttachments={pendingAttachments}
          onAddFiles={addFiles}
          onRemoveAttachment={removeAttachment}
        />
      </div>
    </div>
  );
}

// ─── Chat panel ───────────────────────────────────────────────────────────────
interface ChatPanelProps {
  messages: ChatMessage[];
  streamContent: string | null;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  inputText: string;
  setInputText: (v: string) => void;
  handleSend: () => void;
  handleAbort: () => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  sending: boolean;
  streaming: boolean;
  sendError: string | null;
  agentName: string | undefined;
  hasSession: boolean;
  hasMoreHistory: boolean;
  onLoadOlder: () => void;
  pendingAttachments: PendingAttachment[];
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
}

function ChatPanel({
  messages,
  streamContent,
  messagesEndRef,
  inputText,
  setInputText,
  handleSend,
  handleAbort,
  handleKeyDown,
  handlePaste,
  sending,
  streaming,
  sendError,
  agentName,
  hasSession,
  hasMoreHistory,
  onLoadOlder,
  pendingAttachments,
  onAddFiles,
  onRemoveAttachment,
}: ChatPanelProps) {
  const { onDragOver, onDrop } = useDragDrop(onAddFiles, hasSession && !sending);
  const hasUploading = pendingAttachments.some(a => a.uploading);
  const canSend = (inputText.trim().length > 0 || pendingAttachments.some(a => a.uploadedId))
    && !sending && !hasUploading;

  return (
    <>
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {!hasSession ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <MessageSquare className="w-12 h-12 text-slate-700" />
            <p className="text-slate-500 text-sm">Select a run to view its chat history</p>
          </div>
        ) : messages.length === 0 && !streaming ? (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <Bot className="w-10 h-10 text-slate-700" />
            <p className="text-slate-500 text-sm">No messages in this session</p>
          </div>
        ) : (
          <>
            {/* Load older messages button */}
            {hasMoreHistory && (
              <div className="flex justify-center mb-4">
                <button
                  onClick={onLoadOlder}
                  className="text-xs text-slate-400 hover:text-amber-400 border border-slate-700/60 hover:border-amber-500/40 rounded-full px-4 py-1.5 transition-colors"
                >
                  ↑ Load older messages
                </button>
              </div>
            )}

            {messages.map(msg => (
              <EventMessage key={msg.id} msg={msg} />
            ))}

            {/* Live streaming bubble — separate from messages array */}
            {streamContent !== null && (
              <StreamingBubble content={streamContent} />
            )}

            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Send error */}
      {sendError && (
        <div className="px-5 py-2 bg-red-900/20 border-t border-red-800/40 shrink-0">
          <p className="text-red-400 text-xs">{sendError}</p>
        </div>
      )}

      {/* Input area */}
      {hasSession && (
        <div
          className="border-t border-slate-700/50 shrink-0"
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          {/* Attachment previews */}
          <AttachmentPreviewStrip attachments={pendingAttachments} onRemove={onRemoveAttachment} />

          <div className="px-5 py-4">
            <div className="flex gap-2 items-end rounded-xl border border-slate-700/60 bg-slate-800/60 focus-within:border-amber-500/50 transition-colors px-2 py-2">
              {/* Attach button */}
              <AttachmentUploadButton onFiles={onAddFiles} disabled={sending} />

              {/* Text input */}
              <textarea
                data-tour-target="chat-composer"
                className="flex-1 bg-transparent text-sm text-white placeholder-slate-500 resize-none focus:outline-none py-1 px-2"
                placeholder={`Message ${agentName ?? 'agent'}… (Enter to send, Shift+Enter for newline, or paste/drop a file)`}
                value={inputText}
                onChange={e => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                rows={1}
                style={{ maxHeight: '150px', minHeight: '36px' }}
                disabled={sending}
              />

              {/* Send / abort */}
              {streaming ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleAbort}
                  className="shrink-0 h-9"
                >
                  <Square className="w-4 h-4" />
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSend}
                  disabled={!canSend}
                  loading={sending || hasUploading}
                  className="shrink-0 h-9"
                >
                  <Send className="w-4 h-4" />
                </Button>
              )}
            </div>
            {pendingAttachments.length > 0 && (
              <p className="text-xs text-slate-500 mt-1.5 px-1">
                {hasUploading ? 'Uploading…' : `${pendingAttachments.filter(a => a.uploadedId).length} attachment${pendingAttachments.filter(a => a.uploadedId).length !== 1 ? 's' : ''} ready`}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" /></div>}>
      <ChatPageInner />
    </Suspense>
  );
}
