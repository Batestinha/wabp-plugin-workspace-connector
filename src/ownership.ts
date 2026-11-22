import type { ManagedGroupCapabilities } from '@wabs/plugin-sdk/managed-group-plugin';
import { parseWorkspaceConnectorConfig } from './config';
import { WORKSPACE_CONNECTOR_PLUGIN_ID } from './manifest';

export type WorkspaceAccess = Pick<ManagedGroupCapabilities, 'catalog'> & {
  configFor(scopeId: string, actorIdentityId?: string): Promise<Record<string, unknown>>;
};

export function workspaceClaims(context: Pick<WorkspaceAccess, 'catalog'>) {
  return (context.catalog?.listManifests() ?? []).flatMap(manifest =>
    (manifest.workspaceCapabilities ?? []).map(claim => ({ ...claim, owner: manifest.pluginId })));
}

export async function workspaceScope(context: WorkspaceAccess, scopeId: string, actorIdentityId?: string) {
  const manager = parseWorkspaceConnectorConfig(await context.configFor(scopeId, actorIdentityId));
  const catalog = context.catalog;
  const enabled = Boolean(manager.enabled && catalog && await catalog.enabledFor(WORKSPACE_CONNECTOR_PLUGIN_ID, scopeId));
  const grants = [];
  if (enabled && catalog) {
    for (const claim of workspaceClaims(context)) {
      if (!await catalog.enabledFor(claim.owner, scopeId)) continue;
      const settings = claim.owner === WORKSPACE_CONNECTOR_PLUGIN_ID ? manager :
        await catalog.configFor(claim.owner, scopeId, actorIdentityId);
      if (claim.enabledSetting && Reflect.get(settings, claim.enabledSetting) !== true) continue;
      const limit = (key: string) => {
        const value = Reflect.get(settings, key);
        return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
      };
      grants.push({ ...claim, maximumFileBytes: limit('maximumFileBytes'), maximumFiles: limit('maximumFiles'),
        triggersEnabled: !claim.triggerSetting || Reflect.get(settings, claim.triggerSetting) === true,
        announcementsEnabled: !claim.announcementSetting || Reflect.get(settings, claim.announcementSetting) === true
      });
    }
  }
  return { ...manager, enabled, grants, allowedCapabilities: grants.map(claim => claim.capabilityId) };
}
