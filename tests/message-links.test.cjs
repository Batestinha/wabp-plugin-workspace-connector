const assert = require('node:assert/strict');
const { test } = require('node:test');
const { registerWorkspaceConnectorServices } = require('../dist/services');
const { WorkspaceConnectorClient } = require('../dist/client');
const { MESSAGE_LINK_SERVICE_ID, messageLinkOutput } = require('../dist/serviceApi');

test('a URL requires the owning integration and its feature in the calling scope', async t => {
  const manager = 'official.integration-manager';
  const owners = [
    { pluginId: 'official.workspace-calendar', workspaceCapabilities: [{ capabilityId: 'calendar.feed.replace.v1', enabledSetting: 'publishCalendar' }] },
    { pluginId: 'official.chat-archive', workspaceCapabilities: [{ capabilityId: 'chatarchive.web.read.v1', enabledSetting: 'externalAccess' }] }
  ];
  let installed = owners;
  let managerEnabled = true;
  let calendarEnabled = true;
  const settings = { publishCalendar: true, externalAccess: true, browserLinks: true };
  const calls = [];
  t.mock.method(WorkspaceConnectorClient.prototype, 'messageLink', async (scope, link) => {
    calls.push({ scope, link });
    return { url: 'https://workspace.example' };
  });
  const context = { configFor: async () => ({ enabled: managerEnabled }),
    config: { WORKSPACE_CONNECTOR_BASE_URL: 'https://workspace.example', WORKSPACE_CONNECTOR_OIDC_ISSUER: 'https://issuer.example/realms/workspace',
      WORKSPACE_CONNECTOR_OIDC_AUDIENCE: 'workspace', WORKSPACE_CONNECTOR_OIDC_CLIENT_ID: 'bot',
      WORKSPACE_CONNECTOR_INSTALLATION_ID: 'installation', workspaceConnectorOidcClientSecret: 'fixture-only-service-secret' },
    catalog: { listManifests: () => installed, enabledFor: async (id, scope) => scope === 'scope' &&
      (id === manager || id !== owners[0].pluginId || calendarEnabled), configFor: async () => settings } };
  const method = registerWorkspaceConnectorServices(context).find(service => service.serviceId === MESSAGE_LINK_SERVICE_ID).methods[0];
  const calendar = { target: 'calendarPage', resourceKey: 'events' };
  const archive = { target: 'archiveOrigin' };
  const resolve = (link, scopeId = 'scope') => method.handler(link, { scopeId });
  assert.equal((await resolve(calendar)).url, 'https://workspace.example');
  assert.equal((await resolve(archive)).url, 'https://workspace.example');
  managerEnabled = false;
  assert.equal((await resolve(calendar)).url, null);
  managerEnabled = true;
  calendarEnabled = false;
  assert.equal((await resolve(calendar)).url, null);
  calendarEnabled = true;
  installed = [owners[1]];
  assert.equal((await resolve(calendar)).url, null);
  installed = owners;
  settings.publishCalendar = false;
  assert.equal((await resolve(calendar)).url, null);
  settings.browserLinks = false;
  assert.equal((await resolve(archive)).url, null);
  settings.browserLinks = true;
  settings.externalAccess = false;
  assert.equal((await resolve(archive)).url, null);
  assert.equal((await resolve(calendar, 'elsewhere')).url, null);
  assert.deepEqual(calls, [{ scope: 'scope', link: calendar }, { scope: 'scope', link: archive }]);
  for (const url of ['http://workspace.example', 'https://user@workspace.example', 'unpublished']) {
    assert.equal(messageLinkOutput.safeParse({ url }).success, false);
  }
});
