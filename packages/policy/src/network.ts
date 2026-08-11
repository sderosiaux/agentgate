import type { NetworkRules } from '@agentgate/shared';

export interface NetworkRequest {
  /** Normalized host, as produced by `normalizeUrl`. */
  host: string;
  /** Normalized path, as produced by `normalizeUrl`. */
  path: string;
  method: string;
}

export type NetworkMatch = { matched: 'deny' } | { matched: 'allow' } | { matched: 'none' };

type NetworkRule = NetworkRules['allow'][number];

/** `*` matches any host, `*.suffix` matches any strict subdomain of `suffix`, else exact. */
function hostMatches(pattern: string, host: string): boolean {
  const wanted = pattern.toLowerCase();
  if (wanted === '*') {
    return true;
  }
  if (wanted.startsWith('*.')) {
    const suffix = wanted.slice(1);
    // `*.github.com` covers `api.github.com` but never `github.com` itself: a rule about
    // subdomains should not silently hand over the apex.
    return host.length > suffix.length && host.endsWith(suffix);
  }
  return wanted === host;
}

function segmentsMatch(pattern: readonly string[], target: readonly string[]): boolean {
  const head = pattern[0];
  if (head === undefined) {
    return target.length === 0;
  }
  if (head === '**') {
    // Zero segments included, so `/repos/acme/payments/**` also covers the repo root itself.
    for (let skipped = 0; skipped <= target.length; skipped += 1) {
      if (segmentsMatch(pattern.slice(1), target.slice(skipped))) {
        return true;
      }
    }
    return false;
  }
  if (target.length === 0) {
    return false;
  }
  if (head !== '*' && head !== target[0]) {
    return false;
  }
  return segmentsMatch(pattern.slice(1), target.slice(1));
}

function split(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/** An absent path clause matches every path; `*` is one segment, `**` is any depth. */
function pathMatches(pattern: string | undefined, path: string): boolean {
  if (pattern === undefined) {
    return true;
  }
  return segmentsMatch(split(pattern), split(path));
}

/** An absent methods clause matches every method; an empty list matches none. */
function methodMatches(methods: readonly string[] | undefined, method: string): boolean {
  if (methods === undefined) {
    return true;
  }
  const wanted = method.toUpperCase();
  return methods.includes(wanted);
}

function ruleMatches(rule: NetworkRule, request: NetworkRequest): boolean {
  return (
    hostMatches(rule.host, request.host.toLowerCase()) &&
    pathMatches(rule.path, request.path) &&
    methodMatches(rule.methods, request.method)
  );
}

/**
 * Deny is evaluated first and wins outright: an allow rule can never widen its way past an
 * explicit deny. `none` is not "allowed" — the caller turns it into a default deny (D3 step 5).
 */
export function matchNetworkRules(rules: NetworkRules, request: NetworkRequest): NetworkMatch {
  if (rules.deny.some((rule) => ruleMatches(rule, request))) {
    return { matched: 'deny' };
  }
  if (rules.allow.some((rule) => ruleMatches(rule, request))) {
    return { matched: 'allow' };
  }
  return { matched: 'none' };
}
