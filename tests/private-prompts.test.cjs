const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const plugin = require('../dist').default;
const { deliverWorkspaceDeliveryV2, createWorkspaceConnectorHooks, handleWorkspaceSessionMessage } = require('../dist/hooks');
const { findWorkspaceMediaSession, storeWorkspaceSession } = require('../dist/mediaSessions');
const { WorkspaceConnectorClient } = require('../dist/client');
const { registerWorkspaceConnectorCancellations } = require('../dist/cancellations');
const { workspaceConnectorCatalogDigestPreimage } = require('../dist/contracts/workspace-connector-v0.3');

function fixture(t) {
  const rows = new Map(), prompts = [], sends = [], acknowledgements = [], callbacks = [];
  const locks = new Map(), promptDeliveries = new Map(), closedPrompts = new Set();
  let handler, handlerOptions;
  const capabilityId = 'fixture.confirm.v1';
  const address = { identityId: 'person-1', deliveryChatId: 'person@lid', mentionWid: 'person@lid', phoneNumber: '351910000001' };
  const catalog = { protocolVersion: 2, workspaceId: 'workspace-1', workspaceLabel: 'Workspace', revision: 1,
    aliases: [], capabilities: [{ capabilityId, interfaces: ['interactive'], maximumPayloadBytes: 65536, mediaMimeTypes: [], cancellationSupported: true }] };
  catalog.digestSha256 = createHash('sha256').update(workspaceConnectorCatalogDigestPreimage(catalog)).digest('hex');
  const context = { pluginId: plugin.manifest.pluginId, manifest: plugin.manifest,
    config: { WORKSPACE_CONNECTOR_BASE_URL: 'https://workspace.example', WORKSPACE_CONNECTOR_OIDC_ISSUER: 'https://identity.example/realms/fixture',
      WORKSPACE_CONNECTOR_OIDC_CLIENT_ID: 'fixture', WORKSPACE_CONNECTOR_OIDC_AUDIENCE: 'fixture-api',
      WORKSPACE_CONNECTOR_INSTALLATION_ID: 'installation-1', WORKSPACE_CONNECTOR_DELIVERY_POLL_ENABLED: false,
      workspaceConnectorOidcClientSecret: 'fixture-secret-for-tests' },
    dataStore: { get: async key => structuredClone(rows.get(key)), set: async (key, value) => rows.set(key, structuredClone(value)),
      delete: async key => Number(rows.delete(key)), list: async () => [...rows].map(([key, valueJson]) => ({ id: key, scopeId: null, key, valueJson })) },
    configFor: async () => ({ enabled: true, allowedCapabilities: [capabilityId] }),
    coveredGroupsForScope: async () => [{ groupWid: 'group@g.us' }],
    currentMemberIdentityIdsForScope: async () => [address.identityId],
    resolveStableIdentityById: async () => address,
    logger: { warn() {} },
    i18n: { resolveIdentityLocale: async () => ({ locale: 'pt-PT' }),
      translator: () => key => plugin.manifest.defaultMessages[key] ?? key,
      translatorForIdentity: async () => key => plugin.manifest.defaultMessages[key] ?? key },
    sendText: async (...input) => { sends.push(input); return { messageId: `sent-${sends.length}` }; },
    flowEngine: {
      workflowRuntimeBindingId: 'runtime-1',
      whenTransportReady: async () => {},
      registerPromptHandler: (_purpose, callback, options) => { handler = callback; handlerOptions = options; },
      inspectIdentityFlowStart: async () => ({ kind: 'available' }),
      promptChoice: async input => {
        const key = input.questionSendOptions.idempotencyKey;
        const previous = promptDeliveries.get(key);
        if (previous) {
          if (closedPrompts.has(previous.flowPromptId)) throw new Error('FlowPrompt is no longer deliverable.');
          return { ...previous, deliveryCompletedNow: false };
        }
        prompts.push(input);
        const result = { flowPromptId: `prompt-${prompts.length}`, messageIds: [`prompt-message-${prompts.length}`], deliveryCompletedNow: true, hasPollMessages: false };
        promptDeliveries.set(key, result);
        return result;
      },
      getLockedPromptLock: async id => locks.get(id),
      acknowledgePromptLock: async id => { acknowledgements.push(id); closedPrompts.add(id); return locks.delete(id); },
      cancelPromptBySubject: async () => 1,
    } };
  const client = { catalogV2: async () => catalog };
  t.mock.method(WorkspaceConnectorClient.prototype, 'continueSessionV2', async input => {
    callbacks.push(input);
    return { protocolVersion: 2, invocationId: 'done', actions: [{ kind: 'complete', route: { kind: 'actor_private', fallback: 'none' }, text: 'Confirmed.' }] };
  });
  let hooks = createWorkspaceConnectorHooks(context);
  t.after(() => hooks.onShutdown());
  const delivery = { protocolVersion: 2, deliveryId: 'delivery-1', idempotencyKey: 'delivery-once',
    target: { kind: 'identity', identityId: address.identityId }, expiresAt: '2099-01-01T00:00:00.000Z',
    action: { kind: 'start_session', capabilityId, scopeId: 'scope-1',
      session: { sessionId: 'remote-session-1', expiresAt: '2099-01-01T00:00:00.000Z' },
      prompt: 'Confirm linking?', choices: [{ id: 'confirm', label: 'Confirm' }, { id: 'reject', label: 'Reject' }] } };
  return { context, client, delivery, address, prompts, sends, callbacks, acknowledgements, locks,
    restart: async () => { hooks.onShutdown(); hooks = createWorkspaceConnectorHooks(context); await new Promise(resolve => setImmediate(resolve)); },
    get handlerOptions() { return handlerOptions; },
    start: () => deliverWorkspaceDeliveryV2(context, client, delivery),
    lock(choice = 'confirm') {
      const prompt = prompts.at(-1);
      const lock = { flowPromptId: `prompt-${prompts.length}`, purpose: prompt.purpose, subjectType: prompt.subjectType, subjectId: prompt.subjectId,
        voterIdentityId: address.identityId, voterWid: address.mentionWid,
        selectedOptions: [{ id: choice, label: choice === 'confirm' ? 'Confirm' : 'Reject', number: choice === 'confirm' ? 1 : 2 }], selectionRule: 'SINGLE' };
      locks.set(lock.flowPromptId, lock);
      return lock;
    },
    handle: lock => handler(lock),
  };
}

