/**
 * The refusal body every AgentGate error carries (`AgentGateError.toBody` on the gateway side).
 *
 * Declared here rather than imported from `@agentgate/shared`: this package has no runtime
 * dependencies, because it is the one thing that ships inside an agent's sandbox and every
 * dependency it drags in is code running next to a mission token. The shape is the wire
 * contract, which is stable by design — the drift this risks is a new `agentgate_*` code, and a
 * new code lands on `GatewayError` rather than on nothing.
 */
export interface AgentGateRefusalBody {
  error: string;
  decision?: string;
  reason: string;
  request_id: string;
  /** Only on a 202: the approval a human now has to decide. */
  approval_id?: string;
}

export interface AgentGateSdkErrorInit {
  /** The gateway's own `agentgate_*` code, or an `agentgate_sdk_*` one for a local failure. */
  code: string;
  /** The HTTP status the refusal arrived with. Absent when nothing was refused over HTTP. */
  status?: number | undefined;
  /** Ties this failure to its audit row. Absent only when the gateway never answered. */
  requestId?: string | undefined;
  decision?: string | undefined;
}

/**
 * Everything this SDK throws, so that `catch (error)` has one type to test against and an agent
 * that only wants to know "did AgentGate stop me" needs one `instanceof`.
 */
export class AgentGateSdkError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly decision: string | undefined;

  constructor(message: string, init: AgentGateSdkErrorInit) {
    super(message);
    this.name = new.target.name;
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId;
    this.decision = init.decision;
  }

  /**
   * The gateway's wording, under the name the SPEC error body uses. Same string as `message`:
   * an agent logging `error.message` and an agent printing `error.reason` should not be able to
   * report two different explanations for one refusal.
   */
  get reason(): string {
    return this.message;
  }
}

/** 202: a human has to say yes. `approvalId` is what the retry carries (D7). */
export class ApprovalRequiredError extends AgentGateSdkError {
  constructor(
    message: string,
    readonly approvalId: string,
    init: AgentGateSdkErrorInit,
  ) {
    super(message, init);
  }
}

/** 403: the mission does not cover this request — or no longer covers anything at all. */
export class AccessDeniedError extends AgentGateSdkError {}

/**
 * The approval an agent was waiting on settled as something other than a grant.
 *
 * Still an `AccessDeniedError` — the agent may not proceed, which is all most callers need —
 * but carrying which of the three it was. "The human said no", "the grant expired unused" and
 * "it has already been spent" are three different things to do next, and telling them apart by
 * matching on a sentence is not an interface.
 */
export class ApprovalNotGrantedError extends AccessDeniedError {
  constructor(
    message: string,
    readonly approvalStatus: string,
    init: AgentGateSdkErrorInit,
  ) {
    super(message, init);
  }
}

/** 429: the mission ran out of requests, of requests per minute, or of bytes. */
export class LimitExceededError extends AgentGateSdkError {}

/** 401: the token is missing, malformed, expired or signed by someone else. */
export class InvalidTokenError extends AgentGateSdkError {}

/**
 * Every other refusal *the gateway made*: a malformed envelope (`agentgate_validation_error`), a
 * body larger than it will read (`agentgate_payload_too_large`), an upstream that failed or
 * answered with more than the mission can afford (`agentgate_upstream_error`), a gateway that
 * failed on its own (`agentgate_internal_error`). One class, because these are conditions an
 * agent reports rather than reacts to — but deliberately not the same class as never having
 * reached the gateway at all. Which one it was is `error.code`, carried on every instance.
 */
export class GatewayError extends AgentGateSdkError {}

/**
 * No answer, so no decision: the gateway could not be reached, it went silent, or the caller
 * cancelled. Separated from {@link GatewayError} because the two call for opposite responses —
 * a refusal is final and worth reporting, while this may simply be worth trying again.
 */
export class TransportError extends AgentGateSdkError {}

/** Transport, specifically because time ran out. Retryable in a way a cancellation is not. */
export class TimeoutError extends TransportError {}

/**
 * An answer arrived and could not be read as what it claimed to be: a body that is not JSON, an
 * approval carrying a status this SDK has no meaning for. Its own class rather than a gateway
 * refusal, because nothing was refused — and because guessing at it is how an unknown approval
 * status quietly becomes "keep waiting".
 */
export class MalformedResponseError extends AgentGateSdkError {}

/**
 * `waitForApproval` gave up: nobody decided in the time it was given.
 *
 * Deliberately not a {@link TimeoutError} and not a {@link TransportError}, despite the name.
 * Nothing timed out on the wire and nothing failed — every poll was answered, and the answer was
 * that the approval is still pending. What ran out is a human's attention, which is not a
 * condition to retry the way a dropped connection is.
 */
export class ApprovalTimeoutError extends AgentGateSdkError {}

/**
 * A body is a refusal when it says so in the two fields every `AgentGateError` writes. Checked
 * rather than inferred from the status code, because a proxied response carries the upstream's
 * status verbatim: a 403 from GitHub and a 403 from the gateway are different events, and only
 * one of them is this SDK's business to throw about.
 */
export function asRefusal(body: string): AgentGateRefusalBody | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const candidate = parsed as Partial<AgentGateRefusalBody>;

  if (
    typeof candidate.error !== 'string' ||
    !candidate.error.startsWith('agentgate_') ||
    typeof candidate.reason !== 'string' ||
    typeof candidate.request_id !== 'string'
  ) {
    return null;
  }

  return candidate as AgentGateRefusalBody;
}

/**
 * One refusal, as the error an agent catches. The status decides the class and the code travels
 * on it: `agentgate_mission_expired` and `agentgate_access_denied` are both a 403 an agent
 * cannot retry, and telling them apart is reading `error.code`, not catching a different type.
 */
export function toSdkError(status: number, body: AgentGateRefusalBody): AgentGateSdkError {
  const init: AgentGateSdkErrorInit = {
    code: body.error,
    status,
    requestId: body.request_id,
    decision: body.decision,
  };

  switch (status) {
    case 202:
      return body.approval_id === undefined
        ? // A 202 without an id is an instruction the agent cannot act on; it is reported as
          // the gateway failure it is rather than as an approval it could wait for.
          new GatewayError(
            `${body.reason} (the gateway did not name an approval to wait for)`,
            init,
          )
        : new ApprovalRequiredError(body.reason, body.approval_id, init);
    case 401:
      return new InvalidTokenError(body.reason, init);
    case 403:
      return new AccessDeniedError(body.reason, init);
    case 429:
      return new LimitExceededError(body.reason, init);
    default:
      return new GatewayError(body.reason, init);
  }
}
