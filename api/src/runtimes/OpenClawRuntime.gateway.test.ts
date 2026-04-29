type SentRequest = {
  method: string;
  params: Record<string, unknown>;
};

const mockSentRequests: SentRequest[] = [];
let mockPatchShouldFail = false;

const mockSyncOAuthProviderForOpenClawAgent = jest.fn();

jest.mock('ws', () => {
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    readyState = MockWebSocket.OPEN;
    private handlers = new Map<string, Array<(value?: unknown) => void>>();

    constructor() {
      setImmediate(() => {
        this.emit('message', Buffer.from(JSON.stringify({
          type: 'event',
          event: 'connect.challenge',
          payload: { nonce: 'nonce' },
        })));
      });
    }

    on(event: string, handler: (value?: unknown) => void): this {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
      return this;
    }

    send(raw: string): void {
      const frame = JSON.parse(raw) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      mockSentRequests.push({ method: frame.method, params: frame.params });

      const response: Record<string, unknown> = {
        type: 'res',
        id: frame.id,
        payload: {},
      };

      if (frame.method === 'sessions.patch' && mockPatchShouldFail) {
        delete response.payload;
        response.error = { code: 'INVALID_REQUEST', message: 'bad runtime config' };
      } else if (frame.method === 'chat.send') {
        response.payload = { runId: 'run-123' };
      }

      setImmediate(() => {
        this.emit('message', Buffer.from(JSON.stringify(response)));
      });
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close');
    }

    private emit(event: string, value?: unknown): void {
      const handlers = this.handlers.get(event) ?? [];
      for (const handler of handlers) {
        handler(value);
      }
    }
  }

  return { WebSocket: MockWebSocket };
});

jest.mock('../lib/openclawOAuthProfiles', () => ({
  syncOAuthProviderForOpenClawAgent: (...args: unknown[]) => mockSyncOAuthProviderForOpenClawAgent(...args),
}));

import { OpenClawRuntime } from './OpenClawRuntime';

function dispatchParams(overrides: Partial<Parameters<OpenClawRuntime['dispatch']>[0]> = {}): Parameters<OpenClawRuntime['dispatch']>[0] {
  return {
    message: 'Implement task',
    agentSlug: 'cinder-backend',
    sessionKey: 'hook:atlas:jobrun:383',
    timeoutSeconds: 900,
    name: 'Cinder',
    ...overrides,
  };
}

