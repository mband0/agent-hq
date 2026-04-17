/**
 * Evidence validation helpers for atomic task lifecycle writes (Task #630).
 *
 * Provides strict validation for review, QA, and deploy evidence payloads
 * to ensure coherence, reject partial/blank submissions, and validate
 * field formats (SHA hashes, URLs, timestamps).
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReviewEvidence {
  review_branch?: string | null;
  review_commit?: string | null;
  review_url?: string | null;
}

export interface QaEvidence {
  qa_verified_commit?: string | null;
  qa_tested_url?: string | null;
}

export interface DeployEvidence {
  merged_commit?: string | null;
  deployed_commit?: string | null;
  deploy_target?: string | null;
  deployed_at?: string | null;
}

export interface LiveVerificationEvidence {
  live_verified_by?: string | null;
  live_verified_at?: string | null;
  deployed_commit?: string | null;
}

export interface InlineEvidence extends ReviewEvidence, QaEvidence, DeployEvidence, LiveVerificationEvidence {}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ── Validators ───────────────────────────────────────────────────────────────

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const PLACEHOLDER_VALUES = new Set(['—', '-', 'n/a', 'na', 'none', 'null', 'undefined', 'tbd', 'todo', 'pending']);

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidSha(value: unknown): boolean {
  return typeof value === 'string' && SHA_PATTERN.test(value.trim());
}

function isValidUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

function isValidIsoTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

function normalizedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlaceholderValue(value: unknown): boolean {
  const normalized = normalizedString(value).toLowerCase();
  return normalized.length === 0 || PLACEHOLDER_VALUES.has(normalized);
}

function isMainlineBranch(branch: string | null | undefined): boolean {
  const normalized = normalizedString(branch).toLowerCase();
  return normalized === 'main' || normalized === 'master';
}

function isProductionLikeUrl(url: string | null | undefined): boolean {
  const normalized = normalizedString(url).toLowerCase();
  if (!normalized) return false;
  return normalized.includes('prod')
    || normalized.includes('production')
    || normalized.includes('app.')
    || normalized.includes('www.')
    || normalized.includes('://app.')
    || normalized.includes('://www.');
}

// ── Review evidence validation ───────────────────────────────────────────────

export function validateReviewEvidence(ev: ReviewEvidence): ValidationResult {
  const errors: string[] = [];
  const hasBranch = isNonEmpty(ev.review_branch);
  const hasCommit = isNonEmpty(ev.review_commit);
  const hasUrl = isNonEmpty(ev.review_url);

  // At minimum, branch and commit are required together
  if (!hasBranch && !hasCommit && !hasUrl) {
    errors.push('Review evidence requires at least review_branch and review_commit');
    return { valid: false, errors };
  }

  if (!hasBranch) {
    errors.push('review_branch is required when submitting review evidence');
  }
  if (!hasCommit) {
    errors.push('review_commit is required when submitting review evidence');
  }

  // Format validation
  if (hasCommit && !isValidSha(ev.review_commit)) {
    errors.push(`review_commit must be a valid git SHA (7-40 hex chars), got: "${ev.review_commit}"`);
  }

  return { valid: errors.length === 0, errors };
}

// ── QA evidence validation ───────────────────────────────────────────────────

export function validateQaEvidence(ev: QaEvidence, existingReviewCommit?: string | null): ValidationResult {
  const errors: string[] = [];
  const hasCommit = isNonEmpty(ev.qa_verified_commit);
  const hasUrl = isNonEmpty(ev.qa_tested_url);

  if (!hasCommit && !hasUrl) {
    errors.push('QA evidence requires at least qa_verified_commit');
    return { valid: false, errors };
  }

  if (!hasCommit) {
    errors.push('qa_verified_commit is required when submitting QA evidence');
  }

  // Format validation
  if (hasCommit && !isValidSha(ev.qa_verified_commit)) {
    errors.push(`qa_verified_commit must be a valid git SHA (7-40 hex chars), got: "${ev.qa_verified_commit}"`);
  }

  // Coherence: QA commit should match review commit when review commit is known
  if (hasCommit && isNonEmpty(existingReviewCommit)) {
    if (ev.qa_verified_commit!.trim() !== existingReviewCommit!.trim()) {
      errors.push(
        `qa_verified_commit ("${ev.qa_verified_commit}") does not match review_commit ("${existingReviewCommit}"). ` +
        `QA must verify the same commit that was reviewed.`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Deploy evidence validation ───────────────────────────────────────────────

export function validateDeployEvidence(ev: DeployEvidence): ValidationResult {
  const errors: string[] = [];
  const hasMerged = isNonEmpty(ev.merged_commit);
  const hasDeployed = isNonEmpty(ev.deployed_commit);
  const hasTarget = isNonEmpty(ev.deploy_target);
  const hasTimestamp = isNonEmpty(ev.deployed_at);

  if (!hasMerged && !hasDeployed) {
    errors.push('Deploy evidence requires at least merged_commit or deployed_commit');
  }
  if (!hasTarget) {
    errors.push('deploy_target is required when submitting deploy evidence');
  }
  if (!hasTimestamp) {
    errors.push('deployed_at is required when submitting deploy evidence');
  }

  // Format validation
  if (hasMerged && !isValidSha(ev.merged_commit)) {
    errors.push(`merged_commit must be a valid git SHA (7-40 hex chars), got: "${ev.merged_commit}"`);
  }
  if (hasDeployed && !isValidSha(ev.deployed_commit)) {
    errors.push(`deployed_commit must be a valid git SHA (7-40 hex chars), got: "${ev.deployed_commit}"`);
  }
  if (hasTimestamp && !isValidIsoTimestamp(ev.deployed_at)) {
    errors.push(`deployed_at must be a valid ISO timestamp, got: "${ev.deployed_at}"`);
  }

  return { valid: errors.length === 0, errors };
}

// ── Outcome-specific inline evidence validation ──────────────────────────────

/**
 * Validate inline evidence for a given outcome. Returns errors if the evidence
 * is insufficient or incoherent for the requested outcome.
 *
 * This is the main entry point for atomic outcome+evidence writes.
 * It checks that the caller has provided everything needed for the transition
 * in a single coherent payload.
 */
