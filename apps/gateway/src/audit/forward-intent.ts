import { newId } from '@agentgate/shared';
import { z } from 'zod';
import type { PrismaClient } from '../db.js';

/**
 * What the gateway is about to send, as it is written down before sending it.
 *
 * Everything here is already known by the time the decision is made, and none of it is content:
 * a hash of the body, an alias, an approval id. The same rule as the trail (D10), for the same
 * reason — this table is read by whoever is working out what an agent did after something went
 * wrong, and it must not be a place a secret can end up.
 */
const ForwardIntentSchema = z.strictObject({
  requestId: z.string().min(1),
  principalId: z.string().min(1),
  agentId: z.string().min(1),
  missionId: z.string().min(1),
  resource: z.string().min(1),
  action: z.string().min(1),
  method: z.string().min(1),
  destHost: z.string().min(1),
  destPath: z.string().min(1),
  bodyHash: z.string().optional(),
  credentialAlias: z.string().min(1),
  approvalId: z.string().optional(),
});

export type ForwardIntentInput = z.input<typeof ForwardIntentSchema>;

/**
 * Records that a request is about to leave, and does not come back until it is durable.
 *
 * The one thing this must never be is optional or fire-and-forget. Its whole value is that a
 * failure here happens *before* the upstream acts: the request is refused, nothing has been
 * done, and the agent may retry safely. Swallowing the error would give back exactly the window
 * it was written to close.
 */
export async function recordForwardIntent(
  prisma: PrismaClient,
  intent: ForwardIntentInput,
): Promise<void> {
  const parsed = ForwardIntentSchema.parse(intent);

  await prisma.forwardIntent.create({
    data: {
      id: newId('fwi'),
      ...parsed,
      bodyHash: parsed.bodyHash ?? null,
      approvalId: parsed.approvalId ?? null,
    },
  });
}
