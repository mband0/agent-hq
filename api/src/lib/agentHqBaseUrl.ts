export function getAgentHqBaseUrl(defaultValue = 'http://localhost:3501'): string {
  return (
    process.env.AGENT_HQ_INTERNAL_BASE_URL ??
    process.env.AGENT_HQ_API_URL ??
    process.env.AGENT_HQ_URL ??
    process.env.ATLAS_HQ_API_URL ??
    process.env.ATLAS_HQ_URL ??
    process.env.ATLAS_INTERNAL_BASE_URL ??
    defaultValue
  );
}
