/**
 * runtimes/skillMaterialization.ts — Runtime-aware skill materialization layer.
 *
 * Task #644: Atlas HQ maintains skill assignments as first-class records in its
 * own model. This module is responsible for projecting those assignments into
 * the correct runtime-specific artifacts — without making the runtime files
 * the source of truth.
 *
 * # Architecture
 *
 * Atlas owns the canonical skill records (the `skills` table) and the
 * assignment relationship (`agents.skill_names` / `job_templates.skill_names`).
 * Runtime artifacts — copied skill dirs, symlinks, runtime orientation files, prompt injections — are
 * **derived** and must be regenerated whenever the assignment changes.
 *
 * Each runtime implements a `SkillMaterializationAdapter`:
 *
 *   materialize(context)  — create/update runtime artifacts for the assigned skills
 *   cleanup(context)      — remove runtime artifacts for skills that were removed
 *
 * The adapters are chosen by `getSkillMaterializationAdapter(runtimeType)`.
 *
 * # Current adapters
 *
 *   openclaw     → OpenClawSkillAdapter   — copies into workspace `skills/`
 *   claude-code  → ClaudeCodeSkillAdapter — symlinks into workspace `.claude/skills/`
 *                                            + CLAUDE.md skill section
 *   veri         → PromptInjectionSkillAdapter — embeds skill names in prompt metadata
 *   webhook      → PromptInjectionSkillAdapter — same
 *   (default)    → NoopSkillAdapter       — no-op for unknown/future runtimes
 *
 * # Source-of-truth guarantee
 *
 * Runtime artifacts are always regenerated from the DB-owned skill list at
 * dispatch time. Stale copied dirs/symlinks, extra skill dirs, or modified runtime guidance
 * are replaced on every materialize() call — runtime files are never "promoted"
 * back to the DB.
 */

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';

function resolveInternalSkillsDir(): string {
  return process.env.AGENT_HQ_SKILLS_PATH ?? path.resolve(__dirname, '../../..', 'skills');
}

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * MaterializationContext — everything a skill adapter needs to do its job.
 *
 * The adapter should treat skillNames as the authoritative desired state and
 * reconcile runtime artifacts accordingly.
 */
export interface MaterializationContext {
  /** Absolute path to the agent's working directory (workspace root). */
  workingDirectory: string;

  /** Ordered list of skill names to materialize (authoritative — from Atlas DB). */
  skillNames: string[];

  /**
   * Path to the OpenClaw global skills directory.
   * Filesystem adapters use it to locate source skill dirs.
   * Optional: only relevant for filesystem-based adapters.
   */
  skillsBasePath?: string;

  /**
   * Optional database handle — available to adapters that need to fetch
   * skill content from the Atlas DB (e.g. for prompt injection).
   */
  db?: Database.Database;

  /**
   * Optional hooks URL — forwarded to generateClaudeMd() for runtimes that
   * consume CLAUDE.md orientation files.
   */
  hooksUrl?: string | null;
}

/**
 * SkillMaterializationAdapter — the interface every runtime adapter must implement.
 *
 * Adapters are stateless. They receive a MaterializationContext per call and
 * return a result describing what was done (useful for logging and tests).
 */
export interface SkillMaterializationAdapter {
  /**
   * materialize — reconcile runtime artifacts with the desired skill list.
   *
   * Create artifacts that are missing, update stale ones, and optionally
   * remove those for skills no longer in skillNames. Safe to call multiple
   * times (idempotent per call for the same skillNames).
   */
  materialize(context: MaterializationContext): MaterializationResult;

  /**
   * cleanup — remove runtime artifacts for a given list of skill names.
   *
   * Called when skills are removed from an agent. Adapters that produce
   * no persistent artifacts may leave this as a no-op.
   */
  cleanup(context: MaterializationContext): MaterializationResult;

  /** Human-readable adapter identifier (used in logs). */
  readonly adapterName: string;
}

