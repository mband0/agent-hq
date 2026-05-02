/**
 * contracts/index.ts — Public API for the workflow contract + transport adapter system.
 *
 * Task #632: Split shared workflow contract from runtime-specific transport.
 */

export {
  resolveWorkflowLane,
  getAllowedTaskTypesForSprintType,
  isTaskTypeAllowedForSprintType,
  getEvidenceRequirements,
  resolveEvidenceRequirements,
  PIPELINE_STAGES,
  PIPELINE_REFERENCE,
  RELEASE_LANE_NOTES,
  type WorkflowLane,
  type ResolvedWorkflowLane,
  type OutcomeHelpEntry,
  type EvidenceRequirements,
} from './workflowContract';

export {
  buildContractInstructions,
  CONTRACT_PLACEHOLDER_DEFINITIONS,
  getAvailableContractPlaceholders,
  type ContractPlaceholderDefinition,
  resolveTransportMode,
  type TransportMode,
  type TransportContext,
} from './transportAdapters';
