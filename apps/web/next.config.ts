import type { NextConfig } from 'next';

const config: NextConfig = {
  // The console is shipped as a container that runs `node server.js` with no node_modules
  // beside it (see Dockerfile). Standalone output is what makes that possible.
  output: 'standalone',
  // The monorepo root, not `apps/web`: standalone tracing has to follow workspace symlinks
  // out of this package or it copies half of what the server needs.
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  // ...but the root now contains the previous build's `standalone` tree, which is a copy of this
  // very server. Tracing walks into it and the next build dies collecting page data ("Cannot
  // find module for page: /_document"), so `next build` succeeds once on a clean tree and fails
  // every time after. Excluding that one directory is what makes a rebuild work.
  //
  // Only `standalone`, not `.next` as a whole: the rest of it holds `webpack-runtime.js` and the
  // server chunks that require it, and excluding those produces a standalone server that starts
  // and then 500s on every page.
  outputFileTracingExcludes: {
    '*': ['**/.next/standalone/**'],
  },
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: {
    // No eslint in this repo — prettier and tsc are the gates. Left explicit so `next build`
    // does not fail looking for a config nobody wrote.
    ignoreDuringBuilds: true,
  },
};

export default config;
