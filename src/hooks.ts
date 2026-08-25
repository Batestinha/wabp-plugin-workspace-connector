import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type {
  WorkspaceConnectorAction,
  WorkspaceConnectorDelivery,
  WorkspaceConnectorDeliveryAck
} from '../../../../packages/workspace-connector-contracts/src';
import type { PluginAction } from '../../../platform/pluginRuntime/runtime/pluginActionTypes';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import type { PluginMessageEvent, PluginRuntimeHooks } from '../../../platform/pluginRuntime/types';
import { WorkspaceConnectorClient } from './client';
import { renderWorkspaceActions } from './commands';
import { parseWorkspaceConnectorConfig, workspaceConnectorConnection } from './config';
import {
  findWorkspaceMediaSession,
  forgetWorkspaceMediaSession,
  refreshWorkspaceSessionActions,
  rememberWorkspaceSession,
  reserveWorkspaceMediaFile,
  type StoredWorkspaceMediaSession
} from './mediaSessions';
import {
  deleteWorkspaceMediaRetry,
  dueWorkspaceMediaRetries,
  newWorkspaceMediaRetry,
  rescheduleWorkspaceMediaRetry,
  storeWorkspaceMediaRetry,
  type WorkspaceMediaRetry
} from './mediaRetries';

const DELIVERY_POLL_INTERVAL_MS = 15_000;

type WorkspaceSessionClient = Pick<
  WorkspaceConnectorClient,
  'continueSession' | 'requestMediaGrant' | 'uploadGrantedMedia'
>;

