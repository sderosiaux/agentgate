import type { ProxyRequest, ProxyResponse, WaitForApprovalOptions } from '@agentgate/sdk';
import type { DemoContext, DemoGate, DemoTimings } from '../../src/cases.js';

/** What a stubbed call does: answer, or fail the way the gateway would have. */
export type Outcome = ProxyResponse | Error;

export function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ProxyResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);

  return {
    status,
    headers: { 'x-agentgate-request-id': 'req_stub', ...headers },
    body: text,
    json<T>(): T {
      return JSON.parse(text) as T;
    },
  };
}

export class StubGate implements DemoGate {
  readonly calls: ProxyRequest[] = [];
  readonly waited: string[] = [];
  /** What `waitForApproval` does. Resolving is the human saying yes. */
  waitOutcome: Error | null = null;

  constructor(private readonly outcomes: Outcome[]) {}

  async request(request: ProxyRequest): Promise<ProxyResponse> {
    this.calls.push(request);
    const outcome = this.outcomes[this.calls.length - 1];

    if (outcome === undefined) {
      throw new Error(`the stub was not told what call ${String(this.calls.length)} should do`);
    }
    if (outcome instanceof Error) {
      throw outcome;
    }

    return outcome;
  }

  async waitForApproval(approvalId: string, _options?: WaitForApprovalOptions): Promise<void> {
    this.waited.push(approvalId);

    if (this.waitOutcome !== null) {
      throw this.waitOutcome;
    }
  }
}

/** Timings that make a polling case finish inside a unit test. */
export const FAST_TIMINGS: DemoTimings = {
  isolationTimeoutMs: 50,
  approvalTimeoutMs: 100,
  approvalIntervalMs: 1,
  expirationTimeoutMs: 20,
  expirationIntervalMs: 1,
};

export interface StubContext extends DemoContext {
  gate: StubGate;
  /** Everything the case printed, in order. */
  output: string[];
}

export function contextFor(
  gate: StubGate,
  overrides: Partial<Omit<DemoContext, 'gate'>> = {},
): StubContext {
  const output: string[] = [];

  return {
    gate,
    credential: 'github_work',
    mode: 'container',
    env: { AGENTGATE_URL: 'http://gateway:8080', HOME: '/home/agent' },
    scanRoot: process.cwd(),
    log: (line: string) => output.push(line),
    timings: FAST_TIMINGS,
    sleep: async () => {},
    state: {},
    ...overrides,
    output,
  };
}
