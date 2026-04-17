/**
 * contracts/index.ts — Public API for the workflow contract + transport adapter system.
 *
 * Task #632: Split shared workflow contract from runtime-specific transport.
 */

export {
  PM_TASK_TYPES,
  resolveWorkflowLane,
  getAllowedTaskTypesForSprintType,
  isTaskTypeAllowedForSprintType,
  getEvidenceRequirements,
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
  resolveTransportMode,
  type TransportMode,
  type TransportContext,
} from './transportAdapters';
