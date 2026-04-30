const LEGACY_OUTCOME_META: Record<string, { label: string; description: string; badge_variant?: string | null }> = {
  completed_for_review: { label: 'Ready for Review', description: 'Implementation is ready for QA/review', badge_variant: 'review' },
  qa_pass: { label: 'QA Pass', description: 'QA passed; move the task forward', badge_variant: 'done' },
  qa_fail: { label: 'QA Fail', description: 'QA failed; return the task to the dev queue', badge_variant: 'failed' },
  approved_for_merge: { label: 'Approved for Merge', description: 'Work is complete and can move to ready_to_merge', badge_variant: 'review' },
  deployed_live: { label: 'Deployed', description: 'Merge/deploy completed and the task should move to deployed', badge_variant: 'deployed' },
  live_verified: { label: 'Live Verified', description: 'Deployed work was verified live and can move to done', badge_variant: 'done' },
  blocked: { label: 'Blocked', description: 'Cannot proceed because of an external blocker', badge_variant: 'stalled' },
  failed: { label: 'Failed', description: 'The run itself failed', badge_variant: 'failed' },
  retry: { label: 'Retry', description: 'Retry the stalled task from ready', badge_variant: 'queued' },
};

export function getTaskOutcomeMeta(outcomeKey: string) {
  return LEGACY_OUTCOME_META[outcomeKey] ?? {
    label: outcomeKey,
    description: `Apply outcome ${outcomeKey}`,
    badge_variant: null,
  };
}
