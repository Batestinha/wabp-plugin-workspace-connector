const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const plugin = require('../dist').default;
const { WorkspaceConnectorClient } = require('../dist/client');
const { workspaceConnectorConnection } = require('../dist/config');
const { rememberWorkspaceSession, findWorkspaceMediaSession } = require('../dist/mediaSessions');
const { handleWorkspaceSessionMessage } = require('../dist/hooks');
const { createWorkspaceConnectorHooks } = require('../dist/hooks');
const connection = { baseUrl: 'https://workspace.example', oidcIssuer: 'https://identity.example/realms/fixture',
  clientId: 'fixture', clientSecret: 'fixture', audience: 'fixture-api', installationId: 'fixture-installation' };
const t = (key) => plugin.manifest.defaultMessages[key] ?? key;
const actor = { identityId: 'fixture-identity', displayName: 'Fixture actor' };
const digest = 'a'.repeat(64);
function storeFrom(rows = new Map()) {
  return { rows, get: async (key) => structuredClone(rows.get(key)),
    set: async (key, value) => { rows.set(key, structuredClone(value)); },
    delete: async (key) => Number(rows.delete(key)), list: async () => [] };
}
function context(dataStore = storeFrom()) {
  return { pluginId: plugin.manifest.pluginId, manifest: plugin.manifest, config: {}, dataStore,
    configFor: async () => ({ enabled: false, deliveryChatId: 'fixture@g.us', allowedCapabilities: ['fixture.submit.v1'] }),
    enabledFor: async () => true, ephemeralStore: {}, logger: { warn() {} },
    i18n: { translator: () => t, translatorForIdentity: async () => t,
      resolveIdentityLocale: async () => ({ locale: 'pt-PT', source: 'SCOPE', subjectId: 'fixture-scope', languagePackScopes: [] }) },
    enqueuePluginJob: async () => { throw new Error('Unexpected job'); } };
}
function catalog() {
  return { protocolVersion: 1, workspaceId: 'fixture-workspace', workspaceLabel: 'Fixture workspace', revision: 7,
    aliases: [{ namespace: 'documents', capabilityId: 'fixture.submit.v1', contexts: ['group'], description: 'Fixture submission' }],
    capabilities: [{ capabilityId: 'fixture.submit.v1', kind: 'interactive', maximumPayloadBytes: 8192, mediaMimeTypes: [] }], digestSha256: digest };
}

test('preserves scoped settings and rejects an unsafe deployment endpoint', () => {
  const value = { enabled: true, deliveryChatId: 'fixture@g.us', allowedCapabilities: ['fixture.submit.v1'] };
  assert.deepEqual(plugin.manifest.configSchema.parse(value), { ...value, otpCodeSeparate: false, otpLoginExplanation: '', otpRecoveryExplanation: '' });
  assert.equal(plugin.manifest.configSchema.parse({ otpCodeSeparate: true }).otpCodeSeparate, true);
  assert.throws(() => plugin.manifest.configSchema.parse({ otpLoginExplanation: 'x'.repeat(401) }));
  assert.equal(workspaceConnectorConnection({}), undefined);
  assert.throws(() => workspaceConnectorConnection({ WORKSPACE_CONNECTOR_BASE_URL: 'http://workspace.example' }), /canonical HTTPS/);
  assert.throws(() => workspaceConnectorConnection({ WORKSPACE_CONNECTOR_BASE_URL: 'https://workspace.example/?redirect=elsewhere' }), /canonical HTTPS/);
});

test('registers commands, cancellations and hooks without deployment credentials or network work', async () => {
  const commands = new Map();
  const ctx = context();
  ctx.router = { register: (ns, name, metadata, handler) => commands.set(`${ns}.${name}`, handler),
    listCommands: () => [], replaceNamespaceAliasesAtomically() {} };
  await plugin.registerCommands(ctx);
  assert.deepEqual(plugin.registerHooks(ctx), {});
  assert.equal(plugin.registerCancellations(ctx)[0].workflowId, 'workspace-remote-session');
  assert.ok(commands.has('workspace.status'));
  const result = await commands.get('workspace.status')({ scopeId: 'fixture-scope',
    actor: { identityAddress: { ...actor, canonicalWid: 'fixture@c.us' } }, t });
  assert.equal(result.handled, true);
  assert.ok(result.text);
  assert.equal(ctx.dataStore.rows.size, 0);
});

