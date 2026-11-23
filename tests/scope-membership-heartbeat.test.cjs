const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  heartbeatWorkspaceScopeMemberships,
  noteParticipantMembership,
  refreshWorkspaceScopeMemberships
} = require('../dist/scopeMembershipDirectory');

function storeFrom() {
  const rows = new Map();
  return {
    rows,
    get: async (key) => rows.get(key),
    set: async (key, next) => { rows.set(key, next); }
  };
}

function clientFor(calls) {
  return {
    replaceScopeMembershipsV1: async (request) => {
      calls.push(request);
      return {
        schemaVersion: 1,
        installationId: request.installationId,
        acceptedGeneration: request.generation,
        payloadSha256: request.payloadSha256,
        appliedAt: '2026-11-23T21:00:00.000Z'
      };
    }
  };
}

test('a membership heartbeat re-dates the stored roster without reading WhatsApp', async () => {
  const members = { calls: 0 };
  const dataStore = storeFrom();
  const context = {
    dataStore,
    listEnabledScopes: async () => [{ scopeId: 'scope-a' }],
    currentMemberIdentityIdsForScope: async () => {
      members.calls += 1;
      return ['bea', 'ada'];
    },
    memberStandingsForScope: async () => [{ identityId: 'cara', standing: 'suspended' }]
  };
  const published = [];
  await refreshWorkspaceScopeMemberships(context, clientFor(published), 'wabp-production');
  assert.equal(members.calls, 1);
  assert.deepEqual(published[0].scopes, [
    { scopeId: 'scope-a', memberIdentityIds: ['ada', 'bea'], suspendedIdentityIds: ['cara'] }
  ]);
  dataStore.rows.get('scope-memberships:v1').publishedAt = '2020-01-01T00:00:00.000Z';
  const before = members.calls;
  assert.equal(await heartbeatWorkspaceScopeMemberships(context, clientFor(published), 'wabp-production'), true);
  assert.equal(members.calls, before);
  assert.equal(published.length, 2);
  assert.deepEqual(published[1].scopes, published[0].scopes);
  assert.notEqual(published[1].capturedAt, published[0].capturedAt);
});

test('a participant change updates the stored roster without reading WhatsApp', async () => {
  const dataStore = storeFrom();
  const context = {
    dataStore,
    listEnabledScopes: async () => [{ scopeId: 'scope-a' }],
    currentMemberIdentityIdsForScope: async () => ['ada'],
    memberStandingsForScope: async () => [{ identityId: 'cara', standing: 'suspended' }]
  };
  const published = [];
  const client = clientFor(published);
  await refreshWorkspaceScopeMemberships(context, client, 'wabp-production');
  context.currentMemberIdentityIdsForScope = async () => { throw new Error('WhatsApp must not be read'); };
  assert.equal(await noteParticipantMembership(context, client, 'wabp-production', {
    scopeId: 'scope-a', action: 'join', identityIds: ['bea']
  }), true);
  assert.deepEqual(published.at(-1).scopes[0], {
    scopeId: 'scope-a',
    memberIdentityIds: ['ada', 'bea'],
    suspendedIdentityIds: ['cara']
  });
  assert.equal(await noteParticipantMembership(context, client, 'wabp-production', {
    scopeId: 'scope-a', action: 'promote', identityIds: ['bea']
  }), false);
  context.memberStandingsForScope = async () => [];
  assert.equal(await noteParticipantMembership(context, client, 'wabp-production', {
    scopeId: 'scope-a', action: 'join', identityIds: ['cara']
  }), true);
  assert.deepEqual(published.at(-1).scopes[0], {
    scopeId: 'scope-a',
    memberIdentityIds: ['ada', 'bea', 'cara']
  });
});

