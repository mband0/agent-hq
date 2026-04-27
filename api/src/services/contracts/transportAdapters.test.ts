import fs from 'fs';
import os from 'os';
import path from 'path';


let buildContractInstructions: typeof import('./transportAdapters').buildContractInstructions;
type TransportContext = import('./transportAdapters').TransportContext;

const originalRoot = process.env.AGENT_CONTRACT_ROOT;
let tempDir: string;

beforeEach(() => {
  jest.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-contracts-'));
  process.env.AGENT_CONTRACT_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, 'generic.md'), '## Atlas HQ run contract for this dispatched instance\nSprint type: {{sprintType}}\nWorkflow lane: {{lane}}\nAgent: {{agentSlug}}\nTask ID: {{taskId}}\nBase URL: {{baseUrl}}\nUse ONE of these outcomes: {{validOutcomes}}\n', 'utf-8');
  fs.writeFileSync(path.join(tempDir, 'enhancements.md'), '## Atlas HQ enhancement contract for this dispatched instance\nSprint type: {{sprintType}}\nWorkflow lane: {{lane}}\nUse ONE of these outcomes: {{validOutcomes}}\nREQUIRED OUTPUTS FOR ENHANCEMENTS\nPOST {{baseUrl}}/api/v1/tasks/{{taskId}}/outcome\nchanged_by={{agentSlug}}\n', 'utf-8');

  ({ buildContractInstructions } = require('./transportAdapters'));
});

afterEach(() => {
  if (originalRoot == null) delete process.env.AGENT_CONTRACT_ROOT;
  else process.env.AGENT_CONTRACT_ROOT = originalRoot;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

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
    expect(contract).toContain('completed_for_review, blocked, failed');
    expect(contract).toContain('http://localhost:3501/api/v1/tasks/369/outcome');
  });

  it('renders the placeholders used by the sprint template fixture', () => {
    const contract = buildContractInstructions(buildContext());

    expect(contract).toContain('cinder-backend');
    expect(contract).toContain('http://localhost:3501/api/v1/tasks/369/outcome');
    expect(contract).toContain('Workflow lane: implementation');
    expect(contract).toContain('Use ONE of these outcomes: completed_for_review, blocked, failed');
    expect(contract).not.toContain('{{agentSlug}}');
    expect(contract).not.toContain('{{baseUrl}}');
    expect(contract).not.toContain('{{lane}}');
    expect(contract).not.toContain('{{taskId}}');
    expect(contract).not.toContain('{{validOutcomes}}');
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
