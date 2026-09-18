import { createHash } from 'node:crypto';
import type { CommandMetadata } from '@wabs/plugin-sdk/command-metadata';
import type { CommandContext } from '@wabs/plugin-sdk/commands';
import {
  WorkspaceConnectorCatalogSchema,
  WorkspaceConnectorCatalogV2Schema,
  workspaceConnectorCatalogDigestPreimage,
  type WorkspaceConnectorActionV2,
  type WorkspaceConnectorCatalog,
  type WorkspaceConnectorCatalogV2,
  type WorkspaceConnectorCommandAlias,
  type WorkspaceConnectorCommandAliasV2,
  type WorkspaceConnectorScopeEvidenceV2
} from './contracts/workspace-connector-v0.3';
import { requireStableIdentityAddress } from '@wabs/plugin-sdk/message-actor';
import type { PluginAction } from '@wabs/plugin-sdk/actions';
import type { PluginCommandContext } from './runtime';
import { requireIntegrationCommandContext as requireOfficialCommandRuntime } from '@wabs/plugin-sdk/integration-plugin';
import { requireScopeId } from '@wabs/plugin-sdk/commands';
import { WorkspaceConnectorClient } from './client';
import { parseWorkspaceConnectorConfig, workspaceConnectorConnection } from './config';
import {
  WORKSPACE_CONNECTOR_PLUGIN_ID,
  WORKSPACE_CONNECTOR_SESSION_TIMER_JOB
} from './manifest';
import { rememberWorkspaceSession, rememberWorkspaceSessionV2 } from './mediaSessions';

const CATALOG_CACHE_KEY = 'catalog:v1';
const CATALOG_V2_CACHE_KEY = 'catalog:v2';
const CATALOG_REFRESH_MS = 60_000;

interface CatalogSet {
  v1: WorkspaceConnectorCatalog;
  v2?: WorkspaceConnectorCatalogV2 | undefined;
}

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

  // The /workspace recovery namespace remains v1-compatible. Managed private
  // scope selection is deliberately attached to remote v2 aliases themselves.
  context.router.register('workspace', '*', workspaceCommand('durable'), async (ctx) => {
    const actor = requireActor(ctx);
    const connection = workspaceConnectorConnection(context.config);
    if (!connection) {
      return { handled: true, text: ctx.t('official.workspace-connector.unavailable') };
    }
    const privateInvocation = ctx.message.context === 'private';
    const scopeId = privateInvocation ? `direct:${connection.installationId}` : requireScopeId(ctx);
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
      const alias = catalog.aliases.find((candidate) =>
        candidate.namespace === requestedAlias
        && candidate.contexts.includes(privateInvocation ? 'private' : 'group')
      );
      if (!alias || (!privateInvocation && !scoped.allowedCapabilities.includes(alias.capabilityId))) {
        return { handled: true, text: ctx.t('official.workspace-connector.unknownCapability') };
      }
      return await invokeWorkspaceAliasV1(context, runtime, ctx, catalog, alias, client);
    } catch {
      return { handled: true, text: ctx.t('official.workspace-connector.unavailable') };
    }
  });

  const connection = workspaceConnectorConnection(context.config);
  if (!connection || !context.dataStore) return;
  const cachedV1 = WorkspaceConnectorCatalogSchema.safeParse(await context.dataStore.get(CATALOG_CACHE_KEY));
  const cachedV2 = WorkspaceConnectorCatalogV2Schema.safeParse(await context.dataStore.get(CATALOG_V2_CACHE_KEY));
  let installed: CatalogSet | undefined = cachedV1.success
    ? { v1: cachedV1.data, ...(cachedV2.success ? { v2: cachedV2.data } : {}) }
    : undefined;
  if (installed) await installCatalogAliases(context, runtime, installed);

  const refresh = async (): Promise<void> => {
    try {
      const client = new WorkspaceConnectorClient(connection);
      const v1 = await client.catalog();
      let v2 = installed?.v2;
      try {
        const candidate = await client.catalogV2();
        assertV2CatalogDigest(candidate);
        v2 = candidate;
      } catch {
        // v2 is additive. A deployment that has not exposed it yet retains the
        // last validated v2 catalog while calendar v1 continues normally.
      }
      installed = { v1, ...(v2 ? { v2 } : {}) };
      await installCatalogAliases(context, runtime, installed);
    } catch {
      // A remote outage retains the last atomically installed catalogs and the
      // /workspace recovery namespace.
    }
  };
  await refresh();
  const timer = setInterval(() => void refresh(), CATALOG_REFRESH_MS);
  timer.unref();
}

