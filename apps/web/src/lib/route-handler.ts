import 'server-only';

import { NextResponse } from 'next/server';
import { GatewayError } from './api';

/**
 * The shape every interactive control in this console goes through.
 *
 * Buttons live in client components, and the admin token may not: so a button posts to a route
 * handler here, which is server code, which calls the management API. What crosses back to the
 * browser is the outcome, never the credential that obtained it.
 *
 * The gateway's address is a different matter and is not treated as a secret — the rail prints
 * its host, because an operator looking at a console needs to know which gateway they are
 * looking at. Knowing the address buys nothing without the token.
 */
export async function runAction<T>(work: () => Promise<T>): Promise<NextResponse> {
  try {
    return NextResponse.json(await work());
  } catch (error) {
    if (error instanceof GatewayError) {
      // The gateway's own refusal, passed through: "this approval was already decided" is
      // exactly what the person who just clicked needs to read. `status 0` means the console is
      // misconfigured rather than the gateway refusing, so it becomes a 500.
      return NextResponse.json(
        { error: error.code ?? 'agentgate_error', reason: error.message },
        { status: error.status === 0 ? 500 : error.status },
      );
    }

    return NextResponse.json(
      { error: 'agentgate_upstream_error', reason: 'the gateway could not be reached' },
      { status: 502 },
    );
  }
}
