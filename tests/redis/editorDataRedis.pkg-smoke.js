'use strict';

const config = require('./testSetup');

const storageName = config.get('services.CoAuthoring.server.editorDataStorage');
const storage = require(`../../DocService/sources/${storageName}`);

async function main() {
  const editorData = new storage.EditorData();
  try {
    const pong = await editorData.ping();
    if (pong !== 'PONG') {
      throw new Error(`Unexpected Redis response: ${pong}`);
    }
    process.stdout.write('packaged editorDataRedis loaded and connected\n');
  } finally {
    await editorData.close();
  }
}

module.exports = main;
