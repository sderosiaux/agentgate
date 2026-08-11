.PHONY: help setup dev dev-db require-env db-migrate test demo demo-host reset

help: ## List the available targets
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

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

db-migrate: require-env ## Apply migrations from the host to the test database
	@set -a && . ./.env && set +a && DATABASE_URL="$$DATABASE_URL_TEST" \
		pnpm --filter @agentgate/gateway exec prisma migrate deploy

test: require-env dev-db db-migrate ## Run every workspace test suite (needs the database)
	pnpm -r test

demo: require-env ## Run the end-to-end authorization demo (cases 0-6, in containers)
	docker compose --profile demo build demo-agent
	node scripts/demo-orchestrator.mjs

demo-host: require-env db-migrate ## Run the demo without Docker: local gateway, upstream and agent
	DEMO_MODE=host node scripts/demo-orchestrator.mjs

reset: ## Tear the stack down and delete its data
	docker compose down -v
