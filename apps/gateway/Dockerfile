# Build context is the repo root: the gateway is a pnpm workspace package.
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/
# Every workspace project must be present or the frozen lockfile no longer matches.
# Keep this list in sync with pnpm-workspace.yaml: a new project without a line
# here breaks the image build, and only the image build.
COPY apps/web/package.json apps/web/
COPY packages/auth/package.json packages/auth/
COPY packages/policy/package.json packages/policy/
COPY packages/shared/package.json packages/shared/
COPY services/mock-github/package.json services/mock-github/
# --ignore-scripts: the gateway postinstall runs `prisma generate`, which needs the
# schema this layer does not have yet, and the package `prepare` scripts compile
# sources this layer does not have either. Both happen explicitly below.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY apps/gateway apps/gateway
COPY packages packages
# The gateway's integration tests run the mock upstream in-process, so it is a workspace
# dependency of the gateway and `...` selects it for the build below. Its sources have to be
# here for that build to succeed — it is compiled, never started, by this image.
COPY services services
# `@agentgate/gateway...` builds the gateway and its workspace dependencies, in order.
RUN pnpm --filter @agentgate/gateway exec prisma generate \
    && pnpm --filter "@agentgate/gateway..." build

FROM base AS runtime
ENV NODE_ENV=production
# The workspace is copied whole: pnpm links packages through symlinks, and the
# Prisma CLI and tsx must stay available for the entrypoint (migrate + seed).
COPY --from=build /app /app
COPY apps/gateway/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
WORKDIR /app/apps/gateway
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
