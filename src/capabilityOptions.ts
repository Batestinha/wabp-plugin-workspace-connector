import { workspaceCapabilityOptionsKey, workspaceCapabilityOptionsSchema } from '@wabs/plugin-sdk/controls';
import type { PluginCommandContext } from './runtime';
import type { WorkspaceConnectorConnection } from './config';
import type { WorkspaceConnectorCatalog, WorkspaceConnectorCatalogV2 } from './contracts/workspace-connector-v0.3';

/** Publish only freshly authenticated catalogs, never unbound legacy caches. */
export async function publishCapabilityOptions(
  context: Pick<PluginCommandContext, 'config' | 'dataStore'>,
  connection: WorkspaceConnectorConnection,
  v1: WorkspaceConnectorCatalog,
  v2: WorkspaceConnectorCatalogV2,
): Promise<void> {
  const accountId = context.config.WHATSAPP_ACCOUNT_ID;
  if (!accountId || !context.dataStore) return;
  const options = new Map<string, { value: string; label: string; reference: string; searchText: string }>();
  for (const capability of [...v1.capabilities, ...v2.capabilities]) {
    const id = capability.capabilityId;
    const aliasV2 = v2.aliases.find(alias => alias.capabilityId === id);
    const aliasV1 = v1.aliases.find(alias => alias.capabilityId === id);
    const labels = aliasV2?.descriptionByLocale;
    const label = labels?.['en'] ?? labels?.['pt-PT'] ?? aliasV1?.description ?? id;
    options.set(id, { value: id, label, reference: id,
      searchText: [id, label, ...Object.values(labels ?? {})].join(' ').slice(0, 2048) });
  }
  const snapshot = workspaceCapabilityOptionsSchema.parse({ schemaVersion: 1, accountId,
    installationId: connection.installationId, baseUrl: connection.baseUrl,
    capturedAt: new Date().toISOString(), options: [...options.values()].sort((a, b) => a.label.localeCompare(b.label)) });
  await context.dataStore.set(workspaceCapabilityOptionsKey(accountId, connection.installationId), snapshot);
}
