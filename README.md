# FlashDeal: flash-sale backend with API gateway, rate limiter, queue and worker

A small distributed system built for the M.Tech system design assignment.
Shoppers claim limited-stock deals. Requests enter through an **API gateway**, are throttled by a **Redis token bucket**,
are pushed to **RabbitMQ**, and a **background worker** applies the business rules (stock, one claim per customer, sale
window) against **MongoDB**. A React app has three tabs: **Shop**, **My orders** and a **Control room**.

```
Browser (React) --> nginx :8080 --> API Gateway :3000 --+--> Redis (token bucket, cache, counters)
                                                        +--> RabbitMQ "claims" --> Worker(s) --> MongoDB (stock + claims)
                                                        +--> circuit breaker + retry --> Catalog service --> MongoDB (deals)
```

## Run it

Requirements: Docker Desktop (or Docker Engine + Compose v2). Nothing else.

```bash
docker compose up --build
```

First build takes a few minutes. Then open:

| What | URL |
|---|---|
| App (Shop, My orders, Control room) | http://localhost:8080 |
| Gateway health | http://localhost:3000/api/health |
| RabbitMQ UI | http://localhost:15672 (guest / guest) |
| MongoDB Compass | `mongodb://localhost:27018` (database `flashdeal`) |

Run it in the background with `docker compose up -d`. Stop with `docker compose down`.
**Data is kept** between runs (Docker volume `mongo-data`). To wipe everything: `docker compose down -v`.
For a clean demo without wiping, use **Reset sale** in the Control room.

## What is stored where

| Store | Data |
|---|---|
| MongoDB `deals` | the catalogue: prices, stock, sale window (seeded by a migration) |
| MongoDB `claims` | one document per claim request: confirmed, sold out or rejected, with price paid and order number |
| Redis | rate-limit buckets, deals cache (3 s), counters for the dashboard |
| RabbitMQ | claims waiting for a worker; failed ones end in `claims.dlq` |

## Business rules

- Stock never goes below zero: the worker takes a unit with one atomic update that only matches while `stock > 0`.
- One confirmed claim per customer per deal: checked by the worker and enforced by a unique index in MongoDB.
- A deal can only be claimed inside its sale window.
- Every claim ends as `CONFIRMED`, `SOLD_OUT` or `REJECTED` (already claimed, sale ended, not started, unknown deal).
- Prices and names are copied into the claim, so an order keeps the price paid even if the catalogue changes later.

## Endpoints

| Method | Path | Behaviour |
|---|---|---|
| POST | `/api/claim` | Body `{userId, dealId}`. Rate limited. Pushes to RabbitMQ, returns `202 Accepted` |
| GET | `/api/deals` | Rate limited. Redis cache, then circuit breaker + retry to the catalog service, stale cache as fallback |
| GET | `/api/orders?userId=...` | The user's finished claims from MongoDB |
| GET | `/api/health` | Status of Redis, MongoDB, RabbitMQ, catalog service, circuit state, counters |
| POST | `/api/admin/catalog-failure` | `{"enabled": true}` breaks the catalog service (demo) |
| POST | `/api/admin/reset-sale` | Restock all deals, restart countdowns, delete claims (demo) |
| POST | `/api/admin/reset-metrics` | Zero the counters |

```bash
curl -i -X POST localhost:3000/api/claim -H "Content-Type: application/json" -d '{"userId":"rv","dealId":"deal-001"}'
curl -s localhost:3000/api/health
```

## Assignment requirements -> where they live

| Requirement | Location |
|---|---|
| Git repo + base docker-compose | `docker-compose.yml` |
| Gateway with routing | `api-gateway/src/server.js` |
| Rate limiter (token bucket, 429) | `api-gateway/src/middleware/rateLimiter.js` + Lua script in `services/redisClient.js` |
| Health endpoint | `api-gateway/src/routes/health.js` |
| Mock / downstream service nodes | `catalog-service/` |
| Database schema + migration scripts | `db/migrations/`, `db/migrate.js`, `db/schema.md` |
| Redis cache and counters | `routes/deals.js`, `rateLimiter.js` |
| Async queue + worker loop updating the DB | `services/queuePublisher.js`, `worker/src/worker.js`, `worker/src/claimProcessor.js` |
| Circuit breaker | `api-gateway/src/services/circuitBreaker.js` |
| Retries with exponential backoff | `services/retry.js` (gateway), `worker.js` (job retries + dead-letter queue) |
| Load test script | `load-test/loadtest.js` (and optional `k6-spike.js`) |
| Structured logging / tracing | JSON logs everywhere, one `requestId` across all hops |
| Architecture + data flow diagram | `docs/architecture.md` |
| Load test report | `docs/load-test-report-template.md` |

## Live demo script (10 minutes)

