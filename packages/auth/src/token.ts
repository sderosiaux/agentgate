import { SignJWT, importPKCS8, importSPKI, jwtVerify } from 'jose';
import type { CryptoKey, JWTPayload } from 'jose';
import { AgentGateError } from '@agentgate/shared';

// D9: one token binds one agent to one mission. Ed25519 only — the gateway holds the
// keypair, so there is no algorithm negotiation to attack.
const ALG = 'EdDSA';

export interface AgentClaims {
  agentId: string;
  principalId: string;
  agentType: string;
  missionId: string;
  sessionId: string;
}

export interface TokenService {
  mint(claims: AgentClaims, expiresAt: Date): Promise<string>;
  verify(token: string): Promise<AgentClaims>;
}

/** The keys travel as base64 DER (see scripts/generate-env.mjs); jose imports PEM. */
function toPem(base64Der: string, label: 'PRIVATE KEY' | 'PUBLIC KEY'): string {
  const body =
    base64Der
      .replace(/\s+/g, '')
      .match(/.{1,64}/g)
      ?.join('\n') ?? '';

  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function readClaim(payload: JWTPayload, name: string): string {
  const value = payload[name];

  if (typeof value !== 'string' || value === '') {
    throw new Error(`missing claim ${name}`);
  }

  return value;
}

export function createTokenService(
  privateKeyB64: string | undefined,
  publicKeyB64: string,
): TokenService {
  let privateKey: Promise<CryptoKey> | undefined;
  let publicKey: Promise<CryptoKey> | undefined;

  // Imported lazily so a verify-only gateway never touches the signing key, and so a
  // malformed key surfaces on the call that needs it rather than at wiring time.
  const signingKey = (): Promise<CryptoKey> => {
    if (privateKeyB64 === undefined) {
      throw new Error('No JWT private key configured: this gateway cannot mint agent tokens');
    }

    privateKey ??= importPKCS8(toPem(privateKeyB64, 'PRIVATE KEY'), ALG);

    return privateKey;
  };

  const verificationKey = (): Promise<CryptoKey> => {
    publicKey ??= importSPKI(toPem(publicKeyB64, 'PUBLIC KEY'), ALG);

    return publicKey;
  };

  return {
    async mint(claims, expiresAt) {
      return new SignJWT({
        principal_id: claims.principalId,
        agent_type: claims.agentType,
        mission_id: claims.missionId,
        session_id: claims.sessionId,
      })
        .setProtectedHeader({ alg: ALG })
        .setSubject(claims.agentId)
        .setIssuedAt()
        .setExpirationTime(expiresAt)
        .sign(await signingKey());
    },

    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, await verificationKey(), {
          algorithms: [ALG],
        });

        return {
          agentId: readClaim(payload, 'sub'),
          principalId: readClaim(payload, 'principal_id'),
          agentType: readClaim(payload, 'agent_type'),
          missionId: readClaim(payload, 'mission_id'),
          sessionId: readClaim(payload, 'session_id'),
        };
      } catch {
        // Signature, expiry and shape failures collapse into one answer: the token is
        // not usable. Telling a caller which check failed only helps forgery.
        throw new AgentGateError('agentgate_invalid_token', 401, 'Agent token is invalid');
      }
    },
  };
}
