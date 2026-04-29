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
  });

  it('treats adaptive thinking as the OpenClaw default and omits thinkingLevel', async () => {
    const runtime = new OpenClawRuntime();

    await runtime.dispatch(dispatchParams({
      model: 'openai-codex/gpt-5.4',
      thinking: 'adaptive',
    }));

    const patch = mockSentRequests.find((request) => request.method === 'sessions.patch');
    expect(patch?.params).toEqual({
      key: 'agent:cinder-backend:hook:atlas:jobrun:383',
      model: 'openai-codex/gpt-5.4',
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
  });

  it('passes the task worktree repo root as chat cwd and records both path roots in metadata', async () => {
    const runtime = new OpenClawRuntime();

    await runtime.dispatch(dispatchParams({
      workspaceRoot: '/Users/nordini/.openclaw/workspace-agent-hq-backend',
      activeRepoRoot: '/Users/nordini/.openclaw/workspace-agent-hq-backend/task-375',
    }));

    const send = mockSentRequests.find((request) => request.method === 'chat.send');
    expect(send?.params).toEqual(expect.objectContaining({
      sessionKey: 'agent:cinder-backend:hook:atlas:jobrun:383',
      message: 'Implement task',
      cwd: '/Users/nordini/.openclaw/workspace-agent-hq-backend/task-375',
      metadata: {
        activeRepoRoot: '/Users/nordini/.openclaw/workspace-agent-hq-backend/task-375',
        workspaceRoot: '/Users/nordini/.openclaw/workspace-agent-hq-backend',
      },
    }));
  });

  it('keeps chat cwd on activeRepoRoot even when workspaceRoot points at the parent workspace', async () => {
    const runtime = new OpenClawRuntime();

    await runtime.dispatch(dispatchParams({
      workspaceRoot: '/parent/workspace',
      activeRepoRoot: '/parent/workspace/task-375',
    }));

    const send = mockSentRequests.find((request) => request.method === 'chat.send');
    expect(send?.params).toEqual(expect.objectContaining({
      cwd: '/parent/workspace/task-375',
      metadata: {
        activeRepoRoot: '/parent/workspace/task-375',
        workspaceRoot: '/parent/workspace',
      },
    }));
  });
});