1. `docker compose up -d --build`, show the containers in Docker Desktop (`migrate` runs once and exits, that is normal) and open the app.
2. **Shop.** Show prices, stock bars and countdowns coming from MongoDB. Click **Claim this deal**: it shows *Confirming*, a toast announces the order, and **My orders** shows a receipt. Show the same document in Compass.
3. **Business rules.** Claim the same deal again (button shows *Claimed*). Claim as a second user (change the name in the top bar).
4. **Control room > Send spike of 30.** Thirty shoppers hit the 6-unit smartwatch at once. About 10 pass the rate limiter, 6 get confirmed, the rest are sold out, stock ends at 0 and never below. Counters: Confirmed 6, Sold out ~4, Rate limited ~20.
5. **Async decoupling.** Open the RabbitMQ UI, raise the rate limit (see below), run the load test and watch the queue fill and drain while the gateway keeps answering fast.
6. **Fault tolerance.** *Break catalog service*, wait 4 s, click *Load deals* several times: retries in the logs, circuit goes OPEN, stale cache is served (the Shop shows a warning). *Repair*, wait 10 s: HALF_OPEN -> CLOSED.
7. **Load test.** `node load-test/loadtest.js --target claim --reset true` prints throughput, latency, 429 rate and a **stock check** (no overselling).
8. **Tracing.** Copy a `requestId` from an order receipt and run `docker compose logs | grep <requestId>` to show it crossing gateway, queue, worker and database.
9. **Scaling workers.** `docker compose up -d --scale worker=3` and show the workers sharing the queue.

## Load testing

Needs Node 18+ on your machine (no `npm install`):

```bash
cd load-test
node loadtest.js --target claim --total 500 --concurrency 50 --reset true
node loadtest.js --target deals --total 500 --concurrency 50
```

Results (throughput, p50/p95/p99, status counts, cache hits, worker counters, stock check) print on screen and are saved to
`load-test/results/`. `--reset true` restocks the sale first.

The limiter is per client IP and the test runs from one machine, so most requests get `429`: that is the limiter working.
To show the queue absorbing real load, raise the limit for one run (edit the two values under `api-gateway` in
`docker-compose.yml`, then `docker compose up -d api-gateway`):

```
RATE_LIMIT_CAPACITY=1000
RATE_LIMIT_REFILL_PER_SEC=1000
```

With a high limit, 500 claims are accepted, the queue fills, the worker drains it, and the stock check shows that
confirmed claims equal units sold even though far more shoppers than units were competing.

## Useful knobs (docker-compose.yml)

| Variable | Service | Meaning |
|---|---|---|
| `RATE_LIMIT_CAPACITY`, `RATE_LIMIT_REFILL_PER_SEC` | gateway | token bucket size and refill rate |
| `CACHE_TTL_SEC`, `BREAKER_FAILURES`, `BREAKER_RESET_MS` | gateway | cache lifetime, circuit thresholds |
| `WORKER_PREFETCH`, `PROCESSING_MS_MIN/MAX` | worker | concurrency per worker, simulated payment latency |
| `FAIL_RATE` | worker | e.g. `0.5` makes half of the claims fail to show retries and the dead-letter queue |

## Design notes (good viva answers)

- **Why a queue for a flash sale**: thousands of people want the last few units at once. The gateway answers `202` immediately, and a single ordered consumer decides who gets the stock, so the database is never hammered and the last unit cannot be sold twice.
- **Token bucket in Lua**: the read-modify-write runs atomically inside Redis, so many gateway instances can share one limiter.
- **Fail open**: if Redis is down the limiter allows traffic and logs an error (availability over protection).
- **Atomic stock update**: `findOneAndUpdate({stock: {$gt: 0}}, {$inc: {stock: -1}})` is applied one at a time per document by MongoDB. The `stock >= 0` validator is a second safety net.
- **At-least-once + idempotency**: the worker acks only after saving; a redelivered message hits the unique `claimId` and is ignored.
- **Known limit**: reserving stock and saving the claim are two writes. A worker crash between them can leave one unit reserved (under-selling, never over-selling). A replica set with transactions would remove this.
- **Eventual consistency**: a claim appears in "My orders" a moment after the `202`. The UI shows it as *Processing* until the worker finishes.
- **Circuit breaker**: after 3 failures the gateway stops calling the catalog service and serves stale cached deals.
- **Other limits**: single Redis, RabbitMQ and MongoDB (no replication); rate limit is per IP; the user name in the app is not real authentication.

## Troubleshooting

- **Port already in use** (3000, 8080, 15672, 27018): change the left side of that port mapping in `docker-compose.yml`.
- **Services restart a few times at first start**: RabbitMQ and MongoDB are slow to boot; the gateway and worker retry and settle on their own.
- **Shop is empty or shows an error**: check `docker compose logs migrate catalog-service`. The `migrate` container must have finished successfully.
- **Everything looks sold out**: click *Reset sale* in the Control room.
- **Start completely fresh**: `docker compose down -v` then `docker compose up --build`.
