'use strict';

const assert = require('node:assert/strict');
const {describe, test} = require('@jest/globals');
const commonDefines = require('../../Common/sources/commondefines');
const absentUsers = require('../../DocService/sources/absentUsers');

function connection(docId, userId, extra = {}) {
  return {docId, user: {id: userId}, handshake: {query: {}, url: `/doc/${docId}`}, ...extra};
}

function entry(id, extra = {}) {
  return JSON.stringify({id, connectionId: `connection-${id}`, ...extra});
}

function recordingPublish() {
  const calls = [];
  const publish = async (ctx, data, docId, userId) => {
    calls.push({type: data.type, docId: data.docId, userId: data.userId, data, optDocId: docId, optUserId: userId});
    return true;
  };
  return {calls, publish};
}

function store(results) {
  const seen = [];
  return {
    seen,
    async _releaseAbsentUsers(ctx, docId, connectedUserIds) {
      seen.push({docId, connectedUserIds: [...connectedUserIds].sort()});
      const result = results[docId];
      if (result instanceof Error) {
        throw result;
      }
      return result || {expiredUsers: [], locks: [], presence: []};
    }
  };
}

describe('release of what gone users left in a document', () => {
  test('does nothing with a store that does not share its data (editorDataMemory)', async () => {
    const {calls, publish} = recordingPublish();
    await absentUsers.release([connection('doc-1', 'user-b')], {}, publish);
    assert.deepEqual(calls, []);
  });

  test('releases the locks of a gone user and tells the users who stay, once per document', async () => {
    const locks = [
      {time: 1, user: 'user-a', block: 'block-1'},
      {time: 2, user: 'user-a', block: 'block-2'}
    ];
    const editorData = store({
      'doc-1': {
        expiredUsers: ['user-a'],
        locks,
        presence: [entry('user-b'), entry('user-v', {isCloseCoAuthoring: true}), 'not json']
      }
    });
    const {calls, publish} = recordingPublish();

    await absentUsers.release(
      [connection('doc-1', 'user-b'), connection('doc-2', 'user-c'), connection('doc-1', 'user-v'), {docId: null, user: {id: 'x'}}],
      editorData,
      publish
    );

    assert.deepEqual(editorData.seen, [
      {docId: 'doc-1', connectedUserIds: ['user-b', 'user-v']},
      {docId: 'doc-2', connectedUserIds: ['user-c']}
    ]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].type, commonDefines.c_oPublishType.releaseLock);
    assert.deepEqual([calls[0].docId, calls[0].userId, calls[0].optDocId, calls[0].optUserId], ['doc-1', 'user-a', 'doc-1', 'user-a']);
    assert.deepEqual(calls[0].data.locks, locks);
    assert.equal(calls[1].type, commonDefines.c_oPublishType.participantsState);
    assert.deepEqual([calls[1].docId, calls[1].userId, calls[1].optDocId, calls[1].optUserId], ['doc-1', 'user-a', 'doc-1', 'user-a']);
    assert.deepEqual(calls[1].data.participants, [JSON.parse(entry('user-b'))]);
    assert.equal(typeof calls[1].data.participantsTimestamp, 'number');
  });

  test('announces a gone user without locks, not a user connected here whose presence expired', async () => {
    const editorData = store({
      'doc-1': {expiredUsers: ['user-b'], locks: [], presence: [entry('user-c')]},
      'doc-2': {expiredUsers: ['user-gone'], locks: [], presence: [entry('user-d')]}
    });
    const {calls, publish} = recordingPublish();

    await absentUsers.release([connection('doc-1', 'user-b'), connection('doc-2', 'user-d')], editorData, publish);

    assert.deepEqual(
      calls.map(call => [call.type, call.docId, call.userId]),
      [[commonDefines.c_oPublishType.participantsState, 'doc-2', 'user-gone']]
    );
  });

  test('a failing document does not stop the others', async () => {
    const editorData = store({
      'doc-1': new Error('Redis unavailable'),
      'doc-2': {expiredUsers: [], locks: [{time: 1, user: 'user-a', block: 'block'}], presence: [entry('user-d')]}
    });
    const {calls, publish} = recordingPublish();

    await absentUsers.release([connection('doc-1', 'user-b'), connection('doc-2', 'user-d')], editorData, publish);

    assert.deepEqual(
      calls.map(call => [call.type, call.docId, call.userId]),
      [
        [commonDefines.c_oPublishType.releaseLock, 'doc-2', 'user-a'],
        [commonDefines.c_oPublishType.participantsState, 'doc-2', 'user-a']
      ]
    );
  });
});
