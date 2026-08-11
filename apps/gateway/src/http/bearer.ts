/**
 * The token out of an `Authorization: Bearer …` header, or nothing.
 *
 * One parser for every route that reads one — the agent token on `/v1/proxy`, the same token on
 * the approval status route, the admin token on the management tree. What counts as a bearer
 * header is exactly the kind of detail that drifts when it is written twice.
 */
export function parseBearer(header: string | undefined): string | undefined {
  return /^bearer (.+)$/i.exec(header?.trim() ?? '')?.[1];
}
