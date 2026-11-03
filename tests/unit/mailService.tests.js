const {describe, test, expect, beforeAll, afterAll} = require('@jest/globals');
const net = require('net');

const operationContext = require('../../Common/sources/operationContext');
const mailService = require('../../Common/sources/mailService');

const ctx = new operationContext.Context();
const host = '127.0.0.1';
const testTimeout = 1000 * 10;

// A minimal SMTP server on localhost that accepts any login and message, so the test doesn't
// depend on a public test server (smtp.ethereal.email timed out now and then)
function startSmtpServer() {
  const server = net.createServer(socket => {
    let buffer = '';
    let inData = false;
    socket.write('220 localhost ESMTP\r\n');
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 OK\r\n');
          }
          continue;
        }
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO') {
          socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        } else if (command === 'AUTH') {
          socket.write('235 Authenticated\r\n');
        } else if (command === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (command === 'QUIT') {
          socket.end('221 Bye\r\n');
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
  });
  return new Promise(resolve => server.listen(0, host, () => resolve(server)));
}

let smtpServer;

beforeAll(async () => {
  smtpServer = await startSmtpServer();
});

afterAll(() => {
  mailService.transportersRelease();
  smtpServer.close();
});

describe('Mail service', () => {
  describe('SMTP', () => {
    test(
      'Transporters life cycle',
      async () => {
        const {port} = smtpServer.address();
        const auth = [1, 2, 3].map(i => ({user: `user${i}`, pass: `pass${i}`}));
        auth.forEach(credential => mailService.createTransporter(ctx, host, port, credential, {from: 'some.mail@example.com'}));

        for (let i = 0; i < auth.length; i++) {
          const credentials = auth[i];
          const mail = await mailService.send(host, credentials.user, {
            to: `some.recipient@server${i + 1}.com`,
            text: 'simple test text',
            subject: 'Mail service test'
          });

          expect(mail.envelope).toEqual({from: 'some.mail@example.com', to: [`some.recipient@server${i + 1}.com`]});
        }

        const accountToBeDeleted = auth[1];
        mailService.deleteTransporter(ctx, host, accountToBeDeleted.user);

        const errorPromise = mailService.send(host, accountToBeDeleted.user, {
          to: 'no.recipient@server.com',
          text: 'simple test text',
          subject: 'Mail service test'
        });

        await expect(errorPromise).rejects.toThrow();
      },
      testTimeout
    );
  });
});