test('private session delivery creates a runtime-bound FlowEngine prompt instead of unowned numbered text', async t => {
  const f = fixture(t);
  const ack = await f.start();
  assert.equal(ack.disposition, 'delivered');
  assert.equal(f.prompts.length, 1);
  assert.equal(f.sends.length, 0);
  assert.deepEqual(f.prompts[0].eligibleVoterIdentityIds, ['person-1']);
  assert.deepEqual(f.prompts[0].recipientWids, ['person@lid']);
  assert.deepEqual(f.prompts[0].options, [{ id: 'confirm', label: 'Confirm' }, { id: 'reject', label: 'Reject' }]);
  assert.equal(f.prompts[0].questionSendOptions.idempotencyKey, 'workspace-private:runtime-1:workspace-v2:delivery-once');
  assert.equal(f.handlerOptions.recoverLocked, true);
  const subject = JSON.parse(Buffer.from(f.prompts[0].subjectType.slice('runtime-bound:v1:'.length), 'base64url'));
  assert.equal(subject.runtimeBindingId, 'runtime-1');
});

test('a human prompt lock continues the bound session with current verified identity and durable idempotency', async t => {
  const f = fixture(t);
  await f.start();
  const lock = f.lock();
  f.address.phoneNumber = '351910000099';
  await f.handle(lock);
  assert.equal(f.callbacks.length, 1);
  assert.equal(f.callbacks[0].actor.verifiedWhatsappNumber, '+351910000099');
  assert.deepEqual(f.callbacks[0].input, { kind: 'choice', choiceId: 'confirm' });
  assert.equal(f.callbacks[0].sessionId, 'remote-session-1');
  assert.equal(f.callbacks[0].scopeId, 'scope-1');
  assert.equal(f.callbacks[0].eventId, 'flow-prompt:prompt-1');
  assert.equal(f.callbacks[0].idempotencyKey, 'workspace-choice-v2:prompt-1');
  assert.equal(f.sends[0][1], 'Confirmed.');
  assert.deepEqual(f.acknowledgements, ['prompt-1']);
  assert.equal(await findWorkspaceMediaSession(f.context.dataStore, 'person-1'), undefined);
});

