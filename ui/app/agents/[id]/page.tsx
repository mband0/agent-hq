'use client';
import { formatDateTime, formatTime } from '@/lib/date';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { api, Agent, JobInstance, LogEntry, AgentDoc, ProvisionStatus, ClaudeMdResult, Tool, AgentToolAssignment, AgentMcpAssignment, ClaudeCodeRuntimeConfig, McpServer, ProviderRecord } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ArrowLeft, Bot, Clock, Activity, FileText, Zap, CheckCircle, AlertCircle, Loader2,
  Link2, RefreshCw, Edit2, Save, X, Pencil, Trash2, Power, Settings, BookOpen,
  Wrench, Plus, Search, ChevronDown, ChevronRight, Server,
} from 'lucide-react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  getAgentModelLabel,
  getAgentModelOptionsForProvider,
  getAgentProviderOptions,
  isLocalModelProvider,
  isDynamicModelProvider,
  isOpenClawOnlyProvider,
  isModelAllowedForProvider,
  isProviderConnected,
  PROVIDER_LABELS,
} from '@/lib/providerOptions';

// ─── Edit form state ──────────────────────────────────────────────────────────

const EFFORT_OPTIONS = ['low', 'medium', 'high', 'max'] as const;

const RUNTIME_TYPE_OPTIONS = [
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'veri', label: 'Custom (Agent Runtime)' },
] as const;

interface EditFormState {
  // Core agent fields
  name: string;
  role: string;
  session_key: string;
  workspace_path: string;
  repo_path: string;
  status: 'idle' | 'running' | 'blocked';
  model: string;
  preferred_provider: string;
  runtime_type: 'openclaw' | 'claude-code' | 'webhook' | 'veri';
  runtime_config: ClaudeCodeRuntimeConfig;
  raw_json: string;
  raw_json_expanded: boolean;
  // Job / execution fields (T#619)
  job_title: string;
  schedule: string;
  pre_instructions: string;
  skill_names: string; // comma-separated in the input; serialised to array on save
  timeout_seconds: string; // stored as string for the input
  startup_grace_seconds: string; // stored as string for the input; empty = use global default
  heartbeat_stale_seconds: string; // stored as string for the input; empty = use global default
}

const emptyRuntimeConfig: ClaudeCodeRuntimeConfig = {
  workingDirectory: '',
  model: '',
  effort: 'medium',
  allowedTools: [],
  maxTurns: undefined,
  maxBudgetUsd: undefined,
  systemPromptSuffix: '',
};

function runtimeConfigToJson(cfg: ClaudeCodeRuntimeConfig): string {
  const out: Record<string, unknown> = { workingDirectory: cfg.workingDirectory };
  if (cfg.model) out.model = cfg.model;
  if (cfg.effort) out.effort = cfg.effort;
  if (cfg.allowedTools && cfg.allowedTools.length > 0) out.allowedTools = cfg.allowedTools;
  if (cfg.maxTurns) out.maxTurns = cfg.maxTurns;
  if (cfg.maxBudgetUsd) out.maxBudgetUsd = cfg.maxBudgetUsd;
  if (cfg.systemPromptSuffix) out.systemPromptSuffix = cfg.systemPromptSuffix;
  return JSON.stringify(out, null, 2);
}

function agentToForm(agent: Agent): EditFormState {
  const rc = agent.runtime_config ?? { ...emptyRuntimeConfig };
  const runtimeType = agent.runtime_type ?? 'openclaw';
  return {
    name: agent.name,
    role: agent.role ?? '',
    session_key: agent.session_key,
    workspace_path: agent.workspace_path,
    repo_path: agent.repo_path ?? '',
    status: agent.status,
    model: agent.model ?? '',
    preferred_provider: agent.preferred_provider ?? 'anthropic',
    runtime_type: runtimeType,
    runtime_config: {
      workingDirectory: rc.workingDirectory ?? '',
      model: rc.model ?? '',
      effort: rc.effort ?? 'medium',
      allowedTools: rc.allowedTools ?? [],
      maxTurns: rc.maxTurns,
      maxBudgetUsd: rc.maxBudgetUsd,
      systemPromptSuffix: rc.systemPromptSuffix ?? '',
    },
    raw_json: runtimeType === 'claude-code' ? runtimeConfigToJson(rc) : '',
    raw_json_expanded: false,
    job_title: agent.job_title ?? '',
    schedule: agent.schedule ?? '',
    pre_instructions: agent.pre_instructions ?? '',
    skill_names: (agent.skill_names ?? []).join(', '),
    timeout_seconds: agent.timeout_seconds ? String(agent.timeout_seconds) : '900',
    startup_grace_seconds: agent.startup_grace_seconds ? String(agent.startup_grace_seconds) : '',
    heartbeat_stale_seconds: agent.heartbeat_stale_seconds ? String(agent.heartbeat_stale_seconds) : '',
  };
}

// ─── Provision UI state ───────────────────────────────────────────────────────

type ProvisionUIState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'success'; session_key: string; workspace_path: string }
  | { phase: 'error'; message: string };

// ─── Component ────────────────────────────────────────────────────────────────

