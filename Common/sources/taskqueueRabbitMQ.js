/*
 * (c) Copyright Ascensio System SIA 2010-2024
 *
 * This program is a free software product. You can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License (AGPL)
 * version 3 as published by the Free Software Foundation. In accordance with
 * Section 7(a) of the GNU AGPL its Section 15 shall be amended to the effect
 * that Ascensio System SIA expressly excludes the warranty of non-infringement
 * of any third-party rights.
 *
 * This program is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR  PURPOSE. For
 * details, see the GNU AGPL at: http://www.gnu.org/licenses/agpl-3.0.html
 *
 * The  interactive user interfaces in modified source and object code versions
 * of the Program must display Appropriate Legal Notices, as required under
 * Section 5 of the GNU AGPL version 3.
 *
 * All the Product's GUI elements, including illustrations and icon sets, as
 * well as technical writing content are licensed under the terms of the
 * Creative Commons Attribution-ShareAlike 4.0 International. See the License
 * terms at http://creativecommons.org/licenses/by-sa/4.0/legalcode
 *
 */

'use strict';
const config = require('config');
const events = require('events');
const util = require('util');
const co = require('co');
const utils = require('./utils');
const constants = require('./constants');
const rabbitMQCore = require('./rabbitMQCore');
const activeMQCore = require('./activeMQCore');
const commonDefines = require('./commondefines');
const operationContext = require('./operationContext');

const cfgMaxRedeliveredCount = config.get('FileConverter.converter.maxRedeliveredCount');
const cfgQueueType = config.get('queue.type');
const cfgVisibilityTimeout = config.get('queue.visibilityTimeout');
const cfgQueueRetentionPeriod = config.get('queue.retentionPeriod');
const cfgRabbitQueueConvertTask = config.util.cloneDeep(config.get('rabbitmq.queueconverttask'));
const cfgRabbitQueueConvertResponse = config.util.cloneDeep(config.get('rabbitmq.queueconvertresponse'));
const cfgRabbitExchangeConvertDead = config.util.cloneDeep(config.get('rabbitmq.exchangeconvertdead'));
const cfgRabbitQueueConvertDead = config.util.cloneDeep(config.get('rabbitmq.queueconvertdead'));
const cfgRabbitQueueDelayed = config.util.cloneDeep(config.get('rabbitmq.queuedelayed'));
const cfgActiveQueueConvertTask = constants.ACTIVEMQ_QUEUE_PREFIX + config.get('activemq.queueconverttask');
const cfgActiveQueueConvertResponse = constants.ACTIVEMQ_QUEUE_PREFIX + config.get('activemq.queueconvertresponse');
const cfgActiveQueueConvertDead = constants.ACTIVEMQ_QUEUE_PREFIX + config.get('activemq.queueconvertdead');
const cfgActiveQueueDelayed = constants.ACTIVEMQ_QUEUE_PREFIX + config.get('activemq.queuedelayed');