describe('OpenClawRuntime gateway dispatch', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    mockSentRequests.length = 0;
    mockPatchShouldFail = false;
    mockSyncOAuthProviderForOpenClawAgent.mockResolvedValue({
      ok: true,
      provider: 'openai-codex',
      refreshed: false,
      updatedPaths: [],
    });
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('applies model and thinking through sessions.patch before chat.send', async () => {
    const runtime = new OpenClawRuntime();

    const result = await runtime.dispatch(dispatchParams({
      model: 'anthropic/claude-opus-4-6',
      thinking: 'high',
    }));

    expect(result.runId).toBe('run-123');
    expect(mockSentRequests.map((request) => request.method)).toEqual([
      'connect',
      'sessions.patch',
      'connect',
      'chat.send',
    ]);

    const patch = mockSentRequests.find((request) => request.method === 'sessions.patch');
    expect(patch?.params).toEqual({
      key: 'agent:cinder-backend:hook:atlas:jobrun:383',
      model: 'anthropic/claude-opus-4-6',
      thinkingLevel: 'high',
    });

    const send = mockSentRequests.find((request) => request.method === 'chat.send');
    expect(send?.params).toEqual(expect.objectContaining({
      sessionKey: 'agent:cinder-backend:hook:atlas:jobrun:383',
      message: 'Implement task',
      timeoutMs: 900_000,
    }));
    expect(send?.params).not.toHaveProperty('model');
    expect(send?.params).not.toHaveProperty('thinking');
    expect(send?.params).not.toHaveProperty('thinkingLevel');
    expect(send?.params).not.toHaveProperty('cwd');
    expect(send?.params).not.toHaveProperty('metadata');
  });

  it('treats adaptive thinking as the OpenClaw default and omits thinkingLevel', async () => {
    const runtime = new OpenClawRuntime();

    await runtime.dispatch(dispatchParams({
      model: 'openai-codex/gpt-5.5',
      thinking: 'adaptive',
    }));

    const patch = mockSentRequests.find((request) => request.method === 'sessions.patch');
    expect(patch?.params).toEqual({
      key: 'agent:cinder-backend:hook:atlas:jobrun:383',
      model: 'openai-codex/gpt-5.5',
    });
  });

  it('continues to chat.send when sessions.patch rejects optional overrides', async () => {
    mockPatchShouldFail = true;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = new OpenClawRuntime();

    const result = await runtime.dispatch(dispatchParams({
      model: 'anthropic/claude-opus-4-6',
      thinking: 'high',
    }));

    expect(result.runId).toBe('run-123');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to apply runtime routing overrides'));

    const send = mockSentRequests.find((request) => request.method === 'chat.send');
    expect(send?.params).toEqual(expect.objectContaining({
      sessionKey: 'agent:cinder-backend:hook:atlas:jobrun:383',
      message: 'Implement task',
    }));
    expect(send?.params).not.toHaveProperty('model');
    expect(send?.params).not.toHaveProperty('cwd');
    expect(send?.params).not.toHaveProperty('metadata');
  });

  it('adds active repo context to the initial message without chat.send cwd metadata', async () => {
    const runtime = new OpenClawRuntime();

    const result = await runtime.dispatch(dispatchParams({
      workspaceRoot: '/Users/nordini/.openclaw/workspace-agent-hq-backend',
      activeRepoRoot: '/Users/nordini/.openclaw/workspace-agent-hq-backend/task-375',
      repoAccessMode: 'worktree',
      repoSource: 'worktree:/Users/nordini/agent-hq',
      repoWorkspacePath: '/Users/nordini/.openclaw/workspace-agent-hq-backend/task-375',
      repoBranch: 'prism-frontend/task-386-bug-atlas-chat-panel-opens-with-floating',
      pathMetadata: {
        pathMode: 'worktree',
        repoRootSource: 'worktree',
        workspaceRootSource: 'workspace',
        worktreeRoot: '/Users/nordini/.openclaw/workspace-agent-hq-backend/task-375',
        runtimeConfigWorkingDirectory: '/Users/nordini/.openclaw/workspace-agent-hq-backend',
      },
    }));

    expect(result).toEqual({ runId: 'run-123' });

    const send = mockSentRequests.find((request) => request.method === 'chat.send');
    expect(send).toBeDefined();
    expect(send?.params).toEqual(expect.objectContaining({
      sessionKey: 'agent:cinder-backend:hook:atlas:jobrun:383',
      timeoutMs: 900_000,
    }));
    expect(send?.params).not.toHaveProperty('cwd');
    expect(send?.params).not.toHaveProperty('metadata');

    const message = String(send?.params.message);
    expect(message).toContain('Implement task');
    expect(message).toContain('## Active Repo Context');
    expect(message).toContain('Use this path as the current working directory for repo, file, and git operations:');
    expect(message).toContain('/Users/nordini/.openclaw/workspace-agent-hq-backend/task-375');
    expect(message).toContain('Repo access mode: worktree');
    expect(message).toContain('Path mode: worktree');
    expect(message).toContain('Repo source: worktree:/Users/nordini/agent-hq');
    expect(message).toContain('Prepared repo workspace: /Users/nordini/.openclaw/workspace-agent-hq-backend/task-375');
    expect(message).toContain('Branch: prism-frontend/task-386-bug-atlas-chat-panel-opens-with-floating');
    expect(message).toContain('Parent workspace root: /Users/nordini/.openclaw/workspace-agent-hq-backend');
    expect(message).toContain('Repo root source: worktree');
    expect(message).toContain('Workspace root source: workspace');

    expect(logSpy).toHaveBeenCalledWith(
      '[OpenClawRuntime] dispatch path resolution: sessionKey=agent:cinder-backend:hook:atlas:jobrun:383 mode=worktree cwd=/Users/nordini/.openclaw/workspace-agent-hq-backend/task-375 activeRepoRoot=/Users/nordini/.openclaw/workspace-agent-hq-backend/task-375 workspaceRoot=/Users/nordini/.openclaw/workspace-agent-hq-backend worktreeRoot=/Users/nordini/.openclaw/workspace-agent-hq-backend/task-375 runtimeConfigWorkingDirectory=/Users/nordini/.openclaw/workspace-agent-hq-backend repoRootSource=worktree workspaceRootSource=workspace',
    );
  });

  it('uses activeRepoRoot in prompt context when workspaceRoot points at the parent workspace', async () => {
    const runtime = new OpenClawRuntime();

    await runtime.dispatch(dispatchParams({
      workspaceRoot: '/parent/workspace',
      activeRepoRoot: '/parent/workspace/task-375',
      pathMetadata: {
        pathMode: 'worktree',
        repoRootSource: 'worktree',
        workspaceRootSource: 'workspace',
        worktreeRoot: '/parent/workspace/task-375',
        runtimeConfigWorkingDirectory: '/parent/workspace',
      },
    }));

    const send = mockSentRequests.find((request) => request.method === 'chat.send');
    expect(send).toBeDefined();
    expect(send?.params).not.toHaveProperty('cwd');
    expect(send?.params).not.toHaveProperty('metadata');

    const message = String(send?.params.message);
    expect(message).toContain('Use this path as the current working directory for repo, file, and git operations:\n/parent/workspace/task-375');
    expect(message).toContain('Active repo root: /parent/workspace/task-375');
    expect(message).toContain('Parent workspace root: /parent/workspace');
  });

  it('falls back to workspaceRoot in prompt context when no activeRepoRoot is provided', async () => {
    const runtime = new OpenClawRuntime();

    await runtime.dispatch(dispatchParams({
      workspaceRoot: '/parent/workspace',
      activeRepoRoot: null,
    }));

    const send = mockSentRequests.find((request) => request.method === 'chat.send');
    expect(send).toBeDefined();
    expect(send?.params).not.toHaveProperty('cwd');
    expect(send?.params).not.toHaveProperty('metadata');

    const message = String(send?.params.message);
    expect(message).toContain('Use this path as the current working directory for repo, file, and git operations:\n/parent/workspace');
    expect(message).toContain('Path mode: workspace-root');
    expect(message).toContain('Parent workspace root: /parent/workspace');
  });

  it('does not add repo context when no repo roots are provided', async () => {
    const runtime = new OpenClawRuntime();

    await runtime.dispatch(dispatchParams());

    const send = mockSentRequests.find((request) => request.method === 'chat.send');
    expect(send).toBeDefined();
    expect(send?.params).toEqual(expect.objectContaining({
      message: 'Implement task',
    }));
    expect(send?.params).not.toHaveProperty('cwd');
    expect(send?.params).not.toHaveProperty('metadata');
    expect(String(send?.params.message)).not.toContain('## Active Repo Context');
  });
});
