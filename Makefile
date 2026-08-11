.PHONY: help setup dev dev-db db-migrate test demo reset

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

db-migrate: ## Apply migrations from the host to the compose database
	@set -a && . ./.env && set +a && DATABASE_URL="$$DATABASE_URL_TEST" \
		pnpm --filter @agentgate/gateway exec prisma migrate deploy

test: dev-db db-migrate ## Run every workspace test suite (needs the database)
	pnpm -r test

demo: ## Run the end-to-end authorization demo
	@echo "The demo scenario is implemented in sub-plan 09 (SDK + demo agent)."

reset: ## Tear the stack down and delete its data
	docker compose down -v
