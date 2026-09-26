#!/usr/bin/env bash
# Check that this machine can run NoLaptop, and that the servers you plan to
# manage have what they need. Nothing is installed or changed here.

set -uo pipefail

QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1

ok=0
warn=0
fail=0

green() { printf '  \033[32m✓\033[0m %s\n' "$1"; ok=$((ok + 1)); }
yellow() { printf '  \033[33m!\033[0m %s\n' "$1"; warn=$((warn + 1)); }
red() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }

echo ""
echo "NoLaptop — checking this machine"
echo ""

# --- what NoLaptop itself needs -------------------------------------------

if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "$major" -ge 20 ]]; then
    green "Node $(node -v)"
  else
    red "Node $(node -v) — version 20 or newer is required"
  fi
else
  red "Node is not installed (version 20+ required)"
fi

command -v npm >/dev/null 2>&1 && green "npm $(npm -v)" || red "npm is not installed"

if command -v git >/dev/null 2>&1; then
  green "git $(git --version | awk '{print $3}')"
else
  yellow "git is not installed — fine for running, needed for contributing"
fi

# --- configuration ---------------------------------------------------------

if [[ -f .env ]]; then
  key="$(grep -E '^NL_ENCRYPTION_KEY=' .env | cut -d= -f2- | tr -d '"')"
  pw="$(grep -E '^NL_APP_PASSWORD=' .env | cut -d= -f2- | tr -d '"')"
  [[ ${#key} -ge 32 ]] && green "NL_ENCRYPTION_KEY is set" || red "NL_ENCRYPTION_KEY missing or too short — run: npm run setup"
  [[ ${#pw} -ge 8 ]] && green "NL_APP_PASSWORD is set" || red "NL_APP_PASSWORD missing or too short — run: npm run setup"
  perms="$(stat -c '%a' .env 2>/dev/null || stat -f '%A' .env 2>/dev/null)"
  [[ "$perms" == "600" ]] && green ".env is private (mode 600)" || yellow ".env is mode $perms — 600 would be safer"
else
  yellow ".env does not exist yet — run: npm run setup"
fi

[[ -f data/nolaptop.db ]] && green "Database exists" || yellow "Database not created yet — run: npx prisma db push"

# --- what the servers you manage need --------------------------------------

echo ""
echo "Checking this machine as a *managed server* (optional — you may manage others instead)"
echo ""

command -v tmux >/dev/null 2>&1 && green "tmux $(tmux -V | awk '{print $2}')" \
  || yellow "tmux not found here — required on every server you manage"

if command -v claude >/dev/null 2>&1; then
  green "claude $(claude --version 2>/dev/null | awk '{print $1}')"
  if claude auth status --json 2>/dev/null | grep -q '"loggedIn": *true'; then
    email="$(claude auth status --json 2>/dev/null | sed -n 's/.*"email": *"\([^"]*\)".*/\1/p')"
    green "Claude Code is signed in${email:+ as $email}"
  else
    yellow "Claude Code is not signed in here — run: claude auth login"
  fi
else
  yellow "claude CLI not found here — required on every server you manage"
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  green "Docker is available (needed only for the optional shared database and storage)"
else
  yellow "Docker not available — the optional shared PostgreSQL and S3 cannot be started here"
fi

if command -v sshd >/dev/null 2>&1 || [[ -S /run/sshd.pid ]] || ss -tln 2>/dev/null | grep -q ':22 '; then
  green "An SSH server is listening — this machine can be managed by NoLaptop"
else
  yellow "No SSH server detected here (only matters if you want to manage this machine)"
fi

echo ""
printf 'Result: \033[32m%d ok\033[0m, \033[33m%d warning(s)\033[0m, \033[31m%d blocking\033[0m\n' "$ok" "$warn" "$fail"
echo ""

if [[ $fail -gt 0 ]]; then
  [[ $QUIET -eq 1 ]] && exit 0
  echo "Fix the blocking items above, then run: make install"
  exit 1
fi
exit 0
