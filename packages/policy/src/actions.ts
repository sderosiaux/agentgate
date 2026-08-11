/**
 * The whole action hierarchy, written out. Anything not listed here means exactly itself:
 * no wildcards, no prefix matching, no "read implies list" cleverness — a reader has to be
 * able to tell what a mission grants by reading the mission.
 */
const IMPLIED_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  'repo.read': ['issue.read', 'pull_request.read'],
};

/**
 * Does holding `granted` speak for `requested`?
 *
 * Used for every list in a mission, not just the grants: if `repo.read` covers `issue.read`
 * when allowing, it has to cover it when denying too, otherwise denying `repo.read` while
 * allowing it would leave `issue.read` reachable.
 */
export function actionImplied(granted: string, requested: string): boolean {
  if (granted === requested) {
    return true;
  }
  return IMPLIED_ACTIONS[granted]?.includes(requested) ?? false;
}
