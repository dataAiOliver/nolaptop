# NoLaptop — a small Next.js app with a SQLite database and outbound SSH.
#
# The runtime image carries production dependencies only. Build tooling — the
# Prisma CLI above all — never ships: it drags in database drivers this app
# does not use (mysql2 among them), and an image should not contain code it
# cannot run.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# --ignore-scripts keeps every package's postinstall from running, but
# better-sqlite3 needs its native binding built — so that one is rebuilt
# explicitly rather than trusting the whole dependency tree.
RUN npm ci --ignore-scripts \
    && npm rebuild better-sqlite3 \
    && npx prisma generate

# Production dependencies, plus the generated Prisma client copied across from
# the full tree — `prisma generate` needs the CLI, which does not live here.
FROM node:22-bookworm-slim AS proddeps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild better-sqlite3
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=deps /app/node_modules/@prisma/client ./node_modules/@prisma/client

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npx next build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=4400
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --uid 10001 nolaptop

COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json

# The container may run as any uid (see docker-compose.yml), so the two
# directories that are written at runtime are made writable for everyone.
RUN mkdir -p /app/data /app/.next/cache \
    && chown -R nolaptop:nolaptop /app/data /app/.next \
    && chmod -R a+rwX /app/data /app/.next/cache
USER nolaptop
VOLUME ["/app/data"]
EXPOSE 4400

# The schema is applied from the host before the container starts — see
# scripts/deploy.sh and the `docker` target in the Makefile.
CMD ["node_modules/.bin/next", "start", "-p", "4400"]