export interface MaterializationResult {
  ok: boolean;
  /** Number of skills successfully materialized / cleaned up. */
  count: number;
  /** Per-skill status entries (for debugging). */
  details: Array<{ skill: string; action: 'created' | 'updated' | 'skipped' | 'removed' | 'error'; reason?: string }>;
  /** Non-fatal warnings collected during materialization. */
  warnings: string[];
  /** Fatal error message (when ok=false). */
  error?: string;
}

function emptyResult(): MaterializationResult {
  return { ok: true, count: 0, details: [], warnings: [] };
}

const MANAGED_SKILLS_MANIFEST = '.agent-hq-managed-skills.json';

// ── NoopSkillAdapter ──────────────────────────────────────────────────────────

/**
 * NoopSkillAdapter — fallback for unknown or future runtimes.
 *
 * Does nothing and returns a successful empty result. Safe to use when
 * runtime-specific skill materialization is not yet defined.
 */
export class NoopSkillAdapter implements SkillMaterializationAdapter {
  readonly adapterName = 'noop';

  materialize(_context: MaterializationContext): MaterializationResult {
    return emptyResult();
  }

  cleanup(_context: MaterializationContext): MaterializationResult {
    return emptyResult();
  }
}

// ── FilesystemSkillAdapter ───────────────────────────────────────────────────

/**
 * FilesystemSkillAdapter — base for runtimes that materialize skills under a
 * runtime-specific skills directory in the workspace.
 *
 * OpenClaw and Claude Code both consume filesystem skills, but the workspace
 * contract differs by runtime:
 *   - OpenClaw    → `{workingDirectory}/skills/<name>`
 *   - Claude Code → `{workingDirectory}/.claude/skills/<name>`
 *
 * The adapter:
 *   1. Ensures the runtime-specific skills directory exists in workingDirectory.
 *   2. Creates/updates runtime artifacts for each skill in skillNames.
 *   3. Removes stale symlinks for skills NOT in skillNames (reconcile step).
 *   4. Skips skills whose source dir cannot be found in skillsBasePath or the DB.
 *
 * Workspace skill resolution order:
 *   1. `skillsBasePath/<name>/` — system/OpenClaw skills
 *   2. DB `fs_path` for workspace/atlas skills (when `context.db` is provided)
 *   3. Agent HQ repo `skills/<name>/` — built-in Atlas skills served by the UI
 */
export abstract class FilesystemSkillAdapter implements SkillMaterializationAdapter {
  abstract readonly adapterName: string;

  protected abstract getSkillsDir(workingDirectory: string): string;

  protected shouldCopySkillDirectories(): boolean {
    return false;
  }

  private readManagedSkillNames(skillsDir: string): string[] {
    if (!this.shouldCopySkillDirectories()) return [];
    try {
      const raw = fs.readFileSync(path.join(skillsDir, MANAGED_SKILLS_MANIFEST), 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.skills)
        ? parsed.skills.filter((entry: unknown): entry is string => typeof entry === 'string')
        : [];
    } catch {
      return [];
    }
  }

  private writeManagedSkillNames(skillsDir: string, skillNames: string[]): void {
    if (!this.shouldCopySkillDirectories()) return;
    fs.writeFileSync(
      path.join(skillsDir, MANAGED_SKILLS_MANIFEST),
      `${JSON.stringify({ skills: skillNames }, null, 2)}\n`,
      'utf-8',
    );
  }

  protected writeSkillArtifact(source: string, target: string): 'created' | 'updated' | 'skipped' {
    let lstat: ReturnType<typeof fs.lstatSync> | null = null;
    try { lstat = fs.lstatSync(target); } catch { /* not present */ }

    if (this.shouldCopySkillDirectories()) {
      const action = lstat ? 'updated' : 'created';
      if (lstat) fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(source, target, { recursive: true });
      return action;
    }

    if (lstat) {
      if (lstat.isSymbolicLink()) {
        const existing = fs.readlinkSync(target);
        if (existing === source) return 'skipped';
      }
      fs.rmSync(target, { recursive: true, force: true });
      fs.symlinkSync(source, target);
      return 'updated';
    }

    fs.symlinkSync(source, target);
    return 'created';
  }

