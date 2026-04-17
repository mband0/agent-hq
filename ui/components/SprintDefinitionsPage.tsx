'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  api,
  CustomFieldDefinition,
  SprintTypeConfig,
  SprintWorkflowTemplate,
  TaskFieldSchema,
  WorkflowTemplateInput,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  ArrowRight,
  GitBranch,
  Pencil,
  Plus,
  Save,
  Trash2,
  Workflow,
} from 'lucide-react';

type Notice = { type: 'success' | 'error'; message: string } | null;

type SprintTypeForm = { key: string; name: string; description: string };
type FieldSchemaForm = { id?: number; task_type: string; fields: CustomFieldDefinition[] };
type WorkflowTemplateForm = {
  id?: number;
  key: string;
  name: string;
  description: string;
  is_default: boolean;
  statuses: Array<{
    status_key: string;
    label: string;
    color: string;
    terminal: boolean;
    is_default_entry: boolean;
  }>;
  transitions: Array<{
    transition_key: string;
    from_status_key: string;
    to_status_key: string;
    label: string;
    outcome: string;
  }>;
};

const emptySprintTypeForm: SprintTypeForm = { key: '', name: '', description: '' };
const emptyField: CustomFieldDefinition = { key: '', label: '', type: 'text', required: false, options: [], help_text: '' };

function emptySchemaForm(): FieldSchemaForm {
  return { task_type: '', fields: [{ ...emptyField }] };
}

function emptyWorkflowForm(): WorkflowTemplateForm {
  return {
    key: '',
    name: '',
    description: '',
    is_default: false,
    statuses: [
      { status_key: 'todo', label: 'To Do', color: 'slate', terminal: false, is_default_entry: true },
      { status_key: 'done', label: 'Done', color: 'green', terminal: true, is_default_entry: false },
    ],
    transitions: [
      { transition_key: 'start-work', from_status_key: 'todo', to_status_key: 'done', label: 'Complete', outcome: 'completed' },
    ],
  };
}

function schemaToForm(schema: TaskFieldSchema): FieldSchemaForm {
  return {
    id: schema.id,
    task_type: schema.task_type ?? '',
    fields: schema.schema.fields?.length ? schema.schema.fields.map(field => ({ ...field, options: field.options ?? [] })) : [{ ...emptyField }],
  };
}

function templateToForm(template: SprintWorkflowTemplate): WorkflowTemplateForm {
  return {
    id: template.id,
    key: template.key,
    name: template.name,
    description: template.description,
    is_default: template.is_default === 1,
    statuses: template.statuses.map(status => ({
      status_key: status.status_key,
      label: status.label,
      color: status.color,
      terminal: status.terminal === 1,
      is_default_entry: status.is_default_entry === 1,
    })),
    transitions: (template.transitions ?? []).map(transition => ({
      transition_key: transition.transition_key,
      from_status_key: transition.from_status_key,
      to_status_key: transition.to_status_key,
      label: transition.label,
      outcome: transition.outcome ?? '',
    })),
  };
}

