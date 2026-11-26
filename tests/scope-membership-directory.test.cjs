const assert = require('node:assert/strict');
const { test } = require('node:test');
const { refreshWorkspaceScopeMemberships } = require('../dist/scopeMembershipDirectory');
const { WorkspaceScopeMembershipReplaceV1Schema } = require('../dist/contracts/workspace-connector-v0.3');

function context({ standings } = {}) {
  const rows = new Map();
  return {
    dataStore: { get: async (key) => rows.get(key), set: async (key, value) => { rows.set(key, value); } },
    listEnabledScopes: async () => [{ scopeId: 'community' }, { scopeId: 'standalone' }],
    currentMemberIdentityIdsForScope: async (scopeId) => scopeId === 'community' ? ['member-b', 'member-a'] : ['member-a'],
    ...(standings ? { memberStandingsForScope: standings } : {})
  };
}

function client() {
  const sent = [];
  return {
    sent,
    replaceScopeMembershipsV1: async (request) => {
      WorkspaceScopeMembershipReplaceV1Schema.parse(request);
      sent.push(request);
      return { schemaVersion: 1, installationId: request.installationId, acceptedGeneration: request.generation,
        payloadSha256: request.payloadSha256, appliedAt: new Date().toISOString() };
    }
  };
}

test('publishes a suspension before the WhatsApp removal catches up', async () => {
  const plain = client();
  await refreshWorkspaceScopeMemberships(context(), plain, 'installation-1');
  assert.deepEqual(plain.sent[0].scopes, [
    { scopeId: 'community', memberIdentityIds: ['member-a', 'member-b'] },
    { scopeId: 'standalone', memberIdentityIds: ['member-a'] }
  ]);

  const suspended = client();
  await refreshWorkspaceScopeMemberships(context({
    standings: async (scopeId) => scopeId === 'community'
      ? [
          { identityId: 'suspended-z', standing: 'suspended' },
          { identityId: 'expelled-x', standing: 'expelled' },
          { identityId: 'member-a', standing: 'suspended' },
          { identityId: 'suspended-c', standing: 'suspended' }
        ]
      : []
  }), suspended, 'installation-1');
  assert.deepEqual(suspended.sent[0].scopes, [
    { scopeId: 'community', memberIdentityIds: ['member-b'], suspendedIdentityIds: ['member-a', 'suspended-c', 'suspended-z'] },
    { scopeId: 'standalone', memberIdentityIds: ['member-a'] }
  ]);
  assert.notEqual(suspended.sent[0].payloadSha256, plain.sent[0].payloadSha256);
});

test('rejects a directory that lists someone as both member and suspended', () => {
  assert.throws(() => WorkspaceScopeMembershipReplaceV1Schema.parse({
    schemaVersion: 1, installationId: 'installation-1', generation: 1, capturedAt: new Date().toISOString(),
    payloadSha256: 'a'.repeat(64), idempotencyKey: 'membership:1',
    scopes: [{ scopeId: 'community', memberIdentityIds: ['member-a'], suspendedIdentityIds: ['member-a'] }]
  }), /cannot also be a member/u);
});

test('only registration uses suspended identities and a pending return grants nothing', async () => {
  const { scopeMemberIdentityIds } = require('../dist/scopeMembershipDirectory');
  let standings = [{ identityId: 'held', standing: 'suspended' }];
  const ctx = context({ standings: async () => standings });
  const sink = client();
  await refreshWorkspaceScopeMemberships(ctx, sink, 'installation-1');
  assert.ok((await scopeMemberIdentityIds(ctx, 'community', 'account.registration.v1')).includes('held'));
  assert.ok(!(await scopeMemberIdentityIds(ctx, 'community', 'gallery.upload.v1')).includes('held'));
  standings = [];
  await refreshWorkspaceScopeMemberships(ctx, sink, 'installation-1');
  assert.deepEqual(sink.sent.at(-1).scopes[0].returningIdentityIds, ['held']);
  assert.ok(!(await scopeMemberIdentityIds(ctx, 'community', 'account.registration.v1')).includes('held'));
  standings = [{ identityId: 'held', standing: 'expelled' }];
  await refreshWorkspaceScopeMemberships(ctx, sink, 'installation-1');
  assert.equal(sink.sent.at(-1).scopes[0].returningIdentityIds, undefined);
});

test('a cached group and an unrelated participant event cannot confirm reentry', async () => {
  const { noteParticipantMembership } = require('../dist/scopeMembershipDirectory');
  let held = true, readable = true;
  const ctx = { ...context({ standings: async () => held ? [{ identityId: 'held', standing: 'suspended' }] : [] }),
    listEnabledScopes: async () => [{ scopeId: 'community' }],
    coveredGroupsForScope: async () => [{ groupWid: 'chat' }],
    getAuthoritativeGroupParticipantSnapshot: async () => {
      if (!readable) throw Error('unavailable');
      return { providerId: 'whatsmeow', botWid: 'bot', observedAt: new Date(), participants: [{ wid: 'held' }] };
    },
    resolveIdentityAddress: async wid => ({ identityId: wid })
  };
  const sink = client();
  const refresh = () => refreshWorkspaceScopeMemberships(ctx, sink, 'installation');
  await refresh();
  held = false;
  readable = false;
  await refresh();
  assert.deepEqual(sink.sent.at(-1).scopes[0], { scopeId: 'community', memberIdentityIds: [], returningIdentityIds: ['held'] });
  await noteParticipantMembership(ctx, sink, 'installation', { scopeId: 'community', groupWid: 'chat', action: 'join', identityIds: ['other'] });
  assert.deepEqual(sink.sent.at(-1).scopes[0], { scopeId: 'community', memberIdentityIds: ['other'], returningIdentityIds: ['held'] });
  readable = true;
  await refresh();
  assert.deepEqual(sink.sent.at(-1).scopes[0], { scopeId: 'community', memberIdentityIds: ['held'] });
});
