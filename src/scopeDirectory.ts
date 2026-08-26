import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  WORKSPACE_CONNECTOR_PROTOCOL_VERSION_V2,
  workspaceConnectorCanonicalJson,
  type WorkspaceConnectorScopeDirectoryReceiptV2,
  type WorkspaceConnectorScopeDirectoryReplaceV2
} from '../../../../packages/workspace-connector-contracts/src';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';

const SCOPE_DIRECTORY_STATE_KEY = 'scope-directory:v2';

const scopeDirectoryStateSchema = z.object({
  generation: z.number().int().positive(),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();

export interface WorkspaceScopeDirectoryClient {
  replaceScopeDirectoryV2(
    input: WorkspaceConnectorScopeDirectoryReplaceV2,
    signal?: AbortSignal
  ): Promise<WorkspaceConnectorScopeDirectoryReceiptV2>;
}

export async function refreshWorkspaceScopeDirectory(
  context: PluginRuntimeContext,
  client: WorkspaceScopeDirectoryClient,
  installationId: string
): Promise<boolean> {
  if (!context.listEnabledScopes || !context.coveredGroupsForScope) return false;

  const enabledScopes = await context.listEnabledScopes();
  const scopes = await Promise.all(enabledScopes.map(async (scope) => {
    const coveredGroups = await context.coveredGroupsForScope!(scope.scopeId);
    const chats = new Map<string, { chatId: string; label: string; kind: 'group' }>();
    for (const group of coveredGroups) {
      chats.set(group.groupWid, {
        chatId: group.groupWid,
        label: nonEmptyLabel(group.groupDisplayName, group.groupWid),
        kind: 'group'
      });
    }
    return {
      scopeId: scope.scopeId,
      label: nonEmptyLabel(scope.name, scope.scopeId),
      chats: [...chats.values()].sort((left, right) => left.chatId.localeCompare(right.chatId))
    };
  }));
  scopes.sort((left, right) => left.scopeId.localeCompare(right.scopeId));

  const payloadSha256 = createHash('sha256')
    .update(workspaceConnectorCanonicalJson(scopes))
    .digest('hex');
  const current = scopeDirectoryStateSchema.safeParse(
    await context.dataStore.get(SCOPE_DIRECTORY_STATE_KEY)
  );
  if (current.success && current.data.payloadSha256 === payloadSha256) return false;

  const generation = (current.success ? current.data.generation : 0) + 1;
  const request: WorkspaceConnectorScopeDirectoryReplaceV2 = {
    protocolVersion: WORKSPACE_CONNECTOR_PROTOCOL_VERSION_V2,
    installationId,
    generation,
    payloadSha256,
    idempotencyKey: `scope-directory:${installationId}:${generation}:${payloadSha256}`,
    scopes
  };
  const receipt = await client.replaceScopeDirectoryV2(request);
  if (
    receipt.installationId !== installationId
    || receipt.acceptedGeneration !== generation
    || receipt.payloadSha256 !== payloadSha256
  ) {
    throw new Error('Workspace scope-directory receipt did not match the published generation.');
  }
  await context.dataStore.set(SCOPE_DIRECTORY_STATE_KEY, { generation, payloadSha256 });
  return true;
}

function nonEmptyLabel(label: string | undefined, fallback: string): string {
  const normalized = label?.trim();
  return normalized ? normalized.slice(0, 240) : fallback.slice(0, 240);
}