test('FlowEngine-owned sessions cannot also be continued by the ordinary message hook', async t => {
  const f = fixture(t);
  await f.start();
  await handleWorkspaceSessionMessage(f.context, { continueSessionV2: async () => { throw new Error('Hook must not submit a FlowEngine choice'); } }, 'installation-1', {
    actorIdentityId: 'person-1', actor: { identityAddress: f.address }, message: { id: 'reply-1', body: '1', context: 'private', chatId: 'person@lid' }, isCommandLike: false,
  });
  assert.ok(await findWorkspaceMediaSession(f.context.dataStore, 'person-1'));
});

test('backend failure leaves the human choice locked for durable retry', async t => {
  const f = fixture(t);
  let calls = 0;
  t.mock.method(WorkspaceConnectorClient.prototype, 'continueSessionV2', async input => {
    f.callbacks.push(input);
    if (++calls === 1) throw new Error('503 backend unavailable');
    return { protocolVersion: 2, invocationId: 'done', actions: [] };
  });
  await f.start();
  const lock = f.lock();
  await assert.rejects(f.handle(lock), /503/);
  assert.deepEqual(f.acknowledgements, []);
  assert.ok(f.locks.has('prompt-1'));
  await f.handle(lock);
  assert.equal(f.callbacks[0].idempotencyKey, f.callbacks[1].idempotencyKey);
  assert.deepEqual(f.acknowledgements, ['prompt-1']);
});

for (const change of ['identity', 'scope', 'session', 'choice', 'runtime']) {
  test(`rejects ${change} drift before the remote continuation`, async t => {
    const f = fixture(t);
    await f.start();
    const lock = f.lock();
    if (change === 'identity') f.context.resolveStableIdentityById = async () => ({ ...f.address, identityId: 'wrong-person' });
    if (change === 'scope') f.context.currentMemberIdentityIdsForScope = async () => [];
    if (change === 'session') lock.subjectId = 'wrong-session';
    if (change === 'choice') lock.selectedOptions[0].id = 'invented';
    if (change === 'runtime') lock.subjectType = 'wrong-runtime';
    await f.handle(lock);
    assert.equal(f.callbacks.length, 0);
  });
}

test('a duplicate delivery cannot reopen a completed remote session', async t => {
  const f = fixture(t);
  await f.start();
  await f.handle(f.lock());
  assert.equal((await f.start()).disposition, 'delivered');
  assert.equal(f.prompts.length, 1);
  assert.equal(await findWorkspaceMediaSession(f.context.dataStore, 'person-1'), undefined);
});

