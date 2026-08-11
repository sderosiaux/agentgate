import type { NextResponse } from 'next/server';
import { api } from '@/lib/api';
import { runAction } from '@/lib/route-handler';

/**
 * Mints an agent token for this mission and returns everything about it except the token.
 *
 * `api.mintToken` drops the credential server-side, so there is no code path from this handler
 * to a browser that carries one. The console reports that a session now exists and when it
 * dies; the token itself reaches the agent through the SDK.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  return runAction(request, () => api.mintToken(id));
}