  /**
   * Resolve the filesystem directory for a skill by name.
   *
   * Checks `skillsBasePath` first (system skills). If not found there, falls
   * back to the `fs_path` recorded in the skills DB table for workspace/atlas
   * skills, then to the repo-local skills directory exposed by /api/v1/skills.
   * Returns null if the skill cannot be resolved to a valid directory.
   */
  protected resolveSkillDir(
    name: string,
    skillsBasePath: string | undefined,
    db: Database.Database | undefined,
  ): string | null {
    // 1. System skills path
    if (skillsBasePath) {
      const candidate = path.join(skillsBasePath, name);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch { /* continue */ }
    }

    // 2. DB-recorded fs_path for workspace/atlas skills
    if (db) {
      try {
        const row = db.prepare(`SELECT fs_path FROM skills WHERE name = ? AND fs_path IS NOT NULL`).get(name) as
          | { fs_path: string }
          | undefined;
        if (row?.fs_path) {
          const candidate = row.fs_path;
          try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
              return candidate;
            }
          } catch { /* not accessible */ }
        }
      } catch { /* DB not available */ }
    }

    // 3. Agent HQ repo-local skills exposed by the skills API.
    try {
      const candidate = path.join(resolveInternalSkillsDir(), name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch { /* continue */ }

    return null;
  }

  materialize(context: MaterializationContext): MaterializationResult {
    const { workingDirectory, skillNames, skillsBasePath, db } = context;
    const result: MaterializationResult = { ok: true, count: 0, details: [], warnings: [] };

    // Allow proceeding without skillsBasePath when db is provided (workspace skills only)
    if (!skillsBasePath && !db) {
      if (skillNames.length > 0) {
        result.warnings.push(`[${this.adapterName}] skillsBasePath is not set and no DB provided — skipping skill materialization`);
      }
      return result;
    }

    const skillsDir = this.getSkillsDir(workingDirectory);
    try {
      fs.mkdirSync(skillsDir, { recursive: true });
    } catch (err) {
      result.ok = false;
      result.error = `Failed to create skills dir ${skillsDir}: ${err instanceof Error ? err.message : String(err)}`;
      return result;
    }

    // ── Create / update artifacts for assigned skills ──
    const desiredSet = new Set(skillNames);
    const previouslyManagedSkillNames = this.readManagedSkillNames(skillsDir);

    for (const name of skillNames) {
      const source = this.resolveSkillDir(name, skillsBasePath, db);

      try {
        if (!source) {
          result.warnings.push(
            `[${this.adapterName}] skill "${name}" not found in system path or DB — skipping`,
          );
          result.details.push({ skill: name, action: 'skipped', reason: 'source not found' });
          continue;
        }

        const target = path.join(skillsDir, name);
        const action = this.writeSkillArtifact(source, target);
        if (action === 'skipped') {
          result.details.push({ skill: name, action: 'skipped', reason: 'already correct' });
        } else {
          result.details.push({ skill: name, action });
        }
        result.count++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.warnings.push(`[${this.adapterName}] skill "${name}" materialization error: ${msg}`);
        result.details.push({ skill: name, action: 'error', reason: msg });
      }
    }

    if (this.shouldCopySkillDirectories()) {
      for (const entry of previouslyManagedSkillNames) {
        if (desiredSet.has(entry)) continue;
        try {
          fs.rmSync(path.join(skillsDir, entry), { recursive: true, force: true });
          result.details.push({ skill: entry, action: 'removed', reason: 'no longer assigned' });
        } catch { /* ignore */ }
      }
      this.writeManagedSkillNames(skillsDir, skillNames);
    } else {
      // ── Reconcile: remove stale symlinks for skills no longer assigned ──
      try {
        const existingLinks = fs.readdirSync(skillsDir);
        for (const entry of existingLinks) {
          if (desiredSet.has(entry)) continue;
          const linkPath = path.join(skillsDir, entry);
          try {
            const st = fs.lstatSync(linkPath);
            if (st.isSymbolicLink()) {
              fs.unlinkSync(linkPath);
              result.details.push({ skill: entry, action: 'removed', reason: 'no longer assigned' });
            }
          } catch { /* ignore */ }
        }
      } catch { /* skillsDir may not exist — that's fine */ }
    }

    return result;
  }

  cleanup(context: MaterializationContext): MaterializationResult {
    const { workingDirectory, skillNames } = context;
    const result: MaterializationResult = { ok: true, count: 0, details: [], warnings: [] };

    const skillsDir = this.getSkillsDir(workingDirectory);
    for (const name of skillNames) {
      const linkPath = path.join(skillsDir, name);
      try {
        const st = fs.lstatSync(linkPath);
        if (st.isSymbolicLink() || (this.shouldCopySkillDirectories() && st.isDirectory())) {
          fs.rmSync(linkPath, { recursive: true, force: true });
          result.details.push({ skill: name, action: 'removed' });
          result.count++;
        }
      } catch { /* not present — already clean */ }
    }
    if (this.shouldCopySkillDirectories()) {
      const remainingManaged = this.readManagedSkillNames(skillsDir).filter((name) => !skillNames.includes(name));
      this.writeManagedSkillNames(skillsDir, remainingManaged);
    }

    return result;
  }
}