export function createWorkspaceConnectorHooks(context: PluginRuntimeContext): PluginRuntimeHooks {
  const connection = workspaceConnectorConnection(context.config);
  if (!connection) return {};
  const client = new WorkspaceConnectorClient(connection);
  let polling = false;
  let stopped = false;

  const poll = async (): Promise<void> => {
    if (polling || stopped) return;
    polling = true;
    try {
      const deliveries = await client.claimDeliveries(20);
      for (const delivery of deliveries) {
        const acknowledgement = await deliverWorkspaceDelivery(context, delivery);
        await client.acknowledgeDelivery(acknowledgement).catch((error) => {
          context.logger.warn({ error, deliveryId: delivery.deliveryId }, 'Workspace delivery acknowledgement failed');
        });
      }
      await retryStagedMedia(context, client, connection.installationId);
    } catch (error) {
      context.logger.warn({ error }, 'Workspace delivery poll failed');
    } finally {
      polling = false;
    }
  };

  void poll();
  const timer = setInterval(() => void poll(), DELIVERY_POLL_INTERVAL_MS);
  timer.unref();

  return {
    async resolvePrivateMessageRoute(envelope) {
      const session = await findWorkspaceMediaSession(context.dataStore, envelope.actorIdentityId);
      if (!session) return;
      if (session.surface === 'private') {
        return {
          scopeId: session.scopeId as `direct:${string}`,
          privateChatId: session.originatingChatId
        };
      }
      return { scopeId: session.scopeId, groupWid: session.groupWid };
    },
    async onMessage(event) {
      return handleWorkspaceSessionMessage(context, client, connection.installationId, event);
    },
    onShutdown() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

export async function handleWorkspaceSessionMessage(
  context: PluginRuntimeContext,
  client: WorkspaceSessionClient,
  installationId: string,
  event: PluginMessageEvent
): Promise<PluginAction[] | void> {
  if (event.message.fromMe || event.isCommandLike) return;
  const session = await findWorkspaceMediaSession(
    context.dataStore,
    event.actorIdentityId,
    event.message.chatId
  );
  if (!session) return;
  if (event.message.hasMedia) {
    return handleMediaMessage(context, client, installationId, event, session);
  }
  const body = event.message.body.trim();
  if (!body || (session.acceptedMimeTypes && session.choices.length === 0)) return;
  const choiceId = session.choices.length > 0
    ? resolveWorkspaceChoice(session.choices, body)
    : undefined;
  if (session.choices.length > 0 && !choiceId) {
    return [await reply(context, event, 'official.workspace-connector.invalidChoice')];
  }
  try {
    const result = await client.continueSession({
      protocolVersion: 1,
      installationId,
      catalogRevision: session.catalogRevision,
      catalogDigestSha256: session.catalogDigestSha256,
      sessionId: session.sessionId,
      capabilityId: session.capabilityId,
      scopeId: session.scopeId,
      chatId: session.originatingChatId,
      surface: session.surface,
      locale: session.locale,
      eventId: event.message.id,
      idempotencyKey: `whatsapp-session:${event.message.id}:${session.sessionId}`,
      actor: session.actor,
      input: choiceId
        ? { kind: 'choice', choiceId }
        : { kind: 'text', text: body }
    });
    if (result.sessionId) {
      await rememberWorkspaceSession({
        store: context.dataStore,
        result,
        actorIdentityId: session.actorIdentityId,
        actor: session.actor,
        scopeId: session.scopeId,
        chatId: session.originatingChatId,
        groupWid: session.groupWid,
        capabilityId: session.capabilityId,
        catalogRevision: session.catalogRevision,
        catalogDigestSha256: session.catalogDigestSha256,
        surface: session.surface,
        locale: session.locale,
        previousSession: session
      });
    } else {
      await forgetWorkspaceMediaSession(context.dataStore, session);
    }
    return [workspaceActionReply(event, result.actions)];
  } catch (error) {
    context.logger.warn({ error, sessionId: session.sessionId }, 'Workspace session continuation failed');
    return [await reply(context, event, 'official.workspace-connector.unavailable')];
  }
}

export async function deliverWorkspaceDelivery(
  context: Pick<
    PluginRuntimeContext,
    'configFor' | 'resolveStableIdentityById' | 'sendText'
  >,
  delivery: WorkspaceConnectorDelivery,
  now = new Date()
): Promise<WorkspaceConnectorDeliveryAck> {
  if (new Date(delivery.expiresAt).getTime() <= now.getTime()) {
    return ack(delivery.deliveryId, 'terminal_failure', undefined, 'delivery.expired');
  }
  if (!context.sendText) {
    return ack(delivery.deliveryId, 'terminal_failure', undefined, 'delivery.channel_unavailable');
  }
  try {
    let chatId: string;
    if (delivery.target.kind === 'identity') {
      if (!context.resolveStableIdentityById) {
        return ack(delivery.deliveryId, 'terminal_failure', undefined, 'identity.unavailable');
      }
      chatId = (await context.resolveStableIdentityById(delivery.target.identityId)).deliveryChatId;
    } else {
      const scoped = parseWorkspaceConnectorConfig(await context.configFor(delivery.target.scopeId));
      if (!scoped.enabled || !scoped.deliveryChatId) {
        return ack(delivery.deliveryId, 'terminal_failure', undefined, 'scope.unavailable');
      }
      chatId = scoped.deliveryChatId;
    }
    const text = delivery.action.kind === 'open_url'
      ? `${delivery.action.text}\n${delivery.action.url}`
      : delivery.action.text;
    const sent = await context.sendText(chatId, text, {
      idempotencyKey: `workspace:${delivery.idempotencyKey}`,
      notAfter: new Date(delivery.expiresAt),
      waitForServerAck: true
    });
    return ack(delivery.deliveryId, 'delivered', sent.messageId);
  } catch {
    return ack(delivery.deliveryId, 'retryable_failure', undefined, 'whatsapp.send_failed');
  }
}

async function handleMediaMessage(
  context: PluginRuntimeContext,
  client: WorkspaceSessionClient,
  installationId: string,
  event: PluginMessageEvent,
  session: StoredWorkspaceMediaSession
): Promise<PluginAction[] | void> {
  if (
    !context.mediaStore
    || !session.acceptedMimeTypes
    || !session.maximumFileBytes
    || !session.maximumFiles
  ) return;
  const declaredMimeType = (event.message.media?.mimeType ?? event.message.mediaMimeType ?? '').toLowerCase();
  if (!mimeAccepted(declaredMimeType, session.acceptedMimeTypes)) {
    return [await reply(context, event, 'official.workspace-connector.mediaRejected')];
  }
  const declaredBytes = event.message.media?.sizeBytes;
  if (declaredBytes !== undefined && declaredBytes > session.maximumFileBytes) {
    return [await reply(context, event, 'official.workspace-connector.mediaTooLarge')];
  }
  const staged = await context.mediaStore.stageMessage(event.message.id, {
    fallbackFilename: event.message.media?.filename ?? 'workspace-media.bin',
    maxBytes: session.maximumFileBytes
  });
  if (!staged.ok) {
    return [await reply(
      context,
      event,
      staged.reason === 'too-large'
        ? 'official.workspace-connector.mediaTooLarge'
        : 'official.workspace-connector.mediaUnavailable'
    )];
  }
  if (!mimeAccepted(staged.media.mimeType.toLowerCase(), session.acceptedMimeTypes)) {
    await context.mediaStore.delete(staged.media.id).catch(() => undefined);
    return [await reply(context, event, 'official.workspace-connector.mediaRejected')];
  }
  const reservation = await reserveWorkspaceMediaFile(
    context.dataStore,
    session,
    event.message.id
  );
  if (reservation.disposition !== 'reserved') {
    await context.mediaStore.delete(staged.media.id).catch(() => undefined);
    return reservation.disposition === 'limit'
      ? [await reply(context, event, 'official.workspace-connector.mediaLimitReached')]
      : undefined;
  }
  const activeSession = reservation.session;
  const fileId = createHash('sha256')
    .update(`${activeSession.sessionId}\0${event.message.id}`)
    .digest('hex');
  let retry = newWorkspaceMediaRetry({
    sessionId: activeSession.sessionId,
    capabilityId: activeSession.capabilityId,
    fileId,
    mediaId: staged.media.id,
    responseChatId: event.message.chatId,
    expiresAt: activeSession.expiresAt,
    metadata: {
      protocolVersion: 1,
      actorIdentityId: event.actorIdentityId,
      chatId: activeSession.originatingChatId,
      messageId: event.message.id,
      idempotencyKey: `whatsapp-media:${event.message.id}`,
      filename: staged.media.filename,
      mimeType: staged.media.mimeType.toLowerCase(),
      sizeBytes: staged.media.sizeBytes,
      sha256: staged.media.sha256
    }
  });
  await storeWorkspaceMediaRetry(context.dataStore, retry);
  try {
    const receipt = await transferStagedMedia(
      context,
      client,
      installationId,
      retry
    );
    await Promise.all([
      deleteWorkspaceMediaRetry(context.dataStore, retry),
      context.mediaStore.delete(staged.media.id)
    ]);
    if (receipt.sessionState === 'complete') {
      await forgetWorkspaceMediaSession(context.dataStore, activeSession);
    } else {
      await refreshWorkspaceSessionActions(context.dataStore, activeSession, receipt.actions);
    }
    return [workspaceActionReply(event, receipt.actions)];
  } catch (error) {
    retry = rescheduleWorkspaceMediaRetry(retry);
    await storeWorkspaceMediaRetry(context.dataStore, retry);
    context.logger.warn({ error, sessionId: activeSession.sessionId }, 'Workspace media upload failed');
    return [await reply(context, event, 'official.workspace-connector.mediaUnavailable')];
  }
}

async function retryStagedMedia(
  context: PluginRuntimeContext,
  client: WorkspaceSessionClient,
  installationId: string
): Promise<void> {
  if (!context.mediaStore) return;
  for (const retry of await dueWorkspaceMediaRetries(context.dataStore)) {
    if (new Date(retry.expiresAt).getTime() <= Date.now()) {
      await Promise.all([
        deleteWorkspaceMediaRetry(context.dataStore, retry),
        context.mediaStore.delete(retry.mediaId).catch(() => undefined)
      ]);
      continue;
    }
    try {
      const receipt = await transferStagedMedia(context, client, installationId, retry);
      await Promise.all([
        deleteWorkspaceMediaRetry(context.dataStore, retry),
        context.mediaStore.delete(retry.mediaId)
      ]);
      const session = await findWorkspaceMediaSession(
        context.dataStore,
        retry.metadata.actorIdentityId,
        retry.responseChatId
      );
      if (session?.sessionId === retry.sessionId) {
        if (receipt.sessionState === 'complete') {
          await forgetWorkspaceMediaSession(context.dataStore, session);
        } else {
          await refreshWorkspaceSessionActions(context.dataStore, session, receipt.actions);
        }
      }
      if (context.sendText) {
        await context.sendText(retry.responseChatId, renderWorkspaceActions(receipt.actions), {
          idempotencyKey: `workspace-media-receipt:${retry.fileId}`,
          waitForServerAck: true
        });
      }
    } catch (error) {
      await storeWorkspaceMediaRetry(
        context.dataStore,
        rescheduleWorkspaceMediaRetry(retry)
      );
      context.logger.warn({ error, sessionId: retry.sessionId }, 'Workspace staged-media retry failed');
    }
  }
}

async function transferStagedMedia(
  context: PluginRuntimeContext,
  client: Pick<WorkspaceConnectorClient, 'requestMediaGrant' | 'uploadGrantedMedia'>,
  installationId: string,
  retry: WorkspaceMediaRetry
) {
  if (!context.mediaStore) throw new Error('Workspace media store is unavailable.');
  const grant = await client.requestMediaGrant({
    protocolVersion: 1,
    installationId,
    capabilityId: retry.capabilityId,
    sessionId: retry.sessionId,
    fileId: retry.fileId,
    metadata: retry.metadata
  });
  const storedFile = context.mediaStore.openFile
    ? await context.mediaStore.openFile(retry.mediaId)
    : undefined;
  if (storedFile) {
    const stream = Readable.toWeb(createReadStream(storedFile.path)) as ReadableStream<Uint8Array>;
    return client.uploadGrantedMedia(grant, stream);
  }
  const stored = await context.mediaStore.read(retry.mediaId);
  if (!stored) throw new Error('Workspace staged media is unavailable.');
  return client.uploadGrantedMedia(grant, stored.buffer);
}

function resolveWorkspaceChoice(
  choices: ReadonlyArray<{ id: string; label: string }>,
  answer: string
): string | undefined {
  if (/^[1-9][0-9]*$/u.test(answer)) {
    return choices[Number(answer) - 1]?.id;
  }
  const byId = choices.find((choice) => choice.id === answer);
  if (byId) return byId.id;
  const normalized = answer.toLowerCase();
  const byLabel = choices.filter((choice) => choice.label.trim().toLowerCase() === normalized);
  return byLabel.length === 1 ? byLabel[0]!.id : undefined;
}

function workspaceActionReply(
  event: PluginMessageEvent,
  actions: WorkspaceConnectorAction[]
): PluginAction {
  return {
    type: 'message.sendText',
    chatId: event.message.chatId,
    quotedMessageId: event.message.id,
    text: renderWorkspaceActions(actions)
  };
}

function mimeAccepted(actual: string, accepted: readonly string[]): boolean {
  return accepted.some((candidate) => {
    const normalized = candidate.toLowerCase();
    return normalized === actual || (normalized.endsWith('/*') && actual.startsWith(normalized.slice(0, -1)));
  });
}

async function reply(
  context: PluginRuntimeContext,
  event: PluginMessageEvent,
  key: string
): Promise<PluginAction> {
  const translator = await context.i18n.translatorForIdentity(event.actorIdentityId, event.scopeId);
  return {
    type: 'message.sendText',
    chatId: event.message.chatId,
    quotedMessageId: event.message.id,
    text: translator(key)
  };
}

function ack(
  deliveryId: string,
  disposition: WorkspaceConnectorDeliveryAck['disposition'],
  providerMessageId?: string,
  safeFailureCode?: string
): WorkspaceConnectorDeliveryAck {
  return {
    protocolVersion: 1,
    deliveryId,
    disposition,
    ...(providerMessageId ? { providerMessageId } : {}),
    ...(safeFailureCode ? { safeFailureCode } : {})
  };
}
