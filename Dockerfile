# NoLaptop — a small Next.js app with a SQLite database and outbound SSH.
# Nothing is compiled natively except better-sqlite3, so one build stage is enough.

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

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/scripts ./scripts

# The container may run as any uid (see docker-compose.yml), so the two
# directories that are written at runtime are made writable for everyone.
RUN mkdir -p /app/data /app/.next/cache \
    && chown -R nolaptop:nolaptop /app/data /app/.next \
    && chmod -R a+rwX /app/data /app/.next/cache
USER nolaptop
VOLUME ["/app/data"]
EXPOSE 4400

# The schema is pushed on every start: it is idempotent and keeps an upgraded
# image working against an existing database without a manual step.
CMD ["sh", "-c", "npx prisma db push --skip-generate 2>/dev/null || npx prisma db push; exec npx next start -p 4400"]