test('v2 delivery polling succeeds when the retired v1 delivery endpoint is unavailable', async (t) => {
  const v2Catalog = { protocolVersion: 2, workspaceId: 'fixture-workspace', workspaceLabel: 'Fixture workspace',
    revision: 1, aliases: [], capabilities: [], ambientTriggers: [], digestSha256: 'a'.repeat(64) };
  const ctx = context(storeFrom(new Map([['catalog:v2', v2Catalog]])));
  ctx.config = { WORKSPACE_CONNECTOR_BASE_URL: 'https://workspace.example',
    WORKSPACE_CONNECTOR_OIDC_ISSUER: 'https://identity.example/realms/fixture',
    WORKSPACE_CONNECTOR_OIDC_CLIENT_ID: 'fixture', WORKSPACE_CONNECTOR_OIDC_AUDIENCE: 'fixture-api',
    WORKSPACE_CONNECTOR_INSTALLATION_ID: 'fixture-installation',
    WORKSPACE_CONNECTOR_DELIVERY_POLL_ENABLED: true, workspaceConnectorOidcClientSecret: 'fixture-secret-for-tests' };
  ctx.listEnabledScopes = async () => [{ scopeId: 'gallery-scope', name: 'Gallery' }];
  ctx.configFor = async () => ({ enabled: true, deliveryChatId: '', allowedCapabilities: ['account.whatsapp-link.v1'] });
  let observed;
  const result = new Promise((resolve) => { observed = resolve; });
  t.mock.method(WorkspaceConnectorClient.prototype, 'claimDeliveries', async () => {
    observed('retired-v1-claim');
    throw new Error('v1 delivery route is unavailable');
  });
  t.mock.method(WorkspaceConnectorClient.prototype, 'claimDeliveriesV2', async (_limit, _signal, scopes) => {
    observed(scopes);
    return [];
  });
  const hooks = createWorkspaceConnectorHooks(ctx);
  try {
    assert.deepEqual(await Promise.race([result, new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Delivery polling did not run')), 500))]),
    { 'gallery-scope': ['account.whatsapp-link.v1'] });
  } finally {
    hooks.onShutdown?.();
  }
});

test('reads a persisted v1 session after restart and preserves catalog and actor binding through continuation', async () => {
  const previous = storeFrom();
  await rememberWorkspaceSession({ store: previous,
    result: { protocolVersion: 1, invocationId: 'fixture-invocation', sessionId: 'fixture-session', sessionExpiresAt: '2099-01-01T00:00:00.000Z',
      actions: [{ kind: 'choice', prompt: 'Choose', choices: [{ id: 'choice-a', label: 'Alpha' }, { id: 'choice-b', label: 'Beta' }] }] },
    actorIdentityId: actor.identityId, actor, scopeId: 'fixture-scope', chatId: 'fixture@g.us', groupWid: 'fixture@g.us',
    capabilityId: 'fixture.submit.v1', catalogRevision: 7, catalogDigestSha256: digest, surface: 'group', locale: 'pt-PT' });
  const current = storeFrom(new Map(JSON.parse(JSON.stringify([...previous.rows]))));
  const session = await findWorkspaceMediaSession(current, actor.identityId, 'fixture@g.us');
  assert.equal(session.sessionId, 'fixture-session');
  assert.equal(session.catalogDigestSha256, digest);
  assert.equal(await findWorkspaceMediaSession(current, 'unrelated-identity'), undefined);
  let request;
  const client = { continueSession: async (input) => {
    request = input;
    return { protocolVersion: 1, invocationId: 'fixture-continuation', actions: [{ kind: 'complete', text: 'Fixture accepted.' }] };
  } };
  const actions = await handleWorkspaceSessionMessage(context(current), client, connection.installationId, {
    pluginId: plugin.manifest.pluginId, scopeId: 'fixture-scope', groupId: 'fixture-group', groupWid: 'fixture@g.us', managementMode: 'MANAGE',
    receivedAt: new Date(), actorIdentityId: actor.identityId, actorWid: 'fixture@c.us',
    actor: { wid: 'fixture@c.us', fromMe: false, identityAddress: { ...actor, canonicalWid: 'fixture@c.us', aliases: [] } },
    message: { id: 'fixture-reply', body: '2', context: 'group', chatId: 'fixture@g.us', senderWid: 'fixture@c.us', fromMe: false },
    isCommandLike: false, mentionsBot: false
  });
  assert.equal(request.catalogRevision, 7);
  assert.equal(request.catalogDigestSha256, digest);
  assert.deepEqual(request.actor, actor);
  assert.deepEqual(request.input, { kind: 'choice', choiceId: 'choice-b' });
  assert.equal(actions[0].text, 'Fixture accepted.');
  assert.equal(await findWorkspaceMediaSession(current, actor.identityId), undefined);
});

test('uses the pinned protocol with opaque identities and stable idempotency keys', async () => {
  const requests = [];
  const client = new WorkspaceConnectorClient(connection, { tokens: { accessToken: async () => 'fixture-token', invalidate() {} },
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json(String(url).endsWith('/catalog') ? catalog()
        : { protocolVersion: 1, invocationId: 'fixture-invocation', actions: [{ kind: 'complete', text: 'Accepted.' }] });
    } });
  const remote = await client.catalog();
  await client.invoke({ protocolVersion: 1, installationId: connection.installationId,
    catalogRevision: remote.revision, catalogDigestSha256: remote.digestSha256, capabilityId: 'fixture.submit.v1',
    scopeId: 'fixture-scope', chatId: 'fixture@g.us', surface: 'group', locale: 'pt-PT',
    eventId: 'fixture-event', messageId: 'fixture-message', idempotencyKey: 'fixture-event:submit', actor, arguments: [] });
  const input = JSON.parse(requests[1].init.body);
  assert.equal(input.idempotencyKey, 'fixture-event:submit');
  assert.equal(input.catalogDigestSha256, digest);
  assert.equal(input.actor.identityId, actor.identityId);
  assert.ok(requests.every((r) => r.url.startsWith(connection.baseUrl + '/')));
});

test('refreshes a rejected service token once and rejects an unavailable remote', async () => {
  let attempts = 0, invalidations = 0;
  const client = new WorkspaceConnectorClient(connection, { tokens: { accessToken: async () => 'fixture-token', invalidate: () => invalidations++ },
    fetch: async () => ++attempts === 1 ? new Response('', { status: 401 }) : Response.json(catalog()) });
  assert.equal((await client.catalog()).workspaceId, 'fixture-workspace');
  assert.equal(attempts, 2);
  assert.equal(invalidations, 1);
  const unavailable = new WorkspaceConnectorClient(connection, { tokens: { accessToken: async () => 'fixture-token', invalidate() {} },
    fetch: async () => new Response('Unavailable', { status: 503 }) });
  await assert.rejects(unavailable.catalog());
});

test('includes complete Portuguese messages and unmodified licensed protocol bytes', () => {
  const metadata = require('../wa-plugin.json');
  const pt = require('../locales/pt-PT/official.workspace-connector.json');
  assert.equal(metadata.version, plugin.manifest.version);
  assert.equal(metadata.operatorConsole.controls.length, 6);
  for (const key of Object.keys(plugin.manifest.defaultMessages)) assert.ok(pt[key]?.trim(), key);
  assert.deepEqual(fs.readFileSync('contracts/workspace-connector-v0.3.ts'), fs.readFileSync('src/contracts/workspace-connector-v0.3.ts'));
  assert.equal(plugin.lifecycle, undefined);
});