test('receipt-write failure followed by a human completion cannot reopen the session on delivery retry', async t => {
  const f = fixture(t);
  const persist = f.context.dataStore.set;
  let failed = false;
  f.context.dataStore.set = async (key, value) => {
    if (key.endsWith(':receipt') && !failed) { failed = true; throw new Error('receipt database unavailable'); }
    return persist(key, value);
  };
  assert.equal((await f.start()).disposition, 'retryable_failure');
  await f.handle(f.lock());
  assert.equal(await findWorkspaceMediaSession(f.context.dataStore, 'person-1'), undefined);
  const retry = await f.start();
  assert.equal(await findWorkspaceMediaSession(f.context.dataStore, 'person-1'), undefined);
  assert.equal(retry.disposition, 'delivered');
  assert.equal(retry.providerMessageId, 'prompt-message-1');
  assert.equal(f.prompts.length, 1);
  assert.equal(f.callbacks.length, 1);
});

test('a missing exact receipt keeps the human lock recoverable until its persistence succeeds', async t => {
  const f = fixture(t);
  const persist = f.context.dataStore.set;
  f.context.dataStore.set = async (key, value) => {
    if (key.endsWith(':receipt')) throw new Error('receipt database unavailable');
    return persist(key, value);
  };
  assert.equal((await f.start()).disposition, 'retryable_failure');
  const lock = f.lock();
  await assert.rejects(f.handle(lock), /receipt database unavailable/);
  assert.equal(f.callbacks.length, 0);
  assert.deepEqual(f.acknowledgements, []);
  assert.ok(f.locks.has('prompt-1'));
  f.context.dataStore.set = persist;
  await f.handle(lock);
  assert.equal(f.callbacks.length, 1);
  assert.equal((await f.start()).providerMessageId, 'prompt-message-1');
});

test('a completed prompt without its exact receipt fails closed without restoring session state', async t => {
  const f = fixture(t);
  await f.start();
  await f.handle(f.lock());
  await f.context.dataStore.delete(`${f.prompts[0].subjectId}:receipt`);
  assert.equal((await f.start()).disposition, 'retryable_failure');
  assert.equal(await findWorkspaceMediaSession(f.context.dataStore, 'person-1'), undefined);
  assert.equal(f.callbacks.length, 1);
});

for (const completion of ['reply', 'cancel']) {
  test(`an in-flight delivery retry cannot overwrite concurrent human ${completion} completion`, async t => {
    const f = fixture(t);
    const persist = f.context.dataStore.set;
    f.context.dataStore.set = async (key, value) => {
      if (key.endsWith(':receipt')) throw new Error('receipt database unavailable');
      return persist(key, value);
    };
    assert.equal((await f.start()).disposition, 'retryable_failure');
    f.context.dataStore.set = persist;
    const read = f.context.dataStore.get;
    let pause = true, release, entered;
    const paused = new Promise(resolve => { entered = resolve; });
    const resume = new Promise(resolve => { release = resolve; });
    f.context.dataStore.get = async key => {
      const value = await read(key);
      if (pause && key.endsWith(':receipt')) { pause = false; entered(); await resume; }
      return value;
    };
    const retry = f.start();
    await paused;
    let remoteCalls = 0;
    const registration = registerWorkspaceConnectorCancellations(f.context, () => ({ continueSessionV2: async () => {
      remoteCalls++;
      return { protocolVersion: 2, invocationId: 'cancelled', actions: [] };
    } }))[0];
    const finished = completion === 'reply' ? f.handle(f.lock()) : registration.cancel({ actorIdentityId: 'person-1',
      message: { id: 'cancel-message', chatId: 'person@lid', context: 'private', body: '/cancel' } });
    await new Promise(resolve => setImmediate(resolve));
    const callsWhileDeliveryPending = f.callbacks.length + remoteCalls;
    release();
    await Promise.all([retry, finished]);
    assert.equal(callsWhileDeliveryPending, 0);
    assert.equal(await findWorkspaceMediaSession(f.context.dataStore, 'person-1'), undefined);
    assert.equal((await f.start()).providerMessageId, 'prompt-message-1');
    assert.equal(f.callbacks.length + remoteCalls, 1);
  });
}

