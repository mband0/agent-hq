import { jest } from '@jest/globals';

const mockQuery = jest.fn();
const mockValidateAndLogViolation = jest.fn();
const mockFetchAgentTools = jest.fn(() => []);
const mockCreateAgentToolServer = jest.fn(() => null);

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

jest.mock('../lib/workspaceBoundary', () => ({
  validateAndLogViolation: (...args: unknown[]) => mockValidateAndLogViolation(...args),
}));

jest.mock('../lib/agentHqBaseUrl', () => ({
  getAgentHqBaseUrl: jest.fn(() => 'http://localhost:3501'),
}));

jest.mock('./toolInjection', () => ({
  fetchAgentTools: (...args: unknown[]) => mockFetchAgentTools(...args),
  createAgentToolServer: (...args: unknown[]) => mockCreateAgentToolServer(...args),
}));

import { ClaudeCodeRuntime } from './ClaudeCodeRuntime';

function createEmptyAsyncIterable() {
  return {
    async *[Symbol.asyncIterator]() {
      // no-op
    },
  };
}

describe('ClaudeCodeRuntime path handoff', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockValidateAndLogViolation.mockReset();
    mockFetchAgentTools.mockReset();
    mockFetchAgentTools.mockReturnValue([]);
    mockCreateAgentToolServer.mockReset();
    mockCreateAgentToolServer.mockReturnValue(null);
    mockQuery.mockReturnValue(createEmptyAsyncIterable());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prefers activeRepoRoot over runtimeConfig.workingDirectory for cwd and workspace env', async () => {
    const runtime = new ClaudeCodeRuntime({ workingDirectory: '/agent/default' });

    await runtime.dispatch({
      message: 'Implement task',
      agentSlug: 'cinder-backend',
      sessionKey: 'hook:atlas:jobrun:375',
      timeoutSeconds: 900,
      name: 'Cinder',
      instanceId: 375,
      taskId: 375,
      workspaceRoot: '/parent/workspace',
      activeRepoRoot: '/parent/workspace/task-375',
      runtimeConfig: { workingDirectory: '/wrong/root' },
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [{ options }] = mockQuery.mock.calls[0] as [{ options: { cwd?: string; env?: Record<string, string> } }];
    expect(options.cwd).toBe('/parent/workspace/task-375');
    expect(options.env?.ATLAS_WORKSPACE_ROOT).toBe('/parent/workspace');
    expect(options.env?.ATLAS_ACTIVE_REPO_ROOT).toBe('/parent/workspace/task-375');
  });

  it('keeps parent workspaceRoot as boundary while using activeRepoRoot as authoritative cwd', async () => {
    const runtime = new ClaudeCodeRuntime();

    await runtime.dispatch({
      message: 'Implement task',
      agentSlug: 'cinder-backend',
      sessionKey: 'hook:atlas:jobrun:375',
      timeoutSeconds: 900,
      name: 'Cinder',
      instanceId: 376,
      taskId: 375,
      workspaceRoot: '/parent/workspace',
      activeRepoRoot: '/parent/workspace/task-375',
      runtimeConfig: { workingDirectory: '/parent/workspace/task-375' },
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockValidateAndLogViolation).toHaveBeenCalledWith(
      expect.anything(),
      '/parent/workspace',
      '/parent/workspace/task-375',
      { instanceId: 376 },
    );
  });
});
