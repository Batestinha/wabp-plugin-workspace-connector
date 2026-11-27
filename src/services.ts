import { z } from 'zod';
import type { PluginServiceRegistration } from '@wabs/plugin-sdk/services';
import type { PluginServiceRegistrationContext } from './runtime';
import { WorkspaceConnectorClient } from './client';
import { dispatchWorkspaceCommand } from './commands';
import { workspaceConnectorConnection } from './config';
import { workspaceScope } from './ownership';
import { scopeMemberIdentityIds } from './scopeMembershipDirectory';
import {
  INVOCATION_SERVICE_ID, LEGACY_PROJECTION_SERVICE_ID, invocationInput,
  MESSAGE_LINK_SERVICE_ID, messageLinkInput, messageLinkOutput,
  WORKSPACE_CONNECTOR_PROJECTION_SERVICE_ID, workspaceConnectorProjectionServiceInputSchema,
  workspaceConnectorProjectionServiceOutputSchema
} from './serviceApi';

export function registerWorkspaceConnectorServices(context: PluginServiceRegistrationContext): PluginServiceRegistration[] {
  let linkClient: WorkspaceConnectorClient | undefined;
  const messageLinks: PluginServiceRegistration = {
    serviceId: MESSAGE_LINK_SERVICE_ID,
    methods: [{
      name: 'resolve', access: 'read', inputSchema: messageLinkInput, outputSchema: messageLinkOutput, timeoutMs: 4000,
      async handler(raw, call) {
        const link = messageLinkInput.parse(raw);
        const scope = await workspaceScope(context, call.scopeId);
        const calendar = link.target === 'calendarPage';
        const owner = calendar ? 'official.workspace-calendar' : 'official.chat-archive';
        const capability = calendar ? 'calendar.feed.replace.v1' : 'chatarchive.web.read.v1';
        if (!scope.grants.some(grant => grant.owner === owner && grant.capabilityId === capability)) return { url: null };
        if (!calendar && (await context.catalog?.configFor(owner, call.scopeId))?.browserLinks !== true) return { url: null };
        if (!linkClient) {
          const connection = workspaceConnectorConnection(context.config);
          if (!connection) return { url: null };
          linkClient = new WorkspaceConnectorClient(connection);
        }
        return linkClient.messageLink(call.scopeId, link, call.signal);
      }
    }]
  };
  const projections: PluginServiceRegistration[] = [WORKSPACE_CONNECTOR_PROJECTION_SERVICE_ID, LEGACY_PROJECTION_SERVICE_ID]
    .map(serviceId => ({
      serviceId, methods: [{
        name: 'replace', access: 'mutation', inputSchema: workspaceConnectorProjectionServiceInputSchema,
        outputSchema: workspaceConnectorProjectionServiceOutputSchema, timeoutMs: 30_000,
        async handler(raw, call) {
          const input = workspaceConnectorProjectionServiceInputSchema.parse(raw);
          const scope = await workspaceScope(context, call.scopeId, call.actorIdentityId);
          const owner = scope.grants.find(grant => grant.capabilityId === input.capabilityId)?.owner;
          const legacy = serviceId === LEGACY_PROJECTION_SERVICE_ID;
          if (!owner || (legacy ? !(call.callerPluginId === 'official.community-events' &&
            owner === 'official.workspace-calendar' && input.capabilityId === 'calendar.feed.replace.v1') :
            owner !== call.callerPluginId)) throw new Error('Workspace projection is unavailable for the caller and scope.');
          const connection = workspaceConnectorConnection(context.config);
          if (!connection) throw new Error('Integration Manager is not configured.');
          const client = new WorkspaceConnectorClient(connection);
          const remote = await client.catalog(call.signal);
          if (!remote.capabilities.some(cap => cap.capabilityId === input.capabilityId && cap.kind === 'projection')) {
            throw new Error('Workspace catalog does not offer this projection.');
          }
          return client.replaceProjection({
            protocolVersion: 1, installationId: connection.installationId, scopeId: call.scopeId, ...input
          }, call.signal);
        }
      }]
    }));
  const calendarSubscriptions: PluginServiceRegistration = {
    serviceId: 'official.integration-manager.calendar-subscriptions.v1',
    methods: [{
      name: 'read', access: 'read', inputSchema: z.object({}).strict(),
      outputSchema: z.object({ choice: z.enum(['on', 'off']).nullable(), manageUrl: z.string().url() }).strict().nullable(),
      async handler(_, call) {
        if (call.callerPluginId !== 'official.workspace-calendar' || !call.actorIdentityId) return null;
        const scope = await workspaceScope(context, call.scopeId, call.actorIdentityId);
        if (!scope.grants.some(g => g.owner === call.callerPluginId && g.capabilityId === 'calendar.subscription.status.v1')) return null;
        const connection = workspaceConnectorConnection(context.config);
        if (!connection) return null;
        linkClient ??= new WorkspaceConnectorClient(connection);
        return linkClient.calendarSubscription(call.scopeId, call.actorIdentityId, call.signal);
      }
    }]
  };
  return [...projections, messageLinks, calendarSubscriptions, {
    serviceId: INVOCATION_SERVICE_ID, methods: [{
      name: 'invoke', access: 'mutation', inputSchema: invocationInput,
      outputSchema: z.object({ handled: z.boolean() }).passthrough(), timeoutMs: 30_000,
      async handler(raw, call) {
        const input = invocationInput.parse(raw);
        const actor = call.actorIdentityId && await context.resolveStableIdentityById?.(call.actorIdentityId);
        if (!actor || actor.identityId !== call.actorIdentityId || !context.i18n) throw new Error('Workspace actor unavailable.');
        const groups = await context.coveredGroupsForScope?.(call.scopeId);
        const groupWid = call.groupWid ?? (input.surface === 'group' ? input.chatId : undefined);
        if (!groups?.some(group => group.groupWid === groupWid) ||
          (input.surface === 'group' ? input.chatId !== groupWid : input.chatId !== actor.deliveryChatId) ||
          !(await scopeMemberIdentityIds(context, call.scopeId))?.includes(actor.identityId)) {
          throw new Error('Workspace command is outside the effective scope.');
        }
        const { locale } = await context.i18n.resolveIdentityLocale(actor.identityId, call.scopeId);
        return dispatchWorkspaceCommand({ ...context, i18n: context.i18n }, {
          message: { context: input.surface, id: input.messageId, chatId: input.chatId, senderDisplayName: actor.displayName },
          actor, args: input.args, scopeId: call.scopeId, groupWid, locale,
          t: await context.i18n.translatorForIdentity(actor.identityId, call.scopeId), signal: call.signal
        }, input.command, call.callerPluginId, input.capabilityId);
      }
    }]
  }];
}
