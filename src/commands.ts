import { withMessageSlot } from './messageSlot';
import { createHash } from 'node:crypto';
import { workspaceClaims, workspaceScope, type WorkspaceAccess } from './ownership';
import type { StableIdentityAddressResolution } from '@wabs/plugin-sdk/identity';
import type { CommandMetadata } from '@wabs/plugin-sdk/command-metadata';
import type { CommandContext, CommandResult } from '@wabs/plugin-sdk/commands';
import {
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
import { requireScopeId } from '@wabs/plugin-sdk/commands';
import { WorkspaceConnectorClient } from './client';
import { parseWorkspaceConnectorConfig, workspaceConnectorConnection } from './config';
import {
  WORKSPACE_CONNECTOR_PLUGIN_ID,
  WORKSPACE_CONNECTOR_SESSION_TIMER_JOB
} from './manifest';
import { findWorkspaceMediaSession, rememberWorkspaceSession, rememberWorkspaceSessionV2 } from './mediaSessions';
import { deliverWorkspacePrivateChoice, markWorkspacePrivateChoiceCompleted,
  withWorkspacePrivateSessionLock, workspacePrivatePromptReceipt, WORKSPACE_PRIVATE_CHOICE_PURPOSE } from './privatePrompts';

type InvocationHost = WorkspaceAccess & Pick<PluginCommandContext,
  'config' | 'i18n' | 'dataStore' | 'flowEngine' | 'coveredGroupsForScope' | 'enqueuePluginJob'>;
type Invocation = Pick<CommandContext, 'locale' | 't' | 'scopeId' | 'groupWid' | 'signal'> & {
  actor: StableIdentityAddressResolution;
  message: Pick<CommandContext['message'], 'context' | 'id' | 'chatId' | 'senderDisplayName'>;
  args: string[];
};

export async function registerWorkspaceConnectorCommands(context: PluginCommandContext): Promise<void> {
  context.router.register('workspace', 'status', workspaceCommand('none'), async ctx => {
    const scoped = parseWorkspaceConnectorConfig(await context.configFor!(requireScopeId(ctx)));
    const connection = workspaceConnectorConnection(context.config);
    return { handled: true, text: ctx.t('official.integration-manager.status', {
      enabled: String(scoped.enabled), configured: String(Boolean(connection)), installation: connection?.installationId ?? ''
    }), ...withMessageSlot('official.integration-manager.status') };
  });
  const dispatch = async (ctx: CommandContext, command: string, owner?: string) => {
    if (!ctx.actor || !context.configFor || !command) return { handled: true, text: ctx.t('official.integration-manager.usage'), ...withMessageSlot('official.integration-manager.usage') };
    return dispatchWorkspaceCommand({ ...context, configFor: context.configFor }, {
      ...ctx, scopeId: requireScopeId(ctx), actor: requireStableIdentityAddress(ctx.actor),
      args: ctx.remainingArgs ?? ctx.command.args
    }, command, owner);
  };
  context.router.register('workspace', '*', workspaceCommand('durable'), ctx =>
    dispatch(ctx, ctx.command.subcommand?.toLowerCase() ?? ''));
  context.router.register('register', '*', { ...workspaceCommand('durable'),
    help: { ...workspaceCommand('durable').help!, usage: '/register' } }, ctx =>
    dispatch(ctx, 'register', WORKSPACE_CONNECTOR_PLUGIN_ID));
}

/** Both native app commands and /workspace resolve the same installed claim and fresh catalog. */
export async function dispatchWorkspaceCommand(
  context: InvocationHost, ctx: Invocation, command: string, caller?: string, requestedCapability?: string
): Promise<CommandResult> {
  const deny = () => ({ handled: true, text: ctx.t('official.integration-manager.unknownCapability'), ...withMessageSlot('official.integration-manager.unknownCapability') });
  const claim = workspaceClaims(context).find(entry => entry.commands?.includes('/' + command));
  if (!claim || (caller && claim.owner !== caller) || (requestedCapability && claim.capabilityId !== requestedCapability)) return deny();
  const connection = workspaceConnectorConnection(context.config);
  if (!connection) return { handled: true, text: ctx.t('official.integration-manager.unavailable'), ...withMessageSlot('official.integration-manager.unavailable') };
  const client = new WorkspaceConnectorClient(connection);
  try {
    const scope = await workspaceScope(context, requireScopeId(ctx), ctx.actor.identityId);
    if (!scope.allowedCapabilities.includes(claim.capabilityId)) return deny();
    const v2 = await client.catalogV2(ctx.signal).catch(() => undefined);
    if (v2) {
      assertV2CatalogDigest(v2);
      const alias = v2.aliases.find(item => item.namespace === command);
      if (alias) return alias.capabilityId === claim.capabilityId
        ? await invokeWorkspaceAliasV2(context, ctx, v2, alias, client) : deny();
    }
    const v1 = await client.catalog(ctx.signal);
    const alias = v1.aliases.find(item => item.namespace === command && item.capabilityId === claim.capabilityId);
    return alias ? await invokeWorkspaceAliasV1(context, ctx, v1, alias, client) : deny();
  } catch {
    return { handled: true, text: ctx.t('official.integration-manager.unavailable'), ...withMessageSlot('official.integration-manager.unavailable') };
  }
}

async function invokeWorkspaceAliasV1(
  context: InvocationHost,
  ctx: Invocation,
  catalog: WorkspaceConnectorCatalog,
  alias: WorkspaceConnectorCommandAlias,
  client: WorkspaceConnectorClient
) {
  const actor = ctx.actor;
  const connection = workspaceConnectorConnection(context.config);
  if (!connection) return { handled: true, text: ctx.t('official.integration-manager.unavailable'), ...withMessageSlot('official.integration-manager.unavailable') };
  const privateInvocation = ctx.message.context === 'private';
  if (!alias.contexts.includes(privateInvocation ? 'private' : 'group')) {
    return { handled: true, text: ctx.t('official.integration-manager.unknownCapability'), ...withMessageSlot('official.integration-manager.unknownCapability') };
  }
  const scopeId = privateInvocation ? `direct:${connection.installationId}` : requireScopeId(ctx);
  const scoped = await workspaceScope(context, requireScopeId(ctx), actor.identityId);
  if (!scoped.allowedCapabilities.includes(alias.capabilityId)) {
    return { handled: true, text: ctx.t('official.integration-manager.disabled'), ...withMessageSlot('official.integration-manager.disabled') };
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
    arguments: ctx.args
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
  context: InvocationHost,
  ctx: Invocation,
  catalog: WorkspaceConnectorCatalogV2,
  alias: WorkspaceConnectorCommandAliasV2,
  client: WorkspaceConnectorClient
) {
  return withWorkspacePrivateSessionLock(context, ctx.actor.identityId,
    () => invokeWorkspaceAliasV2Locked(context, ctx, catalog, alias, client));
}

async function invokeWorkspaceAliasV2Locked(
  context: InvocationHost,
  ctx: Invocation,
  catalog: WorkspaceConnectorCatalogV2,
  alias: WorkspaceConnectorCommandAliasV2,
  client: WorkspaceConnectorClient
) {
  const actor = ctx.actor;
  const connection = workspaceConnectorConnection(context.config);
  if (!connection) return { handled: true, text: ctx.t('official.integration-manager.unavailable'), ...withMessageSlot('official.integration-manager.unavailable') };
  const privateInvocation = ctx.message.context === 'private';
  if (!alias.contexts.includes(privateInvocation ? 'private' : 'group')) {
    return { handled: true, text: ctx.t('official.integration-manager.unknownCapability'), ...withMessageSlot('official.integration-manager.unknownCapability') };
  }
  const scopeId = requireScopeId(ctx);
  const scoped = await workspaceScope(context, scopeId, actor.identityId);
  if (!scoped.enabled || !scoped.allowedCapabilities.includes(alias.capabilityId)) {
    return { handled: true, text: ctx.t('official.integration-manager.disabled'), ...withMessageSlot('official.integration-manager.disabled') };
  }
  const groupWid = ctx.groupWid?.trim() || (privateInvocation ? '' : ctx.message.chatId);
  if (!groupWid.endsWith('@g.us')) {
    return { handled: true, text: ctx.t('official.integration-manager.scopeUnavailable'), ...withMessageSlot('official.integration-manager.scopeUnavailable') };
  }
  const origin = {
    chatId: ctx.message.chatId,
    surface: privateInvocation ? 'private' as const : 'group' as const
  };
  const scopeEvidence: WorkspaceConnectorScopeEvidenceV2 = privateInvocation
    ? {
        kind: 'private_resolution',
        scopeId,
        basis: alias.capabilityId === 'account.registration.v1' ? 'connector_binding' : 'managed_scope_membership',
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
    arguments: ctx.args
  }, ctx.signal);
  const route = {
    originChatId: origin.chatId,
    currentChatId: origin.chatId,
    scopeId,
    actorPrivateChatId: actor.deliveryChatId,
    actorMentionWid: actor.mentionWid,
    quotedMessageId: ctx.message.id
  };
  let promptAction: (typeof result.actions)[number] | undefined;
  if (result.session && context.dataStore) {
    const request = result.actions.find((action) => action.kind === 'request_media');
    const promptKey = `workspace-command-v2:${ctx.message.id}:${result.session.sessionId}`;
    if (privateInvocation && context.flowEngine && await workspacePrivatePromptReceipt(
      { dataStore: context.dataStore }, promptKey, actor.identityId, result.session.sessionId)) {
      // Re-delivery of the command must not replace a later prompt or reopen a completed one.
      return { handled: true, response: { kind: 'none' as const }, pluginActions: [] };
    }
    const previous = await findWorkspaceMediaSession(context.dataStore, actor.identityId);
    // A new command must not leave an old locked prompt consuming its replies.
    if (privateInvocation && previous?.schemaVersion === 2 && previous.privatePromptSubjectId && context.flowEngine) {
      await markWorkspacePrivateChoiceCompleted({ dataStore: context.dataStore }, previous);
      await context.flowEngine.cancelPromptBySubject({ purpose: WORKSPACE_PRIVATE_CHOICE_PURPOSE,
        subjectId: previous.privatePromptSubjectId, includeLocked: true });
    }
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
    if (privateInvocation && session && !request && context.flowEngine) {
      promptAction = result.actions.find(action => action.kind === 'choice')
        ?? (!session.timer ? result.actions.find(action => action.kind === 'reply') : undefined);
      if (promptAction?.kind === 'choice' || promptAction?.kind === 'reply') {
        const promptChatId = await resolveWorkspaceActionRouteV2(context, promptAction.route, route);
        if (promptChatId !== actor.deliveryChatId) throw new Error('Workspace private prompt left its bound conversation.');
        await deliverWorkspacePrivateChoice({ ...context, dataStore: context.dataStore }, session,
          promptAction.kind === 'choice' ? promptAction.prompt : promptAction.text,
          promptKey);
      }
    }
    if (session?.timer) {
      await scheduleWorkspaceSessionTimer(context, { ...session, timer: session.timer });
    }
  }
  const pluginActions = await workspaceActionsToPluginActionsV2(context,
    result.actions.filter(action => action !== promptAction), route);
  return {
    handled: true,
    response: { kind: 'none' as const },
    pluginActions
  };
}

function connectorActor(ctx: Invocation) {
  const actor = ctx.actor;
  return {
    identityId: actor.identityId,
    ...(actor.phoneNumber ? { verifiedWhatsappNumber: canonicalPhone(actor.phoneNumber) } : {}),
    ...(ctx.message.senderDisplayName ? { displayName: ctx.message.senderDisplayName } : {})
  };
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
  runtime: Pick<InvocationHost, 'enqueuePluginJob'>,
  session: { sessionId: string; scopeId: string; groupWid: string; actorIdentityId: string; timer: { timerId: string; fireAt: string } }
): Promise<void> {
  if (!runtime.enqueuePluginJob) throw new Error('Workspace job queue is unavailable.');
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
    throw new Error('Integration Manager v2 catalog digest did not match its canonical content.');
  }
}

