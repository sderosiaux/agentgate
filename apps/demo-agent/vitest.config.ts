import { defineConfig } from 'vitest/config';

// No database and no gateway: the cases are driven by a stubbed client, which is what makes
// "did this case decide correctly" testable without staging a whole failure in a real system.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
