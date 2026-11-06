const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MediaAlbumObservations } = require('../dist/mediaAlbumObservations');
const base = { scopeId: 'community-scope', chatId: 'subgroup@g.us', actorIdentityId: 'person', messageType: 'image', hasMedia: true, receivedAt: new Date('2026-11-06T20:30:00Z') };

test('recognizes an unwrapped media burst once and ignores single media and duplicate observations', () => {
  const observations = new MediaAlbumObservations();
  const observe = (id, extra = {}) => observations.observe({ ...base, messageId: id, ...extra });
  assert.equal(observe('a'), false);
  assert.equal(observe('a'), false);
  assert.equal(observe('b'), false);
  assert.equal(observe('c', { messageType: 'video' }), true);
  assert.equal(observe('d'), false);
  assert.equal(observe('c'), false);
});

test('does not combine different people, conversations, scopes or expired bursts', () => {
  const observations = new MediaAlbumObservations();
  const observe = (id, extra = {}) => observations.observe({ ...base, messageId: id, ...extra });
  assert.equal(observe('a'), false);
  assert.equal(observe('b', { actorIdentityId: 'other-person' }), false);
  assert.equal(observe('c', { chatId: 'other@g.us' }), false);
  assert.equal(observe('d', { scopeId: 'other-scope' }), false);
  assert.equal(observe('e', { receivedAt: new Date(base.receivedAt.getTime() + 11_000) }), false);
  assert.equal(observe('document', { messageType: 'document' }), false);
});

test('explicit album wrappers retain their behavior without a second event for child media', () => {
  const observations = new MediaAlbumObservations();
  assert.equal(observations.observe({ ...base, messageId: 'album', messageType: 'album', hasMedia: false }), true);
  for (const messageId of ['a', 'b', 'c', 'd']) assert.equal(observations.observe({ ...base, messageId }), false);
});
