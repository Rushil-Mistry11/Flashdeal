# Architecture and data flow

Mermaid renders on GitHub and at https://mermaid.live (export PNG/SVG for the submission).

## Components

```mermaid
flowchart LR
  U[Browser / load test] --> N[nginx :8080]
  U -->|direct :3000| G
  N --> G[API Gateway<br/>Express]
  G -->|token bucket, cache, counters| R[(Redis)]
  G -->|publish claim| Q[[RabbitMQ<br/>queue: claims]]
  G -->|breaker + retry| C[Catalog service]
  C -->|read deals| D[(MongoDB<br/>deals, claims)]
  Q --> W[Worker pool<br/>Node, scalable]
  W -->|reserve stock + save claim| D
  W -->|counters| R
  Q -. 3 failed attempts .-> DLQ[[claims.dlq]]
  G -->|health, my orders| D
  M[migrate job] -->|schema, indexes, seed| D
```

## Data flow: POST /api/claim

```mermaid
sequenceDiagram
  participant C as Client
  participant G as Gateway
  participant R as Redis
  participant Q as RabbitMQ
  participant W as Worker
  participant D as MongoDB
  C->>G: POST /api/claim {userId, dealId}
  G->>R: tokenBucket(ip)
  alt no token
    G-->>C: 429 Too Many Requests
  else token available
    G->>Q: publish claim (persistent, confirmed)
    G-->>C: 202 Accepted (claimId, requestId)
    Q->>W: deliver claim
    W->>D: already confirmed for this user and deal?
    W->>D: atomic: stock-1 only if stock > 0 and sale open
    alt unit reserved
      W->>D: insert CONFIRMED claim (price, order number)
    else no stock
      W->>D: insert SOLD_OUT claim
    end
    W->>R: INCR counters
    W->>Q: ack
    C->>G: GET /api/orders (polling)
    G->>D: read claims
    G-->>C: Confirmed / Sold out
  end
```

## Data flow: GET /api/deals

```mermaid
flowchart TD
  A[Request] --> B{Rate limit ok?}
  B -- no --> X[429]
  B -- yes --> C{Redis cache hit?}
  C -- yes --> H[200, X-Cache: HIT]
  C -- no --> D{Circuit open?}
  D -- yes --> S
  D -- no --> E[Call catalog service<br/>retry with backoff]
  E -- ok --> F[Cache 3s + save stale copy<br/>200, X-Cache: MISS]
  E -- fails --> S{Stale copy exists?}
  S -- yes --> T[200, X-Cache: STALE]
  S -- no --> U[503]
```

## Request tracing

Every request gets a `requestId` (header `X-Request-Id`, also saved on the claim and shown in the order receipt).
Each log line is JSON with `service`, `stage` and `requestId`:

`gateway` -> `rate-limiter` -> `gateway->queue` -> `queue->worker` -> `worker->mongodb`

Trace one request: `docker compose logs | grep <requestId>`
