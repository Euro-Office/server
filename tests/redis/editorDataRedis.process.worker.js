'use strict';

require('./testSetup');

const {EditorData, EditorStat} = require('../../DocService/sources/editorDataRedis');
const {context} = require('./testHelpers');

const replicaId = process.env.TEST_REDIS_REPLICA_ID || `replica-${process.pid}`;
const data = new EditorData();
const stat = new EditorStat();
let closing = false;

function send(message) {
  if (process.connected) {
    process.send({...message, replicaId, pid: process.pid});
  }
}

function revive(value) {
  if (Array.isArray(value)) {
    return value.map(revive);
  }
  if (value && value.__type === 'context') {
    return context(value.tenant, value.overrides || {});
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
  }
  return value;
}

function storeFor(target) {
  if (target === 'data') {
    return data;
  }
  if (target === 'stat') {
    return stat;
  }
  throw new Error(`Unknown store target: ${target}`);
}

async function close() {
  if (closing) {
    return;
  }
  closing = true;
  await Promise.all([data.close(), stat.close()]);
}

async function dispatch(message) {
  const store = storeFor(message.target);
  const args = revive(message.args || []);
  let restoreSendCommand;

  if (message.signalOnCommand) {
    if (!store.redis.client) {
      throw new Error('Redis client is not connected before controlled dispatch');
    }
    const client = store.redis.client;
    const sendCommand = client.sendCommand.bind(client);
    client.sendCommand = (...commandArgs) => {
      const result = sendCommand(...commandArgs);
      const command = commandArgs[commandArgs.length - 1];
      if (Array.isArray(command) && command[0] === 'EVAL') {
        send({type: 'redis-command-started', requestId: message.requestId, command: command[0]});
        if (message.holdAfterCommand) {
          return Promise.resolve(result).then(() => {
            send({type: 'redis-command-committed', requestId: message.requestId});
            return new Promise(() => {});
          });
        }
      }
      return result;
    };
    restoreSendCommand = () => {
      client.sendCommand = sendCommand;
    };
  }

  try {
    const value = await store[message.method](...args);
    send({type: 'result', requestId: message.requestId, value});
  } finally {
    if (restoreSendCommand) {
      restoreSendCommand();
    }
  }
}

async function handle(message) {
  if (!message || typeof message !== 'object') {
    throw new Error('Worker received an invalid message');
  }
  if (message.type === 'shutdown') {
    await close();
    send({type: 'shutdown-complete', requestId: message.requestId});
    setImmediate(() => process.exit(0));
    return;
  }
  if (message.type === 'dispatch') {
    await dispatch(message);
    return;
  }
  throw new Error(`Unknown worker message type: ${message.type}`);
}

process.on('message', message => {
  handle(message).catch(error => {
    send({
      type: 'error',
      requestId: message && message.requestId,
      error: {name: error.name, message: error.message, stack: error.stack}
    });
  });
});

process.on('disconnect', () => {
  close()
    .catch(() => {})
    .finally(() => process.exit(0));
});

Promise.all([data.connect(), stat.connect()])
  .then(() => send({type: 'ready'}))
  .catch(error => {
    send({type: 'error', error: {name: error.name, message: error.message, stack: error.stack}});
    process.exitCode = 1;
  });
