import fs from 'fs';
import os from 'os';
import path from 'path';


let buildContractInstructions: typeof import('./transportAdapters').buildContractInstructions;
type TransportContext = import('./transportAdapters').TransportContext;

const originalRoot = process.env.AGENT_CONTRACT_ROOT;
const originalCwd = process.cwd();
let tempDir: string;

function loadTransportAdapters() {
  let loaded: typeof import('./transportAdapters');
  jest.isolateModules(() => {
    loaded = require('./transportAdapters');
  });
  return loaded!;
}

beforeEach(() => {
  jest.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-contracts-'));
  process.env.AGENT_CONTRACT_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, 'generic.md'), '## Atlas HQ run contract for this dispatched instance\nSprint type: {{sprintType}}\nWorkflow lane: {{lane}}\nAgent: {{agentSlug}}\nTask ID: {{taskId}}\nBase URL: {{baseUrl}}\nUse ONE of these outcomes: {{validOutcomes}}\n', 'utf-8');
  fs.writeFileSync(path.join(tempDir, 'enhancements.md'), '## Atlas HQ enhancement contract for this dispatched instance\nSprint type: {{sprintType}}\nWorkflow lane: {{lane}}\nUse ONE of these outcomes: {{validOutcomes}}\nREQUIRED OUTPUTS FOR ENHANCEMENTS\nPOST {{baseUrl}}/api/v1/tasks/{{taskId}}/outcome\nchanged_by={{agentSlug}}\n', 'utf-8');

  ({ buildContractInstructions } = loadTransportAdapters());
});

function reloadWithContractRoot(contractRoot: string): void {
  jest.resetModules();
  process.env.AGENT_CONTRACT_ROOT = contractRoot;
  ({ buildContractInstructions } = loadTransportAdapters());
}

afterEach(() => {
  if (originalRoot == null) delete process.env.AGENT_CONTRACT_ROOT;
  else process.env.AGENT_CONTRACT_ROOT = originalRoot;
  process.chdir(originalCwd);
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
  const repoContractRoot = path.resolve(__dirname, '../../../../agent-contracts');

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

  it('falls back to generic when a sprint type has no dedicated template yet', () => {
    const devContract = buildContractInstructions(buildContext({ sprintType: 'dev' }));
    expect(devContract).toContain('## Atlas HQ run contract for this dispatched instance');
    expect(devContract).toContain('Sprint type: dev');
    expect(devContract).toContain('Workflow lane: implementation');
  });

  it('keeps proxy-managed dispatches on the runtime-managed contract path', () => {
    const contract = buildContractInstructions(buildContext({
      sprintType: 'enhancements',
      transportMode: 'proxy-managed',
      baseUrl: undefined,
    }));

    expect(contract).toContain('## Runtime: Proxy-Managed');
    expect(contract).toContain('atlas_lifecycle');
    expect(contract).not.toContain('## Atlas HQ enhancement contract for this dispatched instance');
  });

  it('ships the real enhancement template with lane expectations and evidence guidance', () => {
    reloadWithContractRoot(repoContractRoot);
    const repoTemplate = fs.readFileSync(path.join(repoContractRoot, 'enhancements.md'), 'utf-8');

    expect(repoTemplate).toContain('## Atlas HQ enhancement contract for this dispatched instance');
    expect(repoTemplate).toContain('Sprint type: {{sprintType}}');
    expect(repoTemplate).toContain('Workflow lane: {{lane}}');
    expect(repoTemplate).toContain('REQUIRED OUTPUTS FOR ENHANCEMENTS');
    expect(repoTemplate).toContain('EVIDENCE EXPECTATIONS FOR ENHANCEMENTS');
    expect(repoTemplate).toContain('{{pipelineReference}}');
  });
});