async function installCatalogAliases(
  context: PluginCommandContext,
  runtime: ReturnType<typeof requireOfficialCommandRuntime>,
  catalogs: CatalogSet
): Promise<void> {
  const v2Aliases = catalogs.v2?.aliases ?? [];
  const allNamespaces = [...catalogs.v1.aliases.map((alias) => alias.namespace), ...v2Aliases.map((alias) => alias.namespace)];
  if (allNamespaces.includes('workspace')) {
    throw new Error('The Workspace catalog cannot replace the /workspace recovery namespace.');
  }
  if (new Set(allNamespaces).size !== allNamespaces.length) {
    throw new Error('Workspace catalog versions cannot publish the same command namespace.');
  }
  context.router.replaceNamespaceAliasesAtomically(WORKSPACE_CONNECTOR_PLUGIN_ID, [
    ...catalogs.v1.aliases.map((alias) => ({
      namespace: alias.namespace,
      metadata: workspaceAliasCommandV1(alias),
      handler: async (ctx: CommandContext) => invokeCurrentAliasV1(context, runtime, ctx, alias.namespace)
    })),
    ...v2Aliases.map((alias) => ({
      namespace: alias.namespace,
      metadata: workspaceAliasCommandV2(alias),
      handler: async (ctx: CommandContext) => invokeCurrentAliasV2(context, runtime, ctx, alias.namespace)
    }))
  ]);
  await Promise.all([
    context.dataStore?.set(CATALOG_CACHE_KEY, catalogs.v1),
    ...(catalogs.v2 ? [context.dataStore?.set(CATALOG_V2_CACHE_KEY, catalogs.v2)] : [])
  ]);
}

async function invokeCurrentAliasV1(
  context: PluginCommandContext,
  runtime: ReturnType<typeof requireOfficialCommandRuntime>,
  ctx: CommandContext,
  namespace: string
) {
  const connection = workspaceConnectorConnection(context.config);
  if (!connection) return { handled: true, text: ctx.t('official.workspace-connector.unavailable') };
  try {
    const client = new WorkspaceConnectorClient(connection);
    const catalog = await client.catalog(ctx.signal);
    const alias = catalog.aliases.find((candidate) => candidate.namespace === namespace);
    return alias
      ? await invokeWorkspaceAliasV1(context, runtime, ctx, catalog, alias, client)
      : { handled: true, text: ctx.t('official.workspace-connector.unknownCapability') };
  } catch {
    return { handled: true, text: ctx.t('official.workspace-connector.unavailable') };
  }
}

async function invokeCurrentAliasV2(
  context: PluginCommandContext,
  runtime: ReturnType<typeof requireOfficialCommandRuntime>,
  ctx: CommandContext,
  namespace: string
) {
  const connection = workspaceConnectorConnection(context.config);
  if (!connection) return { handled: true, text: ctx.t('official.workspace-connector.unavailable') };
  try {
    const client = new WorkspaceConnectorClient(connection);
    const catalog = await client.catalogV2(ctx.signal);
    assertV2CatalogDigest(catalog);
    const alias = catalog.aliases.find((candidate) => candidate.namespace === namespace);
    return alias
      ? await invokeWorkspaceAliasV2(context, runtime, ctx, catalog, alias, client)
      : { handled: true, text: ctx.t('official.workspace-connector.unknownCapability') };
  } catch {
    return { handled: true, text: ctx.t('official.workspace-connector.unavailable') };
  }
}

