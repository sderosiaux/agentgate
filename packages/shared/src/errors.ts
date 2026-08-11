import { type Decision, isDecision } from './decision.js';

export type AgentGateErrorCode =
  | 'agentgate_access_denied'
  | 'agentgate_approval_required'
  | 'agentgate_invalid_token'
  | 'agentgate_mission_expired'
  | 'agentgate_limit_exceeded'
  | 'agentgate_unknown_credential'
  | 'agentgate_unmapped_action'
  | 'agentgate_upstream_error'
  | 'agentgate_validation_error'
  | 'agentgate_not_found';

export interface AgentGateErrorBody {
  error: AgentGateErrorCode;
  decision?: Decision;
  reason: string;
  request_id: string;
}

export class AgentGateError extends Error {
  constructor(
    public readonly code: AgentGateErrorCode,
    public readonly httpStatus: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AgentGateError';
  }

  toBody(requestId: string): AgentGateErrorBody {
    const decision = this.details?.['decision'];

    return {
      error: this.code,
      ...(isDecision(decision) ? { decision } : {}),
      reason: this.message,
      request_id: requestId,
    };
  }
}
