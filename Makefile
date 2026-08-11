.PHONY: help setup dev dev-db require-env db-migrate db-reset test leak-scan demo demo-host reset

help: ## List the available targets
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

setup: ## Install dependencies and create .env with fresh secrets if absent
	pnpm install
	@if [ -f .env ]; then \
		echo ".env already exists, keeping it"; \
	else \
		node scripts/generate-env.mjs; \
	fi

dev: ## Start the whole stack
	docker compose up --build

dev-db: ## Start only PostgreSQL, for host-side tests
	docker compose up -d --wait postgres

require-env:
	@if [ ! -f .env ]; then echo "No .env found — run make setup first."; exit 1; fi

db-migrate: require-env ## Apply migrations from the host to BOTH databases: test and demo
	@set -a && . ./.env && set +a && DATABASE_URL="$$DATABASE_URL_TEST" \
		pnpm --filter @agentgate/gateway exec prisma migrate deploy
	@# The demo database too, and this is not optional. `docker compose up` migrates it from
	@# inside the gateway container, so a host that only ever ran `make test` leaves it behind
	@# by however many migrations have landed since — and a schema-drifted demo database is not
	@# a demo that fails loudly, it is one where the console and every proxied request answer 500.
	@set -a && . ./.env && set +a && DATABASE_URL="$$DATABASE_URL_DEMO" \
		pnpm --filter @agentgate/gateway exec prisma migrate deploy

db-reset: require-env ## Drop and rebuild both databases from scratch, and re-seed the demo one
	@# What to run before a demo or a screenshot. `make reset` deletes the compose volume, which
	@# is the right answer when the database lives in a container and no answer at all when it
	@# does not — and either way a demo database that has been reviewed against carries the
	@# residue: expired missions, one-off credentials, audit rows from somebody's test.
	@set -a && . ./.env && set +a && DATABASE_URL="$$DATABASE_URL_TEST" \
		pnpm --filter @agentgate/gateway exec prisma migrate reset --force --skip-seed
	@set -a && . ./.env && set +a && DATABASE_URL="$$DATABASE_URL_DEMO" \
		pnpm --filter @agentgate/gateway exec prisma migrate reset --force --skip-seed
	@set -a && . ./.env && set +a && DATABASE_URL="$$DATABASE_URL_DEMO" \
		pnpm --filter @agentgate/gateway exec prisma db seed

test: require-env dev-db db-migrate ## Run every workspace test suite, leak scan included
	@# The leak scan is one of these suites (tests/security), not a step after them: a check that
	@# only runs when somebody remembers to run it is a check the next contributor will not.
	pnpm -r test

leak-scan: require-env ## Run the demo and prove the upstream token reached nothing it should not
	node scripts/leak-scan.mjs

demo: require-env ## Run the end-to-end authorization demo (cases 0-6, in containers)
	docker compose --profile demo build demo-agent
	node scripts/demo-orchestrator.mjs

demo-host: require-env db-migrate ## Run the demo without Docker: local gateway, upstream and agent
	DEMO_MODE=host node scripts/demo-orchestrator.mjs

reset: ## Tear the compose stack down and delete its data (host databases: see db-reset)
	docker compose down -v