test('private session delivery fails closed when FlowEngine is unavailable', async t => {
  const f = fixture(t);
  delete f.context.flowEngine;
  assert.equal((await f.start()).disposition, 'terminal_failure');
  assert.equal(f.sends.length, 0);
  assert.equal(await findWorkspaceMediaSession(f.context.dataStore, 'person-1'), undefined);
});

test('restart adopts an old plain-text private choice without submitting a human reply', async t => {
  const f = fixture(t);
  await f.start();
  const session = await findWorkspaceMediaSession(f.context.dataStore, 'person-1');
  delete session.privatePromptSubjectId;
  await storeWorkspaceSession(f.context.dataStore, session);
  await f.restart();
  assert.equal(f.prompts.length, 2);
  assert.equal(f.callbacks.length, 0);
  assert.ok((await findWorkspaceMediaSession(f.context.dataStore, 'person-1')).privatePromptSubjectId);
  assert.match(f.prompts[1].question, /previous request/i);
});

test('a reply-send failure replays the cached result without resubmitting the human choice', async t => {
  const f = fixture(t);
  await f.start();
  const lock = f.lock();
  const send = f.context.sendText;
  f.context.sendText = async () => { throw new Error('send unavailable'); };
  await assert.rejects(f.handle(lock), /send unavailable/);
  assert.equal(f.callbacks.length, 1);
  assert.deepEqual(f.acknowledgements, []);
  f.context.sendText = send;
  await f.handle(lock);
  assert.equal(f.callbacks.length, 1);
  assert.equal(f.sends[0][1], 'Confirmed.');
  assert.deepEqual(f.acknowledgements, ['prompt-1']);
});

test('an unrelated active private flow delays delivery without replacing its owner', async t => {
  const f = fixture(t);
  f.context.flowEngine.inspectIdentityFlowStart = async () => ({ kind: 'conflict', session: { id: 'other-flow' } });
  assert.equal((await f.start()).disposition, 'retryable_failure');
  assert.equal(f.prompts.length, 0);
  assert.equal(await findWorkspaceMediaSession(f.context.dataStore, 'person-1'), undefined);
});

test('a competing remote conversation cannot replace the active prompt', async t => {
  const f = fixture(t);
  await f.start();
  f.delivery.action.session.sessionId = 'another-session';
  f.delivery.idempotencyKey = 'another-delivery';
  assert.equal((await f.start()).disposition, 'retryable_failure');
  assert.equal(f.prompts.length, 1);
  assert.equal((await findWorkspaceMediaSession(f.context.dataStore, 'person-1')).sessionId, 'remote-session-1');
});

test('a continuation choice stays owned by FlowEngine and can complete on the next human lock', async t => {
  const f = fixture(t);
  let calls = 0;
  t.mock.method(WorkspaceConnectorClient.prototype, 'continueSessionV2', async input => {
    f.callbacks.push(input);
    return ++calls === 1 ? { protocolVersion: 2, invocationId: 'next', session: f.delivery.action.session,
      actions: [{ kind: 'choice', route: { kind: 'actor_private', fallback: 'none' }, prompt: 'Confirm the next step?', choices: f.delivery.action.choices }] }
      : { protocolVersion: 2, invocationId: 'done', actions: [] };
  });
  await f.start();
  await f.handle(f.lock());
  assert.equal(f.prompts.length, 2);
  assert.equal(f.prompts[1].question, 'Confirm the next step?');
  assert.equal(f.sends.length, 0);
  assert.equal(f.prompts[1].subjectId, (await findWorkspaceMediaSession(f.context.dataStore, 'person-1')).privatePromptSubjectId);
  await f.handle(f.lock('reject'));
  assert.deepEqual(f.callbacks[1].input, { kind: 'choice', choiceId: 'reject' });
  assert.equal(await findWorkspaceMediaSession(f.context.dataStore, 'person-1'), undefined);
});

