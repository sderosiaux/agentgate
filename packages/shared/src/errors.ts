import type { Decision } from './decision.js';

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

export interface AgentGateErrorOptions {
  /** The authorization outcome, when the error is one. It is the only option echoed to the client. */
  decision?: Decision | undefined;
  /** Free-form context for logs and audit rows. Never serialised into a response body. */
  details?: Record<string, unknown> | undefined;
}

export class AgentGateError extends Error {
  readonly decision: Decision | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    public readonly code: AgentGateErrorCode,
    public readonly httpStatus: number,
    message: string,
    options: AgentGateErrorOptions = {},
  ) {
    super(message);
    this.name = 'AgentGateError';
    this.decision = options.decision;
    this.details = options.details;
  }

  toBody(requestId: string): AgentGateErrorBody {
    return {
      error: this.code,
      ...(this.decision === undefined ? {} : { decision: this.decision }),
      reason: this.message,
      request_id: requestId,
    };
  }
}
