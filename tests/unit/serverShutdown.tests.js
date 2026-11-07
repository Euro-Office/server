/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const {EventEmitter, once} = require('node:events');
const http = require('node:http');
const {createRequire} = require('node:module');
const net = require('node:net');
const {afterEach, describe, expect, jest, test} = require('@jest/globals');
const docServiceRequire = createRequire(require.resolve('../../DocService/package.json'));
const WebSocket = docServiceRequire('ws');
const {Server: SocketIoServer} = docServiceRequire('socket.io');
const {
  installShutdownHandlers,
  resolveShutdownTimeout,
  trackUpgradedSockets,
  waitForServerClose
} = require('../../DocService/sources/serverShutdown');

describe('server shutdown', () => {
  const servers = [];
  const socketIoServers = [];

  test.each([
    [undefined, 10000],
    ['invalid', 10000],
    ['0', 10000],
    ['-1s', 10000],
    ['250ms', 250]
  ])('resolves shutdown timeout %p to %p milliseconds', (value, expected) => {
    expect(resolveShutdownTimeout(value)).toBe(expected);
  });

  afterEach(async () => {
    await Promise.all(socketIoServers.splice(0).map(io => new Promise(resolve => io.close(() => resolve()))));
    await Promise.all(
      servers.splice(0).map(server => {
        if (!server.listening) {
          return undefined;
        }
        return new Promise(resolve => server.close(() => resolve()));
      })
    );
  });

  test('closes an active upgraded editor connection', async () => {
    const server = http.createServer();
    servers.push(server);
    const sockets = trackUpgradedSockets(server, () => false);
    let closeCalled = false;
    let socketClosedBeforeServerClose = false;
    let socketIoClosed = false;
    server.on('upgrade', () => {});
    await new Promise(resolve => server.listen(0, resolve));

    const client = net.createConnection(server.address().port);
    client.on('error', () => {});
    client.write(
      'GET /doc/document/c/editor.io?EIO=4&transport=websocket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
    );
    await once(server, 'upgrade');

    const closePromise = once(client, 'close');
    const closeServer = server.close.bind(server);
    server.close = callback => {
      closeCalled = true;
      return closeServer(callback);
    };
    client.once('close', () => {
      socketClosedBeforeServerClose = !closeCalled;
    });
    await expect(
      waitForServerClose(server, sockets, {
        timeout: 1000,
        closeSocketIo: () => {
          expect(closeCalled).toBe(true);
          socketIoClosed = true;
        }
      })
    ).resolves.toBe(false);
    await closePromise;
    expect(socketClosedBeforeServerClose).toBe(false);
    expect(socketIoClosed).toBe(true);
    expect(server.listening).toBe(false);
  });

  test('forces remaining connections closed after the shutdown timeout', async () => {
    const server = http.createServer(() => {});
    servers.push(server);
    const sockets = new Set();
    await new Promise(resolve => server.listen(0, resolve));
    const client = http.get({port: server.address().port, path: '/'});
    client.on('error', () => {});
    await once(server, 'connection');

    await expect(
      waitForServerClose(server, sockets, {
        timeout: 20,
        closeSocketIo: () => new Promise(() => {})
      })
    ).resolves.toBe(true);
    expect(server.listening).toBe(false);
    client.destroy();
  });

  test('waits for Socket.IO disconnect cleanup before Redis cleanup', async () => {
    const server = http.createServer();
    servers.push(server);
    const order = [];
    await new Promise(resolve => server.listen(0, resolve));

    await expect(
      waitForServerClose(server, new Set(), {
        timeout: 1000,
        closeSocketIo: () =>
          new Promise(resolve => {
            setImmediate(() => {
              order.push('socket.io disconnect Redis work');
              resolve();
            });
          })
      })
    ).resolves.toBe(false);
    order.push('Redis cleanup');

    expect(order).toEqual(['socket.io disconnect Redis work', 'Redis cleanup']);
  });

  test('closes an active Engine.IO connection through Socket.IO shutdown', async () => {
    const server = http.createServer();
    servers.push(server);
    const sockets = trackUpgradedSockets(server, () => false);
    await new Promise(resolve => server.listen(0, resolve));
    const io = new SocketIoServer(server, {path: '/doc/', transports: ['websocket']});
    socketIoServers.push(io);

    const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/doc/?EIO=4&transport=websocket`);
    client.on('error', () => {});
    const openPacket = once(client, 'message');
    await once(client, 'open');
    expect((await openPacket)[0].toString()).toMatch(/^0/);
    const connected = once(io, 'connection');
    client.send('40');
    await connected;

    const closed = once(client, 'close');
    await expect(
      waitForServerClose(server, sockets, {
        timeout: 1000,
        closeSocketIo: () => io.close()
      })
    ).resolves.toBe(false);
    await closed;
    expect(io.engine.clientsCount).toBe(0);
    expect(server.listening).toBe(false);
  });

  test('rejects a reconnecting Engine.IO client once shutdown begins', async () => {
    const server = http.createServer();
    servers.push(server);
    let shuttingDown = false;
    const sockets = trackUpgradedSockets(server, () => shuttingDown);
    await new Promise(resolve => server.listen(0, resolve));
    const io = new SocketIoServer(server, {path: '/doc/', transports: ['websocket']});
    socketIoServers.push(io);

    const url = `ws://127.0.0.1:${server.address().port}/doc/?EIO=4&transport=websocket`;
    const activeClient = new WebSocket(url);
    activeClient.on('error', () => {});
    const openPacket = once(activeClient, 'message');
    await once(activeClient, 'open');
    await openPacket;
    const connected = once(io, 'connection');
    activeClient.send('40');
    await connected;

    shuttingDown = true;
    const reconnect = new WebSocket(url);
    reconnect.on('error', () => {});
    const reconnectResult = await new Promise(resolve => {
      const timer = setTimeout(() => resolve('timeout'), 250);
      const finish = result => {
        clearTimeout(timer);
        resolve(result);
      };
      reconnect.once('open', () => finish('open'));
      reconnect.once('close', () => finish('close'));
      reconnect.once('error', () => finish('error'));
    });
    expect(reconnectResult).not.toBe('open');
    reconnect.terminate();

    await expect(
      waitForServerClose(server, sockets, {
        timeout: 1000,
        closeSocketIo: () => io.close()
      })
    ).resolves.toBe(false);
  });

  test('routes signals and fatal process errors through shutdown', async () => {
    const processObject = new EventEmitter();
    const logger = {error: jest.fn()};
    const shutdown = jest.fn((_signal, exitCode) => Promise.resolve(exitCode));
    const exit = jest.fn();
    const cleanup = installShutdownHandlers({processObject, logger, shutdown, exit});

    processObject.emit('SIGTERM');
    processObject.emit('SIGINT');
    processObject.emit('uncaughtException', new Error('uncaught'));
    processObject.emit('unhandledRejection', new Error('rejected'));
    await new Promise(resolve => setImmediate(resolve));

    expect(shutdown).toHaveBeenNthCalledWith(1, 'SIGTERM', 0);
    expect(shutdown).toHaveBeenNthCalledWith(2, 'SIGINT', 0);
    expect(shutdown).toHaveBeenNthCalledWith(3, 'uncaughtException', 1);
    expect(shutdown).toHaveBeenNthCalledWith(4, 'unhandledRejection', 1);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(exit.mock.calls.map(([code]) => code)).toEqual([0, 0, 1, 1]);
    cleanup();
  });
});
