/**
 * runtimes/index.ts — Runtime registry.
 *
 * resolveRuntime() returns the correct AgentRuntime implementation for an agent
 * based on its runtime_type. The dispatcher calls this instead of importing
 * OpenClaw-specific functions directly.
 */

export type { AgentRuntime, DispatchParams, RuntimeEndEvent, RuntimeEndEventType, RuntimeEventCallbacks } from './types';

// Skill materialization — task #644
export {
  getSkillMaterializationAdapter,
  NoopSkillAdapter,
  FilesystemSkillAdapter,
  OpenClawSkillAdapter,
  ClaudeCodeSkillAdapter,
  PromptInjectionSkillAdapter,
} from './skillMaterialization';
export type {
  SkillMaterializationAdapter,
  MaterializationContext,
  MaterializationResult,
} from './skillMaterialization';
export { OpenClawRuntime, abortChatRunBySessionKey } from './OpenClawRuntime';
export type { AbortChatRunResult, AbortChatRunStatus } from './OpenClawRuntime';
export { ClaudeCodeRuntime } from './ClaudeCodeRuntime';
export type { ClaudeCodeRuntimeConfig } from './ClaudeCodeRuntime';
export { WebhookRuntime } from './WebhookRuntime';
export type { WebhookRuntimeConfig } from './WebhookRuntime';
export { VeriAgentRuntime } from './VeriAgentRuntime';
export type { VeriAgentRuntimeConfig } from './VeriAgentRuntime';

// Lifecycle proxy — shared lifecycle contract for remote agent runtimes (task #470)
export {
  parseLifecycleData,
  runPostStreamLifecycle,
  proxyStart,
  proxyHeartbeat,
  proxyProgress,
  proxyBlocker,
  proxyOutcome,
  proxyComplete,
  proxyReviewEvidence,
  buildLifecycleSystemPromptSection,
  buildLifecycleUserPromptSection,
  atlasCall,
  ALL_VALID_OUTCOMES,
  VALID_IMPLEMENTATION_OUTCOMES,
  VALID_QA_OUTCOMES,
  VALID_RELEASE_OUTCOMES,
} from './lifecycleProxy';
export type {
  AtlasLifecycleData,
  LifecycleContext,
  LifecycleProxyConfig,
  LifecycleResult,
} from './lifecycleProxy';

import type { AgentRuntime } from './types';
import { OpenClawRuntime } from './OpenClawRuntime';
import { ClaudeCodeRuntime } from './ClaudeCodeRuntime';
import { WebhookRuntime, type WebhookRuntimeConfig } from './WebhookRuntime';
import { VeriAgentRuntime, type VeriAgentRuntimeConfig } from './VeriAgentRuntime';

/**
 * resolveRuntime — factory that maps runtime_type → AgentRuntime implementation.
 *
 * @param agent - any object with runtime_type and runtime_config fields
 *                (matches the agents DB row shape)
 * @returns      the correct AgentRuntime for this agent
 */
export function resolveRuntime(agent: {
  runtime_type?: string | null;
  runtime_config?: unknown;
}): AgentRuntime {
  const type = agent.runtime_type ?? 'openclaw';

  // Parse runtime_config JSON string if needed
  let config: Record<string, unknown> = {};
  if (agent.runtime_config) {
    if (typeof agent.runtime_config === 'string') {
      try {
        config = JSON.parse(agent.runtime_config) as Record<string, unknown>;
      } catch {
        config = {};
      }
    } else if (typeof agent.runtime_config === 'object') {
      config = agent.runtime_config as Record<string, unknown>;
    }
  }

  switch (type) {
    case 'claude-code':
      return new ClaudeCodeRuntime(config);
    case 'webhook': {
      if (!config.dispatchUrl || typeof config.dispatchUrl !== 'string') {
        throw new Error(
          'WebhookRuntime requires runtime_config.dispatchUrl to be set on the agent',
        );
      }
      return new WebhookRuntime(config as unknown as WebhookRuntimeConfig);
    }
    case 'veri':
      return new VeriAgentRuntime(config as unknown as VeriAgentRuntimeConfig);
    case 'openclaw':
    default:
      return new OpenClawRuntime();
  }
}