export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = Number(params.id);

  const [agent, setAgent] = useState<Agent | null>(null);
  const [instances, setInstances] = useState<JobInstance[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [docs, setDocs] = useState<AgentDoc[]>([]);
  const [activeDoc, setActiveDoc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [provisionStatus, setProvisionStatus] = useState<ProvisionStatus | null>(null);
  const [provisionUI, setProvisionUI] = useState<ProvisionUIState>({ phase: 'idle' });

  // Edit mode (T#619)
  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState<EditFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [localMlxOnline, setLocalMlxOnline] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [dynamicModels, setDynamicModels] = useState<Array<{ id: string; label: string }>>([]);
  const [dynamicModelsLoading, setDynamicModelsLoading] = useState(false);
  const [dynamicModelsError, setDynamicModelsError] = useState<string | null>(null);

  // Capabilities (assigned tools)
  const [agentTools, setAgentTools] = useState<AgentToolAssignment[]>([]);
  const [allTools, setAllTools] = useState<Tool[]>([]);
  const [showAddTool, setShowAddTool] = useState(false);
  const [toolSearch, setToolSearch] = useState('');
  const [addingTool, setAddingTool] = useState<number | null>(null);
  const [removingTool, setRemovingTool] = useState<number | null>(null);

  // Capabilities (assigned MCP servers)
  const [agentMcpServers, setAgentMcpServers] = useState<AgentMcpAssignment[]>([]);
  const [allMcpServers, setAllMcpServers] = useState<McpServer[]>([]);
  const [showAddMcpServer, setShowAddMcpServer] = useState(false);
  const [mcpSearch, setMcpSearch] = useState('');
  const [addingMcpServer, setAddingMcpServer] = useState<number | null>(null);
  const [removingMcpServer, setRemovingMcpServer] = useState<number | null>(null);

  // Capabilities (assigned skills)
  const [allSkills, setAllSkills] = useState<import('@/lib/api').SkillEntry[]>([]);
  const [showAddSkill, setShowAddSkill] = useState(false);
  const [skillSearch, setSkillSearch] = useState('');
  const [addingSkill, setAddingSkill] = useState<string | null>(null);
  const [removingSkill, setRemovingSkill] = useState<string | null>(null);

  // CLAUDE.md state
  const [claudeMd, setClaudeMd] = useState<ClaudeMdResult | null>(null);
  const [claudeMdLoading, setClaudeMdLoading] = useState(false);
  const [claudeMdError, setClaudeMdError] = useState<string | null>(null);
  const [claudeMdEditing, setClaudeMdEditing] = useState(false);
  const [claudeMdEditValue, setClaudeMdEditValue] = useState('');
  const [claudeMdSaving, setClaudeMdSaving] = useState(false);
  const [claudeMdSaveError, setClaudeMdSaveError] = useState<string | null>(null);
  const [claudeMdRegening, setClaudeMdRegening] = useState(false);
  const [claudeMdRegenError, setClaudeMdRegenError] = useState<string | null>(null);

  // hooks_url inline editor
  const [hooksUrlEditing, setHooksUrlEditing] = useState(false);
  const [hooksUrlValue, setHooksUrlValue] = useState('');
  const [hooksUrlSaving, setHooksUrlSaving] = useState(false);
  const [hooksUrlError, setHooksUrlError] = useState<string | null>(null);
  const hooksUrlInputRef = useRef<HTMLInputElement>(null);

  // Delete state
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // ── Loaders ─────────────────────────────────────────────────────────────────

  const loadProvisionStatus = () => {
    api.getProvisionStatus(id)
      .then(s => setProvisionStatus(s))
      .catch(() => setProvisionStatus(null));
  };

  const loadClaudeMd = (agentRuntimeType?: string) => {
    const rt = agentRuntimeType ?? agent?.runtime_type;
    if (rt !== 'claude-code') return;
    setClaudeMdLoading(true);
    setClaudeMdError(null);
    api.getClaudeMd(id)
      .then(r => setClaudeMd(r))
      .catch(e => {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('does not exist') || msg.includes('404')) {
          setClaudeMd({ exists: false, content: null, path: null, last_modified: null });
        } else {
          setClaudeMdError(msg);
        }
      })
      .finally(() => setClaudeMdLoading(false));
  };

  // ── Edit mode helpers ────────────────────────────────────────────────────────

  const enterEditMode = (a: Agent) => {
    setEditForm(agentToForm(a));
    setSaveError(null);
    setEditMode(true);
    // Check local-mlx status
    fetch('/api/local-mlx-status', { signal: AbortSignal.timeout(5000) })
      .then(r => r.json()).then((d: { online: boolean }) => setLocalMlxOnline(d.online))
      .catch(() => setLocalMlxOnline(false));
  };

  const cancelEdit = () => {
    setEditMode(false);
    setEditForm(null);
    setSaveError(null);
    // Strip ?mode=edit from URL
    router.replace(`/agents/${id}`);
  };

  const buildSavePayload = (form: EditFormState) => {
    const base: Record<string, unknown> = {
      name: form.name,
      role: form.role,
      session_key: form.session_key,
      workspace_path: form.workspace_path,
      repo_path: form.repo_path.trim() || null,
      status: form.status,
      model: form.model || null,
      preferred_provider: form.preferred_provider || 'anthropic',
      runtime_type: form.runtime_type,
      runtime_config: null as ClaudeCodeRuntimeConfig | null,
      // Job / execution fields (T#619)
      job_title: form.job_title,
      schedule: form.schedule,
      pre_instructions: form.pre_instructions,
      skill_names: form.skill_names
        ? form.skill_names.split(',').map(s => s.trim()).filter(Boolean)
        : [],
      timeout_seconds: form.timeout_seconds ? Number(form.timeout_seconds) : 900,
      startup_grace_seconds: form.startup_grace_seconds ? Number(form.startup_grace_seconds) : null,
      heartbeat_stale_seconds: form.heartbeat_stale_seconds ? Number(form.heartbeat_stale_seconds) : null,
    };

    if (form.runtime_type === 'claude-code') {
      if (form.raw_json_expanded) {
        base.runtime_config = JSON.parse(form.raw_json) as ClaudeCodeRuntimeConfig;
      } else {
        const cfg: ClaudeCodeRuntimeConfig = {
          workingDirectory: form.runtime_config.workingDirectory,
        };
        if (form.runtime_config.model) cfg.model = form.runtime_config.model;
        if (form.runtime_config.effort) cfg.effort = form.runtime_config.effort;
        if (form.runtime_config.allowedTools && form.runtime_config.allowedTools.length > 0) {
          cfg.allowedTools = form.runtime_config.allowedTools;
        }
        if (form.runtime_config.maxTurns) cfg.maxTurns = Number(form.runtime_config.maxTurns);
        if (form.runtime_config.maxBudgetUsd) cfg.maxBudgetUsd = Number(form.runtime_config.maxBudgetUsd);
        if (form.runtime_config.systemPromptSuffix) cfg.systemPromptSuffix = form.runtime_config.systemPromptSuffix;
        base.runtime_config = cfg;
      }
    }

    return base;
  };

  const handleSave = async () => {
    if (!editForm) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (!editForm.preferred_provider || !isProviderConnected(providers, editForm.preferred_provider)) {
        setSaveError('Select a connected provider in Settings → Providers before saving this agent.');
        setSaving(false);
        return;
      }
      if (editForm.model && !isModelAllowedForProvider(editForm.model, editForm.preferred_provider)) {
        setSaveError('Selected model is not available for the chosen connected provider.');
        setSaving(false);
        return;
      }

      // Validate claude-code required field
      if (editForm.runtime_type === 'claude-code' && !editForm.raw_json_expanded) {
        if (!editForm.runtime_config.workingDirectory.trim()) {
          setSaveError('Working Directory is required for Claude Code runtime.');
          setSaving(false);
          return;
        }
      }
      if (editForm.runtime_type === 'claude-code' && editForm.raw_json_expanded) {
        try {
          const parsed = JSON.parse(editForm.raw_json) as ClaudeCodeRuntimeConfig;
          if (!parsed.workingDirectory) {
            setSaveError('runtime_config.workingDirectory is required for claude-code runtime.');
            setSaving(false);
            return;
          }
        } catch {
          setSaveError('Invalid JSON in raw config editor.');
          setSaving(false);
          return;
        }
      }

      const payload = buildSavePayload(editForm);
      const updated = await api.updateAgent(id, payload as Partial<Agent>);
      setAgent(updated);
      setEditMode(false);
      setEditForm(null);
      router.replace(`/agents/${id}`);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // ── CLAUDE.md helpers ────────────────────────────────────────────────────────

  const saveClaudeMd = async () => {
    setClaudeMdSaving(true);
    setClaudeMdSaveError(null);
    try {
      const updated = await api.updateClaudeMd(id, claudeMdEditValue);
      setClaudeMd(updated);
      setClaudeMdEditing(false);
    } catch (e) {
      setClaudeMdSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setClaudeMdSaving(false);
    }
  };

  const regenClaudeMd = async () => {
    if (!confirm('This will overwrite your manual edits. Continue?')) return;
    setClaudeMdRegening(true);
    setClaudeMdRegenError(null);
    try {
      const updated = await api.regenClaudeMd(id);
      setClaudeMd(updated);
      setClaudeMdEditing(false);
    } catch (e) {
      setClaudeMdRegenError(e instanceof Error ? e.message : String(e));
    } finally {
      setClaudeMdRegening(false);
    }
  };

  const startEditHooksUrl = () => {
    setHooksUrlValue(agent?.hooks_url ?? '');
    setHooksUrlError(null);
    setHooksUrlEditing(true);
    setTimeout(() => hooksUrlInputRef.current?.focus(), 50);
  };

  const saveHooksUrl = async () => {
    if (!agent) return;
    setHooksUrlSaving(true);
    setHooksUrlError(null);
    try {
      const trimmed = hooksUrlValue.trim();
      const updated = await api.updateAgent(id, { hooks_url: trimmed || null });
      setAgent(updated);
      setHooksUrlEditing(false);
    } catch (e) {
      setHooksUrlError(e instanceof Error ? e.message : String(e));
    } finally {
      setHooksUrlSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteAgent(id);
      router.push('/agents');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`Failed to delete agent: ${msg}`);
      setDeleting(false);
      setDeleteConfirmOpen(false);
    }
  };

  // ── Effects ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    Promise.all([
      api.getAgent(id),
      api.getInstances().then(all => all.filter(i => i.agent_id === id).slice(0, 20)),
      api.getLogs({ agent_id: id, limit: 30 }),
      api.getAgentDocs(id),
      api.getAgentTools(id).catch(() => [] as AgentToolAssignment[]),
      api.getAgentMcpServers(id).catch(() => [] as AgentMcpAssignment[]),
      api.getTools().catch(() => [] as Tool[]),
      api.getMcpServers().catch(() => [] as McpServer[]),
      api.getProviders().catch(() => ({ providers: [] })),
      api.getSkills().catch(() => [] as import('@/lib/api').SkillEntry[]),
    ])
      .then(([a, inst, lg, d, atools, amcp, tools, mcpServers, providerResponse, skills]) => {
        setAgent(a);
        setInstances(inst);
        setLogs(lg);
        setDocs(d);
        setAgentTools(atools);
        setAgentMcpServers(amcp);
        setAllTools(tools);
        setAllMcpServers(mcpServers);
        setAllSkills(skills);
        setProviders(providerResponse.providers);
        const firstExisting = d.find((doc: AgentDoc) => doc.exists);
        if (firstExisting) setActiveDoc(firstExisting.filename);
        if (a.runtime_type === 'claude-code') loadClaudeMd('claude-code');
        // Auto-enter edit mode if ?mode=edit is in the URL
        if (searchParams.get('mode') === 'edit') {
          enterEditMode(a);
        }
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));

    loadProvisionStatus();
  }, [id]);

  // Fetch dynamic models when MiniMax (or any dynamic-model provider) is selected in edit mode
  useEffect(() => {
    if (!editForm || !isDynamicModelProvider(editForm.preferred_provider)) {
      setDynamicModels([]);
      setDynamicModelsError(null);
      return;
    }
    setDynamicModelsLoading(true);
    setDynamicModelsError(null);
    api.getMiniMaxModels()
      .then(r => {
        setDynamicModels(r.models);
        setDynamicModelsLoading(false);
      })
      .catch(e => {
        setDynamicModelsError(e instanceof Error ? e.message : String(e));
        setDynamicModelsLoading(false);
      });
  }, [editForm?.preferred_provider]);

  const handleProvision = async () => {
    setProvisionUI({ phase: 'loading' });
    try {
      const result = await api.provisionAgent(id);
      setProvisionUI({
        phase: 'success',
        session_key: result.session_key,
        workspace_path: result.workspace_path,
      });
      setProvisionStatus({ provisioned: true, session_key: result.session_key, workspace_path: result.workspace_path });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setProvisionUI({ phase: 'error', message: msg });
    }
  };

  // ── Guards ───────────────────────────────────────────────────────────────────

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (error) return (
    <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error}</div>
  );

  if (!agent) return null;

  const isProvisioned = provisionStatus?.provisioned || (provisionUI.phase === 'success');
  const resolvedSessionKey = provisionUI.phase === 'success'
    ? provisionUI.session_key
    : provisionStatus?.session_key ?? null;
  const resolvedWorkspacePath = provisionUI.phase === 'success'
    ? provisionUI.workspace_path
    : provisionStatus?.workspace_path ?? null;

  // ── Edit mode render ─────────────────────────────────────────────────────────

  if (editMode && editForm) {
    const setF = (patch: Partial<EditFormState>) => setEditForm(f => f ? { ...f, ...patch } : f);
    const allProviderOptions = getAgentProviderOptions(providers);
    // Filter out OpenClaw-only providers (e.g. MiniMax) if the runtime is not OpenClaw
    const providerOptions = editForm.runtime_type === 'openclaw'
      ? allProviderOptions
      : allProviderOptions.filter(opt => !isOpenClawOnlyProvider(opt.value));
    const modelOptions = getAgentModelOptionsForProvider(editForm.preferred_provider);
    const currentModelUnavailable = !!editForm.model && !isModelAllowedForProvider(editForm.model, editForm.preferred_provider);

    return (
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={cancelEdit}>
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div className="flex items-center gap-2">
              <Pencil className="w-4 h-4 text-amber-400" />
              <h1 className="text-2xl font-bold text-white">Edit Agent</h1>
              <span className="text-slate-500 text-lg">—</span>
              <span className="text-xl text-slate-300">{agent.name}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={handleSave} loading={saving}>
              <Save className="w-4 h-4" /> Save Changes
            </Button>
            <Button variant="ghost" onClick={cancelEdit}>
              <X className="w-4 h-4" /> Cancel
            </Button>
          </div>
        </div>

        {saveError && (
          <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-4 text-red-300 text-sm">
            {saveError}
          </div>
        )}

        {/* Section 1: Core Identity */}
        <Card className="border-amber-500/20">
          <div className="flex items-center gap-2 mb-5">
            <Bot className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-white">Core Identity</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block">
              <span className="text-slate-400 text-xs mb-1 block">Name *</span>
              <input
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                value={editForm.name}
                onChange={e => setF({ name: e.target.value })}
                placeholder="Atlas"
              />
            </label>
            <label className="block md:col-span-2">
              <span className="text-slate-400 text-xs mb-1 block">Role</span>
              <input
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                value={editForm.role}
                onChange={e => setF({ role: e.target.value })}
                placeholder="General assistant — main session"
              />
            </label>

            {/* Runtime adapter — locked after creation */}
            <div className="block md:col-span-2">
              <span className="text-slate-400 text-xs mb-1 block">Runtime Adapter</span>
              <p className="text-slate-500 text-xs mb-1.5">
                Runtime type is locked after creation — changing it would break existing sessions and dispatch config.
              </p>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg">
                  <span className="text-white text-sm">
                    {RUNTIME_TYPE_OPTIONS.find(o => o.value === editForm.runtime_type)?.label ?? editForm.runtime_type}
                  </span>
                  <span className="text-xs text-slate-500 bg-slate-700 px-1.5 py-0.5 rounded">locked</span>
                </div>
              </div>
            </div>

            <label className="block">
              <span className="text-slate-400 text-xs mb-1 block">Preferred Provider</span>
              <p className="text-slate-500 text-xs mb-1.5">Only connected providers from Settings → Providers can be selected here.</p>
              <div className="relative">
                <select
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 appearance-none pr-8"
                  value={editForm.preferred_provider}
                  onChange={e => setF({ preferred_provider: e.target.value, model: '' })}
                  disabled={providerOptions.length === 0}
                >
                  {providerOptions.length === 0 ? (
                    <option value="">No connected providers</option>
                  ) : (
                    providerOptions.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))
                  )}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              </div>
            </label>
            <label className="block">
              <span className="text-slate-400 text-xs mb-1 block">Model</span>
              {isLocalModelProvider(editForm.preferred_provider) ? (
                <input
                  type="text"
                  value={editForm.model}
                  onChange={e => setF({ model: e.target.value })}
                  placeholder="e.g. llama3.2 or mlx-community/Mistral-7B"
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-amber-500"
                />
              ) : isDynamicModelProvider(editForm.preferred_provider) ? (
                <div className="relative">
                  {dynamicModelsLoading ? (
                    <div className="flex items-center gap-2 px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-slate-400 text-sm">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Fetching models…
                    </div>
                  ) : dynamicModelsError ? (
                    <div className="px-3 py-2 bg-red-900/20 border border-red-600/40 rounded-lg text-red-300 text-xs">
                      {dynamicModelsError}
                    </div>
                  ) : (
                    <>
                      <select
                        className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 appearance-none pr-8"
                        value={editForm.model}
                        onChange={e => setF({ model: e.target.value })}
                        disabled={dynamicModels.length === 0}
                      >
                        <option value="">Default (inherit)</option>
                        {dynamicModels.map(m => (
                          <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                    </>
                  )}
                </div>
              ) : (
                <div className="relative">
                  <select
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 appearance-none pr-8"
                    value={currentModelUnavailable ? '' : editForm.model}
                    onChange={e => setF({ model: e.target.value })}
                    disabled={!editForm.preferred_provider || modelOptions.length === 0}
                  >
                    <option value="">Default (inherit)</option>
                    {modelOptions.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                </div>
              )}
              {currentModelUnavailable && (
                <p className="text-amber-400 text-xs mt-1.5">Current saved model is no longer available for the selected connected provider. Pick a new one or use Default.</p>
              )}
            </label>
            <label className="block">
              <span className="text-slate-400 text-xs mb-1 block">Status</span>
              <div className="relative">
                <select
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 appearance-none pr-8"
                  value={editForm.status}
                  onChange={e => setF({ status: e.target.value as EditFormState['status'] })}
                >
                  <option value="idle">Idle</option>
                  <option value="running">Running</option>
                  <option value="blocked">Blocked</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              </div>
            </label>
          </div>

          {/* OpenClaw adapter config — scoped to openclaw runtime */}
          {editForm.runtime_type === 'openclaw' && (
            <div className="mt-4 p-4 bg-amber-950/20 border border-amber-500/20 rounded-lg">
              <span className="text-xs font-semibold text-amber-300 uppercase tracking-wider block mb-3">OpenClaw Adapter Config</span>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label className="block">
                  <span className="text-slate-400 text-xs mb-1 block">Session Key *</span>
                  <input
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 font-mono"
                    value={editForm.session_key}
                    onChange={e => setF({ session_key: e.target.value })}
                    placeholder="main"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-400 text-xs mb-1 block">Workspace Path</span>
                  <input
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 font-mono"
                    value={editForm.workspace_path}
                    onChange={e => setF({ workspace_path: e.target.value })}
                    placeholder="/path/to/workspace"
                  />
                </label>
              </div>
            </div>
          )}

          {/* Repo Path — available for workspace-based runtimes */}
          {(editForm.runtime_type === 'openclaw' || editForm.runtime_type === 'claude-code') && (
            <div className="mt-4">
              <label className="block">
                <span className="text-slate-400 text-xs mb-1 block">
                  Repo Path
                  <span className="text-slate-600 ml-1">(optional — worktree isolation)</span>
                </span>
                <input
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 font-mono"
                  value={editForm.repo_path}
                  onChange={e => setF({ repo_path: e.target.value })}
                  placeholder="/Users/…/atlas-hq"
                />
              </label>
            </div>
          )}


          {/* Claude Code runtime config */}
          {editForm.runtime_type === 'claude-code' && (
            <div className="mt-4 p-4 bg-purple-950/20 border border-purple-500/20 rounded-lg space-y-4">
              <span className="text-xs font-semibold text-purple-300 uppercase tracking-wider">Claude Code Config</span>
              {!editForm.raw_json_expanded && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <label className="block md:col-span-2">
                    <span className="text-slate-400 text-xs mb-1 block">Working Directory <span className="text-red-400">*</span></span>
                    <input
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500 font-mono"
                      value={editForm.runtime_config.workingDirectory}
                      onChange={e => setF({ runtime_config: { ...editForm.runtime_config, workingDirectory: e.target.value } })}
                      placeholder=".openclaw/workspace-<agent-slug>"
                    />
                  </label>
                  <label className="block">
                    <span className="text-slate-400 text-xs mb-1 block">Model</span>
                    <input
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500 font-mono"
                      value={editForm.runtime_config.model ?? ''}
                      onChange={e => setF({ runtime_config: { ...editForm.runtime_config, model: e.target.value } })}
                      placeholder="claude-sonnet-4-6"
                    />
                  </label>
                  <label className="block">
                    <span className="text-slate-400 text-xs mb-1 block">Effort Level</span>
                    <div className="relative">
                      <select
                        className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500 appearance-none pr-8"
                        value={editForm.runtime_config.effort ?? 'medium'}
                        onChange={e => setF({ runtime_config: { ...editForm.runtime_config, effort: e.target.value as ClaudeCodeRuntimeConfig['effort'] } })}
                      >
                        {EFFORT_OPTIONS.map(o => <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</option>)}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                    </div>
                  </label>
                  <label className="block">
                    <span className="text-slate-400 text-xs mb-1 block">Max Turns <span className="text-slate-600">(optional)</span></span>
                    <input
                      type="number"
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
                      value={editForm.runtime_config.maxTurns ?? ''}
                      onChange={e => setF({ runtime_config: { ...editForm.runtime_config, maxTurns: e.target.value ? Number(e.target.value) : undefined } })}
                      placeholder="e.g. 50"
                      min={1}
                    />
                  </label>
                  <label className="block">
                    <span className="text-slate-400 text-xs mb-1 block">Max Budget USD <span className="text-slate-600">(optional)</span></span>
                    <input
                      type="number"
                      step="0.01"
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
                      value={editForm.runtime_config.maxBudgetUsd ?? ''}
                      onChange={e => setF({ runtime_config: { ...editForm.runtime_config, maxBudgetUsd: e.target.value ? Number(e.target.value) : undefined } })}
                      placeholder="e.g. 5.00"
                    />
                  </label>
                  <label className="block md:col-span-2">
                    <span className="text-slate-400 text-xs mb-1 block">System Prompt Suffix <span className="text-slate-600">(optional)</span></span>
                    <textarea
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500 resize-y min-h-[60px]"
                      value={editForm.runtime_config.systemPromptSuffix ?? ''}
                      onChange={e => setF({ runtime_config: { ...editForm.runtime_config, systemPromptSuffix: e.target.value } })}
                      placeholder="Additional instructions appended to the system prompt…"
                    />
                  </label>
                  <label className="block md:col-span-2">
                    <span className="text-slate-400 text-xs mb-1 block">Allowed Tools <span className="text-slate-600">(comma-separated)</span></span>
                    <input
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500 font-mono"
                      value={(editForm.runtime_config.allowedTools ?? []).join(', ')}
                      onChange={e => setF({
                        runtime_config: {
                          ...editForm.runtime_config,
                          allowedTools: e.target.value ? e.target.value.split(',').map(t => t.trim()).filter(Boolean) : [],
                        }
                      })}
                      placeholder="Bash, Read, Write, Edit"
                    />
                  </label>
                </div>
              )}
              <div className="border-t border-purple-500/10 pt-3">
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-xs text-purple-400 hover:text-purple-300 transition-colors"
                  onClick={() => {
                    if (!editForm.raw_json_expanded) {
                      setF({ raw_json: runtimeConfigToJson(editForm.runtime_config), raw_json_expanded: true });
                    } else {
                      setF({ raw_json_expanded: false });
                    }
                  }}
                >
                  <ChevronRight className={`w-3.5 h-3.5 transition-transform ${editForm.raw_json_expanded ? 'rotate-90' : ''}`} />
                  Raw JSON editor {editForm.raw_json_expanded ? '(collapse)' : '(advanced)'}
                </button>
                {editForm.raw_json_expanded && (
                  <textarea
                    className="mt-2 w-full bg-slate-900 border border-purple-500/30 rounded-lg px-3 py-2 text-purple-200 text-xs font-mono focus:outline-none focus:border-purple-400 resize-y min-h-[140px]"
                    value={editForm.raw_json}
                    onChange={e => setF({ raw_json: e.target.value })}
                    spellCheck={false}
                  />
                )}
              </div>
            </div>
          )}
        </Card>

        {/* Section 2: Job & Execution */}
        <Card className="border-amber-500/20">
          <div className="flex items-center gap-2 mb-5">
            <Settings className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-white">Job & Execution</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block md:col-span-2">
              <span className="text-slate-400 text-xs mb-1 block">Lane / Role Title</span>
              <input
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                value={editForm.job_title}
                onChange={e => setF({ job_title: e.target.value })}
                placeholder="e.g. Fullstack Engineer — Agency"
              />
            </label>
            <label className="block">
              <span className="text-slate-400 text-xs mb-1 block">
                Schedule
                <span className="text-slate-600 ml-1">(cron expression — leave blank for manual only)</span>
              </span>
              <input
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 font-mono"
                value={editForm.schedule}
                onChange={e => setF({ schedule: e.target.value })}
                placeholder="0 9 * * 1-5"
              />
            </label>
            {/* Timeouts sub-section */}
            <div className="md:col-span-2 border border-slate-700/60 rounded-lg p-4 bg-slate-800/40">
              <p className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-3">Timeouts</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <label className="block">
                  <span className="text-slate-400 text-xs mb-1 block">
                    Startup grace (seconds)
                    <span className="text-slate-600 ml-1">(default: 300 = 5 min)</span>
                  </span>
                  <input
                    type="number"
                    min={30}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                    value={editForm.startup_grace_seconds}
                    onChange={e => setF({ startup_grace_seconds: e.target.value })}
                    placeholder="300"
                  />
                  {editForm.startup_grace_seconds && Number(editForm.startup_grace_seconds) >= 30 && (
                    <p className="text-slate-600 text-xs mt-1">≈ {Math.round(Number(editForm.startup_grace_seconds) / 60)} min</p>
                  )}
                  <p className="text-slate-600 text-xs mt-1">How long the agent has to send its first check-in signal after dispatch before being auto-failed. Leave blank to use global default.</p>
                </label>
                <label className="block">
                  <span className="text-slate-400 text-xs mb-1 block">
                    Heartbeat stale (seconds)
                    <span className="text-slate-600 ml-1">(default: 600 = 10 min)</span>
                  </span>
                  <input
                    type="number"
                    min={60}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                    value={editForm.heartbeat_stale_seconds}
                    onChange={e => setF({ heartbeat_stale_seconds: e.target.value })}
                    placeholder="600"
                  />
                  {editForm.heartbeat_stale_seconds && Number(editForm.heartbeat_stale_seconds) >= 60 && (
                    <p className="text-slate-600 text-xs mt-1">≈ {Math.round(Number(editForm.heartbeat_stale_seconds) / 60)} min</p>
                  )}
                  <p className="text-slate-600 text-xs mt-1">How long a running agent can go silent (no heartbeat or output) before being auto-failed. Leave blank to use global default.</p>
                </label>
                <label className="block">
                  <span className="text-slate-400 text-xs mb-1 block">
                    Execution timeout (seconds)
                    <span className="text-slate-600 ml-1">(default: 900 = 15 min)</span>
                  </span>
                  <input
                    type="number"
                    min={60}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                    value={editForm.timeout_seconds}
                    onChange={e => setF({ timeout_seconds: e.target.value })}
                    placeholder="900"
                  />
                  {editForm.timeout_seconds && Number(editForm.timeout_seconds) >= 60 && (
                    <p className="text-slate-600 text-xs mt-1">≈ {Math.round(Number(editForm.timeout_seconds) / 60)} min</p>
                  )}
                  <p className="text-slate-600 text-xs mt-1">Maximum total run time for a single agent session. The agent is killed if it exceeds this limit.</p>
                </label>
              </div>
            </div>
            <label className="block md:col-span-2">
              <span className="text-slate-400 text-xs mb-1 block">
                Capabilities / Skills
                <span className="text-slate-600 ml-1">(comma-separated skill names)</span>
              </span>
              <input
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                value={editForm.skill_names}
                onChange={e => setF({ skill_names: e.target.value })}
                placeholder="coding-agent, github, weather"
              />
              <p className="text-slate-600 text-xs mt-1">
                These are the skill names the agent is allowed to use during task runs.
              </p>
            </label>
            <label className="block md:col-span-2">
              <span className="text-slate-400 text-xs mb-1 block">
                Pre-instructions
                <span className="text-slate-600 ml-1">(optional — prepended to every task dispatch)</span>
              </span>
              <textarea
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 resize-y min-h-[120px]"
                value={editForm.pre_instructions}
                onChange={e => setF({ pre_instructions: e.target.value })}
                placeholder="You are the Juno fullstack engineer for the Agency project…"
              />
            </label>
          </div>
        </Card>

        {/* Save/Cancel footer */}
        <div className="flex items-center justify-between gap-2 pb-4">
          {saveError && (
            <p className="text-red-400 text-sm">{saveError}</p>
          )}
          <div className="flex gap-2 ml-auto">
            <Button variant="primary" onClick={handleSave} loading={saving}>
              <Save className="w-4 h-4" /> Save Changes
            </Button>
            <Button variant="ghost" onClick={cancelEdit}>
              <X className="w-4 h-4" /> Cancel
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ── View mode render ─────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => router.back()}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="flex items-center gap-2">
            <StatusDot status={agent.status} />
            <h1 className="text-2xl font-bold text-white">{agent.name}</h1>
          </div>
          <Badge variant={agent.status}>{agent.status}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => enterEditMode(agent)}>
            <Pencil className="w-3.5 h-3.5" /> Edit
          </Button>
          <Button variant="danger" size="sm" onClick={() => setDeleteConfirmOpen(true)}>
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </Button>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      {deleteConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <Card className="max-w-md w-full mx-4 border-red-500/30">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-red-900/30 rounded-lg">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Delete Agent</h3>
                <p className="text-sm text-slate-400">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-sm text-slate-300 mb-6">
              Are you sure you want to delete <strong className="text-white">{agent.name}</strong>? This will also delete all their runs, logs, and chat history.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDeleteConfirmOpen(false)} disabled={deleting}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" onClick={handleDelete} loading={deleting}>
                <Trash2 className="w-3.5 h-3.5" /> Delete Agent
              </Button>
            </div>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Agent info */}
        <Card className="lg:col-span-1">
          <div className="flex items-center gap-2 mb-4">
            <Bot className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-white">Agent Info</h2>
          </div>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-slate-500 text-xs mb-0.5">Session Key</dt>
              <dd><code className="text-amber-300">{agent.session_key}</code></dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs mb-0.5">Role</dt>
              <dd className="text-slate-300">{agent.role || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs mb-0.5">Provider</dt>
              <dd>
                {agent.preferred_provider
                  ? <span className="text-cyan-400 text-xs bg-cyan-500/10 px-1.5 py-0.5 rounded border border-cyan-500/20">
                      {PROVIDER_LABELS[agent.preferred_provider as keyof typeof PROVIDER_LABELS] ?? agent.preferred_provider}
                    </span>
                  : <span className="text-slate-500 text-xs">—</span>
                }
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs mb-0.5">Model</dt>
              <dd>
                {agent.model
                  ? <span className="text-indigo-400 font-mono text-xs bg-indigo-500/10 px-1.5 py-0.5 rounded border border-indigo-500/20">{getAgentModelLabel(agent.model)}</span>
                  : <span className="text-slate-500 text-xs">Default (inherited)</span>
                }
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs mb-0.5">Workspace</dt>
              <dd className="text-slate-400 font-mono text-xs break-all">{agent.workspace_path || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs mb-0.5 flex items-center gap-1">
                🌿 Repo Path
                <span className="text-slate-600 font-normal">(worktree isolation)</span>
              </dt>
              <dd>
                {agent.repo_path
                  ? <span className="text-emerald-400 font-mono text-xs break-all">{agent.repo_path}</span>
                  : <span className="text-slate-600 text-xs italic">Not set — disabled</span>
                }
              </dd>
            </div>

            {/* hooks_url inline editor */}
            <div>
              <dt className="text-slate-500 text-xs mb-0.5 flex items-center gap-1">
                <Link2 className="w-3 h-3" /> Hooks URL
                <span className="text-slate-600 font-normal">(container)</span>
              </dt>
              <dd>
                {hooksUrlEditing ? (
                  <div className="space-y-1">
                    <input
                      ref={hooksUrlInputRef}
                      type="url"
                      value={hooksUrlValue}
                      onChange={e => setHooksUrlValue(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveHooksUrl(); if (e.key === 'Escape') setHooksUrlEditing(false); }}
                      placeholder="http://localhost:3701"
                      className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100 font-mono focus:outline-none focus:border-amber-400"
                    />
                    <div className="flex items-center gap-1.5">
                      <button onClick={saveHooksUrl} disabled={hooksUrlSaving} className="px-2 py-0.5 text-xs bg-amber-500 hover:bg-amber-400 text-slate-900 font-semibold rounded disabled:opacity-50">
                        {hooksUrlSaving ? 'Saving…' : 'Save'}
                      </button>
                      <button onClick={() => setHooksUrlEditing(false)} className="px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200">Cancel</button>
                    </div>
                    {hooksUrlError && <p className="text-xs text-red-400">{hooksUrlError}</p>}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    {agent.hooks_url ? (
                      <code className="text-emerald-300 bg-emerald-900/20 border border-emerald-600/20 px-1.5 py-0.5 rounded text-xs break-all">{agent.hooks_url}</code>
                    ) : (
                      <span className="text-slate-500 text-xs italic">Host gateway (default)</span>
                    )}
                    <button onClick={startEditHooksUrl} className="text-xs text-amber-400 hover:text-amber-300 underline shrink-0">
                      {agent.hooks_url ? 'Edit' : 'Set'}
                    </button>
                  </div>
                )}
              </dd>
            </div>

            <div>
              <dt className="text-slate-500 text-xs mb-0.5">Last Active</dt>
              <dd className="text-slate-400">{agent.last_active ? formatDateTime(agent.last_active) : 'Never'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs mb-0.5">Created</dt>
              <dd className="text-slate-400">{formatDateTime(agent.created_at)}</dd>
            </div>

            {/* Provision status — only shown for OpenClaw runtime agents */}
            {(agent.runtime_type === 'openclaw' || !agent.runtime_type) && (
              <div className="pt-2 border-t border-slate-700/50">
                <dt className="text-slate-500 text-xs mb-1.5">OpenClaw Provision</dt>
                <dd>
                  {provisionStatus === null ? (
                    <span className="text-xs text-slate-500 italic">Status unavailable</span>
                  ) : isProvisioned ? (
                    <div className="space-y-2">
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-300 bg-emerald-900/30 border border-emerald-600/30 px-2 py-0.5 rounded-full">
                        <CheckCircle className="w-3 h-3" /> Provisioned
                      </span>
                      {resolvedSessionKey && (
                        <div className="text-xs text-slate-400 space-y-0.5">
                          <div>Session: <code className="text-amber-300 bg-slate-700 px-1 rounded">{resolvedSessionKey}</code></div>
                          {resolvedWorkspacePath && (
                            <div className="break-all">Workspace: <code className="text-slate-300 bg-slate-700 px-1 rounded">{resolvedWorkspacePath}</code></div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-400 bg-amber-900/20 border border-amber-600/30 px-2 py-0.5 rounded-full">
                        <AlertCircle className="w-3 h-3" /> Not provisioned
                      </span>
                      {provisionUI.phase === 'idle' && (
                        <Button variant="primary" onClick={handleProvision}>
                          <Zap className="w-3.5 h-3.5" /> Provision
                        </Button>
                      )}
                      {provisionUI.phase === 'loading' && (
                        <div className="flex items-center gap-1.5 text-xs text-amber-300">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Provisioning…
                        </div>
                      )}
                      {provisionUI.phase === 'error' && (
                        <div className="space-y-1">
                          <p className="text-xs text-red-400">{provisionUI.message}</p>
                          <Button variant="ghost" onClick={() => setProvisionUI({ phase: 'idle' })}>Retry</Button>
                        </div>
                      )}
                    </div>
                  )}
                </dd>
              </div>
            )}
          </dl>
        </Card>

        {/* Execution card */}
        <Card className="lg:col-span-2">
          <div className="flex items-center gap-2 mb-4">
            <Settings className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-white">Execution</h2>
            {agent.enabled != null && (
              <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full border ml-auto ${
                agent.enabled ? 'text-emerald-300 bg-emerald-900/30 border-emerald-600/30' : 'text-slate-500 bg-slate-800 border-slate-700'
              }`}>
                <Power className="w-2.5 h-2.5" />
                {agent.enabled ? 'Enabled' : 'Disabled'}
              </span>
            )}
          </div>
          {agent.job_title ? (
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div>
                <dt className="text-slate-500 text-xs mb-0.5">Lane</dt>
                <dd className="text-slate-300">{agent.job_title || '—'}</dd>
              </div>
              <div>
                <dt className="text-slate-500 text-xs mb-0.5">Schedule</dt>
                <dd>
                  {agent.schedule ? (
                    <code className="text-blue-300 bg-blue-500/10 px-1.5 py-0.5 rounded border border-blue-500/20 text-xs">{agent.schedule}</code>
                  ) : (
                    <span className="text-slate-500 text-xs">Manual only</span>
                  )}
                </dd>
              </div>
              <div className="md:col-span-2 border border-slate-700/40 rounded-lg p-3 bg-slate-800/30">
                <dt className="text-slate-500 text-xs font-semibold uppercase tracking-wider mb-2">Timeouts</dt>
                <dd className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  <div>
                    <p className="text-slate-500 mb-0.5">Startup grace</p>
                    <p className="text-slate-300">
                      {agent.startup_grace_seconds
                        ? `${agent.startup_grace_seconds}s (${Math.round(agent.startup_grace_seconds / 60)}m)`
                        : <span className="text-slate-500">Global default (5 min)</span>
                      }
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500 mb-0.5">Heartbeat stale</p>
                    <p className="text-slate-300">
                      {agent.heartbeat_stale_seconds
                        ? `${agent.heartbeat_stale_seconds}s (${Math.round(agent.heartbeat_stale_seconds / 60)}m)`
                        : <span className="text-slate-500">Global default (10 min)</span>
                      }
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500 mb-0.5">Execution timeout</p>
                    <p className="text-slate-300">
                      {agent.timeout_seconds
                        ? `${agent.timeout_seconds}s (${Math.round(agent.timeout_seconds / 60)}m)`
                        : <span className="text-slate-500">Default (15 min)</span>
                      }
                    </p>
                  </div>
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 text-xs mb-0.5">Sprint</dt>
                <dd className="text-slate-300">
                  {agent.sprint_id
                    ? <span className="text-xs text-purple-300 bg-purple-500/10 px-1.5 py-0.5 rounded border border-purple-500/20">Sprint #{agent.sprint_id}</span>
                    : <span className="text-slate-500 text-xs">None</span>
                  }
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 text-xs mb-0.5">Skills</dt>
                <dd>
                  {agent.skill_names && agent.skill_names.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {agent.skill_names.map((s: string) => (
                        <span key={s} className="text-xs text-violet-300 bg-violet-500/10 px-1.5 py-0.5 rounded border border-violet-500/20">
                          <BookOpen className="w-2.5 h-2.5 inline mr-0.5" />{s}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-slate-500 text-xs">None</span>
                  )}
                </dd>
              </div>
              {agent.pre_instructions && (
                <div className="md:col-span-2">
                  <dt className="text-slate-500 text-xs mb-0.5">Pre-instructions</dt>
                  <dd>
                    <pre className="text-xs text-slate-300 bg-slate-900/60 border border-slate-700/50 rounded-lg p-3 whitespace-pre-wrap break-words max-h-[200px] overflow-auto">
                      {agent.pre_instructions}
                    </pre>
                  </dd>
                </div>
              )}
            </dl>
          ) : (
            <div className="text-center py-6">
              <p className="text-slate-500 text-sm mb-3">No task template configured for this agent.</p>
              <Button variant="secondary" size="sm" onClick={() => enterEditMode(agent)}>
                <Pencil className="w-3.5 h-3.5" /> Configure Agent Settings
              </Button>
            </div>
          )}
        </Card>
      </div>

      {/* Capabilities — Skills + Tools */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-white">Capabilities</h2>
          </div>
        </div>

        {/* Skills sub-section */}
        <div className="mb-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <BookOpen className="w-3.5 h-3.5 text-violet-400" />
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Skills</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => { setShowAddSkill(v => !v); setSkillSearch(''); }}>
              <Plus className="w-3 h-3" /> Add Skill
            </Button>
          </div>

          {showAddSkill && (
            <div className="mb-3 bg-slate-800/60 border border-slate-700 rounded-xl p-3 space-y-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                <input
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-8 pr-3 py-1.5 text-white text-xs focus:outline-none focus:border-violet-500"
                  placeholder="Search skills…"
                  value={skillSearch}
                  onChange={e => setSkillSearch(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {allSkills
                  .filter(s => {
                    const alreadyAssigned = (agent.skill_names ?? []).includes(s.name);
                    const matchSearch = !skillSearch ||
                      s.name.toLowerCase().includes(skillSearch.toLowerCase()) ||
                      s.description.toLowerCase().includes(skillSearch.toLowerCase());
                    return !alreadyAssigned && matchSearch;
                  })
                  .map(skill => (
                    <button
                      key={skill.name}
                      disabled={addingSkill === skill.name}
                      onClick={async () => {
                        setAddingSkill(skill.name);
                        try {
                          const updated = await api.assignSkillToAgent(id, agent.skill_names ?? [], skill.name);
                          setAgent(updated);
                          setShowAddSkill(false);
                        } catch (e) {
                          alert(`Failed to assign skill: ${e}`);
                        } finally {
                          setAddingSkill(null);
                        }
                      }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-700 transition-colors text-left"
                    >
                      {addingSkill === skill.name
                        ? <Loader2 className="w-3.5 h-3.5 text-violet-400 animate-spin shrink-0" />
                        : <BookOpen className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                      }
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-white font-medium truncate">{skill.name}</p>
                        {skill.description && (
                          <p className="text-xs text-slate-500 truncate">{skill.description}</p>
                        )}
                      </div>
                    </button>
                  ))}
                {allSkills.filter(s =>
                  !(agent.skill_names ?? []).includes(s.name) &&
                  (!skillSearch || s.name.toLowerCase().includes(skillSearch.toLowerCase()) || s.description.toLowerCase().includes(skillSearch.toLowerCase()))
                ).length === 0 && (
                  <p className="text-xs text-slate-600 text-center py-2">No available skills</p>
                )}
              </div>
            </div>
          )}

          {agent.skill_names && agent.skill_names.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {agent.skill_names.map((s: string) => (
                <span key={s} className="inline-flex items-center gap-1 text-xs text-violet-300 bg-violet-500/10 px-2 py-1 rounded-lg border border-violet-500/20">
                  <Link href={`/skills/${encodeURIComponent(s)}`} className="flex items-center gap-1 hover:text-violet-200 transition-colors">
                    <BookOpen className="w-2.5 h-2.5" />{s}
                  </Link>
                  <button
                    disabled={removingSkill === s}
                    onClick={async () => {
                      setRemovingSkill(s);
                      try {
                        const updated = await api.removeSkillFromAgent(id, agent.skill_names ?? [], s);
                        setAgent(updated);
                      } catch (e) {
                        alert(`Failed to remove skill: ${e}`);
                      } finally {
                        setRemovingSkill(null);
                      }
                    }}
                    className="ml-0.5 text-slate-500 hover:text-red-400 transition-colors"
                  >
                    {removingSkill === s ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <X className="w-2.5 h-2.5" />}
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-slate-600 text-xs">No skills assigned</p>
          )}
        </div>

        {/* Tools sub-section */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Wrench className="w-3.5 h-3.5 text-amber-400" />
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Tools</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => { setShowAddTool(v => !v); setToolSearch(''); }}>
              <Plus className="w-3 h-3" /> Add Tool
            </Button>
          </div>

          {showAddTool && (
            <div className="mb-3 bg-slate-800/60 border border-slate-700 rounded-xl p-3 space-y-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                <input
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-8 pr-3 py-1.5 text-white text-xs focus:outline-none focus:border-amber-500"
                  placeholder="Search tools…"
                  value={toolSearch}
                  onChange={e => setToolSearch(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {allTools
                  .filter(t => {
                    const alreadyAssigned = agentTools.some(at => at.tool_id === t.id);
                    const matchSearch = !toolSearch ||
                      t.name.toLowerCase().includes(toolSearch.toLowerCase()) ||
                      t.slug.toLowerCase().includes(toolSearch.toLowerCase());
                    return !alreadyAssigned && matchSearch && t.enabled;
                  })
                  .map(tool => (
                    <button
                      key={tool.id}
                      disabled={addingTool === tool.id}
                      onClick={async () => {
                        setAddingTool(tool.id);
                        try {
                          const assignment = await api.assignToolToAgent(id, tool.id);
                          setAgentTools(prev => [...prev, assignment]);
                          setShowAddTool(false);
                        } catch (e) {
                          alert(`Failed to assign tool: ${e}`);
                        } finally {
                          setAddingTool(null);
                        }
                      }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-700 transition-colors text-left"
                    >
                      {addingTool === tool.id
                        ? <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />
                        : <Wrench className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      }
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-white font-medium truncate">{tool.name}</p>
                        <p className="text-xs text-slate-500 truncate">{tool.slug}</p>
                      </div>
                    </button>
                  ))}
                {allTools.filter(t => !agentTools.some(at => at.tool_id === t.id) && t.enabled &&
                  (!toolSearch || t.name.toLowerCase().includes(toolSearch.toLowerCase()) || t.slug.toLowerCase().includes(toolSearch.toLowerCase()))
                ).length === 0 && (
                  <p className="text-xs text-slate-600 text-center py-2">No available tools</p>
                )}
              </div>
            </div>
          )}

          {agentTools.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {agentTools.map(at => (
                <span key={at.assignment_id} className="inline-flex items-center gap-1 text-xs text-amber-300 bg-amber-500/10 px-2 py-1 rounded-lg border border-amber-500/20">
                  <Wrench className="w-2.5 h-2.5" />
                  {at.name}
                  <button
                    disabled={removingTool === at.tool_id}
                    onClick={async () => {
                      setRemovingTool(at.tool_id);
                      try {
                        // DELETE /agents/:agentId/tools/:toolId expects the real tool id.
                        await api.removeToolFromAgent(id, at.tool_id);
                        setAgentTools(prev => prev.filter(t => t.assignment_id !== at.assignment_id));
                      } catch (e) {
                        alert(`Failed to remove tool: ${e}`);
                      } finally {
                        setRemovingTool(null);
                      }
                    }}
                    className="ml-0.5 text-slate-500 hover:text-red-400 transition-colors"
                  >
                    {removingTool === at.tool_id ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <X className="w-2.5 h-2.5" />}
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-slate-600 text-xs">No tools assigned</p>
          )}
        </div>

        {/* MCP sub-section */}
        <div className="mt-5 pt-5 border-t border-slate-800/80">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Server className="w-3.5 h-3.5 text-cyan-400" />
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">MCP Servers</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => { setShowAddMcpServer(v => !v); setMcpSearch(''); }}>
              <Plus className="w-3 h-3" /> Add MCP
            </Button>
          </div>

          {showAddMcpServer && (
            <div className="mb-3 bg-slate-800/60 border border-slate-700 rounded-xl p-3 space-y-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                <input
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-8 pr-3 py-1.5 text-white text-xs focus:outline-none focus:border-cyan-500"
                  placeholder="Search MCP servers…"
                  value={mcpSearch}
                  onChange={e => setMcpSearch(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {allMcpServers
                  .filter(server => {
                    const alreadyAssigned = agentMcpServers.some(as => as.mcp_server_id === server.id);
                    const matchSearch = !mcpSearch
                      || server.name.toLowerCase().includes(mcpSearch.toLowerCase())
                      || server.slug.toLowerCase().includes(mcpSearch.toLowerCase());
                    return !alreadyAssigned && matchSearch && !!server.enabled;
                  })
                  .map(server => (
                    <button
                      key={server.id}
                      disabled={addingMcpServer === server.id}
                      onClick={async () => {
                        setAddingMcpServer(server.id);
                        try {
                          const assignment = await api.assignMcpServerToAgent(id, server.id);
                          setAgentMcpServers(prev => [...prev, assignment]);
                          setShowAddMcpServer(false);
                        } catch (e) {
                          alert(`Failed to assign MCP server: ${e}`);
                        } finally {
                          setAddingMcpServer(null);
                        }
                      }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-700 transition-colors text-left"
                    >
                      {addingMcpServer === server.id
                        ? <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin shrink-0" />
                        : <Server className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                      }
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-white font-medium truncate">{server.name}</p>
                        <p className="text-xs text-slate-500 truncate">{server.slug}</p>
                      </div>
                    </button>
                  ))}
                {allMcpServers.filter(server =>
                  !agentMcpServers.some(as => as.mcp_server_id === server.id)
                  && !!server.enabled
                  && (!mcpSearch || server.name.toLowerCase().includes(mcpSearch.toLowerCase()) || server.slug.toLowerCase().includes(mcpSearch.toLowerCase()))
                ).length === 0 && (
                  <p className="text-xs text-slate-600 text-center py-2">No available MCP servers</p>
                )}
              </div>
            </div>
          )}

          {agentMcpServers.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {agentMcpServers.map(server => (
                <span key={server.mcp_server_id} className="inline-flex items-center gap-1 text-xs text-cyan-300 bg-cyan-500/10 px-2 py-1 rounded-lg border border-cyan-500/20">
                  <Link href="/capabilities" className="flex items-center gap-1 hover:text-cyan-200 transition-colors">
                    <Server className="w-2.5 h-2.5" />{server.name}
                  </Link>
                  <button
                    disabled={removingMcpServer === server.mcp_server_id}
                    onClick={async () => {
                      setRemovingMcpServer(server.mcp_server_id);
                      try {
                        await api.removeMcpServerFromAgent(id, server.mcp_server_id);
                        setAgentMcpServers(prev => prev.filter(item => item.mcp_server_id !== server.mcp_server_id));
                      } catch (e) {
                        alert(`Failed to remove MCP server: ${e}`);
                      } finally {
                        setRemovingMcpServer(null);
                      }
                    }}
                    className="ml-0.5 text-slate-500 hover:text-red-400 transition-colors"
                  >
                    {removingMcpServer === server.mcp_server_id ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <X className="w-2.5 h-2.5" />}
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-slate-600 text-xs">No MCP servers assigned</p>
          )}
        </div>
      </Card>

      {/* Recent runs */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <Activity className="w-4 h-4 text-amber-400" />
          <h2 className="font-semibold text-white">Run History</h2>
        </div>
        {instances.length === 0 ? (
          <p className="text-slate-500 text-sm">No runs yet</p>
        ) : (
          <div className="space-y-2">
            {instances.map(inst => (
              <div key={inst.id} className="flex items-center gap-3 py-2 border-b border-slate-700/50 last:border-0">
                <Badge variant={inst.status}>{inst.status}</Badge>
                <span className="flex-1 text-sm text-slate-300 truncate">{inst.job_title ?? inst.agent_name ?? `Run #${inst.id}`}</span>
                <span className="text-xs text-slate-500">{formatDateTime(inst.created_at)}</span>
                <Link href={`/chat?agentId=${id}&instanceId=${inst.id}`} className="text-xs text-amber-400 hover:underline">View</Link>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Logs */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <Clock className="w-4 h-4 text-amber-400" />
          <h2 className="font-semibold text-white">Recent Logs</h2>
        </div>
        {logs.length === 0 ? (
          <p className="text-slate-500 text-sm">No logs yet</p>
        ) : (
          <div className="space-y-1 font-mono text-xs">
            {logs.map(log => (
              <div key={log.id} className="flex gap-3 items-start">
                <span className="text-slate-600 shrink-0">{formatTime(log.created_at)}</span>
                <Badge variant={log.level}>{log.level}</Badge>
                <span className={`flex-1 ${log.level === 'error' ? 'text-red-300' : log.level === 'warn' ? 'text-amber-300' : 'text-slate-300'}`}>{log.message}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* CLAUDE.md — only for claude-code agents */}
      {agent.runtime_type === 'claude-code' && (
        <Card>
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-purple-400" />
              <h2 className="font-semibold text-white">CLAUDE.md</h2>
              {claudeMd?.last_modified && (
                <span className="text-xs text-slate-500">Last updated: {formatDateTime(claudeMd.last_modified)}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {claudeMd?.exists && !claudeMdEditing && (
                <Button variant="ghost" size="sm" onClick={() => { setClaudeMdEditValue(claudeMd.content ?? ''); setClaudeMdSaveError(null); setClaudeMdEditing(true); }}>
                  <Edit2 className="w-3.5 h-3.5" /> Edit
                </Button>
              )}
              {claudeMdEditing && (
                <>
                  <Button variant="primary" size="sm" onClick={saveClaudeMd} loading={claudeMdSaving}>
                    <Save className="w-3.5 h-3.5" /> Save
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { setClaudeMdEditing(false); setClaudeMdSaveError(null); }}>
                    <X className="w-3.5 h-3.5" /> Cancel
                  </Button>
                </>
              )}
              <Button variant="ghost" size="sm" onClick={regenClaudeMd} disabled={claudeMdRegening}>
                {claudeMdRegening ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Regenerate
              </Button>
            </div>
          </div>

          {claudeMdLoading && (
            <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading CLAUDE.md…
            </div>
          )}
          {claudeMdError && !claudeMdLoading && (
            <div className="bg-red-900/20 border border-red-700/40 rounded-lg p-3 text-red-300 text-sm">{claudeMdError}</div>
          )}
          {claudeMdRegenError && (
            <div className="mb-3 bg-red-900/20 border border-red-700/40 rounded-lg p-3 text-red-300 text-sm">Regenerate failed: {claudeMdRegenError}</div>
          )}
          {!claudeMdLoading && !claudeMdError && claudeMd && !claudeMd.exists && (
            <div className="text-center py-8 text-slate-500 text-sm space-y-3">
              <FileText className="w-8 h-8 mx-auto text-slate-600" />
              <p>No CLAUDE.md found for this agent's workspace.</p>
              <p className="text-xs text-slate-600">Click Regenerate to create an auto-generated template.</p>
            </div>
          )}
          {!claudeMdLoading && !claudeMdError && claudeMdEditing && (
            <div className="space-y-2">
              <textarea
                className="w-full bg-slate-900 border border-purple-500/30 rounded-lg px-3 py-2 text-slate-100 text-xs font-mono focus:outline-none focus:border-purple-400 resize-y min-h-[300px]"
                value={claudeMdEditValue}
                onChange={e => setClaudeMdEditValue(e.target.value)}
                spellCheck={false}
              />
              {claudeMdSaveError && <p className="text-xs text-red-400">{claudeMdSaveError}</p>}
            </div>
          )}
          {!claudeMdLoading && !claudeMdError && claudeMd?.exists && !claudeMdEditing && (
            <pre className="bg-slate-900/60 border border-slate-700/50 rounded-lg p-4 text-xs font-mono text-slate-300 overflow-auto max-h-[500px] whitespace-pre-wrap break-words">
              {claudeMd.content}
            </pre>
          )}
        </Card>
      )}

      {/* Identity Documents */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <FileText className="w-4 h-4 text-amber-400" />
          <h2 className="font-semibold text-white">Identity Documents</h2>
        </div>
        {docs.filter(d => d.exists).length === 0 ? (
          <p className="text-slate-500 text-sm">No identity documents found for this workspace.</p>
        ) : (
          <>
            <div className="overflow-x-auto flex gap-1 pb-1 mb-4">
              {docs.filter(d => d.exists).map(doc => (
                <button
                  key={doc.filename}
                  onClick={() => setActiveDoc(doc.filename)}
                  className={`whitespace-nowrap px-3 py-1.5 rounded-md text-sm font-mono transition-colors ${
                    activeDoc === doc.filename
                      ? 'bg-amber-500 text-slate-900 font-semibold'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  {doc.filename}
                </button>
              ))}
            </div>
            {activeDoc && (() => {
              const doc = docs.find(d => d.filename === activeDoc);
              if (!doc || !doc.content) return null;
              return (
                <div className="prose prose-invert max-w-none text-sm overflow-auto max-h-[600px] pr-2
                  [&_h1]:text-white [&_h1]:text-lg [&_h1]:font-bold [&_h1]:mt-4 [&_h1]:mb-2
                  [&_h2]:text-white [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1
                  [&_h3]:text-white [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1
                  [&_p]:text-slate-300 [&_p]:leading-relaxed [&_p]:mb-2
                  [&_li]:text-slate-300 [&_li]:leading-relaxed
                  [&_ul]:my-2 [&_ul]:ml-4 [&_ul]:list-disc
                  [&_ol]:my-2 [&_ol]:ml-4 [&_ol]:list-decimal
                  [&_code]:text-amber-200 [&_code]:bg-slate-700 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs
                  [&_pre]:bg-slate-700/80 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:my-3
                  [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-amber-200
                  [&_a]:text-amber-400 [&_a]:underline hover:[&_a]:text-amber-300
                  [&_blockquote]:border-l-2 [&_blockquote]:border-slate-600 [&_blockquote]:pl-3 [&_blockquote]:text-slate-400 [&_blockquote]:italic
                  [&_hr]:border-slate-700
                  [&_strong]:text-slate-100 [&_em]:text-slate-300">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content}</ReactMarkdown>
                </div>
              );
            })()}
          </>
        )}
      </Card>
    </div>
  );
}