// ── OpenClawSkillAdapter ──────────────────────────────────────────────────────

/**
 * OpenClawSkillAdapter — filesystem-based adapter for OpenClaw agents.
 *
 * OpenClaw workspaces consume assigned skills from `WORKSPACE/skills/`.
 * Unlike Claude Code, OpenClaw should not project assigned skills into
 * `.claude/skills/` or mutate `CLAUDE.md` as part of skill materialization.
 */
export class OpenClawSkillAdapter extends FilesystemSkillAdapter {
  readonly adapterName = 'openclaw';

  protected override getSkillsDir(workingDirectory: string): string {
    return path.join(workingDirectory, 'skills');
  }

  protected override shouldCopySkillDirectories(): boolean {
    return true;
  }
}

// ── ClaudeCodeSkillAdapter ────────────────────────────────────────────────────

/**
 * ClaudeCodeSkillAdapter — filesystem-based adapter for Claude Code agents.
 *
 * Functionally identical to OpenClawSkillAdapter today. Separated so
 * Claude Code–specific materialization can diverge (e.g. if it gains a
 * different skills consumption mechanism).
 */
export class ClaudeCodeSkillAdapter extends FilesystemSkillAdapter {
  readonly adapterName = 'claude-code';

  protected override getSkillsDir(workingDirectory: string): string {
    return path.join(workingDirectory, '.claude', 'skills');
  }

