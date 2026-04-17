import React from 'react';

type BadgeVariant = 'queued' | 'dispatched' | 'starting' | 'running' | 'done' | 'failed' | 'idle' | 'blocked' | 'info' | 'warn' | 'error' | 'debug' | 'default' | 'workspace' | 'system' | 'stalled' | 'deployed' | 'review';

const variantClasses: Record<BadgeVariant, string> = {
  queued:     'bg-slate-700 text-slate-300',
  dispatched: 'bg-blue-900/60 text-blue-300',
  starting:   'bg-orange-900/60 text-orange-300',
  running:    'bg-amber-900/60 text-amber-300',
  done:       'bg-green-900/60 text-green-300',
  failed:     'bg-red-900/60 text-red-300',
  idle:       'bg-green-900/60 text-green-300',
  blocked:    'bg-red-900/60 text-red-300',
  info:       'bg-blue-900/60 text-blue-300',
  warn:       'bg-amber-900/60 text-amber-300',
  error:      'bg-red-900/60 text-red-300',
  debug:      'bg-slate-700 text-slate-400',
  default:    'bg-slate-700 text-slate-300',
  workspace:  'bg-violet-900/60 text-violet-300',
  system:     'bg-slate-700 text-slate-400',
  // Task outcome variants
  stalled:    'bg-orange-900/60 text-orange-300',
  deployed:   'bg-cyan-900/60 text-cyan-300',
  review:     'bg-purple-900/60 text-purple-300',
};

export function Badge({ variant = 'default', children, className }: { variant?: BadgeVariant; children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${variantClasses[variant]} ${className ?? ''}`}>
      {children}
    </span>
  );
}

export function StatusDot({ status }: { status: 'idle' | 'running' | 'blocked' }) {
  const colorClass = {
    idle: 'bg-green-400',
    running: 'bg-amber-400 animate-pulse',
    blocked: 'bg-red-400',
  }[status];

  return <span className={`inline-block w-2 h-2 rounded-full ${colorClass}`} />;
}
