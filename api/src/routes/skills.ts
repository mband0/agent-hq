import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

const router = Router();
const INTERNAL_SKILLS_DIR = path.resolve(process.cwd(), '..', 'skills');

function makeStableSkillId(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = ((hash * 31) + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}

// ---------------------------------------------------------------------------
// Filesystem helpers (used for system skills overlay + migration)
// ---------------------------------------------------------------------------

function listFilesRecursive(dir: string, prefix = ''): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(...listFilesRecursive(path.join(dir, entry.name), rel));
      } else {
        results.push(rel);
      }
    }
  } catch (_) { /* ignore */ }
  return results;
}

interface FsSkillEntry {
  name: string;
  path: string; // directory path or file path
  files: string[];
}

function listFsSkillsDir(dir: string): FsSkillEntry[] {
  const skills: FsSkillEntry[] = [];
  if (!fs.existsSync(dir)) return skills;
  try {
    const seen = new Set<string>();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);
        const skillPath = path.join(dir, entry.name);
        skills.push({ name: entry.name, path: skillPath, files: listFilesRecursive(skillPath) });
      } else if (entry.isFile() && (entry.name.endsWith('.skill') || entry.name.endsWith('.md'))) {
        const skillName = entry.name.replace(/\.(skill|md)$/, '');
        if (!seen.has(skillName)) {
          seen.add(skillName);
          skills.push({ name: skillName, path: path.join(dir, entry.name), files: [entry.name] });
        }
      }
    }
  } catch (_) { /* ignore */ }
  return skills;
}

function readFsSkillContent(fsPath: string): string {
  try {
    const stat = fs.statSync(fsPath);
    if (stat.isDirectory()) {
      // Try SKILL.md first, then other .md, then .skill
      const mdMain = path.join(fsPath, 'SKILL.md');
      if (fs.existsSync(mdMain)) return fs.readFileSync(mdMain, 'utf-8');
      const allMd = fs.readdirSync(fsPath).filter(f => f.endsWith('.md'));
      if (allMd.length > 0) return fs.readFileSync(path.join(fsPath, allMd[0]), 'utf-8');
      const allSkill = fs.readdirSync(fsPath).filter(f => f.endsWith('.skill'));
      if (allSkill.length > 0) return fs.readFileSync(path.join(fsPath, allSkill[0]), 'utf-8');
      return '';
    } else {
      return fs.readFileSync(fsPath, 'utf-8');
    }
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// API shape helpers (what we send to clients)
// ---------------------------------------------------------------------------

interface SkillListEntry {
  id: number | null;           // null for system-only skills
  name: string;
  source: 'atlas' | 'workspace' | 'system';
  description: string;
  files: string[];             // present for workspace/system skills with fs_path
  created_at: string | null;
  updated_at: string | null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get('/', (_req: Request, res: Response) => {
  try {
    const result: SkillListEntry[] = listFsSkillsDir(INTERNAL_SKILLS_DIR).map(skill => ({
      id: makeStableSkillId(skill.name),
      name: skill.name,
      source: 'atlas',
      description: '',
      files: skill.files,
      created_at: null,
      updated_at: null,
    }));
    result.sort((a, b) => a.name.localeCompare(b.name));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/migrate-from-fs', (_req: Request, res: Response) => {
  res.json({ ok: true, imported: [], skipped: [], source: INTERNAL_SKILLS_DIR });
});

router.get('/:name', (req: Request, res: Response) => {
  try {
    const name = req.params.name;
    const fsPath = path.join(INTERNAL_SKILLS_DIR, name);
    if (fs.existsSync(fsPath)) {
      return res.json({
        id: makeStableSkillId(name),
        name,
        source: 'atlas',
        description: '',
        content: readFsSkillContent(fsPath),
        fs_path: fsPath,
        created_at: null,
        updated_at: null,
      });
    }
    return res.status(404).json({ error: 'Skill not found' });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get('/:name/file/*', (req: Request, res: Response) => {
  try {
    const name = req.params.name;
    const relativePath = (req.params as Record<string, string>)[0];
    if (!relativePath) return res.status(400).json({ error: 'File path required' });

    const baseDir = path.join(INTERNAL_SKILLS_DIR, name);
    if (!baseDir) return res.status(404).json({ error: 'Skill directory not found' });
    if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) return res.status(404).json({ error: 'Skill directory not found' });

    const resolved = path.resolve(baseDir, relativePath);
    if (!resolved.startsWith(path.resolve(baseDir))) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return res.status(404).json({ error: 'File not found' });
    }

    const content = fs.readFileSync(resolved, 'utf-8');
    return res.json({ name, file: relativePath, content, path: resolved });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, description, content } = req.body as { name: string; description?: string; content?: string };
    if (!name) return res.status(400).json({ error: 'name is required' });
    const skillDir = path.join(INTERNAL_SKILLS_DIR, name);
    if (fs.existsSync(skillDir)) return res.status(409).json({ error: 'Skill already exists' });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      content ?? `# ${name}\n\n${description ?? 'Describe this skill here.'}\n`,
      'utf-8'
    );
    return res.status(201).json({
      id: makeStableSkillId(name),
      name,
      source: 'atlas',
      description: description ?? '',
      content: readFsSkillContent(skillDir),
      created_at: null,
      updated_at: null,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.put('/:name', async (req: Request, res: Response) => {
  try {
    const name = req.params.name;
    const { content } = req.body as { content?: string; description?: string };
    const skillDir = path.join(INTERNAL_SKILLS_DIR, name);
    if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
      return res.status(404).json({ error: 'Skill not found' });
    }
    if (content === undefined) return res.status(400).json({ error: 'No fields to update' });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
    return res.json({
      id: makeStableSkillId(name),
      name,
      source: 'atlas',
      description: '',
      content: readFsSkillContent(skillDir),
      updated_at: null,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.delete('/:name', async (req: Request, res: Response) => {
  try {
    const name = req.params.name;
    const skillDir = path.join(INTERNAL_SKILLS_DIR, name);
    if (!fs.existsSync(skillDir)) return res.status(404).json({ error: 'Skill not found' });
    fs.rmSync(skillDir, { recursive: true, force: true });
    return res.json({ ok: true, name });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
