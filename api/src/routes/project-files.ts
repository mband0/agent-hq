import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDb } from '../db/client';

const router = Router({ mergeParams: true });

const REPO_ROOT = path.resolve(__dirname, '../../..');
const UPLOADS_BASE = process.env.AGENT_HQ_PROJECT_UPLOADS_DIR ?? path.join(REPO_ROOT, 'uploads', 'projects');

// Dynamic multer storage — creates per-project directory
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const projectId = (req.params as { id: string }).id;
    const dir = path.join(UPLOADS_BASE, projectId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const unique = `${Date.now()}-${base}${ext}`;
    cb(null, unique);
  },
});

const upload = multer({ storage });

// GET /api/v1/projects/:id/files
router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const files = db.prepare(`
      SELECT id, filename, original_name, mime_type, size_bytes, created_at, uploaded_by
      FROM project_files
      WHERE project_id = ?
      ORDER BY created_at DESC
    `).all(req.params.id);

    return res.json(files);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// POST /api/v1/projects/:id/files
router.post('/', upload.single('file'), (req: Request, res: Response) => {
  try {
    const db = getDb();
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) {
      // Clean up uploaded file if project not found
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded (field name must be "file")' });
    }

    const uploadedBy = (req.body as { uploaded_by?: string }).uploaded_by ?? 'manual';

    const result = db.prepare(`
      INSERT INTO project_files (project_id, filename, original_name, mime_type, size_bytes, file_path, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id,
      req.file.filename,
      req.file.originalname,
      req.file.mimetype,
      req.file.size,
      req.file.path,
      uploadedBy,
    );

    const record = db.prepare(`
      SELECT id, filename, original_name, mime_type, size_bytes, created_at, uploaded_by
      FROM project_files WHERE id = ?
    `).get(result.lastInsertRowid);

    return res.status(201).json(record);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/projects/:id/files/:fileId
router.get('/:fileId', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const file = db.prepare(`
      SELECT id, filename, original_name, mime_type, size_bytes, created_at, uploaded_by, file_path
      FROM project_files WHERE id = ? AND project_id = ?
    `).get(req.params.fileId, req.params.id);

    if (!file) return res.status(404).json({ error: 'File not found' });
    return res.json(file);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/projects/:id/files/:fileId/download
router.get('/:fileId/download', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const file = db.prepare(`
      SELECT id, filename, original_name, mime_type, file_path
      FROM project_files WHERE id = ? AND project_id = ?
    `).get(req.params.fileId, req.params.id) as {
      id: number; filename: string; original_name: string;
      mime_type: string; file_path: string;
    } | undefined;

    if (!file) return res.status(404).json({ error: 'File not found' });

    if (!fs.existsSync(file.file_path)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(file.original_name)}"`
    );
    return res.sendFile(path.resolve(file.file_path));
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/v1/projects/:id/files/:fileId
router.delete('/:fileId', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const file = db.prepare(`
      SELECT id, file_path FROM project_files WHERE id = ? AND project_id = ?
    `).get(req.params.fileId, req.params.id) as { id: number; file_path: string } | undefined;

    if (!file) return res.status(404).json({ error: 'File not found' });

    // Delete from disk (best-effort)
    try {
      if (fs.existsSync(file.file_path)) {
        fs.unlinkSync(file.file_path);
      }
    } catch (fsErr) {
      console.warn('[project-files] Failed to delete from disk:', fsErr);
    }

    db.prepare('DELETE FROM project_files WHERE id = ?').run(file.id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
