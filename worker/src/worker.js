const amqp = require('amqplib');
const mongoose = require('mongoose');
const Redis = require('ioredis');
const Claim = require('./models/Claim');
const createProcessor = require('./claimProcessor');
const logger = require('./logger');

const cfg = {
  mongoUrl: process.env.MONGO_URL || 'mongodb://mongo:27017',
  mongoDb: process.env.MONGO_DB || 'flashdeal',
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379',
  rabbitUrl: process.env.RABBIT_URL || 'amqp://guest:guest@rabbitmq:5672',
  queue: 'claims',
  dlq: 'claims.dlq',
  prefetch: Number(process.env.WORKER_PREFETCH || 5),
  minMs: Number(process.env.PROCESSING_MS_MIN || 150),
  maxMs: Number(process.env.PROCESSING_MS_MAX || 400),
  failRate: Number(process.env.FAIL_RATE || 0),
  maxAttempts: 3,
};
const WORKER_ID = process.env.HOSTNAME || `worker-${process.pid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry a connection with exponential backoff until it works.
async function withBackoff(name, fn) {
  let delay = 500;
  for (;;) {
    try {
      const result = await fn();
      logger.info(`${name}_connected`);
      return result;
    } catch (err) {
      logger.warn(`${name}_connect_retry`, { err: err.message, delayMs: delay });
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
    }
  }
}

async function main() {
  mongoose.set('bufferTimeoutMS', 3000);
  await withBackoff('mongodb', () =>
    mongoose.connect(cfg.mongoUrl, { dbName: cfg.mongoDb, serverSelectionTimeoutMS: 3000 })
  );
  const { processClaim } = createProcessor({
    Claim,
    deals: mongoose.connection.collection('deals'),
    workerId: WORKER_ID,
  });

  const redis = new Redis(cfg.redisUrl);
  redis.on('error', (e) => logger.error('redis_error', { err: e.message }));
  const count = (name) => redis.incr(`metrics:${name}`).catch(() => {});

  const conn = await withBackoff('rabbitmq', () => amqp.connect(cfg.rabbitUrl));
  conn.on('close', () => {
    logger.error('rabbit_closed_exiting');
    process.exit(1); // docker `restart: unless-stopped` brings the worker back and it reconnects
  });
  conn.on('error', (e) => logger.error('rabbit_error', { err: e.message }));

  const ch = await conn.createChannel();
  await ch.assertQueue(cfg.queue, { durable: true });
  await ch.assertQueue(cfg.dlq, { durable: true });
  ch.prefetch(cfg.prefetch); // each worker handles up to N claims at once; scale out with --scale worker=N

  async function handle(msg) {
    if (!msg) return;
    let claim;
    try {
      claim = JSON.parse(msg.content.toString());
    } catch {
      logger.error('bad_message_to_dlq', { stage: 'worker' });
      ch.sendToQueue(cfg.dlq, msg.content, { persistent: true });
      return ch.ack(msg);
    }

    const attempts = Number((msg.properties.headers || {})['x-attempts'] || 0);
    const ctx = { stage: 'queue->worker', requestId: claim.requestId, claimId: claim.claimId, dealId: claim.dealId, worker: WORKER_ID, attempt: attempts + 1 };
    logger.info('claim_received', ctx);

    try {
      await sleep(cfg.minMs + Math.random() * (cfg.maxMs - cfg.minMs)); // simulated payment / validation latency
      if (cfg.failRate > 0 && Math.random() < cfg.failRate) throw new Error('simulated processing failure');

      const result = await processClaim(claim, attempts);
      logger.info(`claim_${result.outcome.toLowerCase()}`, { ...ctx, stage: 'worker->mongodb', reason: result.reason, stockLeft: result.stockLeft });

      count('processed');
      if (result.outcome === 'CONFIRMED') count('confirmed');
      else if (result.outcome === 'SOLD_OUT') count('sold_out');
      else if (result.outcome === 'REJECTED') count('rejected');
      ch.ack(msg);
    } catch (err) {
      if (attempts + 1 >= cfg.maxAttempts) {
        logger.error('claim_moved_to_dlq', { ...ctx, err: err.message });
        ch.sendToQueue(cfg.dlq, msg.content, { persistent: true, headers: { 'x-error': err.message } });
        return ch.ack(msg);
      }
      const delay = 500 * 2 ** attempts; // 500ms, 1s ... exponential backoff
      logger.warn('claim_retry_scheduled', { ...ctx, err: err.message, delayMs: delay });
      await sleep(delay); // message stays un-acked meanwhile, so it is not lost
      ch.sendToQueue(cfg.queue, msg.content, {
        persistent: true,
        contentType: 'application/json',
        messageId: claim.claimId,
        headers: { 'x-attempts': attempts + 1, 'x-request-id': claim.requestId },
      });
      ch.ack(msg);
    }
  }

  await ch.consume(cfg.queue, handle, { noAck: false });
  logger.info('worker_ready', { worker: WORKER_ID, prefetch: cfg.prefetch });

  const shutdown = async () => {
    logger.info('worker_shutting_down');
    try { await ch.close(); await conn.close(); await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error('worker_fatal', { err: err.message });
  process.exit(1);
});
