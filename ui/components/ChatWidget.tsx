'use client';

import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { api, AtlasHeartbeatStatus, CanonicalMessage, ChatMessage, ChatConfig, ChatSession } from '@/lib/api';
import { findAtlasAgent } from '@/lib/atlas';
import { parseCanonicalMessages, parseGatewayHistoryMessages, parseStoredChatMessages } from '@/lib/chatMessages';
import {
  ATLAS_WIDGET_COMMAND_EVENT,
  consumePendingAtlasWidgetCommand,
  emitAtlasWidgetState,
  type AtlasWidgetCommand,
} from '@/lib/atlasWidget';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, Send, X, Loader2, Square, MessageCircle, Settings, SquarePen, Activity, History, ArrowLeft } from 'lucide-react';
import TelegramSettings from './TelegramSettings';
import { formatTime } from '@/lib/date';
import { ThoughtBubble, ToolCallBubble, ToolResultBubble, TurnStartDivider, ErrorBubble } from '@/components/chat/EventBubbles';
import {
  PendingAttachment,
  validateFile,
  AttachmentUploadButton,
  AttachmentPreviewStrip,
  useDragDrop,
} from './chat/ChatAttachments';

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const HISTORY_LIMIT = 50;
const DIRECT_SESSION_STORAGE_PREFIX = 'agent-hq:direct-chat-session:';
const CHAT_RESPONSE_STALL_MS = 20 * 60 * 1000;

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

function formatTokenCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return value.toLocaleString();
}

// ─── Compact chat bubble ────────────────────────────────────────────────────
const WidgetBubble = memo(function WidgetBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-2`}>
      {!isUser && (
        <div className="w-6 h-6 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shrink-0 mr-1.5 mt-0.5">
          <Bot className="w-3 h-3 text-amber-400" />
        </div>
      )}
      <div
        className={`max-w-[85%] rounded-xl px-3 py-2 text-xs ${
          isUser
            ? 'bg-amber-500/20 border border-amber-500/30 text-amber-100 rounded-tr-sm'
            : 'bg-slate-700/60 border border-slate-600/50 text-slate-200 rounded-tl-sm'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{msg.content}</p>
        ) : (
          <div className="prose prose-invert prose-xs max-w-none
            [&_p]:my-0.5 [&_p]:text-slate-200 [&_p]:text-xs
            [&_h1]:text-white [&_h2]:text-white [&_h3]:text-white [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h1]:my-1 [&_h2]:my-1 [&_h3]:my-1
            [&_code]:text-amber-300 [&_code]:text-[10px] [&_code]:bg-slate-800 [&_code]:px-1 [&_code]:rounded
            [&_pre]:bg-slate-900 [&_pre]:border [&_pre]:border-slate-700 [&_pre]:my-1 [&_pre]:text-[10px]
            [&_a]:text-amber-400 [&_strong]:text-white
            [&_li]:text-slate-200 [&_li]:text-xs [&_li]:my-0
            [&_ul]:my-0.5 [&_ol]:my-0.5
          ">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {msg.content}
            </ReactMarkdown>
          </div>
        )}
        <p className="text-[10px] text-slate-600 mt-0.5 text-right">
          {formatTime(msg.timestamp)}
        </p>
      </div>
    </div>
  );
});

// ─── Heartbeat bubble — styled for board monitor entries ──────────────────────
const HeartbeatBubble = memo(function HeartbeatBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';
  const isOk = msg.content?.trim() === 'HEARTBEAT_OK' || msg.content?.startsWith('HEARTBEAT_OK');
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-2`}>
      {!isUser && (
        <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center shrink-0 mr-1.5 mt-0.5">
          <Activity className="w-3 h-3 text-emerald-400" />
        </div>
      )}
      <div
        className={`max-w-[85%] rounded-xl px-3 py-2 text-xs ${
          isUser
            ? 'bg-slate-700/40 border border-slate-600/40 text-slate-400 rounded-tr-sm italic'
            : isOk
              ? 'bg-emerald-900/20 border border-emerald-700/30 text-emerald-300 rounded-tl-sm'
              : 'bg-slate-700/60 border border-slate-600/50 text-slate-200 rounded-tl-sm'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words text-[10px]">{msg.content}</p>
        ) : isOk ? (
          <p className="font-mono text-[10px]">✓ {msg.content}</p>
        ) : (
          <div className="prose prose-invert prose-xs max-w-none
            [&_p]:my-0.5 [&_p]:text-slate-200 [&_p]:text-xs
            [&_h1]:text-white [&_h2]:text-white [&_h3]:text-white [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs
            [&_code]:text-emerald-300 [&_code]:text-[10px] [&_code]:bg-slate-800 [&_code]:px-1 [&_code]:rounded
            [&_a]:text-emerald-400 [&_strong]:text-white
            [&_li]:text-slate-200 [&_li]:text-xs
            [&_ul]:my-0.5 [&_ol]:my-0.5
          ">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {msg.content}
            </ReactMarkdown>
          </div>
        )}
        <p className="text-[10px] text-slate-600 mt-0.5 text-right">
          {formatTime(msg.timestamp)}
        </p>
      </div>
    </div>
  );
});