function initRabbit(taskqueue, isAddTask, isAddResponse, isAddTaskReceive, isAddResponseReceive, isEmitDead, isAddDelayed, callback) {
  return co(function* () {
    let e = null;
    try {
      const conn = yield rabbitMQCore.connetPromise(() => {
        clear(taskqueue);
        if (!taskqueue.isClose) {
          setTimeout(() => {
            init(taskqueue, isAddTask, isAddResponse, isAddTaskReceive, isAddResponseReceive, isEmitDead, isAddDelayed, null);
          }, rabbitMQCore.RECONNECT_TIMEOUT);
        }
      });
      taskqueue.connection = conn;
      let bAssertTaskQueue = false;
      const optionsTaskQueueDefault = {
        messageTtl: cfgQueueRetentionPeriod * 1000,
        deadLetterExchange: cfgRabbitExchangeConvertDead.name
      };
      const optionsTaskQueue = rabbitMQCore.filterQueueOptions(
        {...optionsTaskQueueDefault, ...cfgRabbitQueueConvertTask.options},
        cfgRabbitQueueConvertTask.name
      );
      if (isAddTask) {
        taskqueue.channelConvertTask = yield rabbitMQCore.createConfirmChannelPromise(conn);
        yield rabbitMQCore.assertQueuePromise(taskqueue.channelConvertTask, cfgRabbitQueueConvertTask.name, optionsTaskQueue);
        bAssertTaskQueue = true;
      }
      let bAssertResponseQueue = false;
      if (isAddResponse) {
        taskqueue.channelConvertResponse = yield rabbitMQCore.createConfirmChannelPromise(conn);
        const filteredResponseOptions = rabbitMQCore.filterQueueOptions(
          {...cfgRabbitQueueConvertResponse.options},
          cfgRabbitQueueConvertResponse.name
        );
        yield rabbitMQCore.assertQueuePromise(taskqueue.channelConvertResponse, cfgRabbitQueueConvertResponse.name, filteredResponseOptions);
        bAssertResponseQueue = true;
      }
      const optionsReceive = {noAck: false};
      if (isAddTaskReceive) {
        taskqueue.channelConvertTaskReceive = yield rabbitMQCore.createChannelPromise(conn);
        taskqueue.channelConvertTaskReceive.prefetch(1);
        if (!bAssertTaskQueue) {
          yield rabbitMQCore.assertQueuePromise(taskqueue.channelConvertTaskReceive, cfgRabbitQueueConvertTask.name, optionsTaskQueue);
        }
        yield rabbitMQCore.consumePromise(
          taskqueue.channelConvertTaskReceive,
          cfgRabbitQueueConvertTask.name,
          message => {
            co(function* () {
              const ack = function () {
                taskqueue.channelConvertTaskReceive && taskqueue.channelConvertTaskReceive.ack(message);
              };
              const redelivered = yield* pushBackRedeliveredRabbit(taskqueue, message, ack);
              if (!redelivered) {
                if (message) {
                  taskqueue.emit('task', message.content.toString(), ack);
                }
              }
            });
          },
          optionsReceive
        );
      }
      if (isAddResponseReceive) {
        taskqueue.channelConvertResponseReceive = markClosedOnClose(yield rabbitMQCore.createChannelPromise(conn));
        if (!bAssertResponseQueue) {
          const filteredResponseOptions = rabbitMQCore.filterQueueOptions(
            {...cfgRabbitQueueConvertResponse.options},
            cfgRabbitQueueConvertResponse.name
          );
          yield rabbitMQCore.assertQueuePromise(taskqueue.channelConvertResponseReceive, cfgRabbitQueueConvertResponse.name, filteredResponseOptions);
        }
        yield rabbitMQCore.consumePromise(
          taskqueue.channelConvertResponseReceive,
          cfgRabbitQueueConvertResponse.name,
          message => {
            if (message) {
              // Settle only on the channel that delivered the message.  A final save
              // can take long enough for a reconnect: the broker has then requeued
              // the message, and an unknown delivery tag would close the new channel.
              const channel = taskqueue.channelConvertResponseReceive;
              const isLive = () => null != channel && !channel.isClosed && channel === taskqueue.channelConvertResponseReceive;
              taskqueue.emit(
                'response',
                message.content.toString(),
                () => {
                  if (isLive()) {
                    channel.ack(message);
                  }
                },
                isLive
              );
            }
          },
          optionsReceive
        );
      }
      if (isAddDelayed) {
        const optionsDelayedQueueDefault = {
          deadLetterExchange: cfgRabbitExchangeConvertDead.name
        };
        const optionsDelayedQueue = rabbitMQCore.filterQueueOptions(
          {...optionsDelayedQueueDefault, ...cfgRabbitQueueDelayed.options},
          cfgRabbitQueueDelayed.name
        );
        taskqueue.channelDelayed = yield rabbitMQCore.createConfirmChannelPromise(conn);
        yield rabbitMQCore.assertQueuePromise(taskqueue.channelDelayed, cfgRabbitQueueDelayed.name, optionsDelayedQueue);
      }
      if (isEmitDead) {
        taskqueue.channelConvertDead = markClosedOnClose(yield rabbitMQCore.createChannelPromise(conn));
        yield rabbitMQCore.assertExchangePromise(
          taskqueue.channelConvertDead,
          cfgRabbitExchangeConvertDead.name,
          'fanout',
          cfgRabbitExchangeConvertDead.options
        );
        const filteredDeadOptions = rabbitMQCore.filterQueueOptions({...cfgRabbitQueueConvertDead.options}, cfgRabbitQueueConvertDead.name);
        const queue = yield rabbitMQCore.assertQueuePromise(taskqueue.channelConvertDead, cfgRabbitQueueConvertDead.name, filteredDeadOptions);

        taskqueue.channelConvertDead.bindQueue(queue, cfgRabbitExchangeConvertDead.name, '');
        yield rabbitMQCore.consumePromise(
          taskqueue.channelConvertDead,
          queue,
          message => {
            if (null != taskqueue.channelConvertDead) {
              if (message) {
                // Settle only on the channel that delivered the message (see the
                // response consumer).
                const channel = taskqueue.channelConvertDead;
                const isLive = () => null != channel && !channel.isClosed && channel === taskqueue.channelConvertDead;
                taskqueue.emit(
                  'dead',
                  message.content.toString(),
                  () => {
                    if (isLive()) {
                      channel.ack(message);
                    }
                  },
                  () => {
                    if (isLive()) {
                      channel.nack(message, false, true);
                    }
                  },
                  isLive
                );
              }
            }
          },
          {noAck: false}
        );
      }

      //process messages received while reconnection time
      repeat(taskqueue);
    } catch (err) {
      e = err;
    }
    if (callback) {
      callback(e);
    }
  });
}
function initActive(taskqueue, isAddTask, isAddResponse, isAddTaskReceive, isAddResponseReceive, isEmitDead, isAddDelayed, callback) {
  return co(function* () {
    let e = null;
    try {
      const conn = yield activeMQCore.connetPromise(() => {
        clear(taskqueue);
        if (!taskqueue.isClose) {
          setTimeout(() => {
            init(taskqueue, isAddTask, isAddResponse, isAddTaskReceive, isAddResponseReceive, isEmitDead, isAddDelayed, null);
          }, activeMQCore.RECONNECT_TIMEOUT);
        }
      });
      taskqueue.connection = conn;
      if (isAddTask) {
        //https://github.com/amqp/rhea/issues/251#issuecomment-535076570
        const optionsConvertTask = {
          target: {
            address: cfgActiveQueueConvertTask,
            capabilities: ['queue']
          }
        };
        taskqueue.channelConvertTask = yield activeMQCore.openSenderPromise(conn, optionsConvertTask);
        initSenderActive(taskqueue.channelConvertTask, taskqueue.channelConvertTaskData);
      }
      if (isAddResponse) {
        const optionsConvertResponse = {
          target: {
            address: cfgActiveQueueConvertResponse,
            capabilities: ['queue']
          }
        };
        taskqueue.channelConvertResponse = yield activeMQCore.openSenderPromise(conn, optionsConvertResponse);
        initSenderActive(taskqueue.channelConvertResponse, taskqueue.channelConvertResponseData);
      }
      if (isAddTaskReceive) {
        const optionsConvertTask = {
          source: {
            address: cfgActiveQueueConvertTask,
            capabilities: ['queue']
          },
          credit_window: 0,
          autoaccept: false
        };
        const receiver = yield activeMQCore.openReceiverPromise(conn, optionsConvertTask);
        //todo ?consumer.dispatchAsync=false&consumer.prefetchSize=1
        receiver.add_credit(1);
        receiver.on('message', context => {
          co(function* () {
            const ack = function () {
              context.delivery.accept();
              receiver.add_credit(1);
            };
            const redelivered = yield* pushBackRedeliveredActive(taskqueue, context, ack);
            if (!redelivered) {
              if (context) {
                taskqueue.emit('task', context.message.body, ack);
              }
            }
          });
        });
        taskqueue.channelConvertTaskReceive = receiver;
      }
      if (isAddResponseReceive) {
        const optionsConvertResponse = {
          source: {
            address: cfgActiveQueueConvertResponse,
            capabilities: ['queue']
          },
          credit_window: 0,
          autoaccept: false
        };
        const receiver = yield activeMQCore.openReceiverPromise(conn, optionsConvertResponse);
        //todo ?consumer.dispatchAsync=false&consumer.prefetchSize=1
        receiver.add_credit(1);
        // Up to ACTIVE_RESPONSE_WINDOW responses are processed at once, so that a
        // final save holding its delivery for its retry window (receiveTask) does
        // not stop the others, while a backlog after an outage is not taken all
        // at once.
        let unsettled = 0;
        receiver.on('message', context => {
          if (context) {
            if (++unsettled < ACTIVE_RESPONSE_WINDOW) {
              receiver.add_credit(1);
            }
            const isLive = () => receiver === taskqueue.channelConvertResponseReceive;
            taskqueue.emit(
              'response',
              context.message.body,
              () => {
                // Settle and restore credit only on the live delivering link.
                if (isLive()) {
                  if (unsettled-- >= ACTIVE_RESPONSE_WINDOW) {
                    receiver.add_credit(1);
                  }
                  context.delivery.accept();
                }
              },
              isLive
            );
          }
        });
        taskqueue.channelConvertResponseReceive = receiver;
      }
      if (isAddDelayed) {
        const optionsDelayed = {
          target: {
            address: cfgActiveQueueDelayed,
            capabilities: ['queue']
          }
        };
        taskqueue.channelDelayed = yield activeMQCore.openSenderPromise(conn, optionsDelayed);
        initSenderActive(taskqueue.channelDelayed, taskqueue.channelDelayedData);
      }
      if (isEmitDead) {
        const optionsConvertDead = {
          source: {
            address: cfgActiveQueueConvertDead,
            capabilities: ['queue']
          },
          credit_window: 0,
          autoaccept: false
        };
        const receiver = yield activeMQCore.openReceiverPromise(conn, optionsConvertDead);
        //todo ?consumer.dispatchAsync=false&consumer.prefetchSize=1
        receiver.add_credit(1);
        receiver.on('message', context => {
          if (context) {
            const isLive = () => receiver === taskqueue.channelConvertDead;
            taskqueue.emit(
              'dead',
              context.message.body,
              () => {
                if (isLive()) {
                  context.delivery.accept();
                  receiver.add_credit(1);
                }
              },
              () => {
                if (isLive()) {
                  context.delivery.release();
                  receiver.add_credit(1);
                }
              },
              isLive
            );
          }
        });
        taskqueue.channelConvertDead = receiver;
      }

      //process messages received while reconnection time
      repeat(taskqueue);
    } catch (err) {
      e = err;
    }
    if (callback) {
      callback(e);
    }
  });
}
// A consumer channel can close on its own (consumer timeout, a channel
// error) while the connection stays up; the broker then requeues its unacked
// deliveries.  Mark it, so that their handlers know.
function markClosedOnClose(channel) {
  channel.on('close', () => {
    channel.isClosed = true;
  });
  return channel;
}
function clear(taskqueue) {
  taskqueue.channelConvertTask = null;
  taskqueue.channelConvertTaskReceive = null;
  taskqueue.channelConvertDead = null;
  taskqueue.channelConvertResponse = null;
  taskqueue.channelConvertResponseReceive = null;
  taskqueue.channelDelayed = null;
  //todo clear all listeners
  // Fail the publishes still waiting for the broker (ActiveMQ): they will never
  // be settled on the lost link, and their callers must not wait forever.
  for (const pending of [taskqueue.channelConvertTaskData, taskqueue.channelConvertResponseData, taskqueue.channelDelayedData]) {
    for (const id in pending || {}) {
      const callback = pending[id];
      delete pending[id];
      callback(new Error('[AMQP] connection lost before the message was settled'));
    }
  }
  taskqueue.channelConvertTaskData = {};
  taskqueue.channelConvertResponseData = {};
  taskqueue.channelDelayedData = {};
}
function* pushBackRedeliveredRabbit(taskqueue, message, ack) {
  if (message?.fields?.redelivered) {
    try {
      operationContext.global.logger.warn('checkRedelivered redelivered data=%j', message);
      //remove current task and add new into tail of queue to remove redelivered flag
      const data = message.content.toString();
      const redeliveredCount = message.properties.headers['x-redelivered-count'];
      if (!redeliveredCount || redeliveredCount < cfgMaxRedeliveredCount) {
        message.properties.headers['x-redelivered-count'] = redeliveredCount ? redeliveredCount + 1 : 1;
        yield addTaskString(taskqueue, data, message.properties.priority, undefined, message.properties.headers);
      } else if (taskqueue.simulateErrorResponse) {
        yield taskqueue.addResponse(taskqueue.simulateErrorResponse(data));
      }
    } catch (err) {
      operationContext.global.logger.error('checkRedelivered error: %s', err.stack);
    } finally {
      ack();
    }
    return true;
  }
  return false;
}
function* pushBackRedeliveredActive(taskqueue, context, ack) {
  if (undefined !== context.message.delivery_count) {
    operationContext.global.logger.warn('checkRedelivered redelivered data=%j', context.message);
    if (context.message.delivery_count > cfgMaxRedeliveredCount) {
      try {
        if (taskqueue.simulateErrorResponse) {
          yield taskqueue.addResponse(taskqueue.simulateErrorResponse(context.message.body));
        }
      } catch (err) {
        operationContext.global.logger.error('checkRedelivered error: %s', err.stack);
      } finally {
        ack();
      }
      return true;
    }
  }
  return false;
}
function repeat(taskqueue) {
  //repeat addTask because they are lost after the reconnection
  //unlike unconfirmed task will come again
  //acknowledge data after reconnect raises an exception 'PRECONDITION_FAILED - unknown delivery tag'
  for (let i = 0; i < taskqueue.addTaskStore.length; ++i) {
    const elem = taskqueue.addTaskStore[i];
    addTask(taskqueue, elem.task, elem.priority, () => {}, elem.expiration, elem.headers);
  }
  taskqueue.addTaskStore.length = 0;
  for (let i = 0; i < taskqueue.addDelayedStore.length; ++i) {
    const elem = taskqueue.addDelayedStore[i];
    addDelayed(taskqueue, elem.task, elem.ttl, () => {});
  }
  taskqueue.addDelayedStore.length = 0;
}
function addTaskRabbit(taskqueue, content, priority, callback, opt_expiration, opt_headers) {
  const options = {persistent: true, priority};
  if (undefined !== opt_expiration) {
    options.expiration = opt_expiration.toString();
  }
  if (undefined !== opt_headers) {
    options.headers = opt_headers;
  }
  taskqueue.channelConvertTask.sendToQueue(cfgRabbitQueueConvertTask.name, content, options, callback);
}
function addTaskActive(taskqueue, content, priority, callback, opt_expiration, _opt_headers) {
  const msg = {durable: true, priority, body: content, ttl: cfgQueueRetentionPeriod * 1000};
  if (undefined !== opt_expiration) {
    msg.ttl = opt_expiration;
  }
  const delivery = taskqueue.channelConvertTask.send(msg);
  if (delivery) {
    taskqueue.channelConvertTaskData[delivery.id] = callback;
  }
}
function addTaskString(taskqueue, task, priority, opt_expiration, opt_headers) {
  //todo confirmation mode
  return new Promise((resolve, reject) => {
    const content = Buffer.from(task);
    if (null != taskqueue.channelConvertTask) {
      addTask(
        taskqueue,
        content,
        priority,
        (err, _ok) => {
          if (null != err) {
            reject(err);
          } else {
            resolve();
          }
        },
        opt_expiration,
        opt_headers
      );
    } else {
      taskqueue.addTaskStore.push({task: content, priority, expiration: opt_expiration, headers: opt_headers});
      resolve();
    }
  });
}
function addResponseRabbit(taskqueue, content, callback) {
  const options = {persistent: true};
  taskqueue.channelConvertResponse.sendToQueue(cfgRabbitQueueConvertResponse.name, content, options, callback);
}
function addResponseActive(taskqueue, content, callback) {
  const msg = {durable: true, body: content};
  const delivery = taskqueue.channelConvertResponse.send(msg);
  if (delivery) {
    taskqueue.channelConvertResponseData[delivery.id] = callback;
  } else {
    callback(new Error('[AMQP] message was not sent'));
  }
}
function closeRabbit(conn) {
  return rabbitMQCore.closePromise(conn);
}
function closeActive(conn) {
  return activeMQCore.closePromise(conn);
}
function addDelayedRabbit(taskqueue, content, ttl, callback) {
  const options = {persistent: true, expiration: ttl.toString()};
  taskqueue.channelDelayed.sendToQueue(cfgRabbitQueueDelayed.name, content, options, callback);
}
function addDelayedActive(taskqueue, content, ttl, callback) {
  const msg = {durable: true, body: content, ttl};
  const delivery = taskqueue.channelDelayed.send(msg);
  if (delivery) {
    taskqueue.channelDelayedData[delivery.id] = callback;
  } else {
    callback(new Error('[AMQP] message was not sent'));
  }
}

