const {describe, test, expect, beforeAll, afterAll} = require('@jest/globals');
const net = require('net');

const operationContext = require('../../Common/sources/operationContext');
const mailService = require('../../Common/sources/mailService');

const ctx = new operationContext.Context();
const host = '127.0.0.1';
const testTimeout = 1000 * 10;

// Minimal SMTP server: accepts any AUTH PLAIN credentials and every message.
const smtpServer = net.createServer(socket => {
  let buffer = '';
  let inData = false;
  socket.write('220 localhost ESMTP\r\n');
  socket.on('data', chunk => {
    buffer += chunk;
    let lineEnd;
    while ((lineEnd = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          socket.write('250 OK\r\n');
        }
      } else if (/^EHLO/i.test(line)) {
        socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
      } else if (/^AUTH/i.test(line)) {
        socket.write('235 Authenticated\r\n');
      } else if (/^DATA/i.test(line)) {
        inData = true;
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (/^QUIT/i.test(line)) {
        socket.end('221 Bye\r\n');
      } else {
        socket.write('250 OK\r\n');
      }
    }
  });
});

beforeAll(() => new Promise(resolve => smtpServer.listen(0, host, resolve)));

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
        const auth = [1, 2, 3].map(i => ({user: `user${i}`, pass: 'pass'}));
        auth.forEach(credential => mailService.createTransporter(ctx, host, port, credential, {from: 'some.mail@ethereal.com'}));

        for (let i = 0; i < auth.length; i++) {
          const credentials = auth[i];
          const mail = await mailService.send(host, credentials.user, {
            to: `some.recipient@server${i + 1}.com`,
            text: 'simple test text',
            subject: 'Mail service test'
          });

          expect(mail.envelope).toEqual({from: 'some.mail@ethereal.com', to: [`some.recipient@server${i + 1}.com`]});
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