const WidgetEventMessage = memo(function WidgetEventMessage({ msg }: { msg: ChatMessage }) {
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
      return <WidgetBubble msg={msg} />;
  }
});

// ─── Streaming bubble ─────────────────────────────────────────────────────────
const WidgetStreamBubble = memo(function WidgetStreamBubble({ content, isHeartbeat }: { content: string; isHeartbeat?: boolean }) {
  return (
    <div className="flex justify-start mb-2">
      <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 mr-1.5 mt-0.5 ${isHeartbeat ? 'bg-emerald-500/20 border border-emerald-500/30' : 'bg-amber-500/20 border border-amber-500/30'}`}>
        {isHeartbeat
          ? <Activity className="w-3 h-3 text-emerald-400" />
          : <Bot className="w-3 h-3 text-amber-400" />
        }
      </div>
      <div className="max-w-[85%] rounded-xl px-3 py-2 text-xs bg-slate-700/60 border border-slate-600/50 text-slate-200 rounded-tl-sm">
        <div className="prose prose-invert prose-xs max-w-none
          [&_p]:my-0.5 [&_p]:text-slate-200 [&_p]:text-xs
          [&_code]:text-amber-300 [&_code]:text-[10px] [&_code]:bg-slate-800 [&_code]:px-1 [&_code]:rounded
          [&_a]:text-amber-400 [&_strong]:text-white
          [&_li]:text-slate-200 [&_li]:text-xs
        ">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
        <span className="inline-block w-1 h-3 bg-amber-400 animate-pulse ml-0.5 align-text-bottom" />
      </div>
    </div>
  );
});

// ─── Session History Item ─────────────────────────────────────────────────────
const SessionHistoryItem = memo(function SessionHistoryItem({
  session,
  isActive,
  onClick,
}: {
  session: ChatSession;
  isActive: boolean;
  onClick: () => void;
}) {
  const preview = session.last_message
    ? session.last_message.slice(0, 80) + (session.last_message.length > 80 ? '…' : '')
    : 'No messages';

  const date = new Date(session.last_activity);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const dateLabel = isToday
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors group ${
        isActive
          ? 'bg-amber-500/15 border border-amber-500/30'
          : 'hover:bg-slate-700/50 border border-transparent'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className={`text-xs truncate font-medium ${isActive ? 'text-amber-300' : 'text-slate-200'}`}>
            {isActive && <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 mr-1.5 mb-0.5 align-middle" />}
            {dateLabel}
          </p>
          <p className="text-[10px] text-slate-500 truncate mt-0.5 leading-tight">{preview}</p>
        </div>
        <span className="text-[9px] text-slate-600 shrink-0 mt-0.5">
          {session.message_count} msg{session.message_count !== 1 ? 's' : ''}
        </span>
      </div>
    </button>
  );
});

// ─── Main Widget ──────────────────────────────────────────────────────────────
export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [unreadHeartbeatCount, setUnreadHeartbeatCount] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  // 'chat' | 'heartbeat'
  const [activeTab, setActiveTab] = useState<'chat' | 'heartbeat'>('chat');

  // Session history (chat tab only)
  const [showHistory, setShowHistory] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [viewingSessionId, setViewingSessionId] = useState<number | null | undefined>(undefined); // undefined = current live session
  const [viewingMessages, setViewingMessages] = useState<ChatMessage[] | null>(null);
  const [viewingLoading, setViewingLoading] = useState(false);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [heartbeatMessages, setHeartbeatMessages] = useState<ChatMessage[]>([]);
  const [streamContent, setStreamContent] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [heartbeatError, setHeartbeatError] = useState<string | null>(null);
  const [heartbeatStatus, setHeartbeatStatus] = useState<AtlasHeartbeatStatus | null>(null);
  const [heartbeatLoading, setHeartbeatLoading] = useState(false);
  const [heartbeatAction, setHeartbeatAction] = useState<'compact' | 'reset' | null>(null);
  // ─── Attachments ──────────────────────────────────────────────────────────
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [chatConfig, setChatConfig] = useState<ChatConfig | null>(null);
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [atlasMainSessionKey, setAtlasMainSessionKey] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);

  const [showNewChatConfirm, setShowNewChatConfirm] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const streamBufRef = useRef('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const heartbeatEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const heartbeatContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const openRef = useRef(open);
  const activeTabRef = useRef(activeTab);
  const userScrolledUpRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastHeartbeatMessageIdRef = useRef<string | null>(null);
  const pendingResponseRef = useRef(false);
  const responseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const streaming = streamContent !== null;

  // Keep refs in sync
  useEffect(() => { openRef.current = open; }, [open]);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

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

  const focusComposer = useCallback((delay = 80) => {
    setTimeout(() => inputRef.current?.focus(), delay);
  }, []);

  const resizeComposer = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;

    el.style.height = 'auto';

    const styles = window.getComputedStyle(el);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 20;
    const padding =
      (Number.parseFloat(styles.paddingTop) || 0)
      + (Number.parseFloat(styles.paddingBottom) || 0);
    const border =
      (Number.parseFloat(styles.borderTopWidth) || 0)
      + (Number.parseFloat(styles.borderBottomWidth) || 0);
    const minHeight = 36;
    const maxHeight = Math.ceil(lineHeight * 4 + padding + border);
    const nextHeight = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);

    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeComposer();
  }, [inputText, resizeComposer]);

  const showLiveChatPanel = useCallback(() => {
    setOpen(true);
    setActiveTab('chat');
    setShowSettings(false);
    setShowHistory(false);
    setViewingSessionId(undefined);
    setViewingMessages(null);
    setViewingLoading(false);
    setUnreadCount(0);
  }, []);

  const applyAtlasWidgetCommand = useCallback((command: AtlasWidgetCommand) => {
    switch (command.type) {
      case 'open':
        showLiveChatPanel();
        return;
      case 'close':
        setOpen(false);
        setShowSettings(false);
        setShowHistory(false);
        return;
      case 'focus-input':
        showLiveChatPanel();
        focusComposer();
        return;
      case 'set-draft':
        showLiveChatPanel();
        setInputText(command.text);
        if (command.focus !== false) focusComposer();
        return;
      case 'open-chat-with-draft':
        showLiveChatPanel();
        setInputText(command.text);
        if (command.focus !== false) focusComposer();
        return;
      default:
        return;
    }
  }, [focusComposer, showLiveChatPanel]);

  useEffect(() => {
    const pending = consumePendingAtlasWidgetCommand();
    if (pending) applyAtlasWidgetCommand(pending);

    const handleCommand = (event: Event) => {
      const detail = (event as CustomEvent<AtlasWidgetCommand>).detail;
      if (!detail) return;
      applyAtlasWidgetCommand(detail);
    };

    window.addEventListener(ATLAS_WIDGET_COMMAND_EVENT, handleCommand as EventListener);
    return () => window.removeEventListener(ATLAS_WIDGET_COMMAND_EVENT, handleCommand as EventListener);
  }, [applyAtlasWidgetCommand]);

  useEffect(() => {
    emitAtlasWidgetState({
      open,
      connected,
      activeTab,
      hasSessionKey: !!sessionKey,
    });
  }, [activeTab, connected, open, sessionKey]);

  // Auto-scroll helpers
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior }), 50);
  }, []);

  const scrollHeartbeatToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    setTimeout(() => heartbeatEndRef.current?.scrollIntoView({ behavior }), 50);
  }, []);

  // Track if user has manually scrolled up
  const handleMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const threshold = 60;
    userScrolledUpRef.current = el.scrollHeight - el.scrollTop - el.clientHeight > threshold;
  }, []);

  // Scroll to bottom when widget opens or tab switches
  useEffect(() => {
    if (open) {
      userScrolledUpRef.current = false;
      if (activeTab === 'chat') scrollToBottom('auto');
      else scrollHeartbeatToBottom('auto');
    }
  }, [open, activeTab, scrollToBottom, scrollHeartbeatToBottom]);

  // Clear unread when opening appropriate tab
  useEffect(() => {
    if (open) {
      if (activeTab === 'chat') setUnreadCount(0);
      if (activeTab === 'heartbeat') setUnreadHeartbeatCount(0);
    }
  }, [open, activeTab]);

  useEffect(() => {
    if (open && activeTab === 'heartbeat') {
      scrollHeartbeatToBottom('smooth');
    }
  }, [activeTab, heartbeatMessages, open, scrollHeartbeatToBottom]);

  // ── Load chat config + find Atlas main session ──
  useEffect(() => {
    // Get chat token
    fetch('/api/chat-config', { cache: 'no-store' })
      .then(r => r.json())
      .then((data: { token: string; gatewayUrl: string }) => {
        setChatConfig({ gatewayUrl: data.gatewayUrl, token: data.token });
      })
      .catch(err => console.error('[chat-widget] config error:', err));

    // Find Atlas main session key
    api.getAgents()
      .then(agents => {
        const atlas = findAtlasAgent(agents);
        if (atlas?.session_key) {
          setAtlasMainSessionKey(atlas.session_key);
          setSessionKey(resolveInitialDirectSessionKey(
            atlas.session_key,
            getStoredDirectSessionKey(atlas.id),
            atlas.openclaw_agent_id,
          ));
          setAgentId(atlas.id);
          setSendError(null);
        } else if (agents.length > 0 && agents[0].session_key) {
          setAtlasMainSessionKey(agents[0].session_key);
          setSessionKey(resolveInitialDirectSessionKey(
            agents[0].session_key,
            getStoredDirectSessionKey(agents[0].id),
            agents[0].openclaw_agent_id,
          ));
          setAgentId(agents[0].id);
          setSendError(null);
        }
      })
      .catch(err => console.error('[chat-widget] agents error:', err));
  }, []);

  useEffect(() => {
    if (agentId && sessionKey) {
      setStoredDirectSessionKey(agentId, sessionKey);
    }
  }, [agentId, sessionKey]);

  const loadHeartbeatMonitor = useCallback(async (markUnread: boolean) => {
    if (!atlasMainSessionKey) return;

    setHeartbeatLoading(true);
    try {
      const [status, canonicalSession] = await Promise.all([
        api.getAtlasHeartbeatStatus(),
        api.getSessionByKey(atlasMainSessionKey).catch(() => null),
      ]);

      const canonicalMessages = canonicalSession && canonicalSession.message_count > 0
        ? await api.getSessionMessages(canonicalSession.id, { limit: 200 })
        : [];
      const parsedMessages = parseCanonicalMessages(canonicalMessages);
      const latestMessageId = parsedMessages.length > 0 ? parsedMessages[parsedMessages.length - 1].id : null;
      const previousMessageId = lastHeartbeatMessageIdRef.current;

      setHeartbeatStatus(status);
      setHeartbeatMessages(parsedMessages);
      setHeartbeatError(null);

      if (
        markUnread
        && latestMessageId
        && previousMessageId
        && latestMessageId !== previousMessageId
        && (!openRef.current || activeTabRef.current !== 'heartbeat')
      ) {
        setUnreadHeartbeatCount(prev => prev + 1);
      }

      lastHeartbeatMessageIdRef.current = latestMessageId;
    } catch (err) {
      setHeartbeatError(err instanceof Error ? err.message : 'Failed to load board monitor');
    } finally {
      setHeartbeatLoading(false);
    }
  }, [atlasMainSessionKey]);

  useEffect(() => {
    if (!atlasMainSessionKey) return;

    void loadHeartbeatMonitor(false);
    const timer = setInterval(() => {
      void loadHeartbeatMonitor(true);
    }, 15000);

    return () => clearInterval(timer);
  }, [atlasMainSessionKey, loadHeartbeatMonitor]);

  const runHeartbeatMaintenance = useCallback(async (action: 'compact' | 'reset') => {
    if (action === 'reset') {
      const confirmed = window.confirm('Reset Atlas heartbeat context? This clears the live gateway context for agent:atlas:main.');
      if (!confirmed) return;
    }

    setHeartbeatAction(action);
    try {
      const result = action === 'compact'
        ? await api.compactAtlasHeartbeat()
        : await api.resetAtlasHeartbeat();
      setHeartbeatStatus(result.status);
      setHeartbeatError(null);
      await loadHeartbeatMonitor(false);
    } catch (err) {
      setHeartbeatError(err instanceof Error ? err.message : `Failed to ${action} heartbeat context`);
    } finally {
      setHeartbeatAction(null);
    }
  }, [loadHeartbeatMonitor]);

  // ── Load session history when history panel opens ──
  const loadSessions = useCallback(() => {
    if (!agentId) return;
    setSessionsLoading(true);
    api.getChatSessions(agentId, 50)
      .then(data => setSessions(data))
      .catch(err => console.error('[chat-widget] sessions error:', err))
      .finally(() => setSessionsLoading(false));
  }, [agentId]);

  useEffect(() => {
    if (showHistory) loadSessions();
  }, [showHistory, loadSessions]);

  // ── Load messages for a historical session ──
  const loadHistoricalSession = useCallback((session: ChatSession) => {
    setViewingSessionId(session.instance_id);
    setViewingLoading(true);
    setViewingMessages(null);
    api.getChatSessionMessages(session.instance_id, session.session_key, 200)
      .then(msgs => setViewingMessages(parseStoredChatMessages(msgs)))
      .catch(err => {
        console.error('[chat-widget] session messages error:', err);
        setViewingMessages([]);
      })
      .finally(() => setViewingLoading(false));
    setShowHistory(false);
  }, []);

  // ── WebSocket message handler ──
  const handleWsMessage = useCallback((data: Record<string, unknown>) => {
    const type = data.type as string;

    if (type === 'chat.history') {
      const historyMsgs = (data.messages as Array<Record<string, unknown>>) || [];
      const parsed = parseGatewayHistoryMessages(historyMsgs);
      clearPendingResponse();
      setMessages(parsed);
      scrollToBottom('auto');
    } else if (type === 'chat') {
      const role = (data.role as string) || 'assistant';
      const delta = (data.delta as string) || '';
      const done = data.done as boolean;

      if (role === 'assistant') {
        if (done) {
          pendingResponseRef.current = false;
          clearResponseWatchdog();
          const finalContent = streamBufRef.current;
          streamBufRef.current = '';
          setStreamContent(null);
          if (finalContent) {
            const msg: ChatMessage = {
              id: `stream-${Date.now()}`,
              role: 'assistant',
              content: finalContent,
              timestamp: new Date().toISOString(),
            };
            setMessages(prev => [...prev, msg]);
            if (!openRef.current || activeTabRef.current !== 'chat') {
              setUnreadCount(prev => prev + 1);
            }
            if (!userScrolledUpRef.current) {
              scrollToBottom('smooth');
            }
          }
          if (wsRef.current?.readyState === WebSocket.OPEN && sessionKey) {
            wsRef.current.send(JSON.stringify({ id: generateId(), type: 'chat.history', sessionKey, limit: HISTORY_LIMIT }));
          }
        } else if (delta) {
          pendingResponseRef.current = true;
          armResponseWatchdog();
          streamBufRef.current += delta;
          setStreamContent(streamBufRef.current);
        }
      }
    } else if (type === 'chat.send') {
      pendingResponseRef.current = true;
      armResponseWatchdog();
      setSending(false);
      streamBufRef.current = '';
      setStreamContent('');
    } else if (type === 'chat.new') {
      const nextSessionKey = typeof data.sessionKey === 'string' ? data.sessionKey : null;
      if (!nextSessionKey) return;
      setShowNewChatConfirm(false);
      setMessages([]);
      clearPendingResponse();
      setSendError(null);
      userScrolledUpRef.current = false;
      setSessionKey(nextSessionKey);
    } else if (type === 'error') {
      pendingResponseRef.current = false;
      clearResponseWatchdog();
      setSendError((data.message as string) || 'Gateway error');
      setSending(false);
      streamBufRef.current = '';
      setStreamContent(null);
      if (wsRef.current?.readyState === WebSocket.OPEN && sessionKey) {
        wsRef.current.send(JSON.stringify({ id: generateId(), type: 'chat.history', sessionKey, limit: HISTORY_LIMIT }));
      }
    }
  }, [armResponseWatchdog, clearPendingResponse, clearResponseWatchdog, scrollToBottom, sessionKey]);

  // ── Connect WebSocket with auto-reconnect ──
  const connectWs = useCallback(() => {
    if (!chatConfig || !sessionKey) return;

    // Clean up existing
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
    }

    const ws = new WebSocket(chatConfig.gatewayUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setSendError(null);
      ws.send(JSON.stringify({ id: generateId(), type: 'connect', params: { auth: { token: chatConfig.token } } }));
      ws.send(JSON.stringify({ id: generateId(), type: 'chat.history', sessionKey, limit: HISTORY_LIMIT }));
    };

    ws.onmessage = (event) => {
      try {
        handleWsMessage(JSON.parse(event.data));
      } catch (err) {
        console.warn('[chat-widget] parse error:', err);
      }
    };

    ws.onerror = () => console.warn('[chat-widget] WebSocket error');
    ws.onclose = () => {
      if (pendingResponseRef.current) {
        clearPendingResponse('Connection to Atlas was interrupted before a response completed. Retry.');
      }
      setConnected(false);
      wsRef.current = null;
      console.log('[chat-widget] WebSocket closed, reconnecting in 3s…');
      reconnectTimerRef.current = setTimeout(connectWs, 3000);
    };
  }, [chatConfig, sessionKey, handleWsMessage, clearPendingResponse]);

  useEffect(() => {
    connectWs();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      clearResponseWatchdog();
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connectWs, clearResponseWatchdog]);

  // ── Attachment helpers ──
  const addFiles = useCallback((files: File[]) => {
    for (const file of files) {
      const error = validateFile(file);
      const id = generateId();
      const isImage = file.type.startsWith('image/');
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined;

      if (error) {
        // Add with error, no upload
        setPendingAttachments(prev => [...prev, { id, file, previewUrl, error }]);
        return;
      }

      // Add as uploading
      setPendingAttachments(prev => [...prev, { id, file, previewUrl, uploading: true }]);

      // Upload immediately
      api.uploadChatAttachment(file, agentId ?? undefined)
        .then(result => {
          setPendingAttachments(prev =>
            prev.map(a => a.id === id ? { ...a, uploading: false, uploadedId: result.id } : a)
          );
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Upload failed';
          setPendingAttachments(prev =>
            prev.map(a => a.id === id ? { ...a, uploading: false, error: msg } : a)
          );
        });
    }
  }, [agentId]);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments(prev => {
      const removed = prev.find(a => a.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter(a => a.id !== id);
    });
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const fileItems = items.filter(item => item.kind === 'file');
    if (fileItems.length === 0) return;
    e.preventDefault();
    const files = fileItems.map(item => item.getAsFile()).filter((f): f is File => f !== null);
    if (files.length) addFiles(files);
  }, [addFiles]);

  // Drag-drop hook
  const { onDragOver, onDrop } = useDragDrop(addFiles, true);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    onDragOver(e);
    setIsDragOver(true);
  }, [onDragOver]);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    setIsDragOver(false);
    onDrop(e);
  }, [onDrop]);

  // ── Send message ──
  const handleSend = () => {
    const hasText = inputText.trim().length > 0;
    const uploadedAttachments = pendingAttachments.filter(a => a.uploadedId && !a.error);
    const stillUploading = pendingAttachments.some(a => a.uploading);
    if ((!hasText && uploadedAttachments.length === 0) || !sessionKey || sending || streaming || stillUploading) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setSendError('Reconnecting…');
      connectWs();
      return;
    }

    const text = inputText.trim();
    const attachmentIds = uploadedAttachments.map(a => a.uploadedId as number);

    setInputText('');
    // Clear attachments — revoke preview URLs
    setPendingAttachments(prev => {
      for (const a of prev) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      return [];
    });
    setSendError(null);

    // Build display content for the user bubble
    const displayContent = [text, ...uploadedAttachments.map(a => `📎 ${a.file.name}`)].filter(Boolean).join('\n');

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: displayContent,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setSending(true);
    pendingResponseRef.current = true;
    armResponseWatchdog();
    userScrolledUpRef.current = false;
    scrollToBottom('smooth');

    ws.send(JSON.stringify({
      id: generateId(),
      type: 'chat.send',
      sessionKey,
      message: text || undefined,
      attachment_ids: attachmentIds.length > 0 ? attachmentIds : undefined,
      idempotencyKey: generateId(),
    }));
  };

  const handleAbort = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !sessionKey) return;
    ws.send(JSON.stringify({ id: generateId(), type: 'chat.abort', sessionKey }));
    clearPendingResponse();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewChat = () => {
    if (messages.length > 0) {
      setShowNewChatConfirm(true);
      return;
    }
    startNewSession();
  };

  const startNewSession = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !sessionKey) {
      setSendError('WebSocket not connected');
      setShowNewChatConfirm(false);
      return;
    }
    setShowNewChatConfirm(false);
    setPendingAttachments(prev => {
      for (const a of prev) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      return [];
    });
    setIsDragOver(false);
    setViewingSessionId(undefined);
    setViewingMessages(null);
    clearPendingResponse();
    ws.send(JSON.stringify({ id: generateId(), type: 'chat.new', sessionKey, channel: 'web' }));
  };

  const handleBackToLive = () => {
    setViewingSessionId(undefined);
    setViewingMessages(null);
    setViewingLoading(false);
    scrollToBottom('auto');
  };

  // Total unread for the floating button badge
  const totalUnread = unreadCount + unreadHeartbeatCount;

  const heartbeatStreamActive = false;
  const chatStreamActive = streaming;

  // Is the user viewing a historical session?
  const isViewingHistory = viewingSessionId !== undefined;
  const displayMessages = isViewingHistory ? (viewingMessages ?? []) : messages;

  return (
    <>
      {/* ── Chat Panel ── */}
      {open && (
        <div className="fixed bottom-36 md:bottom-24 right-4 md:right-6 w-[360px] max-w-[calc(100vw-2rem)] h-[500px] max-h-[calc(100dvh-10rem)] md:max-h-[calc(100dvh-8rem)] bg-slate-900 border border-slate-700/60 rounded-2xl shadow-2xl shadow-black/40 flex flex-col z-30 chat-widget-enter">
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-700/50 shrink-0">
            {isViewingHistory ? (
              // Historical session header
              <>
                <button
                  onClick={handleBackToLive}
                  className="w-7 h-7 rounded-lg hover:bg-slate-700/60 flex items-center justify-center transition-colors"
                  title="Back to current session"
                >
                  <ArrowLeft className="w-4 h-4 text-slate-400" />
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white">Past Session</p>
                  <p className="text-[10px] text-slate-500">Read-only view</p>
                </div>
              </>
            ) : (
              // Live session header
              <>
                <div className="w-7 h-7 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
                  <Bot className="w-3.5 h-3.5 text-amber-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white">Atlas</p>
                  <p className="text-[10px] text-slate-500">
                    {connected ? 'Connected' : 'Connecting…'}
                  </p>
                </div>
              </>
            )}

            {!isViewingHistory && activeTab === 'chat' && (
              <button
                onClick={handleNewChat}
                className="w-7 h-7 rounded-lg hover:bg-slate-700/60 flex items-center justify-center transition-colors"
                title="New chat"
              >
                <SquarePen className="w-4 h-4 text-slate-400" />
              </button>
            )}
            {!isViewingHistory && activeTab === 'chat' && (
              <button
                onClick={() => { setShowHistory(prev => !prev); setShowSettings(false); }}
                className={`w-7 h-7 rounded-lg hover:bg-slate-700/60 flex items-center justify-center transition-colors ${showHistory ? 'bg-slate-700/60' : ''}`}
                title="Session history"
              >
                <History className="w-4 h-4 text-slate-400" />
              </button>
            )}
            <button
              onClick={() => { setShowSettings(prev => !prev); setShowHistory(false); }}
              className={`w-7 h-7 rounded-lg hover:bg-slate-700/60 flex items-center justify-center transition-colors ${showSettings ? 'bg-slate-700/60' : ''}`}
              title="Settings"
            >
              <Settings className="w-4 h-4 text-slate-400" />
            </button>
            <button
              onClick={() => { setOpen(false); setShowSettings(false); setShowHistory(false); }}
              className="w-7 h-7 rounded-lg hover:bg-slate-700/60 flex items-center justify-center transition-colors"
            >
              <X className="w-4 h-4 text-slate-400" />
            </button>
          </div>

          {/* Tab bar */}
          {!showSettings && !isViewingHistory && (
            <div className="flex border-b border-slate-700/50 shrink-0">
              <button
                onClick={() => { setActiveTab('chat'); setUnreadCount(0); setShowHistory(false); }}
                className={`relative flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors flex-1 justify-center ${
                  activeTab === 'chat'
                    ? 'text-amber-400 border-b-2 border-amber-500'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                Chat
                {unreadCount > 0 && activeTab !== 'chat' && (
                  <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </button>
              <button
                onClick={() => { setActiveTab('heartbeat'); setUnreadHeartbeatCount(0); setShowHistory(false); }}
                className={`relative flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors flex-1 justify-center ${
                  activeTab === 'heartbeat'
                    ? 'text-emerald-400 border-b-2 border-emerald-500'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <Activity className="w-3 h-3" />
                Board Monitor
                {unreadHeartbeatCount > 0 && activeTab !== 'heartbeat' && (
                  <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-600 text-white text-[9px] font-bold">
                    {unreadHeartbeatCount > 9 ? '9+' : unreadHeartbeatCount}
                  </span>
                )}
              </button>
            </div>
          )}

          {/* Settings Panel */}
          {showSettings && (
            <TelegramSettings onBack={() => setShowSettings(false)} />
          )}

          {/* Session History Panel (chat tab only) */}
          {!showSettings && activeTab === 'chat' && showHistory && (
            <div className="flex-1 overflow-y-auto px-2 py-2">
              <p className="text-[10px] text-slate-500 px-2 py-1 uppercase tracking-wide font-medium">Previous sessions</p>
              {sessionsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-4 h-4 text-slate-500 animate-spin" />
                </div>
              ) : sessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 gap-2">
                  <History className="w-6 h-6 text-slate-700" />
                  <p className="text-slate-500 text-xs">No previous sessions</p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {sessions.map((session, i) => (
                    <SessionHistoryItem
                      key={`${session.instance_id ?? session.session_key}-${i}`}
                      session={session}
                      isActive={false}
                      onClick={() => loadHistoricalSession(session)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* New Chat Confirmation */}
          {showNewChatConfirm && (
            <div className="absolute inset-0 bg-slate-900/80 backdrop-blur-sm z-10 flex items-center justify-center rounded-2xl">
              <div className="bg-slate-800 border border-slate-700/60 rounded-xl p-4 mx-4 max-w-[280px] text-center">
                <p className="text-sm text-white mb-1">Start new chat?</p>
                <p className="text-xs text-slate-400 mb-4">Current conversation will be cleared.</p>
                <div className="flex gap-2 justify-center">
                  <button
                    onClick={() => setShowNewChatConfirm(false)}
                    className="px-3 py-1.5 text-xs rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={startNewSession}
                    className="px-3 py-1.5 text-xs rounded-lg bg-amber-500/20 border border-amber-500/30 text-amber-300 hover:bg-amber-500/30 transition-colors"
                  >
                    New chat
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Main Chat Tab ── */}
          {!showSettings && activeTab === 'chat' && !showHistory && (
            <div ref={messagesContainerRef} onScroll={handleMessagesScroll} className="flex-1 overflow-y-auto px-3 py-3">
              {isViewingHistory ? (
                // Historical session view
                viewingLoading ? (
                  <div className="flex items-center justify-center h-full gap-2">
                    <Loader2 className="w-4 h-4 text-slate-500 animate-spin" />
                    <p className="text-slate-500 text-xs">Loading session…</p>
                  </div>
                ) : viewingMessages && viewingMessages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
                    <History className="w-8 h-8 text-slate-700" />
                    <p className="text-slate-500 text-xs">No messages in this session</p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-700/50">
                      <p className="text-[10px] text-slate-500 text-center w-full">
                        Past session — read only
                      </p>
                    </div>
                    {displayMessages.map((msg, i) => (
                      <WidgetEventMessage key={msg.id || `hm-${i}`} msg={msg} />
                    ))}
                    <div ref={messagesEndRef} />
                  </>
                )
              ) : messages.length === 0 && !chatStreamActive ? (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
                  <Bot className="w-8 h-8 text-slate-700" />
                  <p className="text-slate-500 text-xs">Ask Atlas anything</p>
                </div>
              ) : (
                <>
                  {messages.map(msg => (
                    <WidgetEventMessage key={msg.id} msg={msg} />
                  ))}
                  {chatStreamActive && streamContent !== null && (
                    <WidgetStreamBubble content={streamContent} isHeartbeat={false} />
                  )}
                  <div ref={messagesEndRef} />
                </>
              )}
            </div>
          )}

          {/* ── Heartbeat Tab ── */}
          {!showSettings && activeTab === 'heartbeat' && (
            <div ref={heartbeatContainerRef} className="flex-1 overflow-y-auto px-3 py-3">
              {heartbeatLoading && heartbeatMessages.length === 0 ? (
                <div className="flex items-center justify-center h-full gap-2">
                  <Loader2 className="w-4 h-4 text-slate-500 animate-spin" />
                  <p className="text-slate-500 text-xs">Loading board monitor…</p>
                </div>
              ) : heartbeatMessages.length === 0 && !heartbeatStreamActive ? (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
                  <Activity className="w-8 h-8 text-slate-700" />
                  <p className="text-slate-500 text-xs">No heartbeat entries yet</p>
                  <p className="text-slate-600 text-[10px]">Board monitor pings appear here</p>
                </div>
              ) : (
                <>
                  {heartbeatMessages.map(msg => (
                    <HeartbeatBubble key={msg.id} msg={msg} />
                  ))}
                  {heartbeatStreamActive && streamContent !== null && (
                    <WidgetStreamBubble content={streamContent} isHeartbeat={true} />
                  )}
                  <div ref={heartbeatEndRef} />
                </>
              )}
            </div>
          )}

          {/* Error */}
          {!showSettings && activeTab === 'chat' && !showHistory && !isViewingHistory && sendError && (
            <div className="px-3 py-1.5 bg-red-900/20 border-t border-red-800/40 shrink-0">
              <p className="text-red-400 text-[10px]">{sendError}</p>
            </div>
          )}

          {/* Input — only on Chat tab, live session */}
          {!showSettings && activeTab === 'chat' && !showHistory && !isViewingHistory && (
            <div
              className={`border-t shrink-0 transition-colors ${isDragOver ? 'border-amber-500/60 bg-amber-500/5' : 'border-slate-700/50'}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {/* Attachment preview strip */}
              <AttachmentPreviewStrip
                attachments={pendingAttachments}
                onRemove={removeAttachment}
              />

              {/* Drag-over overlay hint */}
              {isDragOver && (
                <div className="px-3 pt-2 pb-0">
                  <p className="text-[10px] text-amber-400 text-center">Drop to attach</p>
                </div>
              )}

              <div className="px-3 py-3 flex gap-2 items-end">
                {/* Upload button */}
                <AttachmentUploadButton
                  onFiles={addFiles}
                  disabled={sending || streaming}
                />

                <textarea
                  ref={inputRef}
                  data-tour-target="atlas-widget-composer"
                  className="flex-1 bg-slate-800/60 border border-slate-700/60 rounded-lg px-3 py-2 text-xs leading-5 text-white placeholder-slate-500 resize-none focus:outline-none focus:border-amber-500/50 transition-colors"
                  placeholder={pendingAttachments.length > 0 ? 'Add a message… (optional)' : 'Message Atlas…'}
                  value={inputText}
                  onChange={e => setInputText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  rows={1}
                  style={{ minHeight: '36px' }}
                  disabled={sending}
                />
                {streaming ? (
                  <button
                    onClick={handleAbort}
                    className="shrink-0 w-9 h-9 rounded-lg bg-amber-500/20 border border-amber-500/30 flex items-center justify-center hover:bg-amber-500/30 transition-colors"
                  >
                    <Square className="w-3.5 h-3.5 text-amber-400" />
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={
                      (!inputText.trim() && pendingAttachments.filter(a => a.uploadedId && !a.error).length === 0)
                      || sending
                      || !connected
                      || pendingAttachments.some(a => a.uploading)
                    }
                    className="shrink-0 w-9 h-9 rounded-lg bg-amber-500/20 border border-amber-500/30 flex items-center justify-center hover:bg-amber-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    title={pendingAttachments.some(a => a.uploading) ? 'Uploading…' : 'Send'}
                  >
                    {sending || pendingAttachments.some(a => a.uploading) ? (
                      <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5 text-amber-400" />
                    )}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Heartbeat tab footer — read-only label */}
          {!showSettings && activeTab === 'heartbeat' && (
            <div className="px-3 py-2 border-t border-slate-700/50 shrink-0 space-y-2">
              <div className="flex items-center justify-between gap-2 text-[10px] text-slate-500">
                <span className="truncate">
                  Context: {formatTokenCount(heartbeatStatus?.input_tokens)} in / {formatTokenCount(heartbeatStatus?.output_tokens)} out
                </span>
                <span className="shrink-0">
                  {heartbeatStatus?.updated_at ? formatTime(heartbeatStatus.updated_at) : 'n/a'}
                </span>
              </div>
              {heartbeatError && (
                <p className="text-[10px] text-red-400">{heartbeatError}</p>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void runHeartbeatMaintenance('compact')}
                  disabled={heartbeatAction !== null}
                  className="flex-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[10px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {heartbeatAction === 'compact' ? 'Compacting…' : 'Compact Context'}
                </button>
                <button
                  onClick={() => void runHeartbeatMaintenance('reset')}
                  disabled={heartbeatAction !== null}
                  className="flex-1 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[10px] font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {heartbeatAction === 'reset' ? 'Resetting…' : 'Reset Context'}
                </button>
              </div>
              <p className="text-[10px] text-slate-600 text-center">Board monitor reads Atlas main session and stays separate from direct chat.</p>
            </div>
          )}
        </div>
      )}

      {/* ── Floating Button ── */}
      {!open && (
        <button
          data-tour-target="atlas-chat-bubble"
          onClick={() => setOpen(true)}
          className="fixed bottom-20 md:bottom-6 right-4 md:right-6 w-14 h-14 rounded-full bg-amber-500 hover:bg-amber-400 shadow-lg shadow-amber-500/25 flex items-center justify-center transition-all duration-200 z-30 hover:scale-105 active:scale-95"
          aria-label="Open chat"
        >
          <>
            <MessageCircle className="w-6 h-6 text-slate-900" />
            {totalUnread > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center border-2 border-slate-900">
                {totalUnread > 9 ? '9+' : totalUnread}
              </span>
            )}
            {/* Heartbeat-specific indicator dot (no main unread) */}
            {totalUnread === 0 && unreadHeartbeatCount > 0 && (
              <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-emerald-500 border-2 border-slate-900" />
            )}
          </>
        </button>
      )}
    </>
  );
}
