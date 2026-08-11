import type { NextConfig } from 'next';

const config: NextConfig = {
  // The console is shipped as a container that runs `node server.js` with no node_modules
  // beside it (see Dockerfile). Standalone output is what makes that possible.
  output: 'standalone',
  // The monorepo root, not `apps/web`: standalone tracing has to follow workspace symlinks
  // out of this package or it copies half of what the server needs.
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: {
    // No eslint in this repo — prettier and tsc are the gates. Left explicit so `next build`
    // does not fail looking for a config nobody wrote.
    ignoreDuringBuilds: true,
  },
};

export default config;
