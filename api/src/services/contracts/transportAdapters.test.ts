import { buildContractInstructions, type TransportContext } from './transportAdapters';

function buildContext(overrides: Partial<TransportContext> = {}): TransportContext {
  return {
    instanceId: 1667,
    taskId: 369,
    taskStatus: 'in_progress',
    taskType: 'backend',
    sprintType: 'enhancements',
    agentSlug: 'cinder-backend',
    sessionKey: 'hook:atlas:jobrun:1667',
    baseUrl: 'http://localhost:3501',
    transportMode: 'remote-direct',
    db: null,
    ...overrides,
  };
}

describe('transportAdapters sprint-type contract templates', () => {
  it('uses the sprint-type text template for remote-direct dispatches', () => {
    const contract = buildContractInstructions(buildContext());

    expect(contract).toContain('## Atlas HQ enhancement contract for this dispatched instance');
    expect(contract).toContain('Sprint type: enhancements');
    expect(contract).toContain('Workflow lane: implementation');
    expect(contract).toContain('REQUIRED OUTPUTS FOR ENHANCEMENTS');
    expect(contract).toContain('Use ONE of these outcomes: completed_for_review, blocked, failed');
    expect(contract).toContain('http://localhost:3501/api/v1/tasks/369/outcome');
  });

  it('falls back to the generic text template for unknown sprint types', () => {
    const contract = buildContractInstructions(buildContext({ sprintType: 'qa' }));

    expect(contract).toContain('## Atlas HQ run contract for this dispatched instance');
    expect(contract).toContain('Sprint type: qa');
    expect(contract).toContain('Use ONE of these outcomes: completed_for_review, blocked, failed');
  });

  it('uses the sprint-type text template for proxy-managed dispatches too', () => {
    const contract = buildContractInstructions(buildContext({
      sprintType: 'enhancements',
      transportMode: 'proxy-managed',
      baseUrl: undefined,
    }));

    expect(contract).toContain('## Atlas HQ enhancement contract for this dispatched instance');
    expect(contract).toContain('Workflow lane: implementation');
    expect(contract).not.toContain('## Runtime: Proxy-Managed');
  });
});
