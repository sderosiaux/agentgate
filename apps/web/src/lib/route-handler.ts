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
/**
 * These routes carry the admin token's authority and ask the caller for nothing, so a page an
 * operator merely visits must not be able to drive them.
 *
 * The threat is this system's own: a compromised agent is handed its `approval_id` in the 202 it
 * receives, so one cross-site request issued from an operator's browser would let it approve its
 * own pending action — defeating the human decision D7 exists to require.
 *
 * Two checks, cheapest first:
 *
 *  - the body must announce JSON. A `<form>` can only send urlencoded, multipart or plain text,
 *    so this single line ends the whole form-CSRF class; a cross-origin `fetch` announcing JSON
 *    is preflighted, and this console answers no preflight.
 *  - an `Origin` that is present and foreign is refused outright, for callers that are not
 *    browsers and therefore not bound by preflight at all.
 *
 * No token and no nonce: the console holds one shared credential and has no session of its own,
 * so there is nothing to bind a nonce to. Restricting who can reach the console at all is a
 * deployment control, and belongs in the threat model rather than here.
 */
function crossSiteRefusal(request: Request): NextResponse | null {
  const announced = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();

  if (announced !== 'application/json') {
    return NextResponse.json(
      {
        error: 'agentgate_unsupported_media_type',
        reason: 'this route takes application/json, and only application/json',
      },
      { status: 415 },
    );
  }

  const origin = request.headers.get('origin');
  if (origin !== null && !isSameOrigin(origin, request)) {
    return NextResponse.json(
      { error: 'agentgate_forbidden', reason: 'request origin is not this console' },
      { status: 403 },
    );
  }

  return null;
}

/**
 * Compared against the names the caller itself used rather than against a configured address:
 * the console is reached through whatever name its deployment gives it, and pinning one would
 * refuse every legitimate call.
 *
 * `X-Forwarded-Host` is consulted because a reverse proxy commonly rewrites `Host` to an
 * internal name while the browser's `Origin` still says the external one — without this, the
 * console would answer 403 to its own buttons behind any such proxy. A browser cannot forge it:
 * setting a custom header cross-origin triggers a preflight, and this console answers none.
 */
function isSameOrigin(origin: string, request: Request): boolean {
  const names = [
    request.headers.get('host') ?? new URL(request.url).host,
    request.headers.get('x-forwarded-host'),
  ];

  try {
    const from = new URL(origin).host;

    return names.some((name) => name !== null && name === from);
  } catch {
    // An Origin that is not a URL is not one this console sent.
    return false;
  }
}

export async function runAction<T>(
  request: Request,
  work: () => Promise<T>,
): Promise<NextResponse> {
  const refused = crossSiteRefusal(request);
  if (refused !== null) {
    return refused;
  }

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
