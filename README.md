# SnapOrder

An in-restaurant, table-side ordering system. A QR code tagged to a physical
table lets a guest scan it, view the menu, and place a precise order
directly — not a delivery app, and not just a digital menu. Built to make
ordering faster for both the guest and the waiter.

## Project layout

```
backend/    Express API (Node.js, ESM)
frontend/   React + Vite
```

Design/spec docs live at the repo root: `SNAPORDER_DESIGN_SYSTEM.md`,
`SNAPORDER_DATABASE_SCHEMA.md`, `SNAPORDER_API_CONTRACTS.md`,
`SNAPORDER_AUTHORIZATION.md` (the RBAC/ABAC/IAM/PAM model), and
`SNAPORDER_GITHUB_SETUP.md`.

## Prerequisites

- [Node.js](https://nodejs.org/) v20+ and npm
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (for Postgres, Redis, RabbitMQ)

## Quick start

```bash
# 1. Install dependencies for both backend and frontend
npm run setup

# 2. Copy env templates and fill in real values where needed
#    (defaults work as-is for local dev)
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env

# 3. Start Postgres, Redis, and RabbitMQ
docker-compose up -d

# 4. Apply the database schema (safe to re-run — skips what's already applied)
npm run migrate

# 5. Start the backend and frontend (in separate terminals)
npm run dev:backend    # http://localhost:3000
npm run dev:frontend   # http://localhost:5173
```

RabbitMQ's management UI is at http://localhost:15672 (guest/guest).

### A local-machine quirk worth knowing about

If you already have a native Postgres installation on this machine, it may
already be bound to port 5432 — that's why `docker-compose.yml` maps this
project's Postgres container to host port **5433** instead. `DB_PORT=5433`
in `.env.example` already reflects this; no action needed unless you've
changed the mapping.

## Useful commands

| Command | What it does |
|---|---|
| `npm run setup` | `npm install` in both `backend/` and `frontend/` |
| `npm run migrate` | Applies any new database migrations |
| `npm run dev:backend` | Starts the backend with auto-reload |
| `npm run dev:frontend` | Starts the Vite dev server |
| `docker-compose up -d` | Starts Postgres/Redis/RabbitMQ |
| `docker-compose down` | Stops them (data persists in Docker volumes) |
| `docker-compose logs -f` | Tails logs from all three services |

## Testing

```bash
cd backend
npm test
```

Self-contained: `tests/globalSetup.js` creates a separate `snaporder_test`
database on the same local Postgres (never the dev one — tests truncate
tables between runs) and applies every migration to it automatically, the
first time you run `npm test`. Requires `docker-compose up -d` to already
be running (or any reachable Postgres matching `backend/.env.test`).

Unit tests (`tests/unit/`) cover pure logic with no database — JWT
issuance/verification, the Haversine proximity math, the RBAC permission
matrix, Paystack webhook signature verification. Integration tests
(`tests/integration/`) exercise real HTTP requests against the actual
Express app (`backend/src/app.js`) with `supertest`, backed by the real
test database — this is where model+controller+route behavior is
actually verified, including RBAC denials, the allergen removal-policy
engine, order state transitions, and the Paystack payment/webhook flow
(the Paystack API call itself is mocked; signature verification is not).

## CI/CD

`.github/workflows/ci.yml` runs on every push/PR to `main`: lint both
apps, run the backend test suite against a real Postgres service
container, `npm audit` both apps (fails on high/critical), build both
Docker images, and build the frontend for production. On a push to
`main`, both Docker images are also published to GitHub Container
Registry (`ghcr.io`) using the repo's own token — no extra secrets
needed. **Not built yet:** actually deploying those published images
anywhere — there's no hosting target configured. See `known-gaps.md`
(session memory) for the full list of what's next.

## Production Docker setup

`docker-compose.prod.yml` builds and runs the real application images
(`backend/Dockerfile`, `frontend/Dockerfile`) alongside Postgres/Redis/
RabbitMQ — unlike the dev `docker-compose.yml`, which only runs those
three and expects `npm run dev` for the apps themselves. Copy
`.env.prod.example` to `.env` in the repo root, fill in real secrets,
then:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Only the backend (3000) and frontend (80) ports are published to the
host — Postgres/Redis/RabbitMQ stay inside the Docker network, unlike
the dev compose file (which publishes all three for local tooling).

## Status

Early development. See `SNAPORDER_AUTHORIZATION.md` and the other
`SNAPORDER_*.md` docs at the repo root for the current design specs, and
`SNAPORDER_DATABASE_SCHEMA.md` for what's actually implemented in the
database (`backend/database/migrations/`).
