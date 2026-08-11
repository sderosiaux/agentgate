# Build context is the repo root: mock-github is a pnpm workspace package.
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY services/mock-github/package.json services/mock-github/
# Every workspace project must be present or the frozen lockfile no longer matches.
COPY apps/gateway/package.json apps/gateway/
COPY packages/auth/package.json packages/auth/
COPY packages/shared/package.json packages/shared/
# --ignore-scripts: the postinstall and prepare scripts of the other workspace
# projects compile sources this layer does not have. The build below is explicit.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY services/mock-github services/mock-github
RUN pnpm --filter @agentgate/mock-github build

FROM base AS runtime
ENV NODE_ENV=production
# The workspace is copied whole: pnpm links dependencies through symlinks.
COPY --from=build /app /app
WORKDIR /app/services/mock-github
EXPOSE 3001
CMD ["node", "dist/index.js"]