export default function SprintDefinitionsPage() {
  const [config, setConfig] = useState<SprintTypeConfig[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice>(null);
  const [creatingSprintType, setCreatingSprintType] = useState(false);
  const [sprintTypeForm, setSprintTypeForm] = useState<SprintTypeForm>(emptySprintTypeForm);
  const [taskTypesText, setTaskTypesText] = useState('');
  const [schemaEditor, setSchemaEditor] = useState<FieldSchemaForm | null>(null);
  const [templateEditor, setTemplateEditor] = useState<WorkflowTemplateForm | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = async (preferredKey?: string) => {
    setLoading(true);
    try {
      const response = await api.getWorkflowConfig();
      const sprintTypes = response.sprint_types ?? [];
      setConfig(sprintTypes);
      const nextKey = preferredKey && sprintTypes.some(type => type.key === preferredKey)
        ? preferredKey
        : sprintTypes[0]?.key ?? '';
      setSelectedKey(nextKey);
      setNotice(null);
    } catch (error) {
      setNotice({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const selectedSprintType = useMemo(
    () => config.find(type => type.key === selectedKey) ?? null,
    [config, selectedKey],
  );

  useEffect(() => {
    if (!selectedSprintType) return;
    setSprintTypeForm({
      key: selectedSprintType.key,
      name: selectedSprintType.name,
      description: selectedSprintType.description,
    });
    setTaskTypesText(selectedSprintType.task_types.map(taskType => taskType.task_type).join('\n'));
    setSchemaEditor(null);
    setTemplateEditor(null);
  }, [selectedSprintType]);

  const editingTemplate = useMemo(
    () => selectedSprintType?.workflow_templates.find(template => template.id === templateEditor?.id) ?? null,
    [selectedSprintType, templateEditor?.id],
  );
  const editingTemplateActiveUsage = editingTemplate?.usage?.active_planning_sprints ?? 0;
  const lockedExistingStatusKeys = useMemo(
    () => new Set((editingTemplate?.statuses ?? []).map(status => status.status_key)),
    [editingTemplate],
  );
  const baseFieldSchema = useMemo(
    () => selectedSprintType?.field_schemas.find(schema => schema.task_type == null) ?? null,
    [selectedSprintType],
  );
  const overrideFieldSchemas = useMemo(
    () => (selectedSprintType?.field_schemas ?? [])
      .filter(schema => schema.task_type != null)
      .sort((a, b) => (a.task_type ?? '').localeCompare(b.task_type ?? '')),
    [selectedSprintType],
  );

  const setSuccess = (message: string) => setNotice({ type: 'success', message });
  const setError = (error: unknown) => setNotice({ type: 'error', message: error instanceof Error ? error.message : String(error) });

  const startNewBaseSchema = () => setSchemaEditor({ task_type: '', fields: [{ ...emptyField }] });
  const startNewOverrideSchema = () => setSchemaEditor({ task_type: '', fields: [{ ...emptyField }] });

  const submitCreateSprintType = async () => {
    if (!sprintTypeForm.key.trim() || !sprintTypeForm.name.trim()) {
      setNotice({ type: 'error', message: 'Sprint type key and name are required.' });
      return;
    }
    setSaving('create-sprint-type');
    try {
      await api.createSprintType({
        key: sprintTypeForm.key.trim(),
        name: sprintTypeForm.name.trim(),
        description: sprintTypeForm.description.trim(),
      });
      await load(sprintTypeForm.key.trim());
      setCreatingSprintType(false);
      setSuccess(`Created sprint type ${sprintTypeForm.key.trim()}.`);
    } catch (error) {
      setError(error);
    } finally {
      setSaving(null);
    }
  };

  const saveSprintType = async () => {
    if (!selectedSprintType) return;
    setSaving('sprint-type');
    try {
      await api.updateSprintType(selectedSprintType.key, {
        name: sprintTypeForm.name.trim(),
        description: sprintTypeForm.description.trim(),
      });
      await load(selectedSprintType.key);
      setSuccess(`Saved sprint type ${selectedSprintType.key}.`);
    } catch (error) {
      setError(error);
    } finally {
      setSaving(null);
    }
  };

  const deleteSprintType = async () => {
    if (!selectedSprintType || !window.confirm(`Delete sprint type ${selectedSprintType.key}?`)) return;
    setSaving('delete-sprint-type');
    try {
      await api.deleteSprintType(selectedSprintType.key);
      await load();
      setSuccess(`Deleted sprint type ${selectedSprintType.key}.`);
    } catch (error) {
      setError(error);
    } finally {
      setSaving(null);
    }
  };

  const saveTaskTypes = async () => {
    if (!selectedSprintType) return;
    const taskTypes = [...new Set(taskTypesText.split(/[,\n]/).map(value => value.trim()).filter(Boolean))];
    setSaving('task-types');
    try {
      await api.replaceSprintTypeTaskTypes(selectedSprintType.key, taskTypes);
      await load(selectedSprintType.key);
      setSuccess(`Updated allowed task types for ${selectedSprintType.key}.`);
    } catch (error) {
      setError(error);
    } finally {
      setSaving(null);
    }
  };

  const saveSchema = async () => {
    if (!selectedSprintType || !schemaEditor) return;
    setSaving('schema');
    try {
      const payload = {
        task_type: schemaEditor.task_type.trim() || null,
        schema: {
          fields: schemaEditor.fields
            .filter(field => field.key?.trim())
            .map(field => ({
              key: field.key?.trim(),
              label: field.label?.trim(),
              type: field.type,
              required: Boolean(field.required),
              options: field.type === 'select' ? (field.options ?? []).map(option => option.trim()).filter(Boolean) : undefined,
              help_text: field.help_text?.trim(),
            })),
        },
      };
      if (schemaEditor.id) {
        await api.updateTaskFieldSchema(selectedSprintType.key, schemaEditor.id, payload);
      } else {
        await api.createTaskFieldSchema(selectedSprintType.key, payload);
      }
      await load(selectedSprintType.key);
      setSchemaEditor(null);
      setSuccess('Saved field schema.');
    } catch (error) {
      setError(error);
    } finally {
      setSaving(null);
    }
  };

  const deleteSchema = async (schema: TaskFieldSchema) => {
    if (!selectedSprintType || !window.confirm('Delete this field schema?')) return;
    setSaving(`delete-schema-${schema.id}`);
    try {
      await api.deleteTaskFieldSchema(selectedSprintType.key, schema.id);
      await load(selectedSprintType.key);
      if (schemaEditor?.id === schema.id) setSchemaEditor(null);
      setSuccess('Deleted field schema.');
    } catch (error) {
      setError(error);
    } finally {
      setSaving(null);
    }
  };

  const saveTemplate = async () => {
    if (!selectedSprintType || !templateEditor) return;
    setSaving('template');
    try {
      const payload: WorkflowTemplateInput = {
        key: templateEditor.key.trim(),
        name: templateEditor.name.trim(),
        description: templateEditor.description.trim(),
        is_default: templateEditor.is_default ? 1 : 0,
        statuses: templateEditor.statuses.map((status, index) => ({
          status_key: status.status_key.trim(),
          label: status.label.trim(),
          color: status.color.trim() || 'slate',
          stage_order: index,
          terminal: status.terminal ? 1 : 0,
          is_default_entry: status.is_default_entry ? 1 : 0,
          metadata: {},
        })),
        transitions: templateEditor.transitions
          .filter(transition => transition.transition_key.trim() && transition.from_status_key.trim() && transition.to_status_key.trim())
          .map((transition, index) => ({
            transition_key: transition.transition_key.trim(),
            from_status_key: transition.from_status_key.trim(),
            to_status_key: transition.to_status_key.trim(),
            label: transition.label.trim(),
            outcome: transition.outcome.trim() || null,
            stage_order: index,
            metadata: {},
          })),
      };
      if (templateEditor.id) {
        await api.updateWorkflowTemplate(selectedSprintType.key, templateEditor.id, payload);
      } else {
        await api.createWorkflowTemplate(selectedSprintType.key, payload);
      }
      await load(selectedSprintType.key);
      setTemplateEditor(null);
      setSuccess('Saved sprint status template.');
    } catch (error) {
      setError(error);
    } finally {
      setSaving(null);
    }
  };

  const deleteTemplate = async (template: SprintWorkflowTemplate) => {
    if (!selectedSprintType || !window.confirm(`Delete sprint status template ${template.name}?`)) return;
    setSaving(`delete-template-${template.id}`);
    try {
      await api.deleteWorkflowTemplate(selectedSprintType.key, template.id);
      await load(selectedSprintType.key);
      if (templateEditor?.id === template.id) setTemplateEditor(null);
      setSuccess(`Deleted sprint status template ${template.name}.`);
    } catch (error) {
      setError(error);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Workflow className="w-6 h-6 text-amber-400" />
            Sprint Definitions
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Define sprint types, task field defaults, and sprint status templates here. Task Routing stays separate for runtime assignment and dispatch rules.
          </p>
        </div>
        <Link
          href="/routing"
          className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 transition-colors hover:border-slate-500 hover:text-white"
        >
          <GitBranch className="h-4 w-4 text-amber-400" />
          Open Task Routing
        </Link>
      </div>

      {notice && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${notice.type === 'error' ? 'border-rose-800/60 bg-rose-950/40 text-rose-200' : 'border-emerald-800/60 bg-emerald-950/40 text-emerald-200'}`}>
          {notice.message}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)]" data-tour-target="sprint-definitions-main">
        <Card className="space-y-4 h-fit">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">Sprint types</p>
              <h2 className="mt-1 text-lg font-semibold text-white">Sprint definitions</h2>
            </div>
            <Button size="sm" variant="ghost" onClick={() => { setCreatingSprintType(true); setSprintTypeForm(emptySprintTypeForm); }}>
              <Plus className="w-3.5 h-3.5" />
            </Button>
          </div>

          {loading ? (
            <p className="text-sm text-slate-400">Loading sprint definitions…</p>
          ) : config.length === 0 ? (
            <p className="text-sm text-slate-400">No sprint types found.</p>
          ) : (
            <div className="space-y-2">
              {config.map(type => (
                <button
                  key={type.key}
                  onClick={() => setSelectedKey(type.key)}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${selectedKey === type.key ? 'border-amber-500/50 bg-amber-500/10' : 'border-slate-700 bg-slate-900/70 hover:border-slate-500'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-white">{type.name}</span>
                    {type.is_system === 1 && <span className="text-[10px] uppercase tracking-wide text-slate-400">system</span>}
                  </div>
                  <p className="mt-1 text-xs text-slate-400">{type.key}</p>
                </button>
              ))}
            </div>
          )}

          {creatingSprintType && (
            <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-3 space-y-3">
              <input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="key" value={sprintTypeForm.key} onChange={e => setSprintTypeForm(form => ({ ...form, key: e.target.value }))} />
              <input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="name" value={sprintTypeForm.name} onChange={e => setSprintTypeForm(form => ({ ...form, name: e.target.value }))} />
              <textarea className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="description" rows={3} value={sprintTypeForm.description} onChange={e => setSprintTypeForm(form => ({ ...form, description: e.target.value }))} />
              <div className="flex gap-2">
                <Button size="sm" variant="primary" loading={saving === 'create-sprint-type'} onClick={submitCreateSprintType}>Create</Button>
                <Button size="sm" variant="ghost" onClick={() => setCreatingSprintType(false)}>Cancel</Button>
              </div>
            </div>
          )}
        </Card>

        {selectedSprintType ? (
          <div className="space-y-6">
            <Card className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">Sprint type details</p>
                  <h2 className="mt-1 text-lg font-semibold text-white">{selectedSprintType.name}</h2>
                  <p className="mt-1 text-sm text-slate-400">Edit the sprint type metadata and its allowed task type catalog.</p>
                </div>
                {selectedSprintType.is_system !== 1 && (
                  <Button size="sm" variant="danger" loading={saving === 'delete-sprint-type'} onClick={deleteSprintType}>
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </Button>
                )}
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Key</label>
                  <input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-400" value={sprintTypeForm.key} disabled />
                </div>
                <div>
                  <label className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Name</label>
                  <input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" value={sprintTypeForm.name} onChange={e => setSprintTypeForm(form => ({ ...form, name: e.target.value }))} />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Description</label>
                <textarea className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" rows={3} value={sprintTypeForm.description} onChange={e => setSprintTypeForm(form => ({ ...form, description: e.target.value }))} />
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between gap-3">
                  <label className="block text-xs uppercase tracking-wide text-slate-500">Allowed task types</label>
                  <span className="text-xs text-slate-500">One per line or comma separated</span>
                </div>
                <textarea className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" rows={4} value={taskTypesText} onChange={e => setTaskTypesText(e.target.value)} />
              </div>

              <div className="flex gap-2">
                <Button variant="primary" loading={saving === 'sprint-type'} onClick={saveSprintType}><Save className="w-3.5 h-3.5" />Save details</Button>
                <Button variant="secondary" loading={saving === 'task-types'} onClick={saveTaskTypes}>Save task types</Button>
              </div>
            </Card>

            <Card className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">Task field schemas</p>
                  <h2 className="mt-1 text-lg font-semibold text-white">Default fields and task-type overrides</h2>
                  <p className="mt-1 text-sm text-slate-400">Each sprint type gets one default schema for every task, plus optional overrides for specific task types like backend or design.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {!baseFieldSchema && (
                    <Button size="sm" variant="secondary" onClick={startNewBaseSchema}>
                      <Plus className="w-3.5 h-3.5" />
                      Create default schema
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" onClick={startNewOverrideSchema}>
                    <Plus className="w-3.5 h-3.5" />
                    Add override
                  </Button>
                </div>
              </div>

              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
                <div className="grid gap-3 lg:grid-cols-3">
                  <div className="rounded-xl border border-slate-700/70 bg-slate-950/60 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-amber-300">1. Default fields</p>
                    <p className="mt-2 text-sm text-slate-300">The default schema applies to every task created in this sprint type.</p>
                  </div>
                  <div className="rounded-xl border border-slate-700/70 bg-slate-950/60 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-amber-300">2. Optional overrides</p>
                    <p className="mt-2 text-sm text-slate-300">An override only applies to one task type, such as <span className="text-white">backend</span> or <span className="text-white">design</span>.</p>
                  </div>
                  <div className="rounded-xl border border-slate-700/70 bg-slate-950/60 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-amber-300">3. Resolution order</p>
                    <p className="mt-2 text-sm text-slate-300">Task type override first, then this sprint type’s default schema, then generic fallbacks.</p>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">Default fields</p>
                      <h3 className="mt-1 text-base font-semibold text-white">Every {selectedSprintType.name.toLowerCase()} task starts here</h3>
                    </div>
                    {baseFieldSchema && (
                      <Button size="sm" variant="ghost" onClick={() => setSchemaEditor(schemaToForm(baseFieldSchema))}>
                        <Pencil className="w-3.5 h-3.5" />
                        Edit default
                      </Button>
                    )}
                  </div>

                  {baseFieldSchema ? (
                    <div className="mt-3 rounded-xl border border-amber-500/30 bg-slate-900/70 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="font-medium text-white">Default schema</h4>
                            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-300">Applies to all task types</span>
                          </div>
                          <p className="mt-1 text-xs text-slate-400">{baseFieldSchema.schema.fields?.length ?? 0} field(s)</p>
                        </div>
                        <Button size="sm" variant="ghost" loading={saving === `delete-schema-${baseFieldSchema.id}`} onClick={() => deleteSchema(baseFieldSchema)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                      <div className="mt-3 space-y-2">
                        {(baseFieldSchema.schema.fields ?? []).length > 0 ? (
                          (baseFieldSchema.schema.fields ?? []).map(field => (
                            <div key={field.key} className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs text-slate-300">
                              <div className="flex items-center gap-2"><span className="font-medium text-white">{field.label || field.key}</span><span className="text-slate-500">{field.type}</span>{field.required && <span className="text-amber-300">required</span>}</div>
                              {field.help_text && <p className="mt-1 text-slate-400">{field.help_text}</p>}
                            </div>
                          ))
                        ) : (
                          <div className="rounded-lg border border-dashed border-slate-700 bg-slate-950/60 px-3 py-4 text-sm text-slate-400">
                            This default schema exists but has no fields yet.
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 rounded-xl border border-dashed border-slate-700 bg-slate-950/50 p-4 text-sm text-slate-400">
                      No default schema yet. Create one if every {selectedSprintType.name.toLowerCase()} task should collect shared fields.
                    </div>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">Task-type overrides</p>
                      <h3 className="mt-1 text-base font-semibold text-white">Only used for specific task types</h3>
                    </div>
                    <p className="text-xs text-slate-500">{overrideFieldSchemas.length} override{overrideFieldSchemas.length === 1 ? '' : 's'}</p>
                  </div>

                  {overrideFieldSchemas.length === 0 ? (
                    <div className="mt-3 rounded-xl border border-dashed border-slate-700 bg-slate-950/50 p-4 text-sm text-slate-400">
                      No overrides yet. Add one when a task type needs fields that differ from the default schema.
                    </div>
                  ) : (
                    <div className="mt-3 grid gap-3 lg:grid-cols-2">
                      {overrideFieldSchemas.map(schema => (
                        <div key={schema.id} className="rounded-xl border border-slate-700 bg-slate-900/70 p-4">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <h4 className="font-medium capitalize text-white">{schema.task_type} override</h4>
                                <span className="rounded-full border border-slate-600 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-300">Task-type only</span>
                              </div>
                              <p className="mt-1 text-xs text-slate-400">Applies only to <span className="text-white">{schema.task_type}</span> tasks. {schema.schema.fields?.length ?? 0} field(s).</p>
                            </div>
                            <div className="flex gap-2">
                              <Button size="sm" variant="ghost" onClick={() => setSchemaEditor(schemaToForm(schema))}><Pencil className="w-3.5 h-3.5" /></Button>
                              <Button size="sm" variant="ghost" loading={saving === `delete-schema-${schema.id}`} onClick={() => deleteSchema(schema)}><Trash2 className="w-3.5 h-3.5" /></Button>
                            </div>
                          </div>
                          <div className="mt-3 space-y-2">
                            {(schema.schema.fields ?? []).length > 0 ? (
                              (schema.schema.fields ?? []).map(field => (
                                <div key={field.key} className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs text-slate-300">
                                  <div className="flex items-center gap-2"><span className="font-medium text-white">{field.label || field.key}</span><span className="text-slate-500">{field.type}</span>{field.required && <span className="text-amber-300">required</span>}</div>
                                  {field.help_text && <p className="mt-1 text-slate-400">{field.help_text}</p>}
                                </div>
                              ))
                            ) : (
                              <div className="rounded-lg border border-dashed border-slate-700 bg-slate-950/60 px-3 py-4 text-sm text-slate-400">
                                This override exists but has no fields yet.
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {schemaEditor && (
                <div className="rounded-xl border border-amber-500/30 bg-slate-900/80 p-4 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="font-semibold text-white">
                        {schemaEditor.id
                          ? (schemaEditor.task_type.trim() ? `Edit ${schemaEditor.task_type.trim()} override` : 'Edit default schema')
                          : (schemaEditor.task_type.trim() ? `New ${schemaEditor.task_type.trim()} override` : 'New schema')}
                      </h3>
                      <p className="mt-1 text-sm text-slate-400">Leave task type blank to edit the default schema used by every task in this sprint type.</p>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => setSchemaEditor(null)}>Close</Button>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-3 text-sm text-slate-300">
                    Resolution order: exact task-type override, then this sprint type&apos;s default schema, then generic fallbacks.
                  </div>
                  <input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="task type for override, or leave blank for default schema" value={schemaEditor.task_type} onChange={e => setSchemaEditor(editor => editor ? { ...editor, task_type: e.target.value } : editor)} />
                  <div className="space-y-3">
                    {schemaEditor.fields.map((field, index) => (
                      <div key={index} className="rounded-xl border border-slate-700 bg-slate-950/70 p-3 space-y-3">
                        <div className="grid gap-3 md:grid-cols-2">
                          <input className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" placeholder="field key" value={field.key ?? ''} onChange={e => setSchemaEditor(editor => editor ? { ...editor, fields: editor.fields.map((item, itemIndex) => itemIndex === index ? { ...item, key: e.target.value } : item) } : editor)} />
                          <input className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" placeholder="label" value={field.label ?? ''} onChange={e => setSchemaEditor(editor => editor ? { ...editor, fields: editor.fields.map((item, itemIndex) => itemIndex === index ? { ...item, label: e.target.value } : item) } : editor)} />
                        </div>
                        <div className="grid gap-3 md:grid-cols-3">
                          <select className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" value={field.type ?? 'text'} onChange={e => setSchemaEditor(editor => editor ? { ...editor, fields: editor.fields.map((item, itemIndex) => itemIndex === index ? { ...item, type: e.target.value, options: e.target.value === 'select' ? (item.options ?? []) : [] } : item) } : editor)}>
                            {['text', 'textarea', 'url', 'select', 'number', 'checkbox'].map(type => <option key={type} value={type}>{type}</option>)}
                          </select>
                          <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={Boolean(field.required)} onChange={e => setSchemaEditor(editor => editor ? { ...editor, fields: editor.fields.map((item, itemIndex) => itemIndex === index ? { ...item, required: e.target.checked } : item) } : editor)} />Required</label>
                          <Button size="sm" variant="ghost" onClick={() => setSchemaEditor(editor => editor ? { ...editor, fields: editor.fields.filter((_, itemIndex) => itemIndex !== index) || [{ ...emptyField }] } : editor)}><Trash2 className="w-3.5 h-3.5" />Remove</Button>
                        </div>
                        <input className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" placeholder="help text" value={field.help_text ?? ''} onChange={e => setSchemaEditor(editor => editor ? { ...editor, fields: editor.fields.map((item, itemIndex) => itemIndex === index ? { ...item, help_text: e.target.value } : item) } : editor)} />
                        {field.type === 'select' && (
                          <input className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" placeholder="options, comma separated" value={(field.options ?? []).join(', ')} onChange={e => setSchemaEditor(editor => editor ? { ...editor, fields: editor.fields.map((item, itemIndex) => itemIndex === index ? { ...item, options: e.target.value.split(',').map(option => option.trim()).filter(Boolean) } : item) } : editor)} />
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setSchemaEditor(editor => editor ? { ...editor, fields: [...editor.fields, { ...emptyField }] } : editor)}><Plus className="w-3.5 h-3.5" />Add field</Button>
                    <Button size="sm" variant="primary" loading={saving === 'schema'} onClick={saveSchema}>Save schema</Button>
                  </div>
                </div>
              )}
            </Card>

            <Card className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">Sprint statuses</p>
                  <h2 className="mt-1 text-lg font-semibold text-white">Sprint status templates</h2>
                  <p className="mt-1 text-sm text-slate-400">Create and edit the statuses a sprint of this type can move through, plus the allowed transitions between them.</p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setTemplateEditor(emptyWorkflowForm())}><Plus className="w-3.5 h-3.5" />New status template</Button>
              </div>

              <div className="grid gap-3 xl:grid-cols-2">
                {selectedSprintType.workflow_templates.map(template => (
                  <section key={template.id} className="rounded-xl border border-slate-700 bg-slate-900/70 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-base font-semibold text-white">{template.name}</h3>
                          {template.is_default === 1 && <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-300">Default</span>}
                          {template.is_system === 1 && <span className="rounded-full border border-slate-600 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-300">System</span>}
                          {(template.usage?.active_planning_sprints ?? 0) > 0 && <span className="rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-rose-200">Live in {template.usage?.active_planning_sprints} sprint{(template.usage?.active_planning_sprints ?? 0) === 1 ? '' : 's'}</span>}
                        </div>
                        <p className="mt-1 text-sm text-slate-400">{template.description}</p>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setTemplateEditor(templateToForm(template))}><Pencil className="w-3.5 h-3.5" /></Button>
                        <Button size="sm" variant="ghost" loading={saving === `delete-template-${template.id}`} onClick={() => deleteTemplate(template)}><Trash2 className="w-3.5 h-3.5" /></Button>
                      </div>
                    </div>
                    <div className="mt-4">
                      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Statuses</p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {template.statuses.map((status, index) => (
                          <div key={status.status_key} className="flex items-center gap-2">
                            <span className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-xs text-slate-200">{status.label}</span>
                            {index < template.statuses.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-slate-600" />}
                          </div>
                        ))}
                      </div>
                    </div>
                  </section>
                ))}
              </div>

              {templateEditor && (
                <div className="rounded-xl border border-amber-500/30 bg-slate-900/80 p-4 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-semibold text-white">{templateEditor.id ? 'Edit sprint status template' : 'New sprint status template'}</h3>
                    <Button size="sm" variant="ghost" onClick={() => setTemplateEditor(null)}>Close</Button>
                  </div>
                  {editingTemplateActiveUsage > 0 && (
                    <div className="rounded-xl border border-rose-800/60 bg-rose-950/30 px-4 py-3 text-sm text-rose-100">
                      This status template is attached to {editingTemplateActiveUsage} planning/active sprint{editingTemplateActiveUsage === 1 ? '' : 's'}. Safe edits like labels, descriptions, colors, and adding new statuses are allowed. Template key changes and existing status key rename/removal are blocked until those live sprints are reassigned or completed.
                    </div>
                  )}

                  <div className="grid gap-3 md:grid-cols-2">
                    <input className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white disabled:text-slate-500" placeholder="key" value={templateEditor.key} disabled={editingTemplateActiveUsage > 0 && Boolean(templateEditor.id)} onChange={e => setTemplateEditor(editor => editor ? { ...editor, key: e.target.value } : editor)} />
                    <input className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="name" value={templateEditor.name} onChange={e => setTemplateEditor(editor => editor ? { ...editor, name: e.target.value } : editor)} />
                  </div>
                  <textarea className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" rows={3} placeholder="description" value={templateEditor.description} onChange={e => setTemplateEditor(editor => editor ? { ...editor, description: e.target.value } : editor)} />
                  <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={templateEditor.is_default} onChange={e => setTemplateEditor(editor => editor ? { ...editor, is_default: e.target.checked } : editor)} />Make default status template for this sprint type</label>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between"><h4 className="text-sm font-semibold text-white">Statuses</h4><Button size="sm" variant="secondary" onClick={() => setTemplateEditor(editor => editor ? { ...editor, statuses: [...editor.statuses, { status_key: '', label: '', color: 'slate', terminal: false, is_default_entry: false }] } : editor)}><Plus className="w-3.5 h-3.5" />Add status</Button></div>
                    {templateEditor.statuses.map((status, index) => {
                      const isLockedLiveStatus = editingTemplateActiveUsage > 0 && lockedExistingStatusKeys.has(status.status_key);
                      return (
                        <div key={index} className="rounded-xl border border-slate-700 bg-slate-950/70 p-3 space-y-3">
                          <div className="grid gap-3 md:grid-cols-3">
                            <input className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white disabled:text-slate-500" placeholder="status key" value={status.status_key} disabled={isLockedLiveStatus} onChange={e => setTemplateEditor(editor => editor ? { ...editor, statuses: editor.statuses.map((item, itemIndex) => itemIndex === index ? { ...item, status_key: e.target.value } : item) } : editor)} />
                            <input className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" placeholder="label" value={status.label} onChange={e => setTemplateEditor(editor => editor ? { ...editor, statuses: editor.statuses.map((item, itemIndex) => itemIndex === index ? { ...item, label: e.target.value } : item) } : editor)} />
                            <input className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" placeholder="color" value={status.color} onChange={e => setTemplateEditor(editor => editor ? { ...editor, statuses: editor.statuses.map((item, itemIndex) => itemIndex === index ? { ...item, color: e.target.value } : item) } : editor)} />
                          </div>
                          <div className="flex flex-wrap gap-4">
                            <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={status.terminal} onChange={e => setTemplateEditor(editor => editor ? { ...editor, statuses: editor.statuses.map((item, itemIndex) => itemIndex === index ? { ...item, terminal: e.target.checked } : item) } : editor)} />Terminal</label>
                            <label className="flex items-center gap-2 text-sm text-slate-300"><input type="radio" checked={status.is_default_entry} name="default-entry" onChange={() => setTemplateEditor(editor => editor ? { ...editor, statuses: editor.statuses.map((item, itemIndex) => ({ ...item, is_default_entry: itemIndex === index })) } : editor)} />Default entry</label>
                            <Button size="sm" variant="ghost" disabled={isLockedLiveStatus} onClick={() => setTemplateEditor(editor => editor ? { ...editor, statuses: editor.statuses.filter((_, itemIndex) => itemIndex !== index) } : editor)}><Trash2 className="w-3.5 h-3.5" />Remove</Button>
                            {isLockedLiveStatus && <span className="text-xs text-rose-200">Live status keys are locked</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between"><h4 className="text-sm font-semibold text-white">Transitions</h4><Button size="sm" variant="secondary" onClick={() => setTemplateEditor(editor => editor ? { ...editor, transitions: [...editor.transitions, { transition_key: '', from_status_key: '', to_status_key: '', label: '', outcome: '' }] } : editor)}><Plus className="w-3.5 h-3.5" />Add transition</Button></div>
                    {templateEditor.transitions.map((transition, index) => (
                      <div key={index} className="rounded-xl border border-slate-700 bg-slate-950/70 p-3 space-y-3">
                        <div className="grid gap-3 md:grid-cols-2">
                          <input className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" placeholder="transition key" value={transition.transition_key} onChange={e => setTemplateEditor(editor => editor ? { ...editor, transitions: editor.transitions.map((item, itemIndex) => itemIndex === index ? { ...item, transition_key: e.target.value } : item) } : editor)} />
                          <input className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" placeholder="label" value={transition.label} onChange={e => setTemplateEditor(editor => editor ? { ...editor, transitions: editor.transitions.map((item, itemIndex) => itemIndex === index ? { ...item, label: e.target.value } : item) } : editor)} />
                        </div>
                        <div className="grid gap-3 md:grid-cols-3">
                          <input className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" placeholder="from status" value={transition.from_status_key} onChange={e => setTemplateEditor(editor => editor ? { ...editor, transitions: editor.transitions.map((item, itemIndex) => itemIndex === index ? { ...item, from_status_key: e.target.value } : item) } : editor)} />
                          <input className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" placeholder="to status" value={transition.to_status_key} onChange={e => setTemplateEditor(editor => editor ? { ...editor, transitions: editor.transitions.map((item, itemIndex) => itemIndex === index ? { ...item, to_status_key: e.target.value } : item) } : editor)} />
                          <input className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" placeholder="outcome" value={transition.outcome} onChange={e => setTemplateEditor(editor => editor ? { ...editor, transitions: editor.transitions.map((item, itemIndex) => itemIndex === index ? { ...item, outcome: e.target.value } : item) } : editor)} />
                        </div>
                        <Button size="sm" variant="ghost" onClick={() => setTemplateEditor(editor => editor ? { ...editor, transitions: editor.transitions.filter((_, itemIndex) => itemIndex !== index) } : editor)}><Trash2 className="w-3.5 h-3.5" />Remove</Button>
                      </div>
                    ))}
                  </div>

                  <Button variant="primary" loading={saving === 'template'} onClick={saveTemplate}>Save status template</Button>
                </div>
              )}
            </Card>
          </div>
        ) : (
          <Card><p className="text-sm text-slate-400">Select a sprint type to configure it.</p></Card>
        )}
      </div>
    </div>
  );
}
