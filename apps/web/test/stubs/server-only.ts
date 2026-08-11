/**
 * Stands in for the `server-only` package under vitest.
 *
 * That package resolves to a module which throws on import unless the bundler is running in the
 * `react-server` condition — which is exactly what makes it a useful guard in the Next build, and
 * exactly what stops a plain test runner from importing `src/lib/api.ts` at all. Replacing it
 * here removes nothing: the guarantee it provides is enforced by `next build`, and the built
 * artefact is inspected by `client-bundle.test.ts`.
 */
export {};
