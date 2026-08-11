# Build context is the repo root: the gateway is a pnpm workspace package.
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/
# --ignore-scripts: the gateway postinstall runs `prisma generate`, which needs the
# schema this layer does not have yet. Generation happens explicitly below.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY apps/gateway apps/gateway
RUN pnpm --filter @agentgate/gateway exec prisma generate \
    && pnpm --filter @agentgate/gateway build

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
