/**
 * Canonical failure classification system for workflow exits.
 *
 * Task #95 establishes a lane-aware failure taxonomy so Atlas HQ can tell
 * apart genuine QA defects, release blockers, approval gates, environment
 * drift, and runtime/infra issues without collapsing everything into a
 * generic "failed" bucket.
 */

export const FAILURE_CLASSES = [
  'qa_failure',
  'release_failure',
  'approval_blocked',
  'env_blocked',
  'infra_failure',
  'runtime_failure',
  'unknown',
] as const;

export type FailureClass = typeof FAILURE_CLASSES[number];
export type FailureLane = 'implementation' | 'qa' | 'release' | 'system';

export function isValidFailureClass(value: unknown): value is FailureClass {
  return typeof value === 'string' && FAILURE_CLASSES.includes(value as FailureClass);
}

export interface RecoverySpec {
  recoveryStatus: string;
  autoRecoverable: boolean;
  recoveryDescription: string;
  preserveOwner: boolean;
}

const RECOVERY_MAP: Record<FailureClass, RecoverySpec> = {
  qa_failure: {
    recoveryStatus: 'ready',
    autoRecoverable: true,
    recoveryDescription: 'QA defect, return to implementation for another pass',
    preserveOwner: true,
  },
  release_failure: {
    recoveryStatus: 'ready',
    autoRecoverable: true,
    recoveryDescription: 'Post-QA release blocker, return to implementation/release remediation without mislabeling as QA',
    preserveOwner: true,
  },
  approval_blocked: {
    recoveryStatus: 'stalled',
    autoRecoverable: false,
    recoveryDescription: 'Waiting on human approval or external go-ahead, keep task blocked until unblocked',
    preserveOwner: true,
  },
  env_blocked: {
    recoveryStatus: 'stalled',
    autoRecoverable: false,
    recoveryDescription: 'Environment or access blocker, keep task blocked until the environment is fixed',
    preserveOwner: true,
  },
  infra_failure: {
    recoveryStatus: 'failed',
    autoRecoverable: false,
    recoveryDescription: 'Infrastructure or platform failure, requires operational intervention',
    preserveOwner: false,
  },
  runtime_failure: {
    recoveryStatus: 'failed',
    autoRecoverable: false,
    recoveryDescription: 'Runtime/lifecycle failure, requires task or execution triage',
    preserveOwner: false,
  },
  unknown: {
    recoveryStatus: 'failed',
    autoRecoverable: false,
    recoveryDescription: 'Unclassified failure, requires manual triage',
    preserveOwner: true,
  },
};

export function getRecoverySpec(failureClass: FailureClass): RecoverySpec {
  return RECOVERY_MAP[failureClass];
}

export function isCodeFailure(failureClass: FailureClass): boolean {
  return failureClass === 'qa_failure' || failureClass === 'release_failure';
}

export function inferFailureClass(context: {
  outcome: string;
  summary?: string | null;
  fromStatus?: string;
  error?: string | null;
}): FailureClass {
  const combined = `${(context.summary ?? '').toLowerCase()} ${(context.error ?? '').toLowerCase()}`;

  if (context.outcome === 'qa_fail') return 'qa_failure';

  if (combined.includes('approval') || combined.includes('waiting on user') || combined.includes('waiting for signoff') || combined.includes('needs approval')) {
    return 'approval_blocked';
  }

  if (
    combined.includes('env')
    || combined.includes('environment')
    || combined.includes('ssh key')
    || combined.includes('access')
    || combined.includes('credential')
    || combined.includes('npm')
    || combined.includes('build fail')
    || combined.includes('worktree')
  ) {
    return context.outcome === 'blocked' ? 'env_blocked' : 'runtime_failure';
  }

  if (combined.includes('deploy') || combined.includes('merge conflict') || combined.includes('release') || combined.includes('cherry-pick')) {
    return 'release_failure';
  }

  if (combined.includes('infra') || combined.includes('database down') || combined.includes('gateway') || combined.includes('pm2') || combined.includes('service unavailable')) {
    return 'infra_failure';
  }

  if (combined.includes('runtime') || combined.includes('contract') || combined.includes('not authoritative') || combined.includes('timeout') || combined.includes('timed out')) {
    return 'runtime_failure';
  }

  if (context.fromStatus === 'review' || context.outcome === 'qa_fail') return 'qa_failure';
  if (context.fromStatus === 'qa_pass' || context.fromStatus === 'ready_to_merge' || context.fromStatus === 'deployed') return 'release_failure';
  if (context.outcome === 'blocked') return 'env_blocked';

  return 'unknown';
}

export function inferFailureLane(fromStatus?: string | null): FailureLane {
  if (fromStatus === 'in_progress') return 'implementation';
  if (fromStatus === 'review' || fromStatus === 'qa_pass') return 'qa';
  if (fromStatus === 'ready_to_merge' || fromStatus === 'deployed') return 'release';
  return 'system';
}

export function isBlockedFailureClass(failureClass: FailureClass): boolean {
  return failureClass === 'approval_blocked' || failureClass === 'env_blocked';
}

export function isFailedFailureClass(failureClass: FailureClass): boolean {
  return !isBlockedFailureClass(failureClass);
}

const LANE_FAILURE_CLASS_RULES: Record<FailureLane, FailureClass[]> = {
  implementation: ['approval_blocked', 'env_blocked', 'infra_failure', 'runtime_failure', 'unknown'],
  qa: ['qa_failure', 'approval_blocked', 'env_blocked', 'infra_failure', 'runtime_failure', 'unknown'],
  release: ['release_failure', 'approval_blocked', 'env_blocked', 'infra_failure', 'runtime_failure', 'unknown'],
  system: ['approval_blocked', 'env_blocked', 'infra_failure', 'runtime_failure', 'unknown'],
};

export function isFailureClassAllowedForLane(failureClass: FailureClass, lane: FailureLane): boolean {
  return LANE_FAILURE_CLASS_RULES[lane].includes(failureClass);
}

export interface FailureClassDisplay {
  label: string;
  badge: string;
  severity: 'error' | 'warning' | 'info';
}

const DISPLAY_MAP: Record<FailureClass, FailureClassDisplay> = {
  qa_failure:       { label: 'QA Failure',         badge: '🟠 QA',       severity: 'error' },
  release_failure:  { label: 'Release Failure',    badge: '🟠 Release',  severity: 'error' },
  approval_blocked: { label: 'Approval Blocked',   badge: '🟡 Approval', severity: 'warning' },
  env_blocked:      { label: 'Environment Blocked',badge: '🟡 Env',      severity: 'warning' },
  infra_failure:    { label: 'Infrastructure Failure', badge: '🔴 Infra', severity: 'error' },
  runtime_failure:  { label: 'Runtime Failure',    badge: '🔴 Runtime',  severity: 'error' },
  unknown:          { label: 'Unknown Failure',    badge: '⚪ Unknown',  severity: 'info' },
};

export function getFailureClassDisplay(failureClass: FailureClass): FailureClassDisplay {
  return DISPLAY_MAP[failureClass];
}

export function getAllFailureClasses(): Array<{ value: FailureClass } & FailureClassDisplay & RecoverySpec> {
  return FAILURE_CLASSES.map(fc => ({
    value: fc,
    ...DISPLAY_MAP[fc],
    ...RECOVERY_MAP[fc],
  }));
}
