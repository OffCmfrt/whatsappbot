const { Queue, Worker, QueueScheduler } = require('bullmq');
const Redis = require('ioredis');
const connection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const messageHandler = require('../handlers/messageHandler');

const MESSAGE_QUEUE_NAME = 'whatsappMessageQueue';

// Create QueueScheduler to handle delayed, stalled jobs
new QueueScheduler(MESSAGE_QUEUE_NAME, { connection });

// Create a message Queue
const messageQueue = new Queue(MESSAGE_QUEUE_NAME, { connection });

// Create a worker to process queued messages
const worker = new Worker(
  MESSAGE_QUEUE_NAME,
  async job => {
    const { from, messageBody, senderName } = job.data;
    try {
      await messageHandler.processMessage(from, messageBody, senderName);
      return { status: 'completed' };
    } catch (error) {
      console.error('Error processing queued message:', error);
      throw error;
    }
  },
  { connection }
);

worker.on('failed', (job, err) => {
  console.error(`Job failed for ${job.id} with error: ${err.message}`);
});

worker.on('completed', job => {
  console.log(`Job completed for ${job.id}`);
});

console.log('📥 Queue Worker started and listening for messages');

module.exports = {
  messageQueue
};
