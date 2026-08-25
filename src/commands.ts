import type { CommandMetadata } from '../../../adminBot/router/commandMetadata';
import type { CommandContext } from '../../../adminBot/router/commandRouter';
import {
  WorkspaceConnectorCatalogSchema,
  type WorkspaceConnectorCatalog,
  type WorkspaceConnectorCommandAlias
} from '../../../../packages/workspace-connector-contracts/src';
import { requireStableIdentityAddress } from '../../../platform/identity/messageActor';
import type { PluginCommandContext } from '../../../platform/pluginRuntime/types';
import { requireOfficialCommandRuntime, requireScopeId } from '../shared';
import { WorkspaceConnectorClient } from './client';
import { parseWorkspaceConnectorConfig, workspaceConnectorConnection } from './config';
import { WORKSPACE_CONNECTOR_PLUGIN_ID } from './manifest';
import { rememberWorkspaceSession } from './mediaSessions';

const CATALOG_CACHE_KEY = 'catalog:v1';
const CATALOG_REFRESH_MS = 60_000;

export async function registerWorkspaceConnectorCommands(context: PluginCommandContext): Promise<void> {
  const runtime = requireOfficialCommandRuntime(context);
  context.router.register('workspace', 'status', workspaceCommand('none'), async (ctx) => {
    const scopeId = requireScopeId(ctx);
    const actorIdentityId = requireActor(ctx).identityId;
    const scoped = parseWorkspaceConnectorConfig(await runtime.configFor(scopeId, actorIdentityId));
    const connection = workspaceConnectorConnection(context.config);
    return {
      handled: true,
      text: ctx.t('official.workspace-connector.status', {
        enabled: String(scoped.enabled),
        configured: String(Boolean(connection)),
        installation: connection?.installationId ?? ''
      })
    };
  });

  context.router.register('workspace', '*', workspaceCommand('durable'), async (ctx) => {
    const actor = requireActor(ctx);
    const connection = workspaceConnectorConnection(context.config);
    if (!connection) {
      return { handled: true, text: ctx.t('official.workspace-connector.unavailable') };
    }
    const privateInvocation = ctx.message.context === 'private';
    const scopeId = privateInvocation
      ? `direct:${connection.installationId}`
      : requireScopeId(ctx);
    const scoped = privateInvocation
      ? { enabled: true, allowedCapabilities: [] as string[] }
      : parseWorkspaceConnectorConfig(await runtime.configFor(scopeId, actor.identityId));
    if (!scoped.enabled) {
      return { handled: true, text: ctx.t('official.workspace-connector.disabled') };
    }
    const requestedAlias = ctx.command.subcommand?.trim().toLowerCase();
    if (!requestedAlias) {
      return { handled: true, text: ctx.t('official.workspace-connector.usage') };
    }
    try {
      const client = new WorkspaceConnectorClient(connection);
      const catalog = await client.catalog(ctx.signal);
      await installCatalogAliases(context, runtime, catalog);
      const alias = catalog.aliases.find((candidate) =>
        candidate.namespace === requestedAlias && candidate.contexts.includes(privateInvocation ? 'private' : 'group')
      );
      if (!alias || (!privateInvocation && !scoped.allowedCapabilities.includes(alias.capabilityId))) {
        return { handled: true, text: ctx.t('official.workspace-connector.unknownCapability') };
      }
      return invokeWorkspaceAlias(context, runtime, ctx, catalog, alias, client);
    } catch {
      return { handled: true, text: ctx.t('official.workspace-connector.unavailable') };
    }
  });

  const connection = workspaceConnectorConnection(context.config);
  if (!connection) return;
  if (
    !context.dataStore
    || typeof context.dataStore.get !== 'function'
    || typeof context.dataStore.set !== 'function'
  ) return;
  const cached = WorkspaceConnectorCatalogSchema.safeParse(
    await context.dataStore.get(CATALOG_CACHE_KEY)
  );
  if (cached.success) {
    await installCatalogAliases(context, runtime, cached.data);
  }
  const refresh = async (): Promise<void> => {
    try {
      const catalog = await new WorkspaceConnectorClient(connection).catalog();
      await installCatalogAliases(context, runtime, catalog);
    } catch {
      // A remote outage retains the last atomically installed catalog and the
      // /workspace recovery namespace. Invocation remains remotely authorized.
    }
  };
  await refresh();
  const timer = setInterval(() => void refresh(), CATALOG_REFRESH_MS);
  timer.unref();
}

