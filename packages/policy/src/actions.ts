/**
 * The whole action hierarchy, written out. Anything not listed here means exactly itself:
 * no wildcards, no prefix matching, no "read implies list" cleverness — a reader has to be
 * able to tell what a mission grants by reading the mission.
 */
/**
 * A Map, not an object literal: action names come from a mission document, so `toString`,
 * `constructor` or `__proto__` are strings a caller can put in a list. A plain object would
 * answer those from its prototype and hand back a function, which turns a decision into a
 * TypeError. A Map has no such chain — an unlisted key is simply absent.
 */
const IMPLIED_ACTIONS = new Map<string, readonly string[]>([
  ['repo.read', ['issue.read', 'pull_request.read']],
]);

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
  return IMPLIED_ACTIONS.get(granted)?.includes(requested) ?? false;
}
