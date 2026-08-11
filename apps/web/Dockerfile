# Build context is the repo root: the console is a pnpm workspace package.
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
# Every workspace project must be present or the frozen lockfile no longer matches.
# Keep this list in sync with pnpm-workspace.yaml.
COPY apps/demo-agent/package.json apps/demo-agent/
COPY apps/gateway/package.json apps/gateway/
COPY packages/auth/package.json packages/auth/
COPY packages/policy/package.json packages/policy/
COPY packages/sdk/package.json packages/sdk/
COPY packages/shared/package.json packages/shared/
COPY services/mock-github/package.json services/mock-github/
COPY tests/package.json tests/
# --ignore-scripts: the gateway's postinstall runs `prisma generate` against a schema this
# layer does not have, and the console does not need it either way.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY apps/web apps/web
# No ADMIN_TOKEN, and no GATEWAY_URL: every route is server-rendered on demand, so nothing is
# fetched at build time and no secret is ever present in this layer.
# NOTE: `next/font` downloads its font files during the build, so this stage needs network
# access. The result is self-hosted — the running console makes no third-party request.
RUN pnpm --filter @agentgate/web build

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Next's standalone output is a self-contained server: the traced subset of node_modules is
# already inside it, so the runtime image never installs anything.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
