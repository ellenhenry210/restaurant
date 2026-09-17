# Multi-stage build — the final image ships only production
# dependencies and application code, not devDependencies (jest,
# supertest, nodemon, eslint) or the npm cache layers used to install
# them.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app

# Runs as a dedicated non-root user, not the image's default root — a
# compromised Node process (a dependency vulnerability, an injection bug)
# then can't write outside its own app directory or touch anything else
# on the host/container.
RUN addgroup -S snaporder && adduser -S snaporder -G snaporder

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY database ./database

USER snaporder

EXPOSE 3000

# Same check the app exposes for load-balancer/orchestrator health
# probes (see src/app.js) — process-up only for now (known gap: doesn't
# yet verify DB/Redis/RabbitMQ connectivity), not a Docker-specific check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Migrations run at boot (src/init-db.js) — fine for this single-instance
# deployment; see that file's doc comment for when that stops being true
# (multiple instances behind a load balancer need migrations moved to a
# separate, single controlled deploy step instead).
CMD ["node", "src/index.js"]
