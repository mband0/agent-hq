import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ClaudeCodeSkillAdapter,
  OpenClawSkillAdapter,
} from './skillMaterialization';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('skill materialization runtime adapters', () => {
  it('materializes OpenClaw skills into workspace/skills without touching CLAUDE.md', () => {
    const workspaceDir = makeTempDir('openclaw-workspace-');
    const skillsBasePath = makeTempDir('openclaw-skills-base-');
    const sourceSkillDir = path.join(skillsBasePath, 'create-tool');
    fs.mkdirSync(sourceSkillDir, { recursive: true });
    fs.writeFileSync(path.join(sourceSkillDir, 'SKILL.md'), '# create-tool\n', 'utf-8');

    const adapter = new OpenClawSkillAdapter();
    const result = adapter.materialize({
      workingDirectory: workspaceDir,
      skillNames: ['create-tool'],
      skillsBasePath,
    });

    expect(result.ok).toBe(true);
    const materialized = path.join(workspaceDir, 'skills', 'create-tool');
    expect(fs.lstatSync(materialized).isDirectory()).toBe(true);
    expect(fs.lstatSync(materialized).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(materialized, 'SKILL.md'), 'utf-8')).toBe('# create-tool\n');
    expect(fs.existsSync(path.join(workspaceDir, '.claude', 'skills', 'create-tool'))).toBe(false);
    expect(fs.existsSync(path.join(workspaceDir, 'CLAUDE.md'))).toBe(false);
  });

  it('reconciles removed OpenClaw skills on rematerialization', () => {
    const workspaceDir = makeTempDir('openclaw-remat-workspace-');
    const skillsBasePath = makeTempDir('openclaw-remat-skills-base-');

    for (const skillName of ['create-tool', 'debug-tool']) {
      const sourceSkillDir = path.join(skillsBasePath, skillName);
      fs.mkdirSync(sourceSkillDir, { recursive: true });
      fs.writeFileSync(path.join(sourceSkillDir, 'SKILL.md'), `# ${skillName}\n`, 'utf-8');
    }

    const adapter = new OpenClawSkillAdapter();
    adapter.materialize({
      workingDirectory: workspaceDir,
      skillNames: ['create-tool', 'debug-tool'],
      skillsBasePath,
    });

    const result = adapter.materialize({
      workingDirectory: workspaceDir,
      skillNames: ['debug-tool'],
      skillsBasePath,
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, 'skills', 'create-tool'))).toBe(false);
    expect(fs.lstatSync(path.join(workspaceDir, 'skills', 'debug-tool')).isDirectory()).toBe(true);
  });

  it('resolves repo-local Agent HQ skills when they are not in the OpenClaw skills base or DB', () => {
    const workspaceDir = makeTempDir('openclaw-repo-skill-workspace-');
    const missingSkillsBasePath = makeTempDir('openclaw-empty-skills-base-');

    const adapter = new OpenClawSkillAdapter();
    const result = adapter.materialize({
      workingDirectory: workspaceDir,
      skillNames: ['create-tool'],
      skillsBasePath: missingSkillsBasePath,
    });

    const materializedPath = path.join(workspaceDir, 'skills', 'create-tool');
    expect(result.ok).toBe(true);
    expect(fs.lstatSync(materializedPath).isDirectory()).toBe(true);
    expect(fs.lstatSync(materializedPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(materializedPath, 'SKILL.md'), 'utf-8')).toContain('name: create-tool');
  });

  it('replaces old OpenClaw skill symlinks with real directories', () => {
    const workspaceDir = makeTempDir('openclaw-replace-symlink-workspace-');
    const skillsBasePath = makeTempDir('openclaw-replace-symlink-base-');
    const sourceSkillDir = path.join(skillsBasePath, 'create-tool');
    fs.mkdirSync(sourceSkillDir, { recursive: true });
    fs.writeFileSync(path.join(sourceSkillDir, 'SKILL.md'), '# create-tool\n', 'utf-8');
    fs.mkdirSync(path.join(workspaceDir, 'skills'), { recursive: true });
    fs.symlinkSync(sourceSkillDir, path.join(workspaceDir, 'skills', 'create-tool'));

    const adapter = new OpenClawSkillAdapter();
    const result = adapter.materialize({
      workingDirectory: workspaceDir,
      skillNames: ['create-tool'],
      skillsBasePath,
    });

    const materializedPath = path.join(workspaceDir, 'skills', 'create-tool');
    expect(result.ok).toBe(true);
    expect(result.details).toContainEqual({ skill: 'create-tool', action: 'updated' });
    expect(fs.lstatSync(materializedPath).isDirectory()).toBe(true);
    expect(fs.lstatSync(materializedPath).isSymbolicLink()).toBe(false);
  });

  it('keeps Claude Code behavior on .claude/skills and CLAUDE.md', () => {
    const workspaceDir = makeTempDir('claude-code-workspace-');
    const skillsBasePath = makeTempDir('claude-code-skills-base-');
    const sourceSkillDir = path.join(skillsBasePath, 'create-tool');
    fs.mkdirSync(sourceSkillDir, { recursive: true });
    fs.writeFileSync(path.join(sourceSkillDir, 'SKILL.md'), '# create-tool\n', 'utf-8');

    const adapter = new ClaudeCodeSkillAdapter();
    const result = adapter.materialize({
      workingDirectory: workspaceDir,
      skillNames: ['create-tool'],
      skillsBasePath,
    });

    expect(result.ok).toBe(true);
    expect(fs.lstatSync(path.join(workspaceDir, '.claude', 'skills', 'create-tool')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(workspaceDir, 'CLAUDE.md'), 'utf-8')).toContain('.claude/skills/create-tool/SKILL.md');
  });
});
