# Load test report

Group / members: ...   Date: ...

## 1. Setup
- Machine: CPU / RAM / OS:
- Rate limit: capacity 10, refill 5/sec per IP (or the values you used)
- Workers: 1 (prefetch 5), simulated payment latency 150-400 ms
- Catalogue: 6 deals, 601 units in total (deal-006 has only 6)
- Tool: `load-test/loadtest.js`, 500 requests, concurrency 50, a different shopper for every request

## 2. Results (paste from `load-test/results/*.json`)

| Test | Throughput (req/s) | 202/200 | 429 | 5xx | p50 | p95 | p99 |
|---|---|---|---|---|---|---|---|
| Claims, default limiter | | | | | | | |
| Claims, limiter raised (queue absorbs load) | | | | | | | |
| Deals (cache) | | | | | | | |

## 3. How the rate limiter protected the system
- % of requests rejected, queue depth at peak (RabbitMQ UI screenshot), time for the worker to drain.

## 4. Business correctness under load (from `stockCheck`)
- Stock before / after, units sold, confirmed claims, sold-out claims, `noOverselling` result.
- Explain why stock cannot go negative (atomic conditional update + database validator).

## 5. How the cache helped
- Cache hit rate, latency of HIT vs MISS, requests that never reached the catalog service.

## 6. Fault tolerance observations
- Circuit state changes (log lines), stale-cache responses while the service was down, recovery time.

## 7. Conclusions and limitations
- Bottlenecks, what you would change (replicated Redis/Mongo, transactions, horizontal gateway, per-user limits).
