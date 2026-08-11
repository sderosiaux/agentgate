# Build context is the repo root: the demo agent is a pnpm workspace package.
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/demo-agent/package.json apps/demo-agent/
# Every workspace project must be present or the frozen lockfile no longer matches.
# Keep this list in sync with pnpm-workspace.yaml: a new project without a line
# here breaks the image build, and only the image build.
COPY apps/gateway/package.json apps/gateway/
COPY apps/web/package.json apps/web/
COPY packages/auth/package.json packages/auth/
COPY packages/policy/package.json packages/policy/
COPY packages/sdk/package.json packages/sdk/
COPY packages/shared/package.json packages/shared/
COPY services/mock-github/package.json services/mock-github/
COPY tests/package.json tests/
# --ignore-scripts: the `prepare` scripts of the workspace packages compile sources
# this layer does not have yet. The build below is explicit.
RUN pnpm install --frozen-lockfile --ignore-scripts
# Sources, and only the two projects this image runs. `test/` is deliberately absent:
# case 2 scans this filesystem for the fragment of the upstream token, and the suite
# that tests case 2 necessarily names it.
COPY packages/sdk/tsconfig.json packages/sdk/
COPY packages/sdk/src packages/sdk/src
COPY apps/demo-agent/tsconfig.json apps/demo-agent/
COPY apps/demo-agent/src apps/demo-agent/src
# Named rather than `@agentgate/demo-agent...`: the SDK's *dev* dependency on the gateway
# is part of that selector, and this image has no reason to build a gateway.
RUN pnpm --filter @agentgate/sdk build && pnpm --filter @agentgate/demo-agent build

FROM base AS runtime
ENV NODE_ENV=production
# The workspace is copied whole: pnpm links packages through symlinks.
COPY --from=build /app /app
WORKDIR /app/apps/demo-agent
# No EXPOSE and no port: this container listens for nothing. It sits on agent-net,
# where the gateway is the only thing it can reach.
CMD ["node", "dist/main.js"]
