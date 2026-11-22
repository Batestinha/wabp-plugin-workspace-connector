const assert = require('node:assert/strict');
const { test } = require('node:test');
const { deliverWorkspaceDeliveryV2 } = require('../dist/hooks');
const { dispatchWorkspaceCommand } = require('../dist/commands');
const { workspaceScope } = require('../dist/ownership');
const id = 'gallery.media.upload.v1', owner = 'official.piwigo-gallery', manager = 'official.integration-manager';
const claim = { capabilityId: id, commands: ['/gallery'], triggers: ['gallery.media-dump-hint.v1'], enabledSetting: 'uploadsEnabled',
  triggerSetting: 'albumHintsEnabled', announcementSetting: 'announcementsEnabled' };
test('turning off Piwigo in the originating scope stops a queued cross-scope announcement', async () => {
  let available = true;
  let announcements = false;
  let sends = 0;
  const ctx = { configFor: async () => ({ enabled: true }),
    catalog: { listManifests: () => [{ pluginId: owner, workspaceCapabilities: [claim] }],
      enabledFor: async (plugin, scope) => plugin === manager || scope === 'destination' || available,
      configFor: async () => ({ uploadsEnabled: true, albumHintsEnabled: true, announcementsEnabled: announcements, maximumFiles: 2 }) },
    sendText: async () => { sends++; } };
  const delivery = { protocolVersion: 2, deliveryId: 'queued', idempotencyKey: 'existing-key',
    origin: { capabilityId: id, scopeId: 'origin' }, target: { kind: 'scope_chat', scopeId: 'destination', chatId: 'dest@g.us' },
    action: { kind: 'reply', text: 'Your album is ready' }, expiresAt: '2099-01-01T00:00:00.000Z' };
  assert.equal((await workspaceScope(ctx, 'origin')).grants[0].maximumFiles, 2);
  assert.equal((await deliverWorkspaceDeliveryV2(ctx, {}, delivery)).safeFailureCode, 'capability.disabled');
  available = false; announcements = true;
  assert.equal((await deliverWorkspaceDeliveryV2(ctx, {}, delivery)).safeFailureCode, 'capability.disabled');
  assert.equal(sends, 0);
  assert.equal((await dispatchWorkspaceCommand(ctx, { t: key => key }, 'gallery', 'other', id)).text,
    'official.integration-manager.unknownCapability');
});