function healthCheckRabbit(taskqueue) {
  return co(function* () {
    if (!taskqueue.channelConvertDead) {
      return false;
    }
    const exchange = yield rabbitMQCore.assertExchangePromise(
      taskqueue.channelConvertDead,
      cfgRabbitExchangeConvertDead.name,
      'fanout',
      cfgRabbitExchangeConvertDead.options
    );
    return !!exchange;
  });
}
/**
 * Check ActiveMQ connection health without using a generator.
 * @param {TaskQueueRabbitMQ} taskqueue - Queue instance holding the connection
 * @returns {Promise<boolean>} true if connection is open
 */
function healthCheckActive(taskqueue) {
  // todo better check
  if (!taskqueue.connection) {
    return Promise.resolve(false);
  }
  return Promise.resolve(taskqueue.connection.is_open());
}

// Responses an ActiveMQ consumer processes at once.
const ACTIVE_RESPONSE_WINDOW = 16;
function initSenderActive(sender, senderData) {
  const processEvent = function (context, res) {
    const id = context?.delivery?.id;
    const callback = senderData[id];
    if (callback) {
      delete senderData[id];
      callback(res);
    }
  };

  sender.on('accepted', context => {
    processEvent(context, null);
  });
  sender.on('rejected', context => {
    const error = context.delivery?.remote_state?.error;
    processEvent(context, new Error('[AMQP] message is rejected (error=' + error + ')'));
  });
  sender.on('released', context => {
    const delivery_failed = context.delivery?.remote_state?.delivery_failed;
    const undeliverable_here = context.delivery?.remote_state?.undeliverable_here;
    const err = new Error('[AMQP] message is released (delivery_failed=' + delivery_failed + ', undeliverable_here=' + undeliverable_here + ')');
    processEvent(context, err);
  });
  sender.on('modified', context => {
    const delivery_failed = context.delivery?.remote_state?.delivery_failed;
    const undeliverable_here = context.delivery?.remote_state?.undeliverable_here;
    const err = new Error('[AMQP] message is modified (delivery_failed=' + delivery_failed + ', undeliverable_here=' + undeliverable_here + ')');
    processEvent(context, err);
  });
}

