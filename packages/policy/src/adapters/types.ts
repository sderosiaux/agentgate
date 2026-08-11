export interface MappedRequest {
  /** Mission scope key, e.g. `github:acme/payments`. */
  resource: string;
  /** Action type, e.g. `pull_request.create`. */
  action: string;
}

/**
 * Turns a request into the pair the policy engine reasons about. The mapping lives here and
 * only here: the agent never gets to say what it is doing, it only gets to make a request.
 */
export interface ProviderAdapter {
  provider: string;
  matchesHost(logicalHost: string): boolean;
  /** `null` means unmapped, which the gateway turns into a deny (D4), never a fallback allow. */
  mapRequest(method: string, path: string): MappedRequest | null;
}
