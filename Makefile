SHELL := /bin/bash
.DEFAULT_GOAL := help

PORT ?= 4400

# ---------------------------------------------------------------- help

help: ## Show this help
	@echo "NoLaptop — start a coding agent on any of your servers, from your phone."
	@echo ""
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "First time?  make install  then  make dev"

# ---------------------------------------------------------------- setup

check: ## Check that this machine can run NoLaptop
	@bash scripts/check.sh

install: ## Install dependencies, generate secrets, create the database
	@bash scripts/check.sh --quiet || true
	npm install
	npm run setup
	npx prisma db push
	@echo ""
	@echo "Ready. Start it with:  make dev    (or: make start)"

# ---------------------------------------------------------------- running

dev: ## Run in development mode, with hot reload
	npm run dev

start: ## Build and run in production mode
	npm run build
	npm start

docker: ## Run with Docker Compose on localhost
	@mkdir -p data
	npx prisma db push
	NL_UID=$$(id -u) NL_GID=$$(id -g) docker compose up -d --build
	@echo "NoLaptop is on http://localhost:$(PORT)"
	@echo "Password:  grep NL_APP_PASSWORD .env"

docker-stop: ## Stop the Docker Compose stack
	docker compose down

logs: ## Follow the Docker Compose logs
	docker compose logs -f

# ---------------------------------------------------------------- publish

deploy: ## Publish on NL_PUBLIC_HOSTNAME with TLS — see README "Publishing it"
	@bash scripts/deploy.sh

deploy-stop: ## Take the published instance down
	@docker compose -f docker-compose.yml -f docker-compose.traefik.yml down 2>/dev/null \
		|| docker compose -f docker-compose.yml -f docker-compose.caddy.yml down 2>/dev/null \
		|| docker compose down

# ---------------------------------------------------------------- quality

typecheck: ## Type-check without emitting
	npx tsc --noEmit

build: ## Production build
	npm run build

# ---------------------------------------------------------------- demo

demo: ## Create two example projects on a server to see what this does
	@node scripts/demo.mjs

demo-clean: ## Remove what `make demo` created
	@node scripts/demo.mjs --clean

# ---------------------------------------------------------------- data

reset: ## Delete the local database — servers, sessions and resources are forgotten
	@read -p "Delete the NoLaptop database? Remote projects are untouched. [y/N] " ok; \
	  if [ "$$ok" = "y" ]; then rm -f data/nolaptop.db && npx prisma db push && echo "Database reset."; \
	  else echo "Cancelled."; fi

.PHONY: help check install dev start docker docker-stop logs deploy deploy-stop typecheck build demo demo-clean reset
