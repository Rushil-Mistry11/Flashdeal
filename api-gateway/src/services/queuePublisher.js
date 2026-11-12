const amqp = require('amqplib');
const config = require('../config');
const logger = require('../utils/logger');
const { sleep } = require('./retry');

const state = { connected: false };
let connection = null;
let channel = null;
let looping = false;

// Keeps trying (with backoff) until RabbitMQ is reachable; re-runs automatically if the connection drops.
async function connectLoop() {
  if (looping) return;
  looping = true;
  let delay = 500;
  try {
    for (;;) {
      try {
        connection = await amqp.connect(config.rabbitUrl);
        connection.on('error', (e) => logger.error('rabbit_connection_error', { err: e.message }));
        connection.on('close', () => {
          state.connected = false;
          channel = null;
          logger.warn('rabbit_connection_closed');
          setTimeout(connectLoop, 1000);
        });
        channel = await connection.createConfirmChannel();
        channel.on('error', (e) => logger.error('rabbit_channel_error', { err: e.message }));
        await channel.assertQueue(config.queueName, { durable: true });
        state.connected = true;
        logger.info('rabbit_connected');
        return;
      } catch (err) {
        logger.warn('rabbit_connect_retry', { err: err.message, delayMs: delay });
        await sleep(delay);
        delay = Math.min(delay * 2, 5000);
      }
    }
  } finally {
    looping = false;
  }
}

// Resolves only after the broker confirms it stored the message.
function publish(message) {
  return new Promise((resolve, reject) => {
    if (!state.connected || !channel) return reject(new Error('queue unavailable'));
    channel.sendToQueue(
      config.queueName,
      Buffer.from(JSON.stringify(message)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: message.claimId,
        headers: { 'x-attempts': 0, 'x-request-id': message.requestId },
      },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

async function queueDepth() {
  if (!state.connected || !channel) return null;
  try {
    const q = await channel.checkQueue(config.queueName);
    return q.messageCount;
  } catch {
    return null;
  }
}

module.exports = { connectLoop, publish, queueDepth, state };
