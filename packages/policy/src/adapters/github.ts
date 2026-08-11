import { AgentGateError } from '@agentgate/shared';
import type { MappedRequest, ProviderAdapter } from './types.js';

const HOST = 'api.github.com';

/** GitHub owner and repository names. Anything else is not a repo we can name in a mission. */
const NAME = /^[A-Za-z0-9._-]+$/;
const NUMBER = /^[0-9]+$/;

function isName(segment: string | undefined): segment is string {
  return segment !== undefined && NAME.test(segment);
}

function isNumber(segment: string | undefined): boolean {
  return segment !== undefined && NUMBER.test(segment);
}

/**
 * The SPEC D4 table, in one place. Order does not matter: at most one row can match a given
 * (method, path) pair, and a pair matching none is unmapped.
 */
function mapPath(method: string, tail: readonly string[]): string | null {
  const [first, second, third] = tail;

  if (tail.length === 0) {
    if (method === 'GET') return 'repo.read';
    if (method === 'DELETE') return 'repository.delete';
    return null;
  }
  if (tail.length === 1 && first === 'pulls') {
    if (method === 'GET') return 'pull_request.read';
    if (method === 'POST') return 'pull_request.create';
    return null;
  }
  if (tail.length === 2 && first === 'issues' && isNumber(second)) {
    return method === 'GET' ? 'issue.read' : null;
  }
  if (tail.length === 2 && first === 'git' && second === 'refs') {
    return method === 'POST' ? 'branch.create' : null;
  }
  if (tail.length === 3 && first === 'pulls' && isNumber(second) && third === 'merge') {
    return method === 'PUT' ? 'pull_request.merge' : null;
  }
  return null;
}

export const githubAdapter: ProviderAdapter = {
  provider: 'github',

  matchesHost(logicalHost: string): boolean {
    return logicalHost.toLowerCase() === HOST;
  },

  mapRequest(method: string, path: string): MappedRequest | null {
    if (!path.startsWith('/') || path.includes('/../') || path.endsWith('/..')) {
      // `normalizeUrl` runs before anything reaches here, so a path in this shape means the
      // pipeline was bypassed. Failing loudly beats mapping a path nobody normalized.
      throw new AgentGateError(
        'agentgate_validation_error',
        400,
        'provider adapter received a path that was not normalized',
      );
    }

    const segments = path.split('/').filter((segment) => segment !== '');
    const [root, owner, repo] = segments;
    if (root !== 'repos' || !isName(owner) || !isName(repo)) {
      return null;
    }

    const action = mapPath(method.toUpperCase(), segments.slice(3));
    return action === null ? null : { resource: `github:${owner}/${repo}`, action };
  },
};