let init;
let addTask;
let addResponse;
let close;
let addDelayed;
let healthCheck;
if (commonDefines.c_oAscQueueType.rabbitmq === cfgQueueType) {
  init = initRabbit;
  addTask = addTaskRabbit;
  addResponse = addResponseRabbit;
  close = closeRabbit;
  addDelayed = addDelayedRabbit;
  healthCheck = healthCheckRabbit;
} else {
  init = initActive;
  addTask = addTaskActive;
  addResponse = addResponseActive;
  close = closeActive;
  addDelayed = addDelayedActive;
  healthCheck = healthCheckActive;
}

function TaskQueueRabbitMQ(simulateErrorResponse) {
  this.isClose = false;
  this.connection = null;
  this.channelConvertTask = null;
  this.channelConvertTaskReceive = null;
  this.channelConvertDead = null;
  this.channelConvertResponse = null;
  this.channelConvertResponseReceive = null;
  this.channelDelayed = null;
  this.addTaskStore = [];
  this.addDelayedStore = [];
  this.channelConvertTaskData = {};
  this.channelConvertResponseData = {};
  this.channelDelayedData = {};
  this.simulateErrorResponse = simulateErrorResponse;
}
util.inherits(TaskQueueRabbitMQ, events.EventEmitter);
TaskQueueRabbitMQ.prototype.init = function (isAddTask, isAddResponse, isAddTaskReceive, isAddResponseReceive, isEmitDead, isAddDelayed, callback) {
  init(this, isAddTask, isAddResponse, isAddTaskReceive, isAddResponseReceive, isEmitDead, isAddDelayed, callback);
};
TaskQueueRabbitMQ.prototype.initPromise = function (isAddTask, isAddResponse, isAddTaskReceive, isAddResponseReceive, isEmitDead, isAddDelayed) {
  const t = this;
  return new Promise((resolve, reject) => {
    init(t, isAddTask, isAddResponse, isAddTaskReceive, isAddResponseReceive, isEmitDead, isAddDelayed, err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
};
TaskQueueRabbitMQ.prototype.addTask = function (task, priority, opt_expiration, _opt_headers) {
  task.setVisibilityTimeout(cfgVisibilityTimeout);
  return addTaskString(this, JSON.stringify(task), priority, opt_expiration);
};
TaskQueueRabbitMQ.prototype.addResponse = function (task, opt_requireConfirm) {
  const t = this;
  return new Promise((resolve, reject) => {
    const content = Buffer.from(JSON.stringify(task));
    if (null != t.channelConvertResponse) {
      addResponse(t, content, (err, _ok) => {
        if (null != err) {
          reject(err);
        } else {
          resolve();
        }
      });
    } else if (opt_requireConfirm) {
      reject(new Error('Response channel is unavailable; response was not persisted'));
    } else {
      resolve();
    }
  });
};
TaskQueueRabbitMQ.prototype.addDelayed = function (task, ttl, opt_requireConfirm) {
  const t = this;
  return new Promise((resolve, reject) => {
    const content = Buffer.from(JSON.stringify(task));
    if (null != t.channelDelayed) {
      addDelayed(t, content, ttl, (err, _ok) => {
        if (null != err) {
          reject(err);
        } else {
          resolve();
        }
      });
    } else if (opt_requireConfirm) {
      reject(new Error('Delayed-task channel is unavailable; retry was not persisted'));
    } else {
      t.addDelayedStore.push({task: content, ttl});
      resolve();
    }
  });
};
TaskQueueRabbitMQ.prototype.close = function () {
  const t = this;
  return co(function* () {
    t.isClose = true;
    if (t.channelConvertTask) {
      yield close(t.channelConvertTask);
    }
    if (t.channelConvertTaskReceive) {
      yield close(t.channelConvertTaskReceive);
    }
    if (t.channelConvertDead) {
      yield close(t.channelConvertDead);
    }
    if (t.channelConvertResponse) {
      yield close(t.channelConvertResponse);
    }
    if (t.channelConvertResponseReceive) {
      yield close(t.channelConvertResponseReceive);
    }
    if (t.channelDelayed) {
      yield close(t.channelDelayed);
    }
    yield close(t.connection);
  });
};
TaskQueueRabbitMQ.prototype.closeOrWait = function () {
  if (commonDefines.c_oAscQueueType.rabbitmq === cfgQueueType) {
    return this.close();
  } else {
    //todo remove sleep
    //sleep to wait acknowledge
    return this.close().then(() => {
      return utils.sleep(1000);
    });
  }
};
TaskQueueRabbitMQ.prototype.healthCheck = function () {
  return healthCheck(this);
};

module.exports = TaskQueueRabbitMQ;
