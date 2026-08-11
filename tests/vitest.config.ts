import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    // The leak scan runs a whole demo, starts a gateway and starts the console. Nothing here
    // may run next to it: two suites binding ports and writing rows at the same time is how a
    // security check starts failing for reasons that have nothing to do with security.
    fileParallelism: false,
    // A full demo plus a Next.js server start. Slow on purpose — the alternative is a check
    // that only looks at things already sitting on disk.
    testTimeout: 10 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
  },
});
