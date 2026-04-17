'use client';
import { formatDateTime, formatDate, formatTime, timeAgo } from '@/lib/date';

import { useEffect, useState } from 'react';
import { api, Project } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FolderOpen, Plus, Trash2, X, Check, Briefcase } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DeleteProjectModal } from '@/components/DeleteProjectModal';

interface FormState {
  name: string;
  description: string;
}

const emptyForm: FormState = { name: '', description: '' };

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null);

  const load = () => {
    api.getProjects()
      .then(setProjects)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleCreate = async () => {
    if (!form.name.trim()) {
      setFormError('Name is required');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const created = await api.createProject({ name: form.name.trim(), description: form.description.trim() });
      setShowForm(false);
      setForm(emptyForm);
      // Navigate to the new project
      router.push(`/projects/${created.id}`);
    } catch (e) {
      setFormError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteClick = (id: number, name: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDeleteTarget({ id, name });
  };

  const handleDeleteConfirmed = () => {
    setDeleteTarget(null);
    load();
  };

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (error) return (
    <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error}</div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Projects</h1>
          <p className="text-slate-400 text-sm mt-1">{projects.length} project{projects.length !== 1 ? 's' : ''}</p>
        </div>
        <Button variant="primary" onClick={() => { setShowForm(true); setForm(emptyForm); setFormError(null); }}>
          <Plus className="w-4 h-4" /> New Project
        </Button>
      </div>

      {/* Create Form */}
      {showForm && (
        <Card className="border-amber-500/30">
          <h2 className="font-semibold text-white mb-4">New Project</h2>
          <div className="space-y-3">
            <label className="block">
              <span className="text-slate-400 text-xs mb-1 block">Name *</span>
              <input
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="My Project"
                autoFocus
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
              />
            </label>
            <label className="block">
              <span className="text-slate-400 text-xs mb-1 block">Description</span>
              <input
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="What is this project about?"
              />
            </label>
          </div>
          {formError && <p className="text-red-400 text-xs mt-2">{formError}</p>}
          <div className="flex gap-2 mt-4">
            <Button variant="primary" onClick={handleCreate} loading={saving}>
              <Check className="w-3.5 h-3.5" /> Create
            </Button>
            <Button variant="ghost" onClick={() => setShowForm(false)}>
              <X className="w-3.5 h-3.5" /> Cancel
            </Button>
          </div>
        </Card>
      )}

      {/* Delete Modal */}
      {deleteTarget && (
        <DeleteProjectModal
          projectId={deleteTarget.id}
          projectName={deleteTarget.name}
          onConfirm={handleDeleteConfirmed}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Projects Grid */}
      {projects.length === 0 && !showForm ? (
        <Card data-tour-target="projects-list">
          <div className="text-center py-16 space-y-3">
            <FolderOpen className="w-12 h-12 text-slate-600 mx-auto" />
            <p className="text-slate-400 font-medium">No projects yet</p>
            <p className="text-slate-500 text-sm">Create a project to group agents and share context across runs.</p>
            <Button variant="primary" onClick={() => setShowForm(true)} className="mt-2">
              <Plus className="w-4 h-4" /> New Project
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4" data-tour-target="projects-list">
          {projects.map(project => (
            <Link key={project.id} href={`/projects/${project.id}`}>
              <Card className="hover:border-amber-500/40 transition-colors cursor-pointer h-full group">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <FolderOpen className="w-5 h-5 text-amber-400 shrink-0" />
                    <h3 className="font-semibold text-white truncate group-hover:text-amber-300 transition-colors">
                      {project.name}
                    </h3>
                  </div>
                  <button
                    onClick={(e) => handleDeleteClick(project.id, project.name, e)}
                    className="p-1 rounded text-slate-600 hover:text-red-400 hover:bg-slate-700 transition-colors shrink-0 opacity-0 group-hover:opacity-100"
                    title="Delete project"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {project.description && (
                  <p className="text-slate-400 text-sm mt-2 line-clamp-2">{project.description}</p>
                )}

                <div className="flex items-center gap-3 mt-3">
                  <span className="flex items-center gap-1 text-xs text-slate-500">
                    <Briefcase className="w-3 h-3" />
                    {(project as Project & { job_count?: number }).job_count ?? 0} agents
                  </span>
                  <span className="text-xs text-slate-600">
                    {formatDate(project.created_at)}
                  </span>
                </div>

                {project.context_md && (
                  <div className="mt-2">
                    <Badge variant="workspace">has context</Badge>
                  </div>
                )}
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