test('a repair reads groups one at a time and keeps a cooling group', async () => {
  const dataStore = storeFrom();
  const seen = [];
  const context = {
    dataStore,
    listEnabledScopes: async () => [{ scopeId: 'scope-a' }],
    coveredGroupsForScope: async () => [{ groupWid: 'group-b@g.us' }, { groupWid: 'group-a@g.us' }],
    getAuthoritativeGroupParticipantSnapshot: async (groupWid) => {
      seen.push(groupWid);
      if (groupWid === 'group-b@g.us') {
        const error = new Error('cooling down');
        error.name = 'TransportRateLimitError';
        error.code = 'rate_overlimit';
        throw error;
      }
      return {
        providerId: 'whatsmeow',
        observedAt: new Date(),
        botWid: 'bot@lid',
        participants: [{ wid: '111@lid' }, { wid: '222@lid' }]
      };
    },
    resolveIdentityAddress: async (wid) => ({ identityId: wid === '111@lid' ? 'ada' : 'bea' }),
    memberStandingsForScope: async () => []
  };
  dataStore.rows.set('scope-memberships:v1', {
    generation: 4,
    payloadSha256: 'ab'.repeat(32),
    publishedAt: '2020-01-01T00:00:00.000Z',
    scopes: [{ scopeId: 'scope-a', memberIdentityIds: ['ada', 'cara'] }],
    groups: [
      { scopeId: 'scope-a', groupWid: 'group-a@g.us', memberIdentityIds: ['ada'] },
      { scopeId: 'scope-a', groupWid: 'group-b@g.us', memberIdentityIds: ['cara'] }
    ]
  });
  const published = [];
  await assert.rejects(
    refreshWorkspaceScopeMemberships(context, clientFor(published), 'wabp-production'),
    (error) => error.directoryPreserved === true && error.code === 'rate_overlimit'
  );
  assert.deepEqual(seen, ['group-a@g.us', 'group-b@g.us']);
  assert.deepEqual(published.at(-1).scopes, [{
    scopeId: 'scope-a',
    memberIdentityIds: ['ada', 'bea', 'cara']
  }]);
  const stored = dataStore.rows.get('scope-memberships:v1');
  assert.deepEqual(stored.groups.find((group) => group.groupWid === 'group-b@g.us').memberIdentityIds, ['cara']);
  assert.deepEqual(stored.groups.find((group) => group.groupWid === 'group-a@g.us').memberIdentityIds, ['ada', 'bea']);
});

test('a heartbeat re-dates the roster and keeps each group', async () => {
  const dataStore = storeFrom();
  const groups = [
    { scopeId: 'scope-a', groupWid: 'group-a@g.us', memberIdentityIds: ['ada'] },
    { scopeId: 'scope-a', groupWid: 'group-b@g.us', memberIdentityIds: ['cara'] }
  ];
  dataStore.rows.set('scope-memberships:v1', {
    generation: 4,
    payloadSha256: 'ab'.repeat(32),
    publishedAt: '2020-01-01T00:00:00.000Z',
    scopes: [{ scopeId: 'scope-a', memberIdentityIds: ['ada', 'cara'] }],
    groups
  });
  const published = [];
  assert.equal(await heartbeatWorkspaceScopeMemberships({ dataStore }, clientFor(published), 'wabp-production'), true);
  assert.deepEqual(published.at(-1).scopes, [{ scopeId: 'scope-a', memberIdentityIds: ['ada', 'cara'] }]);
  assert.deepEqual(dataStore.rows.get('scope-memberships:v1').groups, groups);
});

test('a heartbeat finishes a pending publish without dropping per-group rosters', async () => {
  const dataStore = storeFrom();
  const scopes = [{ scopeId: 'scope-a', memberIdentityIds: ['ada', 'cara'] }];
  const groups = [
    { scopeId: 'scope-a', groupWid: 'group-a@g.us', memberIdentityIds: ['ada'] },
    { scopeId: 'scope-a', groupWid: 'group-b@g.us', memberIdentityIds: ['cara'] }
  ];
  const payloadSha256 = 'ab'.repeat(32);
  dataStore.rows.set('scope-memberships:v1', {
    generation: 4,
    payloadSha256,
    publishedAt: '2020-01-01T00:00:00.000Z',
    scopes,
    groups,
    pending: {
      schemaVersion: 1,
      installationId: 'wabp-production',
      generation: 5,
      capturedAt: '2026-11-23T21:00:00.000Z',
      payloadSha256,
      idempotencyKey: `scope-memberships:wabp-production:5:${payloadSha256}`,
      scopes
    }
  });
  const published = [];
  assert.equal(await heartbeatWorkspaceScopeMemberships({ dataStore }, clientFor(published), 'wabp-production'), true);
  const stored = dataStore.rows.get('scope-memberships:v1');
  assert.equal(stored.pending, undefined);
  assert.equal(stored.generation, 5);
  assert.deepEqual(stored.groups, groups);
});