test('user cancellation closes the owned FlowEngine prompt after remote cancellation succeeds', async t => {
  const f = fixture(t);
  await f.start();
  const cancellations = [];
  f.context.flowEngine.cancelPromptBySubject = async input => { cancellations.push(input); return 1; };
  const registration = registerWorkspaceConnectorCancellations(f.context, () => ({ continueSessionV2: async input => {
    assert.deepEqual(input.input, { kind: 'cancel', reason: 'user' });
    return { protocolVersion: 2, invocationId: 'cancelled', actions: [] };
  } }))[0];
  const result = await registration.cancel({ actorIdentityId: 'person-1',
    message: { id: 'cancel-message', chatId: 'person@lid', context: 'private', body: '/cancel' } });
  assert.equal(result.cancelled, true);
  assert.deepEqual(cancellations, [{ purpose: f.prompts[0].purpose, subjectId: f.prompts[0].subjectId, includeLocked: true }]);
  assert.equal(await findWorkspaceMediaSession(f.context.dataStore, 'person-1'), undefined);
});

test('delivery retry cannot reopen a user-cancelled session whose send receipt was not persisted', async t => {
  const f = fixture(t);
  const persist = f.context.dataStore.set;
  f.context.dataStore.set = async (key, value) => {
    if (key.endsWith(':receipt')) throw new Error('receipt database unavailable');
    return persist(key, value);
  };
  assert.equal((await f.start()).disposition, 'retryable_failure');
  const registration = registerWorkspaceConnectorCancellations(f.context, () => ({ continueSessionV2: async () => (
    { protocolVersion: 2, invocationId: 'cancelled', actions: [] }
  ) }))[0];
  const result = await registration.cancel({ actorIdentityId: 'person-1',
    message: { id: 'cancel-message', chatId: 'person@lid', context: 'private', body: '/cancel' } });
  assert.equal(result.cancelled, true);
  f.context.dataStore.set = persist;
  const retry = await f.start();
  assert.equal(await findWorkspaceMediaSession(f.context.dataStore, 'person-1'), undefined);
  assert.equal(retry.disposition, 'retryable_failure');
  assert.equal(retry.providerMessageId, undefined);
  assert.equal(f.prompts.length, 1);
});

test('restart recovers a pending prompt send with its original question and delivery key', async t => {
  const f = fixture(t);
  const sendPrompt = f.context.flowEngine.promptChoice;
  f.context.flowEngine.promptChoice = async () => { throw new Error('transport not ready'); };
  assert.equal((await f.start()).disposition, 'retryable_failure');
  assert.equal(f.prompts.length, 0);
  f.context.flowEngine.promptChoice = sendPrompt;
  await f.restart();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].question, 'Confirm linking?');
  assert.equal(f.prompts[0].questionSendOptions.idempotencyKey, 'workspace-private:runtime-1:workspace-v2:delivery-once');
  assert.equal(f.callbacks.length, 0);
});

test('a private continuation requesting text keeps the next human answer in FlowEngine', async t => {
  const f = fixture(t);
  let calls = 0;
  t.mock.method(WorkspaceConnectorClient.prototype, 'continueSessionV2', async input => {
    f.callbacks.push(input);
    return ++calls === 1 ? { protocolVersion: 2, invocationId: 'name', session: f.delivery.action.session,
      actions: [{ kind: 'reply', route: { kind: 'actor_private', fallback: 'none' }, text: 'Your display name?' }] }
      : { protocolVersion: 2, invocationId: 'done', actions: [] };
  });
  await f.start();
  await f.handle(f.lock());
  assert.equal(f.prompts.length, 2);
  assert.equal(f.prompts[1].question, 'Your display name?');
  assert.equal(f.sends.length, 0);
  const lock = f.lock();
  lock.selectedOptions = [{ id: f.prompts[1].freeTextOption.id, label: 'Actual human answer', isFreeText: true, number: 0 }];
  await f.handle(lock);
  assert.deepEqual(f.callbacks[1].input, { kind: 'text', text: 'Actual human answer' });
});
