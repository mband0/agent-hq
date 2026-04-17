'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, Save, ServerCog, TerminalSquare } from 'lucide-react';
import { api, type GatewayConfig, type GatewayRuntimeHint, type GatewayStatus } from '@/lib/api';

const RUNTIME_OPTIONS: Array<{ value: GatewayRuntimeHint; label: string }> = [
  { value: 'powershell', label: 'Windows PowerShell' },
  { value: 'wsl', label: 'WSL' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' },
  { value: 'external', label: 'Already running elsewhere' },
];

function commandBlock(runtimeHint: GatewayRuntimeHint): { title: string; lines: string[]; note: string } {
  switch (runtimeHint) {
    case 'powershell':
      return {
        title: 'Start OpenClaw from PowerShell',
        lines: [
          'npm install -g openclaw',
          'openclaw gateway run --port 18789',
        ],
        note: 'Run OpenClaw separately, then click Re-check below. Agent HQ will connect to the gateway but will not try to manage the process for you.',
      };
    case 'wsl':
      return {
        title: 'Start OpenClaw from WSL',
        lines: [
          'npm install -g openclaw',
          'openclaw gateway run --port 18789',
        ],
        note: 'If your WSL networking does not mirror localhost automatically, update the gateway URL here to the Windows-reachable host and port before re-checking.',
      };
    case 'macos':
      return {
        title: 'Start OpenClaw from macOS',
        lines: [
          'npm install -g openclaw',
          'openclaw gateway run --port 18789',
        ],
        note: 'Leave Agent HQ running, start OpenClaw in a separate terminal, then re-check the connection.',
      };
    case 'linux':
      return {
        title: 'Start OpenClaw from Linux',
        lines: [
          'npm install -g openclaw',
          'openclaw gateway run --port 18789',
        ],
        note: 'Leave Agent HQ running, start OpenClaw in a separate terminal, then re-check the connection.',
      };
    case 'external':
      return {
        title: 'Connect to an existing OpenClaw gateway',
        lines: [
          'Make sure the gateway is already running.',
          'Set the WebSocket URL below.',
          'Click Re-check to verify connectivity.',
        ],
        note: 'Use this when OpenClaw is managed outside Agent HQ, including remote hosts, containers, or another shell/session.',
      };
  }
}

function statusTone(status: GatewayStatus | null): { label: string; className: string } {
  if (!status) {
    return {
      label: 'Unknown',
      className: 'border-zinc-700 bg-zinc-800 text-zinc-300',
    };
  }
  switch (status.state) {
    case 'ready':
      return {
        label: 'Ready',
        className: 'border-emerald-700/50 bg-emerald-500/10 text-emerald-300',
      };
    case 'pairing_required':
      return {
        label: 'Pairing Required',
        className: 'border-amber-700/50 bg-amber-500/10 text-amber-300',
      };
    case 'auth_error':
      return {
        label: 'Auth Error',
        className: 'border-rose-700/50 bg-rose-500/10 text-rose-300',
      };
    case 'timeout':
      return {
        label: 'Timeout',
        className: 'border-amber-700/50 bg-amber-500/10 text-amber-300',
      };
    default:
      return {
        label: 'Offline',
        className: 'border-zinc-700 bg-zinc-800 text-zinc-300',
      };
  }
}

export default function SettingsGatewayPage() {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [wsUrl, setWsUrl] = useState('ws://127.0.0.1:18789');
  const [runtimeHint, setRuntimeHint] = useState<GatewayRuntimeHint>('powershell');
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);

  const guide = useMemo(() => commandBlock(runtimeHint), [runtimeHint]);
  const tone = statusTone(status);

  const load = async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const [cfg, nextStatus] = await Promise.all([
        api.getGatewayConfig(),
        api.getGatewayStatus(),
      ]);
      setConfig(cfg);
      setStatus(nextStatus);
      setWsUrl(cfg.ws_url);
      setRuntimeHint(cfg.runtime_hint);
      setDetails(nextStatus.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (showSpinner) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const next = await api.updateGatewayConfig({ ws_url: wsUrl, runtime_hint: runtimeHint });
      setConfig(next);
      setWsUrl(next.ws_url);
      setRuntimeHint(next.runtime_hint);
      setSuccess('Gateway settings saved.');
      const nextStatus = await api.getGatewayStatus();
      setStatus(nextStatus);
      setDetails(nextStatus.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleCheck = async () => {
    setChecking(true);
    setError(null);
    setSuccess(null);
    try {
      const nextStatus = await api.getGatewayStatus();
      setStatus(nextStatus);
      setDetails(nextStatus.error);
      setSuccess(nextStatus.state === 'ready' ? 'Gateway is reachable.' : 'Gateway check completed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await api.restartGateway();
      setSuccess(response.message ?? 'Gateway restart attempted.');
      setDetails(response.output ?? response.pairing_message ?? null);
      const nextStatus = await api.getGatewayStatus();
      setStatus(nextStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-2">
          <ServerCog className="h-5 w-5 text-zinc-300" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white">OpenClaw Gateway Setup</h2>
          <p className="text-sm text-zinc-400">
            Agent HQ connects to an existing OpenClaw gateway. Start OpenClaw yourself, then verify it here.
          </p>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-700/40 bg-rose-900/20 p-3 text-sm text-rose-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-700/40 bg-emerald-900/20 p-3 text-sm text-emerald-300">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.2fr,0.8fr]">
        <div className="space-y-6 rounded-xl border border-zinc-700/60 bg-zinc-800/50 p-6">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white">Connection</h3>
                <p className="text-xs leading-5 text-zinc-400">
                  Set the gateway URL Agent HQ should use, then run OpenClaw in a separate terminal.
                </p>
              </div>
              <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${tone.className}`}>
                {tone.label}
              </span>
            </div>

            <label className="block space-y-2">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">Gateway URL</span>
              <input
                value={wsUrl}
                onChange={(event) => setWsUrl(event.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white outline-none transition-colors focus:border-amber-400"
                placeholder="ws://127.0.0.1:18789"
              />
            </label>

            <div className="space-y-2">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">How are you running OpenClaw?</span>
              <div className="grid gap-2 sm:grid-cols-2">
                {RUNTIME_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setRuntimeHint(option.value)}
                    className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                      runtimeHint === option.value
                        ? 'border-amber-400 bg-amber-500/10 text-amber-300'
                        : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || loading}
                className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save Settings
              </button>
              <button
                type="button"
                onClick={handleCheck}
                disabled={checking || loading}
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Re-check Gateway
              </button>
              <button
                type="button"
                onClick={handleRestart}
                disabled={restarting || loading}
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {restarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ServerCog className="h-4 w-4" />}
                Try Local Restart
              </button>
            </div>

            {details && (
              <div className="rounded-lg border border-zinc-700 bg-zinc-900/80 p-3 text-xs leading-5 text-zinc-400">
                <div className="font-medium text-zinc-300">Last check</div>
                <div>{details}</div>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4 rounded-xl border border-zinc-700/60 bg-zinc-800/50 p-6">
          <div className="flex items-center gap-2">
            <TerminalSquare className="h-4 w-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-white">{guide.title}</h3>
          </div>
          <pre className="overflow-x-auto rounded-lg border border-zinc-700 bg-zinc-950 p-4 text-xs leading-6 text-zinc-200">
            {guide.lines.join('\n')}
          </pre>
          <p className="text-xs leading-5 text-zinc-400">{guide.note}</p>
          {config?.source === 'default' && (
            <p className="text-xs leading-5 text-zinc-500">
              Using the default gateway URL because no saved gateway configuration exists yet.
            </p>
          )}
          {loading && (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading gateway settings…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
