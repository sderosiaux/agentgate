/**
 * Keyset pagination, spelled out rather than delegated.
 *
 * `take`/`skip` would drift under insertion — the trail and the approval queue grow while a
 * client reads them, and an offset-paged reader silently sees the same row twice or misses one.
 * A cursor names a row, and a page is "everything strictly older than that row" in the same
 * order the list is sorted: rows appearing after the first page cannot move a later one.
 *
 * Lives outside both plugin trees because both need it — the approval service is read by
 * enforcement, and nothing enforcement touches may reach into management (D11).
 */

export const DEFAULT_PAGE_SIZE = 50;

/** The most any one call may ask for: a management API is not a bulk export. */
export const MAX_PAGE_SIZE = 200;

/** The row a cursor names, in the two dimensions the sort uses. */
export interface PageAnchor {
  at: Date;
  id: string;
}

/**
 * The `where` clause for "strictly after this row in a newest-first order".
 *
 * The tie-break on `id` is what makes the order total: two rows can share a timestamp, and an
 * order that cannot separate them cannot page through them either.
 */
export function olderThan(field: string, anchor: PageAnchor): Record<string, unknown> {
  return {
    OR: [{ [field]: { lt: anchor.at } }, { [field]: anchor.at, id: { lt: anchor.id } }],
  };
}

export interface Page<T> {
  items: T[];
  /** The id to pass back as `cursor`, or `null` when this was the last page. */
  nextCursor: string | null;
}

/**
 * Splits the `limit + 1` rows a query asked for into a page and the answer to "is there more".
 * One extra row rather than a second `count` over a table that only grows.
 */
export function pageOf<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  if (rows.length <= limit) {
    return { items: rows, nextCursor: null };
  }

  const items = rows.slice(0, limit);

  return { items, nextCursor: items.at(-1)?.id ?? null };
}
