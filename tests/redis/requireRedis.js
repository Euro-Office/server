'use strict';

const {EditorData} = require('../../DocService/sources/editorDataRedis');

async function requireRedis(testName) {
  const probe = new EditorData();
  let timeoutId;
  let readinessError;
  try {
    await Promise.race([
      probe._command(['PING']),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Redis readiness probe timed out')), 1000);
      })
    ]);
  } catch (error) {
    readinessError = new Error(`Redis is required for ${testName}; start the Redis test stack or configure TEST_REDIS_*.`, {
      cause: error
    });
  } finally {
    clearTimeout(timeoutId);
    try {
      await probe.close();
    } catch (error) {
      readinessError ||= new Error(`Redis readiness probe cleanup failed for ${testName}.`, {cause: error});
    }
  }
  if (readinessError) {
    throw readinessError;
  }
}

module.exports = {requireRedis};