async function invokeWorkspaceAliasV1(
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
  const scopeId = privateInvocation ? `direct:${connection.installationId}` : requireScopeId(ctx);
  const scoped = privateInvocation
    ? { enabled: true, allowedCapabilities: [] as string[] }
    : parseWorkspaceConnectorConfig(await runtime.configFor(scopeId, actor.identityId));
  if (!scoped.enabled || (!privateInvocation && !scoped.allowedCapabilities.includes(alias.capabilityId))) {
    return { handled: true, text: ctx.t('official.workspace-connector.disabled') };
  }
  const workspaceActor = connectorActor(ctx);
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

async function invokeWorkspaceAliasV2(
  context: PluginCommandContext,
  runtime: ReturnType<typeof requireOfficialCommandRuntime>,
  ctx: CommandContext,
  catalog: WorkspaceConnectorCatalogV2,
  alias: WorkspaceConnectorCommandAliasV2,
  client: WorkspaceConnectorClient
) {
  const actor = requireActor(ctx);
  const connection = workspaceConnectorConnection(context.config);
  if (!connection) return { handled: true, text: ctx.t('official.workspace-connector.unavailable') };
  const privateInvocation = ctx.message.context === 'private';
  if (!alias.contexts.includes(privateInvocation ? 'private' : 'group')) {
    return { handled: true, text: ctx.t('official.workspace-connector.unknownCapability') };
  }
  const scopeId = requireScopeId(ctx);
  const scoped = parseWorkspaceConnectorConfig(await runtime.configFor(scopeId, actor.identityId));
  if (!scoped.enabled || !scoped.allowedCapabilities.includes(alias.capabilityId)) {
    return { handled: true, text: ctx.t('official.workspace-connector.disabled') };
  }
  const groupWid = ctx.groupWid?.trim() || (privateInvocation ? '' : ctx.message.chatId);
  if (!groupWid.endsWith('@g.us')) {
    return { handled: true, text: ctx.t('official.workspace-connector.scopeUnavailable') };
  }
  const origin = {
    chatId: ctx.message.chatId,
    surface: privateInvocation ? 'private' as const : 'group' as const
  };
  const scopeEvidence: WorkspaceConnectorScopeEvidenceV2 = privateInvocation
    ? {
        kind: 'private_resolution',
        scopeId,
        basis: 'managed_scope_membership',
        checkedAt: new Date().toISOString()
      }
    : {
        kind: 'group_membership',
        scopeId,
        groupChatId: ctx.message.chatId,
        actorIsCurrentMember: true,
        checkedAt: new Date().toISOString()
      };
  const workspaceActor = connectorActor(ctx);
  const result = await client.invokeV2({
    protocolVersion: 2,
    installationId: connection.installationId,
    catalogRevision: catalog.revision,
    catalogDigestSha256: catalog.digestSha256,
    capabilityId: alias.capabilityId,
    scopeId,
    origin,
    current: origin,
    scopeEvidence,
    locale: ctx.locale,
    eventId: ctx.message.id,
    messageId: ctx.message.id,
    idempotencyKey: `whatsapp-v2:${ctx.message.id}:${alias.capabilityId}`,
    actor: workspaceActor,
    arguments: ctx.remainingArgs ?? ctx.command.args
  }, ctx.signal);
  const pluginActions = await workspaceActionsToPluginActionsV2(context, result.actions, {
    originChatId: origin.chatId,
    currentChatId: origin.chatId,
    scopeId,
    actorPrivateChatId: actor.deliveryChatId,
    actorMentionWid: actor.mentionWid,
    quotedMessageId: ctx.message.id
  });
  if (result.session && context.dataStore) {
    const request = result.actions.find((action) => action.kind === 'request_media');
    const mediaChatId = request
      ? await resolveWorkspaceActionRouteV2(context, request.route, {
          originChatId: origin.chatId,
          currentChatId: origin.chatId,
          scopeId,
          actorPrivateChatId: actor.deliveryChatId
        })
      : undefined;
    const session = await rememberWorkspaceSessionV2({
      store: context.dataStore,
      result,
      actorIdentityId: actor.identityId,
      actor: workspaceActor,
      actorPrivateChatId: actor.deliveryChatId,
      actorMentionWid: actor.mentionWid,
      scopeId,
      origin,
      groupWid,
      scopeEvidence,
      capabilityId: alias.capabilityId,
      catalogRevision: catalog.revision,
      catalogDigestSha256: catalog.digestSha256,
      authenticatedInteractiveCapabilityIds: catalog.capabilities
        .filter((capability) => capability.interfaces.includes('interactive'))
        .map((capability) => capability.capabilityId),
      scopeAllowedCapabilityIds: scoped.allowedCapabilities,
      locale: ctx.locale,
      ...(mediaChatId ? { mediaChatId } : {})
    });
    if (session?.timer) {
      await scheduleWorkspaceSessionTimer(runtime, { ...session, timer: session.timer });
    }
  }
  return {
    handled: true,
    response: { kind: 'none' as const },
    pluginActions
  };
}

function connectorActor(ctx: CommandContext) {
  const actor = requireActor(ctx);
  return {
    identityId: actor.identityId,
    ...(actor.phoneNumber ? { verifiedWhatsappNumber: canonicalPhone(actor.phoneNumber) } : {}),
    ...(ctx.message.senderDisplayName ? { displayName: ctx.message.senderDisplayName } : {})
  };
}

function requireActor(ctx: CommandContext) {
  if (!ctx.actor) throw new Error('Workspace requests require an authoritative actor identity.');
  return requireStableIdentityAddress(ctx.actor);
}

function canonicalPhone(phoneNumber: string): string {
  return phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
}

export function renderWorkspaceActions(actions: Array<
  | { kind: 'noop' }
  | { kind: 'reply' | 'complete' | 'denied'; text: string }
  | { kind: 'open_url'; text: string; url: string }
  | { kind: 'choice'; prompt: string; choices: Array<{ id: string; label: string }> }
  | { kind: 'request_media'; prompt: string }
>): string {
  return actions.map((action) => renderWorkspaceAction(action)).filter(Boolean).join('\n\n');
}

function renderWorkspaceAction(action:
  | { kind: 'noop' }
  | { kind: 'reply' | 'complete' | 'denied'; text: string }
  | { kind: 'open_url'; text: string; url: string }
  | { kind: 'choice'; prompt: string; choices: Array<{ id: string; label: string }> }
  | { kind: 'request_media'; prompt: string }
): string {
  switch (action.kind) {
    case 'noop':
      return '';
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
}

export async function workspaceActionsToPluginActionsV2(
  context: Pick<PluginCommandContext, 'coveredGroupsForScope'>,
  actions: WorkspaceConnectorActionV2[],
  routeContext: {
    originChatId: string;
    currentChatId: string;
    scopeId: string;
    actorPrivateChatId: string;
    actorMentionWid: string;
    quotedMessageId?: string | undefined;
  }
): Promise<PluginAction[]> {
  const resolved: PluginAction[] = [];
  for (const action of actions) {
    if (action.kind === 'noop') continue;
    const chatId = await resolveWorkspaceActionRouteV2(context, action.route, routeContext);
    const privateFallback = action.route.kind === 'actor_private'
      && action.route.fallback !== 'none'
      && routeContext.originChatId.endsWith('@g.us')
      ? {
          chatId: action.route.fallback === 'current'
            ? routeContext.currentChatId
            : routeContext.originChatId,
          mentionedWids: [routeContext.actorMentionWid]
        }
      : undefined;
    resolved.push({
      type: 'message.sendText',
      chatId,
      text: renderWorkspaceAction(action),
      ...(routeContext.quotedMessageId && chatId === routeContext.currentChatId
        ? { quotedMessageId: routeContext.quotedMessageId }
        : {}),
      ...(privateFallback ? { privateDeliveryFallback: privateFallback } : {})
    });
  }
  return resolved;
}

export async function resolveWorkspaceActionRouteV2(
  context: Pick<PluginCommandContext, 'coveredGroupsForScope'>,
  route: Exclude<WorkspaceConnectorActionV2, { kind: 'noop' }>['route'],
  input: {
    originChatId: string;
    currentChatId: string;
    scopeId: string;
    actorPrivateChatId: string;
  }
): Promise<string> {
  switch (route.kind) {
    case 'origin': return input.originChatId;
    case 'current': return input.currentChatId;
    case 'actor_private': return input.actorPrivateChatId;
    case 'scope_chat': {
      if (route.scopeId !== input.scopeId || !context.coveredGroupsForScope) {
        throw new Error('Workspace action requested an unbound scope chat.');
      }
      const covered = await context.coveredGroupsForScope(input.scopeId);
      if (!covered.some((group) => group.groupWid === route.chatId)) {
        throw new Error('Workspace action requested a chat outside the managed scope.');
      }
      return route.chatId;
    }
  }
}

async function scheduleWorkspaceSessionTimer(
  runtime: ReturnType<typeof requireOfficialCommandRuntime>,
  session: { sessionId: string; scopeId: string; groupWid: string; actorIdentityId: string; timer: { timerId: string; fireAt: string } }
): Promise<void> {
  await runtime.enqueuePluginJob({
    jobName: WORKSPACE_CONNECTOR_SESSION_TIMER_JOB,
    scopeId: session.scopeId,
    groupWid: session.groupWid,
    runAt: new Date(session.timer.fireAt),
    payload: {
      sessionId: session.sessionId,
      actorIdentityId: session.actorIdentityId,
      timerId: session.timer.timerId
    },
    dedupeKey: `${WORKSPACE_CONNECTOR_SESSION_TIMER_JOB}:${session.sessionId}:${session.timer.timerId}`
  });
}

export function assertV2CatalogDigest(catalog: WorkspaceConnectorCatalogV2): void {
  const digest = createHash('sha256').update(workspaceConnectorCatalogDigestPreimage(catalog)).digest('hex');
  if (digest !== catalog.digestSha256) {
    throw new Error('Workspace connector v2 catalog digest did not match its canonical content.');
  }
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

function workspaceAliasCommandV1(alias: WorkspaceConnectorCommandAlias): CommandMetadata {
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

function workspaceAliasCommandV2(alias: WorkspaceConnectorCommandAliasV2): CommandMetadata {
  const supportsPrivate = alias.contexts.includes('private');
  return {
    plane: 'group_operation',
    interaction: supportsPrivate ? 'either_same_chat' : 'group_same_chat',
    pluginId: WORKSPACE_CONNECTOR_PLUGIN_ID,
    requiresManagedGroup: true,
    requiresCurrentManagedGroupMembership: true,
    currentManagedGroupMembershipMode: 'effective_scope',
    ...(supportsPrivate ? {
      privateManagedTarget: {
        mode: 'infer_group_or_community' as const,
        qualifyWithCommunity: true
      }
    } : {}),
    mutation: 'durable',
    auditAction: 'workspace-connector.invoke',
    help: {
      familyKey: 'official.workspace-connector.help.family',
      featureId: 'workspace-connector',
      descriptionKey: 'official.workspace-connector.help.command',
      usage: localizedCatalogValue(alias.usageByLocale),
      keywords: [alias.namespace]
    },
    assistant: {
      executable: true,
      requiresConfirmation: true,
      intentTags: [alias.namespace]
    }
  };
}

function localizedCatalogValue(values: Record<string, string>): string {
  return values.en ?? values['pt-PT'] ?? Object.values(values)[0] ?? '';
}
