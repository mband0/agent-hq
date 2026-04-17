import type { Task, TaskHistory } from './api';

export type FailureTaskLike = {
  status: string;
  failure_class?: Task['failure_class'];
  failure_detail?: string | null;
  blocker_reason?: string | null;
  qa_verified_commit?: string | null;
  qa_tested_url?: string | null;
  review_commit?: string | null;
};

export type FailureDisplay = {
  label: string;
  badge: string;
  severity: 'error' | 'warning' | 'info';
};

export type FailureRecovery = {
  recoveryStatus: string;
  autoRecoverable: boolean;
  recoveryDescription: string;
  preserveOwner: boolean;
};

export function isFailureBlocked(task: Pick<FailureTaskLike, 'status' | 'failure_class'>): boolean {
  return task.status === 'stalled' || task.failure_class === 'approval_blocked' || task.failure_class === 'env_blocked';
}

export function getFailureSourceLabel(task: Pick<FailureTaskLike, 'failure_class' | 'status'>): string | null {
  switch (task.failure_class) {
    case 'qa_failure':
      return 'QA';
    case 'release_failure':
      return 'Release';
    case 'approval_blocked':
      return 'Approval';
    case 'env_blocked':
      return 'Environment';
    case 'infra_failure':
      return 'Infrastructure';
    case 'runtime_failure':
      return 'Runtime';
    case 'unknown':
      return 'Unknown';
    default:
      if (task.status === 'stalled' || task.status === 'failed') {
        return 'Pipeline';
      }
      return null;
  }
}

export function getFailureTone(task: Pick<FailureTaskLike, 'status' | 'failure_class'>): {
  pill: string;
  panel: string;
  text: string;
} {
  if (isFailureBlocked(task)) {
    return {
      pill: 'bg-amber-900/60 text-amber-300 border border-amber-600/30',
      panel: 'border-amber-500/30 bg-amber-950/20',
      text: 'text-amber-200',
    };
  }

  return {
    pill: 'bg-red-900/60 text-red-300 border border-red-600/30',
    panel: 'border-red-500/30 bg-red-950/20',
    text: 'text-red-200',
  };
}

export function getFailureSummary(task: Pick<FailureTaskLike, 'failure_detail' | 'blocker_reason'>): string | null {
  return task.failure_detail || task.blocker_reason || null;
}

export function hadQaPassBeforeFailure(task: Pick<FailureTaskLike, 'qa_verified_commit' | 'qa_tested_url' | 'review_commit' | 'failure_class' | 'status'>): boolean {
  return Boolean(
    task.qa_verified_commit
    && task.qa_tested_url
    && task.review_commit
    && task.failure_class
    && task.failure_class !== 'qa_failure'
    && task.status !== 'review'
  );
}

export function getFailureActor(history: TaskHistory[]): string | null {
  for (const entry of history) {
    if (entry.field === 'failure_class' || entry.field === 'status') {
      return entry.changed_by;
    }
  }
  return null;
}
