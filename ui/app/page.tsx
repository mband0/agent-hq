'use client';
import { formatDateTime, formatDate, formatTime, timeAgo } from '@/lib/date';

import { useEffect, useState } from 'react';
import { api, DashboardStats, CompletedRecentTask, JobInstance } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Bot, Briefcase, CheckCircle2, XCircle, Clock, Activity, Coins } from 'lucide-react';
import Link from 'next/link';

function StatCard({
  label,
  value,
  icon: Icon,
  color = 'text-slate-300',
  subtext,
}: {
  label: string;
  value: number | string;
  icon: React.ElementType;
  color?: string;
  subtext?: string;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-slate-400 text-sm mb-1">{label}</p>
          <p className={`text-3xl font-bold ${color}`}>{value}</p>
          {subtext && <p className="text-slate-500 text-xs mt-1">{subtext}</p>}
        </div>
        <div className="p-2 bg-slate-700/50 rounded-lg">
          <Icon className={`w-5 h-5 ${color}`} />
        </div>
      </div>
    </Card>
  );
}

function outcomeBadgeVariant(outcome: string | null): 'default' | 'failed' | 'review' | 'done' | 'deployed' {
  if (!outcome) return 'done';
  if (outcome === 'live_verified') return 'done';
  if (outcome === 'qa_pass') return 'review';
  if (outcome === 'completed_for_review') return 'review';
  if (outcome === 'deployed_live') return 'deployed';
  if (outcome === 'failed') return 'failed';
  return 'done';
}

function CompletedTaskRow({ task }: { task: CompletedRecentTask }) {
  const completionTime = task.live_verified_at ?? task.completed_at ?? task.updated_at;
  const outcome = task.outcome ?? 'live_verified';
  const agentDisplay = task.agent_name ?? task.live_verified_by ?? '—';

  return (
    <div className="flex items-center justify-between py-3 border-b border-slate-700/50 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white truncate">{task.title}</p>
        <p className="text-xs text-slate-500">
          {agentDisplay}
          {task.project_name ? ` · ${task.project_name}` : ''}
        </p>
      </div>
      <div className="flex items-center gap-3 ml-4">
        <Badge variant={outcomeBadgeVariant(outcome)}>
          {outcome.replace(/_/g, ' ')}
        </Badge>
        <span className="text-xs text-slate-500 whitespace-nowrap">
          {timeAgo(completionTime)}
        </span>
        <Link href={`/tasks/${task.id}`} className="text-xs text-amber-400 hover:underline whitespace-nowrap">
          View
        </Link>
      </div>
    </div>
  );
}