function workspaceCommand(mutation: CommandMetadata['mutation']): CommandMetadata {
  return {
    plane: 'group_operation',
    interaction: mutation === 'none' ? 'group_same_chat' : 'either_same_chat',
    pluginId: WORKSPACE_CONNECTOR_PLUGIN_ID,
    ...(mutation === 'none' ? { requiredAccessPlane: 'group_member' as const } : {}),
    ...(mutation === 'durable' ? {
      requiresCurrentManagedGroupMembership: true, currentManagedGroupMembershipMode: 'effective_scope' as const,
      privateManagedTarget: { mode: 'infer_group_or_community' as const, collapseCommunities: true }
    } : {}),
    requiresManagedGroup: true,
    ...(mutation === 'none'
      ? { targets: [{ kind: 'scope' as const, flag: ['scope', 'scope-id'], fallback: 'current_scope' as const }] }
      : {}),
    mutation,
    auditAction: mutation === 'none' ? 'workspace-connector.status' : 'workspace-connector.invoke',
    help: {
      familyKey: 'official.integration-manager.help.family',
      featureId: 'workspace-connector',
      topicId: mutation === 'none' ? 'workspace-status' : 'workspace-invoke',
      descriptionKey: 'official.integration-manager.help.command',
      usage: mutation === 'none' ? '/workspace status' : '/workspace {capability} [...arguments]',
      exampleKeys: [mutation === 'none'
        ? 'official.integration-manager.help.status.example'
        : 'official.integration-manager.help.invoke.example']
    },
    assistant: {
      executable: true,
      requiresConfirmation: mutation !== 'none',
      intentTags: ['workspace']
    }
  };
}