export function validateInlineEvidenceForOutcome(
  outcome: string,
  evidence: InlineEvidence,
  taskRecord: {
    review_branch?: string | null;
    review_commit?: string | null;
    review_url?: string | null;
    qa_verified_commit?: string | null;
    qa_tested_url?: string | null;
    task_type?: string | null;
  },
): ValidationResult {
  const errors: string[] = [];

  // PM tasks are exempt from implementation evidence requirements
  const exemptTypes = ['ops', 'adhoc', 'pm_analysis', 'pm_operational'];
  const isExempt = exemptTypes.includes(taskRecord.task_type ?? '');

  if (outcome === 'completed_for_review' && !isExempt) {
    // Merge incoming evidence with existing task record
    const effectiveBranch = evidence.review_branch ?? taskRecord.review_branch;
    const effectiveCommit = evidence.review_commit ?? taskRecord.review_commit;
    const effectiveUrl = evidence.review_url ?? taskRecord.review_url;

    if (!isNonEmpty(effectiveBranch)) {
      errors.push('completed_for_review requires review_branch (provide inline or record beforehand)');
    }
    if (!isNonEmpty(effectiveCommit)) {
      errors.push('completed_for_review requires review_commit (provide inline or record beforehand)');
    }
    if (isPlaceholderValue(effectiveBranch)) {
      errors.push('completed_for_review requires review_branch, blank placeholder values are not allowed');
    } else if (isMainlineBranch(effectiveBranch)) {
      errors.push('completed_for_review requires review_branch to be a feature branch, not main/master');
    }
    if (isPlaceholderValue(effectiveCommit)) {
      errors.push('completed_for_review requires review_commit, blank placeholder values are not allowed');
    }
    if (isPlaceholderValue(effectiveUrl)) {
      errors.push('completed_for_review requires review_url, blank placeholder values are not allowed');
    } else if (!isValidUrl(effectiveUrl)) {
      errors.push('completed_for_review requires valid review_url');
    } else if (isProductionLikeUrl(effectiveUrl)) {
      errors.push('completed_for_review requires review_url to reference a non-production review artifact');
    }

    // Validate formats on inline-provided fields
    if (isNonEmpty(evidence.review_commit) && !isValidSha(evidence.review_commit)) {
      errors.push(`review_commit must be a valid git SHA (7-40 hex chars), got: "${evidence.review_commit}"`);
    }
  }

  if (outcome === 'qa_pass') {
    const effectiveQaCommit = evidence.qa_verified_commit ?? taskRecord.qa_verified_commit;
    const effectiveReviewCommit = evidence.review_commit ?? taskRecord.review_commit;
    const effectiveQaUrl = evidence.qa_tested_url ?? taskRecord.qa_tested_url;

    if (!isNonEmpty(effectiveQaCommit)) {
      errors.push('qa_pass requires qa_verified_commit (provide inline or record beforehand)');
    }
    if (isPlaceholderValue(effectiveQaCommit)) {
      errors.push('qa_pass requires qa_verified_commit, blank placeholder values are not allowed');
    }
    if (isPlaceholderValue(effectiveQaUrl)) {
      errors.push('qa_pass requires qa_tested_url, blank placeholder values are not allowed');
    } else if (!isValidUrl(effectiveQaUrl)) {
      errors.push('qa_pass requires valid qa_tested_url');
    } else if (isProductionLikeUrl(effectiveQaUrl)) {
      errors.push('qa_pass requires qa_tested_url to reference a non-production QA artifact');
    }

    if (isNonEmpty(evidence.qa_verified_commit) && !isValidSha(evidence.qa_verified_commit)) {
      errors.push(`qa_verified_commit must be a valid git SHA (7-40 hex chars), got: "${evidence.qa_verified_commit}"`);
    }

    // Coherence check: qa commit must match review commit
    if (isNonEmpty(effectiveQaCommit) && isNonEmpty(effectiveReviewCommit)) {
      if (effectiveQaCommit!.trim() !== effectiveReviewCommit!.trim()) {
        errors.push(
          `qa_verified_commit ("${effectiveQaCommit}") does not match review_commit ("${effectiveReviewCommit}"). ` +
          `QA must verify the same commit that was reviewed.`
        );
      }
    }
  }

  if (outcome === 'deployed_live') {
    const effectiveMerged = evidence.merged_commit;
    const effectiveDeployed = evidence.deployed_commit;
    const effectiveTarget = evidence.deploy_target;
    const effectiveTimestamp = evidence.deployed_at;

    // These are typically not pre-recorded, so they should be inline
    if (!isNonEmpty(effectiveMerged) && !isNonEmpty(effectiveDeployed)) {
      errors.push('deployed_live requires at least merged_commit or deployed_commit');
    }

    if (isNonEmpty(effectiveMerged) && !isValidSha(effectiveMerged)) {
      errors.push(`merged_commit must be a valid git SHA, got: "${effectiveMerged}"`);
    }
    if (isNonEmpty(effectiveDeployed) && !isValidSha(effectiveDeployed)) {
      errors.push(`deployed_commit must be a valid git SHA, got: "${effectiveDeployed}"`);
    }
  }

  if (outcome === 'live_verified') {
    if (!isNonEmpty(evidence.live_verified_by)) {
      errors.push('live_verified requires live_verified_by');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Extract evidence fields from a request body, returning only the fields
 * that are explicitly provided (not undefined).
 */
export function extractInlineEvidence(body: Record<string, unknown>): InlineEvidence {
  const fields: (keyof InlineEvidence)[] = [
    'review_branch', 'review_commit', 'review_url',
    'qa_verified_commit', 'qa_tested_url',
    'merged_commit', 'deployed_commit', 'deploy_target', 'deployed_at',
    'live_verified_by', 'live_verified_at',
  ];

  const result: InlineEvidence = {};
  for (const field of fields) {
    if (field in body) {
      (result as Record<string, unknown>)[field] = body[field] as string | null;
    }
  }
  return result;
}

/**
 * Returns true if the evidence object has at least one non-empty field.
 */
export function hasAnyEvidence(ev: InlineEvidence): boolean {
  return Object.values(ev).some(v => isNonEmpty(v));
}