function FailedJobRow({ instance }: { instance: JobInstance }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-slate-700/50 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white truncate">{instance.job_title ?? `Agent run #${instance.template_id}`}</p>
        <p className="text-xs text-slate-500">{instance.agent_name ?? `Agent #${instance.agent_id}`}</p>
      </div>
      <div className="flex items-center gap-3 ml-4">
        <Badge variant="failed">failed</Badge>
        <span className="text-xs text-slate-500">
          {formatTime(instance.created_at)}
        </span>
        <Link href={`/chat?agentId=${instance.agent_id}&instanceId=${instance.id}`} className="text-xs text-amber-400 hover:underline">
          View
        </Link>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [completedRecent, setCompletedRecent] = useState<CompletedRecentTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState<string | null>(null);

  useEffect(() => {
    try {
      const name = localStorage.getItem('agent-hq-user-name');
      if (name && name.trim()) setUserName(name.trim());
    } catch {}
  }, []);

  useEffect(() => {
    Promise.all([
      api.getStats(),
      api.getCompletedRecent(24),
    ])
      .then(([s, cr]) => {
        setStats(s);
        setCompletedRecent(cr.tasks);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">
        <p className="font-semibold mb-1">Could not load dashboard</p>
        <p className="text-sm">{error}</p>
        <p className="text-xs mt-2 text-red-400">Make sure the API is reachable and the UI is pointed at the correct API base.</p>
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">
          {userName ? `Welcome back, ${userName}` : 'Dashboard'}
        </h1>
        <p className="text-slate-400 text-sm mt-1">Agent HQ — Agent Control Center</p>
      </div>

      {/* Empty board tip */}
      {stats.activeJobs === 0 && stats.recentRuns === 0 && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-5 flex items-center gap-3">
          <div className="p-2 bg-amber-400/10 rounded-lg">
            <Activity className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <p className="text-sm text-white font-medium">No active tasks</p>
            <p className="text-xs text-slate-400 mt-0.5">
              Head to the{' '}
              <Link href="/tasks" className="text-amber-400 hover:underline">Tasks Board</Link>
              {' '}to create one and get started.
            </p>
          </div>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4" data-tour-target="dashboard-overview">
        <StatCard
          label="Total Agents"
          value={stats.totalAgents}
          icon={Bot}
          color="text-blue-400"
        />
        <StatCard
          label="Active Runs"
          value={stats.activeJobs}
          icon={Activity}
          color="text-amber-400"
          subtext="queued + running"
        />
        <StatCard
          label="Enabled Templates"
          value={stats.enabledTemplates}
          icon={Briefcase}
          color="text-violet-400"
        />
        <StatCard
          label="Runs Today"
          value={stats.recentRuns}
          icon={Clock}
          color="text-slate-300"
          subtext="last 24 hours"
        />
        <StatCard
          label="Completed Today"
          value={stats.doneRecent}
          icon={CheckCircle2}
          color="text-green-400"
          subtext="last 24 hours"
        />
        <StatCard
          label="Tokens Today"
          value={stats.todayTokenUsage.toLocaleString()}
          icon={Coins}
          color="text-cyan-400"
          subtext="sum of tracked agent-run tokens"
        />
        <StatCard
          label="Failed Today"
          value={stats.failedRecent}
          icon={XCircle}
          color={stats.failedRecent > 0 ? 'text-red-400' : 'text-slate-500'}
          subtext="last 24 hours"
        />
      </div>

      {/* Failed runs */}
      {stats.failedRecent > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <XCircle className="w-4 h-4 text-red-400" />
            <h2 className="text-sm font-semibold text-white">Recent Failures (24h)</h2>
          </div>
          <div>
            {stats.recentFailed.map(instance => (
              <FailedJobRow key={instance.id} instance={instance} />
            ))}
          </div>
        </Card>
      )}

      {/* Completed tasks in last 24h */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <CheckCircle2 className="w-4 h-4 text-green-400" />
          <h2 className="text-sm font-semibold text-white">Completed in the Last 24 Hours</h2>
          {completedRecent.length > 0 && (
            <span className="ml-auto text-xs text-slate-500">{completedRecent.length} task{completedRecent.length !== 1 ? 's' : ''}</span>
          )}
        </div>
        {completedRecent.length === 0 ? (
          <p className="text-sm text-slate-500">No tasks completed in the last 24 hours.</p>
        ) : (
          <div>
            {completedRecent.map(task => (
              <CompletedTaskRow key={task.id} task={task} />
            ))}
          </div>
        )}
      </Card>

      {/* Quick links */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { href: '/agents', label: 'Manage Agents', desc: 'Register + edit agents' },
          { href: '/tasks', label: 'Tasks Board', desc: 'Plan + track work' },
          { href: '/capabilities', label: 'Capabilities', desc: 'Skills + tools' },
          { href: '/logs', label: 'Execution Logs', desc: 'Debug + audit' },
        ].map(({ href, label, desc }) => (
          <Link key={href} href={href}>
            <Card className="hover:border-slate-600 hover:bg-slate-800 transition-colors cursor-pointer h-full">
              <p className="font-medium text-white text-sm">{label}</p>
              <p className="text-slate-500 text-xs mt-1">{desc}</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
