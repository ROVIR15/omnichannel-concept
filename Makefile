# Omnichannel messaging concept — task runner.
# Recipes are written with spaces below and converted; edit with real tabs.

# PORT resolution: command line  >  .env  >  default.
DOTENV_PORT := $(shell [ -f .env ] && sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*//p' .env | tail -1 | tr -d '"'"'"' ')
PORT       ?= $(or $(DOTENV_PORT),12301)
NGROK_DOMAIN ?= $(shell [ -f .env ] && sed -n 's/^[[:space:]]*NGROK_DOMAIN[[:space:]]*=[[:space:]]*//p' .env | tail -1 | tr -d '"'"'"' ')
BASE       ?= http://localhost:$(PORT)
LOG        ?= /tmp/omnichannel-$(PORT).log
BUN        ?= bun
DB         ?= data/omnichannel.sqlite

.DEFAULT_GOAL := help
.PHONY: help install env dev start bg stop restart logs sim demo check typecheck channels health tunnel tunnel-url tunnel-cf db-reset db-shell db-dump clean nuke

help: ## Show available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "  PORT=$(PORT)  (source: $(if $(DOTENV_PORT),.env,default)  ·  override: make dev PORT=4000)"

install: ## Install dependencies
	$(BUN) install

env: ## Create .env from .env.example if missing
	@test -f .env && echo ".env already exists, leaving it alone" \
	  || (cp .env.example .env && echo "created .env — fill in your credentials")

dev: ## Run with hot reload (foreground)
	PORT=$(PORT) $(BUN) --watch src/index.ts

start: ## Run once (foreground)
	PORT=$(PORT) $(BUN) src/index.ts

bg: stop ## Run in the background, logging to a temp file
	@PORT=$(PORT) nohup $(BUN) src/index.ts > $(LOG) 2>&1 & \
	  sleep 1.5; \
	  curl -sf $(BASE)/health > /dev/null \
	    && echo "running on $(BASE)  (logs: make logs)" \
	    || (echo "failed to start — see $(LOG)"; tail -20 $(LOG); exit 1)

stop: ## Stop the background server
	@pids=$$(lsof -ti:$(PORT) 2>/dev/null); \
	  if [ -n "$$pids" ]; then kill -9 $$pids && echo "stopped :$(PORT)"; fi

restart: bg ## Restart the background server

logs: ## Tail background server logs
	@touch $(LOG); tail -f $(LOG)

sim: ## Fire sample webhooks at a running server (all 5 channels)
	@BASE=$(BASE) ./scripts/simulate.sh

demo: bg sim ## Start server, send sample traffic, open the inbox
	@echo; echo "inbox → $(BASE)/"
	@command -v open > /dev/null && open $(BASE)/ || true

check: ## Run the capability/session-window guard checks (in-memory DB)
	DB_PATH=:memory: $(BUN) scripts/check-guards.ts

typecheck: ## Type-check without emitting
	$(BUN) x tsc --noEmit

channels: ## Show per-channel capabilities from a running server
	@curl -s $(BASE)/api/channels | $(BUN) x json 2>/dev/null || curl -s $(BASE)/api/channels

health: ## Ping a running server
	@curl -sf $(BASE)/health && echo || (echo "not running on $(BASE)"; exit 1)

tunnel: ## Public HTTPS URL for webhooks (ngrok; set NGROK_DOMAIN in .env for a stable one)
	@command -v ngrok > /dev/null \
	  || (echo "install ngrok first: brew install ngrok"; exit 1)
	@echo "Leave this running. Webhook URL = <public-url>/webhooks/meta"
	@if [ -n "$(NGROK_DOMAIN)" ]; then \
	   echo "Using stable domain: https://$(NGROK_DOMAIN)"; \
	   ngrok http $(PORT) --domain=$(NGROK_DOMAIN); \
	 else \
	   echo "No NGROK_DOMAIN set — the URL will change on every restart."; \
	   echo "Claim a free static domain at https://dashboard.ngrok.com/domains, then set"; \
	   echo "NGROK_DOMAIN=your-name.ngrok-free.app in .env to stop re-pasting into Meta."; \
	   ngrok http $(PORT); \
	 fi

tunnel-url: ## Print the public URL of a running ngrok tunnel
	@curl -s --max-time 3 http://127.0.0.1:4040/api/tunnels 2>/dev/null \
	  | python3 -c "import sys,json; t=json.load(sys.stdin).get('tunnels',[]); print(t[0]['public_url'] if t else 'no ngrok tunnel running')" 2>/dev/null \
	  || echo "no ngrok tunnel running"

tunnel-cf: ## Fallback: cloudflared quick tunnel (URL changes every restart)
	@command -v cloudflared > /dev/null \
	  || (echo "install cloudflared first: brew install cloudflared"; exit 1)
	cloudflared tunnel --config scripts/cloudflared-quick.yml \
	  --protocol http2 --edge-ip-version 4 --url $(BASE)

db-reset: stop ## Delete the SQLite database (re-seeds on next start)
	@rm -f $(DB) $(DB)-wal $(DB)-shm && echo "removed $(DB) — it will re-seed from .env on next start"

db-shell: ## Open a sqlite3 shell on the database
	@sqlite3 $(DB)

db-dump: ## Show what is stored (orgs, channels, message counts)
	@sqlite3 -header -column $(DB) \
	  "SELECT name AS organisation, (SELECT COUNT(*) FROM channel_accounts c WHERE c.org_id=o.id) AS channels, (SELECT COUNT(*) FROM conversations v WHERE v.org_id=o.id) AS conversations FROM organisations o;"

clean: stop ## Stop server and remove logs
	@rm -f $(LOG)

nuke: clean ## Also remove node_modules and the lockfile
	@rm -rf node_modules bun.lock && echo "removed node_modules and bun.lock"