  override materialize(context: MaterializationContext): MaterializationResult {
    const result = super.materialize(context);

    if (context.workingDirectory) {
      try {
        writeClaudeCodeSkillSection(context);
      } catch (err) {
        result.warnings.push(
          `[claude-code] failed to write CLAUDE.md skill section: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return result;
  }
}

// ── PromptInjectionSkillAdapter ───────────────────────────────────────────────

/**
 * PromptInjectionSkillAdapter — non-filesystem adapter for remote runtimes.
 *
 * Remote runtimes (Custom, Webhook) do not share a local filesystem with Atlas.
 * Skills are not symlinked — instead the adapter records which skills are
 * assigned on the context for the dispatcher to embed in the system prompt.
 *
 * In the current implementation this adapter is intentionally minimal:
 * the dispatcher already has the skill names and embeds them in the lifecycle
 * system prompt section. This adapter serves as the canonical hook point for
 * future prompt-level skill injection logic (e.g. fetching and inlining skill
 * content from the Atlas DB, not just their names).
 */
export class PromptInjectionSkillAdapter implements SkillMaterializationAdapter {
  readonly adapterName: string;

  constructor(runtimeName: string) {
    this.adapterName = `prompt-injection(${runtimeName})`;
  }

  materialize(context: MaterializationContext): MaterializationResult {
    const result = emptyResult();
    if (context.skillNames.length === 0) return result;

    // Log that skills are available for prompt injection — actual injection
    // happens in the runtime's dispatch call via the lifecycle prompt section.
    result.count = context.skillNames.length;
    for (const name of context.skillNames) {
      result.details.push({ skill: name, action: 'skipped', reason: 'prompt injection — no filesystem artifact' });
    }
    return result;
  }

  cleanup(_context: MaterializationContext): MaterializationResult {
    // Nothing to clean up for prompt-injection mode
    return emptyResult();
  }
}

// ── Claude Code skill section writer ─────────────────────────────────────────

/**
 * writeClaudeCodeSkillSection — write or update the "## Available Skills" section
 * in `{workingDirectory}/CLAUDE.md`.
 *
 * If CLAUDE.md does not exist, it is created with only the skills section.
 * If it already exists, the section between the skill markers is replaced.
 * This is intentionally narrow: only the skill section is touched; the rest
 * of the file is preserved verbatim.
 *
 * Marker lines (must appear as whole lines, no inline content):
 *   <!-- atlas-skills-start -->
 *   <!-- atlas-skills-end -->
 *
 * If neither marker exists in an existing file, the section is appended.
 */
function writeClaudeCodeSkillSection(context: MaterializationContext): void {
  const { workingDirectory, skillNames } = context;
  const claudeMdPath = path.join(workingDirectory, 'CLAUDE.md');

  const section = buildSkillSection(skillNames);

  if (!fs.existsSync(claudeMdPath)) {
    fs.mkdirSync(workingDirectory, { recursive: true });
    fs.writeFileSync(claudeMdPath, section, 'utf-8');
    return;
  }

  const existing = fs.readFileSync(claudeMdPath, 'utf-8');
  const START = '<!-- atlas-skills-start -->';
  const END = '<!-- atlas-skills-end -->';

  const startIdx = existing.indexOf(START);
  const endIdx = existing.indexOf(END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace existing section
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + END.length);
    fs.writeFileSync(claudeMdPath, `${before}${section}${after}`, 'utf-8');
  } else {
    // Append section (markers not present — preserve existing content)
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    fs.writeFileSync(claudeMdPath, `${existing}${separator}${section}`, 'utf-8');
  }
}

function buildSkillSection(skillNames: string[]): string {
  const lines: string[] = [];
  lines.push('<!-- atlas-skills-start -->');
  lines.push('## Available Skills');
  lines.push('');

  if (skillNames.length === 0) {
    lines.push('_No skills assigned to this agent._');
  } else {
    lines.push('The following skills are available in `.claude/skills/<name>/SKILL.md`.');
    lines.push('Read the relevant skill file before starting any task that matches its description.');
    lines.push('');
    for (const name of skillNames) {
      lines.push(`- **${name}** — \`.claude/skills/${name}/SKILL.md\``);
    }
  }

  lines.push('<!-- atlas-skills-end -->');
  return lines.join('\n') + '\n';
}

// ── Adapter factory ───────────────────────────────────────────────────────────

/**
 * getSkillMaterializationAdapter — return the correct adapter for a given runtime type.
 *
 * This is the single dispatch point. The dispatcher calls this instead of
 * reaching for runtime-specific functions directly.
 *
 * @param runtimeType - the agent's runtime_type string (e.g. "openclaw", "claude-code")
 * @returns a SkillMaterializationAdapter appropriate for that runtime
 */
export function getSkillMaterializationAdapter(
  runtimeType: string | null | undefined,
): SkillMaterializationAdapter {
  switch (runtimeType ?? 'openclaw') {
    case 'openclaw':
      return new OpenClawSkillAdapter();
    case 'claude-code':
      return new ClaudeCodeSkillAdapter();
    case 'veri':
      return new PromptInjectionSkillAdapter('veri');
    case 'webhook':
      return new PromptInjectionSkillAdapter('webhook');
    default:
      return new NoopSkillAdapter();
  }
}
