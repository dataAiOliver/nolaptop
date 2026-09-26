#!/usr/bin/env bash
#
# Publish NoLaptop on a hostname with TLS.
#
# This does not know your infrastructure, and does not try to: it reads four
# values from .env, checks the things that actually go wrong (DNS pointing
# somewhere else, a proxy network that does not exist, the secrets missing),
# then builds and starts the container behind the proxy you chose.
#
# Everything it needs is in .env — nothing about any particular server is
# committed to this repository.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

green() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
yellow() { printf '  \033[33m!\033[0m %s\n' "$1"; }
red() { printf '  \033[31m✗\033[0m %s\n' "$1"; }
die() { red "$1"; printf '\n'; exit 1; }

# ------------------------------------------------------------------ config

[[ -f .env ]] || die ".env does not exist. Run: make install"

get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d '"'"'"'\r'; }

HOSTNAME_="$(get NL_PUBLIC_HOSTNAME)"
PROXY="$(get NL_PROXY)"
PROXY="${PROXY:-traefik}"
NETWORK="$(get NL_TRAEFIK_NETWORK)"
NETWORK="${NETWORK:-proxy}"

printf '\nPublishing NoLaptop\n\n'

[[ -n "$HOSTNAME_" ]] || die "NL_PUBLIC_HOSTNAME is not set in .env. Add: NL_PUBLIC_HOSTNAME=\"nolaptop.example.com\""
[[ -n "$(get NL_ENCRYPTION_KEY)" && -n "$(get NL_APP_PASSWORD)" ]] \
  || die "The secrets are missing. Run: npm run setup"
green "Hostname: $HOSTNAME_"

case "$PROXY" in
  traefik|caddy|none) green "Proxy: $PROXY" ;;
  *) die "NL_PROXY must be traefik, caddy or none — got \"$PROXY\"" ;;
esac

# The container writes to the bind-mounted ./data, so it must run as whoever
# owns that directory here.
mkdir -p data
NL_UID="$(stat -c '%u' data 2>/dev/null || id -u)"
NL_GID="$(stat -c '%g' data 2>/dev/null || id -g)"
export NL_UID NL_GID
green "Runs as uid $NL_UID:$NL_GID (owner of ./data)"

command -v docker >/dev/null 2>&1 || die "Docker is not installed."
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is not available."
green "Docker is available"

# --------------------------------------------------------------------- DNS

resolved="$(getent ahostsv4 "$HOSTNAME_" 2>/dev/null | awk '{print $1; exit}')"
public="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"

if [[ -z "$resolved" ]]; then
  yellow "$HOSTNAME_ does not resolve yet. Add an A record pointing at ${public:-this machine}."
elif [[ -n "$public" && "$resolved" != "$public" ]]; then
  yellow "$HOSTNAME_ resolves to $resolved, but this machine is $public."
  yellow "Certificates will fail until the A record points here. Continuing anyway."
else
  green "DNS: $HOSTNAME_ → $resolved"
fi

# ------------------------------------------------------------------- proxy

FILES=(-f docker-compose.yml)

if [[ "$PROXY" == "traefik" ]]; then
  if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
    die "The Docker network \"$NETWORK\" does not exist. Set NL_TRAEFIK_NETWORK to the one your Traefik uses."
  fi
  green "Traefik network: $NETWORK"
  FILES+=(-f docker-compose.traefik.yml)
elif [[ "$PROXY" == "caddy" ]]; then
  for port in 80 443; do
    if ss -tln 2>/dev/null | grep -qE ":$port\b"; then
      yellow "Port $port is already in use. Caddy needs it — is another proxy running?"
    fi
  done
  FILES+=(-f docker-compose.caddy.yml)
else
  yellow "No proxy: NoLaptop stays on 127.0.0.1 and nothing is published."
fi

# ------------------------------------------------------------------- build

# The runtime image has no Prisma CLI, so the schema is applied from here —
# ./data is the same bind mount the container will use.
printf '\n'
npx prisma db push >/dev/null 2>&1 && green "Database schema up to date" \
  || yellow "Could not apply the schema. Run: npx prisma db push"

docker compose "${FILES[@]}" build || die "The image did not build."
green "Image built"

docker compose "${FILES[@]}" up -d --remove-orphans || die "The container did not start."
green "Container started"

# ------------------------------------------------------------------ verify

printf '\n  Waiting for it to answer'
ok=""
for _ in $(seq 1 30); do
  printf '.'
  if docker compose "${FILES[@]}" exec -T nolaptop \
      node -e "fetch('http://127.0.0.1:4400/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
    ok="yes"
    break
  fi
  sleep 2
done
printf '\n'
[[ -n "$ok" ]] || die "It did not come up. Look at: docker compose logs nolaptop"
green "The app is healthy inside the container"

if [[ "$PROXY" != "none" ]]; then
  printf '  Waiting for the certificate'
  live=""
  for _ in $(seq 1 30); do
    printf '.'
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "https://$HOSTNAME_/api/status" 2>/dev/null || true)"
    if [[ "$code" == "200" ]]; then live="yes"; break; fi
    sleep 4
  done
  printf '\n'
  if [[ -n "$live" ]]; then
    green "https://$HOSTNAME_ is live"
  else
    yellow "https://$HOSTNAME_ is not answering yet."
    yellow "A fresh certificate can take a minute. Check your proxy's log if it stays this way."
  fi
fi

printf '\n  Sign in with the password in .env:  grep NL_APP_PASSWORD .env\n\n'
