# Build context is the repo root: the gateway is a pnpm workspace package.
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/
RUN pnpm install --frozen-lockfile
COPY apps/gateway apps/gateway
RUN pnpm --filter @agentgate/gateway exec prisma generate \
    && pnpm --filter @agentgate/gateway build

FROM base AS runtime
ENV NODE_ENV=production
# The Prisma CLI and tsx stay in the image: the entrypoint applies migrations and
# runs the seed before the gateway boots.
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/apps/gateway/node_modules apps/gateway/node_modules
COPY --from=build /app/apps/gateway/dist apps/gateway/dist
COPY --from=build /app/apps/gateway/package.json apps/gateway/prisma.config.ts apps/gateway/
COPY --from=build /app/apps/gateway/prisma apps/gateway/prisma
COPY apps/gateway/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
WORKDIR /app/apps/gateway
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
