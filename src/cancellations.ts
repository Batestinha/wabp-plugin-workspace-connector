import type {
  PluginCancellationRegistration,
  PluginCommandContext
} from '../../../platform/pluginRuntime/types';
import { WorkspaceConnectorClient } from './client';
import { renderWorkspaceActions } from './commands';
import { workspaceConnectorConnection } from './config';
import {
  findWorkspaceMediaSession,
  forgetWorkspaceMediaSession,
  workspaceSessionContinuationCapabilityId
} from './mediaSessions';
import {
  deleteWorkspaceMediaRetry,
  workspaceMediaRetriesForSession
} from './mediaRetries';

type WorkspaceCancellationClient = Pick<WorkspaceConnectorClient, 'continueSessionV2'>;

export function registerWorkspaceConnectorCancellations(
  context: PluginCommandContext,
  clientFactory: (connection: ConstructorParameters<typeof WorkspaceConnectorClient>[0]) => WorkspaceCancellationClient =
    (connection) => new WorkspaceConnectorClient(connection)
): PluginCancellationRegistration[] {
  return [{
    workflowId: 'workspace-remote-session',
    async cancel(input) {
      if (!context.dataStore) return undefined;
      const session = await findWorkspaceMediaSession(
        context.dataStore,
        input.actorIdentityId,
        input.message.chatId
      );
      if (!session || session.schemaVersion !== 2) return undefined;
      const t = await context.i18n.translatorForIdentity(input.actorIdentityId, session.scopeId);
      const connection = workspaceConnectorConnection(context.config);
      if (!connection) {
        return {
          workflowId: 'workspace-remote-session',
          cancelled: false,
          text: t('official.workspace-connector.cancelFailed'),
          reason: 'connection-unavailable'
        };
      }
      try {
        const result = await clientFactory(connection).continueSessionV2({
          protocolVersion: 2,
          installationId: connection.installationId,
          catalogRevision: session.catalogRevision,
          catalogDigestSha256: session.catalogDigestSha256,
          sessionId: session.sessionId,
          capabilityId: workspaceSessionContinuationCapabilityId(session),
          scopeId: session.scopeId,
          origin: session.origin,
          current: {
            chatId: input.message.chatId,
            surface: input.message.context
          },
          scopeEvidence: session.scopeEvidence,
          locale: session.locale,
          eventId: input.message.id,
          idempotencyKey: `whatsapp-cancel-v2:${session.sessionId}:${input.message.id}`,
          actor: session.actor,
          input: { kind: 'cancel', reason: 'user' }
        });
        if (result.session) {
          return {
            workflowId: 'workspace-remote-session',
            cancelled: false,
            text: t('official.workspace-connector.cancelFailed'),
            reason: 'remote-session-remained-active'
          };
        }
        const retries = await workspaceMediaRetriesForSession(context.dataStore, session.sessionId);
        await Promise.all([
          forgetWorkspaceMediaSession(context.dataStore, session),
          ...retries.map(async (retry) => {
            await Promise.all([
              deleteWorkspaceMediaRetry(context.dataStore!, retry),
              context.mediaStore?.delete(retry.mediaId).catch(() => undefined)
            ]);
          })
        ]);
        return {
          workflowId: 'workspace-remote-session',
          cancelled: true,
          text: renderWorkspaceActions(result.actions) || t('official.workspace-connector.cancelled')
        };
      } catch {
        return {
          workflowId: 'workspace-remote-session',
          cancelled: false,
          text: t('official.workspace-connector.cancelFailed'),
          reason: 'remote-cancellation-failed'
        };
      }
    }
  }];
}
