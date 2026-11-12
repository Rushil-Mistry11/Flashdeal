const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

module.exports = {
  port: num(process.env.PORT, 3000),
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379',
  rabbitUrl: process.env.RABBIT_URL || 'amqp://guest:guest@rabbitmq:5672',
  mongoUrl: process.env.MONGO_URL || 'mongodb://mongo:27017',
  mongoDb: process.env.MONGO_DB || 'flashdeal',
  catalogServiceUrl: process.env.CATALOG_SERVICE_URL || 'http://catalog-service:4000',
  queueName: 'claims',
  rateLimit: {
    capacity: num(process.env.RATE_LIMIT_CAPACITY, 10),          // max burst
    refillPerSec: num(process.env.RATE_LIMIT_REFILL_PER_SEC, 5), // sustained rate
  },
  cacheTtlSec: num(process.env.CACHE_TTL_SEC, 3),
  breaker: {
    failureThreshold: num(process.env.BREAKER_FAILURES, 3),
    resetTimeoutMs: num(process.env.BREAKER_RESET_MS, 10000),
  },
};