async function installCatalogAliases(
  context: PluginCommandContext,
  runtime: ReturnType<typeof requireOfficialCommandRuntime>,
  catalog: WorkspaceConnectorCatalog
): Promise<void> {
  if (catalog.aliases.some((alias) => alias.namespace === 'workspace')) {
    throw new Error('The Workspace catalog cannot replace the /workspace recovery namespace.');
  }
  context.router.replaceNamespaceAliasesAtomically(
    WORKSPACE_CONNECTOR_PLUGIN_ID,
    catalog.aliases.map((alias) => ({
      namespace: alias.namespace,
      metadata: workspaceAliasCommand(alias),
      handler: async (ctx: CommandContext) => {
        const connection = workspaceConnectorConnection(context.config);
        if (!connection) {
          return { handled: true, text: ctx.t('official.workspace-connector.unavailable') };
        }
        try {
          const client = new WorkspaceConnectorClient(connection);
          const current = await client.catalog(ctx.signal);
          const currentAlias = current.aliases.find((candidate) =>
            candidate.namespace === alias.namespace
          );
          if (!currentAlias) {
            await installCatalogAliases(context, runtime, current);
            return { handled: true, text: ctx.t('official.workspace-connector.unknownCapability') };
          }
          await installCatalogAliases(context, runtime, current);
          return invokeWorkspaceAlias(context, runtime, ctx, current, currentAlias, client);
        } catch {
          return { handled: true, text: ctx.t('official.workspace-connector.unavailable') };
        }
      }
    }))
  );
  await context.dataStore?.set(CATALOG_CACHE_KEY, catalog);
}

async function invokeWorkspaceAlias(
  context: PluginCommandContext,
  runtime: ReturnType<typeof requireOfficialCommandRuntime>,
  ctx: CommandContext,
  catalog: WorkspaceConnectorCatalog,
  alias: WorkspaceConnectorCommandAlias,
  client: WorkspaceConnectorClient
) {
  const actor = requireActor(ctx);
  const connection = workspaceConnectorConnection(context.config);
  if (!connection) return { handled: true, text: ctx.t('official.workspace-connector.unavailable') };
  const privateInvocation = ctx.message.context === 'private';
  if (!alias.contexts.includes(privateInvocation ? 'private' : 'group')) {
    return { handled: true, text: ctx.t('official.workspace-connector.unknownCapability') };
  }
  const scopeId = privateInvocation
    ? `direct:${connection.installationId}`
    : requireScopeId(ctx);
  const scoped = privateInvocation
    ? { enabled: true, allowedCapabilities: [] as string[] }
    : parseWorkspaceConnectorConfig(await runtime.configFor(scopeId, actor.identityId));
  if (!scoped.enabled || (!privateInvocation && !scoped.allowedCapabilities.includes(alias.capabilityId))) {
    return { handled: true, text: ctx.t('official.workspace-connector.disabled') };
  }
  const workspaceActor = {
    identityId: actor.identityId,
    ...(actor.phoneNumber ? { verifiedWhatsappNumber: canonicalPhone(actor.phoneNumber) } : {}),
    ...(ctx.message.senderDisplayName ? { displayName: ctx.message.senderDisplayName } : {})
  };
  const surface = privateInvocation ? 'private' as const : 'group' as const;
  const result = await client.invoke({
    protocolVersion: 1,
    installationId: connection.installationId,
    catalogRevision: catalog.revision,
    catalogDigestSha256: catalog.digestSha256,
    capabilityId: alias.capabilityId,
    scopeId,
    chatId: ctx.message.chatId,
    surface,
    locale: ctx.locale,
    eventId: ctx.message.id,
    messageId: ctx.message.id,
    idempotencyKey: `whatsapp:${ctx.message.id}:${alias.capabilityId}`,
    actor: workspaceActor,
    arguments: ctx.remainingArgs ?? ctx.command.args
  }, ctx.signal);
  if (result.sessionId && context.dataStore) {
    await rememberWorkspaceSession({
      store: context.dataStore,
      result,
      actorIdentityId: actor.identityId,
      actor: workspaceActor,
      scopeId,
      chatId: ctx.message.chatId,
      groupWid: ctx.message.chatId,
      capabilityId: alias.capabilityId,
      catalogRevision: catalog.revision,
      catalogDigestSha256: catalog.digestSha256,
      surface,
      locale: ctx.locale
    });
  }
  return { handled: true, text: renderWorkspaceActions(result.actions) };
}

