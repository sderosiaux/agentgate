import type { TokenService } from '@agentgate/auth';
import type { ApprovalService } from '../approvals/service.js';
import type { PrismaClient } from '../db.js';

/**
 * Everything the management tree needs, and nothing the enforcement tree hands it (D11): the
 * two are wired separately in `app.ts`, and this list is what "separately" means in practice.
 */
export interface ManagementDeps {
  prisma: PrismaClient;
  approvals: ApprovalService;
  /** Mints agent tokens. Needs `AGENTGATE_JWT_PRIVATE_KEY`; enforcement only ever verifies. */
  tokenService: TokenService;
  /**
   * Whether this gateway was started with a signing key.
   *
   * A gateway that only verifies is a supported deployment, not a misconfiguration — the key
   * belongs on as few hosts as possible, and every gateway in a fleet still has to enforce. So
   * the fact is carried here and answered with a 503 at the route, rather than being discovered
   * as an exception halfway through minting and reported as "the gateway could not answer".
   */
  canMintTokens: boolean;
  /** The same injected clock the pipeline reads, so token TTLs and expiry agree with it. */
  clock: () => Date;
  /** The one credential that can reach this tree. Required at boot, never logged. */
  adminToken: string;
  /** Encrypts a credential value on the way in. Nothing here ever decrypts one. */
  masterKey: string;
}
