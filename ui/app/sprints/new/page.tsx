'use client';

import { useEffect, useState } from 'react';
import { api, Project, SprintType, SprintWorkflowTemplate } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Rocket, ChevronDown, ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface FormState {
  project_id: string;
  name: string;
  goal: string;
  sprint_type: string;
  workflow_template_key: string;
  length_kind: 'time' | 'runs';
  length_value: string;
  started_at: string;
  status: 'planning' | 'active';
}

const emptyForm: FormState = {
  project_id: '',
  name: '',
  goal: '',
  sprint_type: 'generic',
  workflow_template_key: '',
  length_kind: 'time',
  length_value: '2w',
  started_at: '',
  status: 'planning',
};

export default function NewSprintPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [sprintTypes, setSprintTypes] = useState<SprintType[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [workflowTemplates, setWorkflowTemplates] = useState<SprintWorkflowTemplate[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.getProjects(), api.getSprintTypes(), api.getWorkflowTemplates(undefined, { systemOnly: false })])
      .then(([p, types, workflowResponse]) => {
        setProjects(p);
        setSprintTypes(types);
        setWorkflowTemplates(workflowResponse.templates ?? []);
        setForm(f => ({
          ...f,
          project_id: f.project_id || (p.length > 0 ? String(p[0].id) : ''),
          sprint_type: f.sprint_type || (types[0]?.key ?? 'generic'),
        }));
      })
      .catch(e => setError(String(e)));
  }, []);

  const selectedSprintType = sprintTypes.find(type => type.key === form.sprint_type) ?? null;
  const availableTemplates = workflowTemplates.filter(template => template.sprint_type_key === form.sprint_type);
  const defaultTemplate = availableTemplates.find(template => template.is_default === 1) ?? availableTemplates[0] ?? null;
  const selectedWorkflowTemplate = availableTemplates.find(template => template.key === form.workflow_template_key) ?? defaultTemplate;

  useEffect(() => {
    if (availableTemplates.length === 0) return;
    if (form.workflow_template_key && availableTemplates.some(template => template.key === form.workflow_template_key)) return;
    setForm(current => ({
      ...current,
      workflow_template_key: defaultTemplate?.key ?? '',
    }));
  }, [availableTemplates, defaultTemplate, form.workflow_template_key]);

  const set = (k: keyof FormState, v: string) => setForm(f => ({ ...f, [k]: v }));

  const handleCreate = async () => {
    if (!form.project_id) { setError('Select a project'); return; }
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError(null);
    try {
      const created = await api.createSprint({
        project_id: Number(form.project_id),
        name: form.name.trim(),
        goal: form.goal.trim(),
        sprint_type: form.sprint_type,
        workflow_template_key: selectedWorkflowTemplate?.key ?? null,
        length_kind: form.length_kind,
        length_value: form.length_value.trim(),
        started_at: form.started_at || null,
        status: form.status,
      });
      router.push(`/sprints/${created.id}`);
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/sprints" className="text-slate-400 hover:text-white transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Rocket className="w-6 h-6 text-amber-400" />
            New Sprint
          </h1>
          <p className="text-slate-400 text-sm mt-0.5">Define a sprint to group agent tasks with a shared goal</p>
        </div>
      </div>

      <Card>
        <div className="space-y-5">
          {/* Project */}
          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Project *</label>
            <div className="relative">
              <select
                className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                value={form.project_id}
                onChange={e => set('project_id', e.target.value)}
              >
                <option value="">— Select project —</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <ChevronDown className="absolute right-2 top-3 w-4 h-4 text-slate-400 pointer-events-none" />
            </div>
          </div>

          {/* Name */}
          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Sprint Name *</label>
            <input
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400"
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder="e.g. Sprint 1 – Market Maker Stabilization"
              autoFocus
            />
          </div>

          {/* Goal */}
          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Sprint Goal</label>
            <textarea
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400 resize-none h-24"
              value={form.goal}
              onChange={e => set('goal', e.target.value)}
              placeholder="What should agents accomplish during this sprint? This will be prepended to every agent task payload."
            />
            <p className="text-xs text-slate-500 mt-1">This goal is automatically injected into agent task payloads.</p>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Sprint Type</label>
            <div className="relative">
              <select
                className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                value={form.sprint_type}
                onChange={e => set('sprint_type', e.target.value)}
              >
                {sprintTypes.map(type => <option key={type.key} value={type.key}>{type.name}</option>)}
              </select>
              <ChevronDown className="absolute right-2 top-3 w-4 h-4 text-slate-400 pointer-events-none" />
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Sprint type controls the task behavior and field schema used inside this sprint, not the project type.
              {selectedSprintType ? ` ${selectedSprintType.description}` : ''}
            </p>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Workflow Template</label>
            <div className="relative">
              <select
                className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                value={selectedWorkflowTemplate?.key ?? ''}
                onChange={e => set('workflow_template_key', e.target.value)}
                disabled={availableTemplates.length === 0}
              >
                {availableTemplates.map(template => <option key={template.key} value={template.key}>{template.name}</option>)}
              </select>
              <ChevronDown className="absolute right-2 top-3 w-4 h-4 text-slate-400 pointer-events-none" />
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Pick the workflow this sprint should run.
              {selectedWorkflowTemplate ? ` ${selectedWorkflowTemplate.description}` : ''}
            </p>
            {selectedWorkflowTemplate && (
              <div className="mt-2 rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2">
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Statuses in this workflow</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {selectedWorkflowTemplate.statuses.map(status => (
                    <span key={status.status_key} className="rounded-full border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-200">
                      {status.label}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Length */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Length Type</label>
              <div className="relative">
                <select
                  className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                  value={form.length_kind}
                  onChange={e => set('length_kind', e.target.value as 'time' | 'runs')}
                >
                  <option value="time">Time-based</option>
                  <option value="runs">Run-based</option>
                </select>
                <ChevronDown className="absolute right-2 top-3 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">
                {form.length_kind === 'time' ? 'Duration (e.g. 2w, 3d, 4h)' : 'Max Runs'}
              </label>
              <input
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400"
                value={form.length_value}
                onChange={e => set('length_value', e.target.value)}
                placeholder={form.length_kind === 'time' ? '2w' : '10'}
              />
              {form.length_kind === 'time' && (
                <p className="text-xs text-slate-500 mt-1">w=weeks, d=days, h=hours, m=minutes</p>
              )}
            </div>
          </div>

          {/* Status + Start Date */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Initial Status</label>
              <div className="relative">
                <select
                  className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                  value={form.status}
                  onChange={e => set('status', e.target.value as 'planning' | 'active')}
                >
                  <option value="planning">Planning</option>
                  <option value="active">Active (start now)</option>
                </select>
                <ChevronDown className="absolute right-2 top-3 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Start Date (optional)</label>
              <input
                type="datetime-local"
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400"
                value={form.started_at}
                onChange={e => set('started_at', e.target.value)}
              />
            </div>
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <div className="flex gap-3 pt-2">
            <Button variant="primary" onClick={handleCreate} loading={saving}>
              <Rocket className="w-4 h-4" /> Create Sprint
            </Button>
            <Button variant="ghost" onClick={() => router.push('/sprints')}>
              Cancel
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
