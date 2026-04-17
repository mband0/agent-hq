'use client';

import { memo, useState } from 'react';
import { ChatMessage } from '@/lib/api';
import { Brain, Wrench, Terminal, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react';

// ─── Thought bubble — collapsible italic muted block ─────────────────────────
export const ThoughtBubble = memo(function ThoughtBubble({ msg }: { msg: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex justify-start mb-2">
      <div className="max-w-[80%] w-full">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-400 transition-colors py-1 group"
        >
          <Brain className="w-3.5 h-3.5 text-purple-400/70" />
          <span className="italic">Thinking…</span>
          {expanded ? (
            <ChevronDown className="w-3 h-3 text-slate-600 group-hover:text-slate-400" />
          ) : (
            <ChevronRight className="w-3 h-3 text-slate-600 group-hover:text-slate-400" />
          )}
        </button>
        {expanded && (
          <div className="ml-5.5 pl-3 border-l-2 border-purple-500/20 mt-1 mb-1">
            <p className="text-xs text-slate-500 italic whitespace-pre-wrap leading-relaxed">
              {msg.content}
            </p>
          </div>
        )}
      </div>
    </div>
  );
});

// ─── Tool call bubble — card with name + collapsible args ────────────────────
export const ToolCallBubble = memo(function ToolCallBubble({ msg }: { msg: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = (msg.meta?.name as string) || msg.content || 'unknown tool';
  const args = msg.meta?.args;
  const hasArgs = !!(args && typeof args === 'object' && Object.keys(args as object).length > 0);

  return (
    <div className="flex justify-start mb-2">
      <div className="max-w-[80%] w-full bg-slate-800/50 border border-slate-700/50 rounded-lg overflow-hidden">
        <button
          onClick={() => hasArgs && setExpanded(!expanded)}
          className={`w-full flex items-center gap-2 px-3 py-2 text-xs ${hasArgs ? 'hover:bg-slate-700/30 cursor-pointer' : 'cursor-default'} transition-colors`}
        >
          <Wrench className="w-3.5 h-3.5 text-blue-400 shrink-0" />
          <span className="text-blue-300 font-medium font-mono">{toolName}</span>
          {hasArgs && (
            expanded ? (
              <ChevronDown className="w-3 h-3 text-slate-600 ml-auto" />
            ) : (
              <ChevronRight className="w-3 h-3 text-slate-600 ml-auto" />
            )
          )}
        </button>
        {expanded && hasArgs && (
          <div className="border-t border-slate-700/40 px-3 py-2">
            <pre className="text-xs text-slate-400 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed">
              {JSON.stringify(args, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
});

// ─── Tool result bubble — card with name + truncated output (expandable) ─────
export const ToolResultBubble = memo(function ToolResultBubble({ msg }: { msg: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = (msg.meta?.name as string) || 'tool';
  const output = msg.content || (msg.meta?.output as string) || '';
  const truncateAt = 200;
  const needsTruncation = output.length > truncateAt;
  const displayOutput = expanded || !needsTruncation ? output : output.slice(0, truncateAt) + '…';

  return (
    <div className="flex justify-start mb-2">
      <div className="max-w-[80%] w-full bg-slate-800/50 border border-slate-700/50 rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2">
          <Terminal className="w-3.5 h-3.5 text-green-400 shrink-0" />
          <span className="text-green-300 text-xs font-medium font-mono">{toolName}</span>
          <span className="text-slate-600 text-xs ml-auto">result</span>
        </div>
        {output && (
          <div className="border-t border-slate-700/40 px-3 py-2">
            <pre className="text-xs text-slate-400 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed">
              {displayOutput}
            </pre>
            {needsTruncation && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-xs text-slate-500 hover:text-slate-400 mt-1 transition-colors"
              >
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// ─── Turn start — slim divider ───────────────────────────────────────────────
export const TurnStartDivider = memo(function TurnStartDivider({ msg }: { msg: ChatMessage }) {
  const turn = (msg.meta?.turn as number) ?? '?';
  const maxTurns = msg.meta?.max_turns as number | undefined;

  return (
    <div className="flex items-center gap-3 my-3">
      <div className="flex-1 h-px bg-slate-700/50" />
      <span className="text-xs text-slate-600 font-medium">
        Turn {turn}{maxTurns ? ` / ${maxTurns}` : ''}
      </span>
      <div className="flex-1 h-px bg-slate-700/50" />
    </div>
  );
});

// ─── Error bubble — red-tinted ───────────────────────────────────────────────
export const ErrorBubble = memo(function ErrorBubble({ msg }: { msg: ChatMessage }) {
  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[75%] rounded-2xl px-4 py-2.5 text-sm bg-red-900/20 border border-red-800/40 text-red-300 rounded-tl-sm">
        <div className="flex items-center gap-2 mb-1">
          <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
          <span className="text-xs font-medium text-red-400">Error</span>
        </div>
        <p className="whitespace-pre-wrap break-words text-red-300/80">{msg.content}</p>
      </div>
    </div>
  );
});
