import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // See test/stubs/server-only.ts: the real package refuses to be imported outside a
      // react-server bundle, which is the point of it and also why a test runner cannot load
      // the module it guards.
      'server-only': fileURLToPath(new URL('./test/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    // jsdom by default because most of what is worth testing here is what a human sees. The
    // files that exercise server code (`api.ts`, the built bundle) opt into node with a
    // `@vitest-environment node` pragma.
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