function requireActor(ctx: CommandContext) {
  if (!ctx.actor) throw new Error('Workspace requests require an authoritative actor identity.');
  return requireStableIdentityAddress(ctx.actor);
}

function canonicalPhone(phoneNumber: string): string {
  return phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
}

export function renderWorkspaceActions(actions: Array<
  | { kind: 'reply' | 'complete' | 'denied'; text: string }
  | { kind: 'open_url'; text: string; url: string }
  | { kind: 'choice'; prompt: string; choices: Array<{ id: string; label: string }> }
  | { kind: 'request_media'; prompt: string }
>): string {
  return actions.map((action) => {
    switch (action.kind) {
      case 'reply':
      case 'complete':
      case 'denied':
        return action.text;
      case 'open_url':
        return `${action.text}\n${action.url}`;
      case 'choice':
        return [action.prompt, ...action.choices.map((choice, index) => `${index + 1}. ${choice.label}`)].join('\n');
      case 'request_media':
        return action.prompt;
    }
  }).join('\n\n');
}

function workspaceCommand(mutation: CommandMetadata['mutation']): CommandMetadata {
  return {
    plane: 'group_operation',
    interaction: mutation === 'none' ? 'group_same_chat' : 'either_same_chat',
    pluginId: WORKSPACE_CONNECTOR_PLUGIN_ID,
    ...(mutation === 'none' ? { requiredAccessPlane: 'group_member' as const } : {}),
    ...(mutation === 'durable' ? { privateScopeAuthorization: 'handler' as const } : {}),
    requiresManagedGroup: true,
    ...(mutation === 'none'
      ? { targets: [{ kind: 'scope' as const, flag: ['scope', 'scope-id'], fallback: 'current_scope' as const }] }
      : {}),
    mutation,
    auditAction: mutation === 'none' ? 'workspace-connector.status' : 'workspace-connector.invoke',
    help: {
      familyKey: 'official.workspace-connector.help.family',
      featureId: 'workspace-connector',
      topicId: mutation === 'none' ? 'workspace-status' : 'workspace-invoke',
      descriptionKey: 'official.workspace-connector.help.command',
      usage: mutation === 'none' ? '/workspace status' : '/workspace {capability} [...arguments]',
      exampleKeys: [mutation === 'none'
        ? 'official.workspace-connector.help.status.example'
        : 'official.workspace-connector.help.invoke.example']
    },
    assistant: {
      executable: true,
      requiresConfirmation: mutation !== 'none',
      intentTags: ['workspace']
    }
  };
}

function workspaceAliasCommand(alias: WorkspaceConnectorCommandAlias): CommandMetadata {
  return {
    ...workspaceCommand('durable'),
    help: {
      familyKey: 'official.workspace-connector.help.family',
      featureId: 'workspace-connector',
      descriptionKey: 'official.workspace-connector.help.command',
      usage: `/${alias.namespace} [...arguments]`
    }
  };
}
