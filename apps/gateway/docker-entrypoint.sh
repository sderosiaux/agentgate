#!/bin/sh
set -e

echo "agentgate: applying database migrations"
pnpm exec prisma migrate deploy

echo "agentgate: seeding demo data"
pnpm exec prisma db seed

exec "$@"
