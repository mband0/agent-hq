import { getAgentHqBaseUrl } from './agentHqBaseUrl';

describe('getAgentHqBaseUrl', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('prefers AGENT_HQ_INTERNAL_BASE_URL over legacy Atlas vars', () => {
    process.env.AGENT_HQ_INTERNAL_BASE_URL = 'http://agent-hq-internal:3501';
    process.env.ATLAS_INTERNAL_BASE_URL = 'http://atlas-internal:3501';

    expect(getAgentHqBaseUrl()).toBe('http://agent-hq-internal:3501');
  });

  it('falls back to legacy Atlas vars when Agent HQ vars are not set', () => {
    delete process.env.AGENT_HQ_INTERNAL_BASE_URL;
    delete process.env.AGENT_HQ_API_URL;
    delete process.env.AGENT_HQ_URL;
    process.env.ATLAS_INTERNAL_BASE_URL = 'http://atlas-internal:3501';

    expect(getAgentHqBaseUrl()).toBe('http://atlas-internal:3501');
  });
});
