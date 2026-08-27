import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import {
  WorkspaceConnectorAmbientEventV2Schema,
  WorkspaceConnectorCatalogV2Schema,
  type WorkspaceConnectorAction,
  type WorkspaceConnectorActionV2,
  type WorkspaceConnectorDelivery,
  type WorkspaceConnectorDeliveryAck,
  type WorkspaceConnectorDeliveryAckV2,
  type WorkspaceConnectorDeliveryV2
} from '../../../../packages/workspace-connector-contracts/src';
import type { PluginAction } from '../../../platform/pluginRuntime/runtime/pluginActionTypes';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import { enqueuePluginJob } from '../../../platform/jobs/queue';
import type {
  PluginJobEvent,
  PluginMessageEvent,
  PluginRuntimeHooks
} from '../../../platform/pluginRuntime/types';
import { WorkspaceConnectorClient } from './client';
import {
  renderWorkspaceActions,
  resolveWorkspaceActionRouteV2,
  workspaceActionsToPluginActionsV2
} from './commands';
import { parseWorkspaceConnectorConfig, workspaceConnectorConnection } from './config';
import {
  WORKSPACE_CONNECTOR_AMBIENT_JOB,
  WORKSPACE_CONNECTOR_PLUGIN_ID,
  WORKSPACE_CONNECTOR_SESSION_TIMER_JOB
} from './manifest';
import {
  findWorkspaceMediaSession,
  forgetWorkspaceMediaSession,
  refreshWorkspaceSessionActions,
  refreshWorkspaceSessionActionsV2,
  rememberWorkspaceSession,
  rememberWorkspaceSessionV2,
  reserveWorkspaceMediaFile,
  type StoredWorkspaceMediaSession,
  type StoredWorkspaceSessionV2
} from './mediaSessions';
import {
  deleteWorkspaceMediaRetry,
  dueWorkspaceMediaRetries,
  newWorkspaceMediaRetry,
  newWorkspaceMediaRetryV2,
  rescheduleWorkspaceMediaRetry,
  storeWorkspaceMediaRetry,
  type WorkspaceMediaRetry
} from './mediaRetries';
import { refreshWorkspaceScopeDirectory } from './scopeDirectory';
import { refreshWorkspaceScopeMemberships } from './scopeMembershipDirectory';

const DELIVERY_POLL_INTERVAL_MS = 15_000;
const SCOPE_DIRECTORY_REFRESH_INTERVAL_MS = 60_000;
const DELIVERY_MEDIA_TIMEOUT_MS = 10 * 60_000;
const MAX_DELIVERY_MEDIA_BYTES = 25 * 1024 * 1024 * 1024;

const ambientJobPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  event: WorkspaceConnectorAmbientEventV2Schema,
  actorPrivateChatId: z.string().min(1).max(512),
  actorMentionWid: z.string().min(1).max(512)
}).strict();

const timerJobPayloadSchema = z.object({
  sessionId: z.string().min(1).max(512),
  actorIdentityId: z.string().min(1).max(512),
  timerId: z.string().min(1).max(512)
}).strict();

type WorkspaceSessionClient = Pick<
  WorkspaceConnectorClient,
  'continueSession' | 'requestMediaGrant' | 'uploadGrantedMedia'
> & Partial<Pick<
  WorkspaceConnectorClient,
  'continueSessionV2' | 'publishAmbientEventV2' | 'requestMediaGrantV2' | 'uploadGrantedMediaV2'
>>;

export function createWorkspaceConnectorHooks(context: PluginRuntimeContext): PluginRuntimeHooks {
  const connection = workspaceConnectorConnection(context.config);
  if (!connection) return {};
  const client = new WorkspaceConnectorClient(connection);
  let polling = false;
  let scopeDirectoryRefresh: Promise<void> | undefined;
  let stopped = false;

  const refreshScopeDirectory = (): Promise<void> => {
    if (scopeDirectoryRefresh) return scopeDirectoryRefresh;
    scopeDirectoryRefresh = (async () => {
      if (!await workspaceV2IsInstalled(context)) return;
      await refreshWorkspaceScopeDirectory(context, client, connection.installationId);
    })()
      .catch((error) => {
        context.logger.warn({ error }, 'Workspace v2 scope-directory refresh failed');
      })
      .finally(() => {
        scopeDirectoryRefresh = undefined;
      });
    return scopeDirectoryRefresh;
  };

  let scopeMembershipRefresh: Promise<void> | undefined;
  const refreshScopeMemberships = (): Promise<void> => {
    if (scopeMembershipRefresh) return scopeMembershipRefresh;
    scopeMembershipRefresh = (async () => {
      if (!await workspaceV2IsInstalled(context)) return;
      await refreshWorkspaceScopeMemberships(context, client, connection.installationId);
    })()
      .catch((error) => {
        context.logger.warn({ error }, 'Workspace v1 scope-membership refresh failed');
      })
      .finally(() => {
        scopeMembershipRefresh = undefined;
      });
    return scopeMembershipRefresh;
  };

  const poll = async (): Promise<void> => {
    if (polling || stopped) return;
    polling = true;
    try {
      const deliveries = await client.claimDeliveries(20);
      for (const delivery of deliveries) {
        const acknowledgement = await deliverWorkspaceDelivery(context, delivery);
        await client.acknowledgeDelivery(acknowledgement).catch((error) => {
          context.logger.warn({ error, deliveryId: delivery.deliveryId }, 'Workspace v1 delivery acknowledgement failed');
        });
      }
      if (await workspaceV2IsInstalled(context)) {
        const deliveriesV2 = await client.claimDeliveriesV2(20);
        for (const delivery of deliveriesV2) {
          const acknowledgement = await deliverWorkspaceDeliveryV2(context, client, delivery);
          await client.acknowledgeDeliveryV2(acknowledgement).catch((error) => {
            context.logger.warn({ error, deliveryId: delivery.deliveryId }, 'Workspace v2 delivery acknowledgement failed');
          });
        }
      }
      await retryStagedMedia(context, client, connection.installationId);
    } catch (error) {
      context.logger.warn({ error }, 'Workspace delivery poll failed');
    } finally {
      polling = false;
    }
  };

  const timer = context.config.WORKSPACE_CONNECTOR_DELIVERY_POLL_ENABLED
    ? setInterval(() => void poll(), DELIVERY_POLL_INTERVAL_MS)
    : undefined;
  if (timer) {
    void poll();
    timer.unref();
  }
  const scopeDirectoryTimer = setInterval(
    () => {
      void refreshScopeDirectory();
      void refreshScopeMemberships();
    },
    SCOPE_DIRECTORY_REFRESH_INTERVAL_MS
  );
  scopeDirectoryTimer.unref();
  void refreshScopeDirectory();
  void refreshScopeMemberships();

  return {
    async resolvePrivateMessageRoute(envelope) {
      const session = await findWorkspaceMediaSession(context.dataStore, envelope.actorIdentityId);
      if (!session) return;
      if (session.schemaVersion === 1) {
        if (session.surface === 'private') {
          return {
            scopeId: session.scopeId as `direct:${string}`,
            privateChatId: session.originatingChatId
          };
        }
        return { scopeId: session.scopeId, groupWid: session.groupWid };
      }
      return { scopeId: session.scopeId, groupWid: session.groupWid };
    },
    async onMessage(event) {
      const sessionActions = await handleWorkspaceSessionMessage(
        context,
        client,
        connection.installationId,
        event
      );
      if (sessionActions?.length) return sessionActions;
      return enqueueWorkspaceAmbientEvent(context, connection.installationId, event);
    },
    async onGroupScopeCovered() {
      await Promise.all([refreshScopeDirectory(), refreshScopeMemberships()]);
    },
    async onParticipantChange() {
      await refreshScopeMemberships();
    },
    async onPluginJob(job) {
      if (job.jobName === WORKSPACE_CONNECTOR_SESSION_TIMER_JOB) {
        return handleWorkspaceSessionTimer(context, client, connection.installationId, job);
      }
      if (job.jobName === WORKSPACE_CONNECTOR_AMBIENT_JOB) {
        return handleWorkspaceAmbientJob(context, client, job);
      }
      return;
    },
    onShutdown() {
      stopped = true;
      if (timer) clearInterval(timer);
      clearInterval(scopeDirectoryTimer);
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
  if (session.schemaVersion === 2) {
    return handleWorkspaceSessionMessageV2(context, client, installationId, event, session);
  }
  if (event.message.hasMedia) {
    return handleMediaMessageV1(context, client, installationId, event, session);
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
      input: choiceId ? { kind: 'choice', choiceId } : { kind: 'text', text: body }
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

async function handleWorkspaceSessionMessageV2(
  context: PluginRuntimeContext,
  client: WorkspaceSessionClient,
  installationId: string,
  event: PluginMessageEvent,
  session: StoredWorkspaceSessionV2
): Promise<PluginAction[] | void> {
  if (event.message.hasMedia) {
    if (session.mediaChatId !== event.message.chatId) return;
    return handleMediaMessageV2(context, client, installationId, event, session);
  }
  if (!client.continueSessionV2) throw new Error('Workspace connector v2 client is unavailable.');
  const body = event.message.body.trim();
  if (!body || (session.acceptedMessageKinds && session.choices.length === 0)) return;
  const choiceId = session.choices.length > 0
    ? resolveWorkspaceChoice(session.choices, body)
    : undefined;
  if (session.choices.length > 0 && !choiceId) {
    return [await reply(context, event, 'official.workspace-connector.invalidChoice')];
  }
  try {
    const result = await client.continueSessionV2({
      protocolVersion: 2,
      installationId,
      catalogRevision: session.catalogRevision,
      catalogDigestSha256: session.catalogDigestSha256,
      sessionId: session.sessionId,
      capabilityId: session.capabilityId,
      scopeId: session.scopeId,
      origin: session.origin,
      current: {
        chatId: event.message.chatId,
        surface: event.message.context
      },
      scopeEvidence: session.scopeEvidence,
      locale: session.locale,
      eventId: event.message.id,
      idempotencyKey: `whatsapp-session-v2:${event.message.id}:${session.sessionId}`,
      actor: session.actor,
      input: choiceId ? { kind: 'choice', choiceId } : { kind: 'text', text: body }
    });
    return applyWorkspaceResultV2(context, event, session, result);
  } catch (error) {
    context.logger.warn({ error, sessionId: session.sessionId }, 'Workspace v2 session continuation failed');
    return [await reply(context, event, 'official.workspace-connector.unavailable')];
  }
}

async function applyWorkspaceResultV2(
  context: PluginRuntimeContext,
  event: PluginMessageEvent,
  session: StoredWorkspaceSessionV2,
  result: import('../../../../packages/workspace-connector-contracts/src').WorkspaceConnectorInvocationResultV2
): Promise<PluginAction[]> {
  const request = result.actions.find((action) => action.kind === 'request_media');
  const mediaChatId = request
    ? await resolveWorkspaceActionRouteV2(context, request.route, workspaceRouteContext(session, event.message.chatId))
    : undefined;
  let currentSession: StoredWorkspaceSessionV2 | undefined;
  if (result.session) {
    currentSession = await rememberWorkspaceSessionV2({
      store: context.dataStore,
      result,
      actorIdentityId: session.actorIdentityId,
      actor: session.actor,
      actorPrivateChatId: session.actorPrivateChatId,
      actorMentionWid: session.actorMentionWid,
      scopeId: session.scopeId,
      origin: session.origin,
      groupWid: session.groupWid,
      scopeEvidence: session.scopeEvidence,
      capabilityId: session.capabilityId,
      catalogRevision: session.catalogRevision,
      catalogDigestSha256: session.catalogDigestSha256,
      locale: session.locale,
      ...(mediaChatId ? { mediaChatId } : {}),
      previousSession: session
    });
  } else {
    await forgetWorkspaceMediaSession(context.dataStore, session);
  }
  const actions = await workspaceActionsToPluginActionsV2(context, result.actions, {
    ...workspaceRouteContext(session, event.message.chatId),
    actorMentionWid: session.actorMentionWid,
    quotedMessageId: event.message.id
  });
  if (currentSession?.timer) actions.push(workspaceTimerAction(currentSession));
  return actions;
}

export async function deliverWorkspaceDelivery(
  context: Pick<PluginRuntimeContext, 'configFor' | 'resolveStableIdentityById' | 'sendText'>,
  delivery: WorkspaceConnectorDelivery,
  now = new Date()
): Promise<WorkspaceConnectorDeliveryAck> {
  if (new Date(delivery.expiresAt).getTime() <= now.getTime()) {
    return ackV1(delivery.deliveryId, 'terminal_failure', undefined, 'delivery.expired');
  }
  if (!context.sendText) {
    return ackV1(delivery.deliveryId, 'terminal_failure', undefined, 'delivery.channel_unavailable');
  }
  try {
    let chatId: string;
    if (delivery.target.kind === 'identity') {
      if (!context.resolveStableIdentityById) {
        return ackV1(delivery.deliveryId, 'terminal_failure', undefined, 'identity.unavailable');
      }
      chatId = (await context.resolveStableIdentityById(delivery.target.identityId)).deliveryChatId;
    } else {
      const scoped = parseWorkspaceConnectorConfig(await context.configFor(delivery.target.scopeId));
      if (!scoped.enabled || !scoped.deliveryChatId) {
        return ackV1(delivery.deliveryId, 'terminal_failure', undefined, 'scope.unavailable');
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
    return ackV1(delivery.deliveryId, 'delivered', sent.messageId);
  } catch {
    return ackV1(delivery.deliveryId, 'retryable_failure', undefined, 'whatsapp.send_failed');
  }
}

export async function deliverWorkspaceDeliveryV2(
  context: Pick<
    PluginRuntimeContext,
    | 'configFor'
    | 'coveredGroupsForScope'
    | 'resolveStableIdentityById'
    | 'sendText'
    | 'sendMedia'
  >,
  client: Pick<WorkspaceConnectorClient, 'downloadGrantedMediaV2'>,
  delivery: WorkspaceConnectorDeliveryV2,
  now = new Date()
): Promise<WorkspaceConnectorDeliveryAckV2> {
  if (new Date(delivery.expiresAt).getTime() <= now.getTime()) {
    return ackV2(delivery.deliveryId, 'terminal_failure', undefined, 'delivery.expired');
  }
  let chatId: string;
  try {
    chatId = await resolveDeliveryChatV2(context, delivery);
  } catch {
    return ackV2(delivery.deliveryId, 'terminal_failure', undefined, 'scope.unavailable');
  }
  try {
    if (delivery.action.kind === 'media') {
      if (!context.sendMedia) {
        return ackV2(delivery.deliveryId, 'terminal_failure', undefined, 'delivery.channel_unavailable');
      }
      if (delivery.action.media.sizeBytes > MAX_DELIVERY_MEDIA_BYTES) {
        return ackV2(delivery.deliveryId, 'terminal_failure', undefined, 'media.too_large');
      }
      const directory = await mkdtemp(path.join(tmpdir(), 'workspace-delivery-'));
      try {
        const mediaPath = path.join(directory, 'media.bin');
        const signal = AbortSignal.timeout(DELIVERY_MEDIA_TIMEOUT_MS);
        const response = await client.downloadGrantedMediaV2(delivery.action.media, signal);
        await writeVerifiedWorkspaceMedia(response, mediaPath, delivery.action.media);
        const sent = await context.sendMedia(chatId, {
          filename: path.basename(delivery.action.media.filename),
          mimeType: delivery.action.media.mimeType,
          path: mediaPath
        }, {
          idempotencyKey: `workspace-v2:${delivery.idempotencyKey}`,
          ...(delivery.action.caption ? { caption: delivery.action.caption } : {}),
          waitUntilMsgSent: true,
          waitForServerAck: true,
          notAfter: new Date(delivery.expiresAt)
        });
        return ackV2(delivery.deliveryId, 'delivered', sent.messageId);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    if (!context.sendText) {
      return ackV2(delivery.deliveryId, 'terminal_failure', undefined, 'delivery.channel_unavailable');
    }
    const text = delivery.action.kind === 'open_url'
      ? `${delivery.action.text}\n${delivery.action.url}`
      : delivery.action.text;
    const sent = await context.sendText(chatId, text, {
      idempotencyKey: `workspace-v2:${delivery.idempotencyKey}`,
      notAfter: new Date(delivery.expiresAt),
      waitForServerAck: true
    });
    return ackV2(delivery.deliveryId, 'delivered', sent.messageId);
  } catch {
    return ackV2(delivery.deliveryId, 'retryable_failure', undefined, 'whatsapp.send_failed');
  }
}

async function resolveDeliveryChatV2(
  context: Pick<
    PluginRuntimeContext,
    'configFor' | 'coveredGroupsForScope' | 'resolveStableIdentityById'
  >,
  delivery: WorkspaceConnectorDeliveryV2
): Promise<string> {
  if (delivery.target.kind === 'identity') {
    if (!context.resolveStableIdentityById) throw new Error('Identity resolver unavailable.');
    return (await context.resolveStableIdentityById(delivery.target.identityId)).deliveryChatId;
  }
  const scoped = parseWorkspaceConnectorConfig(await context.configFor(delivery.target.scopeId));
  if (!scoped.enabled) throw new Error('Connector is disabled for the scope.');
  if (delivery.target.kind === 'scope') {
    if (!scoped.deliveryChatId) throw new Error('Scope delivery route is unavailable.');
    return scoped.deliveryChatId;
  }
  if (!context.coveredGroupsForScope) throw new Error('Managed scope directory is unavailable.');
  const target = delivery.target;
  if (target.kind !== 'scope_chat') throw new Error('Unsupported Workspace delivery target.');
  const covered = await context.coveredGroupsForScope(target.scopeId);
  if (!covered.some((group) => group.groupWid === target.chatId)) {
    throw new Error('Delivery chat is outside the managed scope.');
  }
  return target.chatId;
}

async function writeVerifiedWorkspaceMedia(
  response: Response,
  destinationPath: string,
  expected: { sizeBytes: number; sha256: string }
): Promise<void> {
  if (!response.body) throw new Error('Workspace media response had no body.');
  const hash = createHash('sha256');
  let received = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      if (received > expected.sizeBytes) {
        callback(new Error('Workspace media exceeded its declared size.'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
    verifier,
    createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 })
  );
  if (received !== expected.sizeBytes || hash.digest('hex') !== expected.sha256) {
    throw new Error('Workspace media did not match its declared size and digest.');
  }
}

async function handleMediaMessageV1(
  context: PluginRuntimeContext,
  client: WorkspaceSessionClient,
  installationId: string,
  event: PluginMessageEvent,
  session: Extract<StoredWorkspaceMediaSession, { schemaVersion: 1 }>
): Promise<PluginAction[] | void> {
  if (!context.mediaStore || !session.acceptedMimeTypes || !session.maximumFileBytes || !session.maximumFiles) return;
  const declaredMimeType = (event.message.media?.mimeType ?? event.message.mediaMimeType ?? '').toLowerCase();
  if (!mimeAccepted(declaredMimeType, session.acceptedMimeTypes)) {
    return [await reply(context, event, 'official.workspace-connector.mediaRejected')];
  }
  const declaredBytes = event.message.media?.sizeBytes;
  if (declaredBytes !== undefined && declaredBytes > session.maximumFileBytes) {
    return [await reply(context, event, 'official.workspace-connector.mediaTooLarge')];
  }
  const stagedResult = await stageWorkspaceMedia(context, event, session.maximumFileBytes);
  if (!stagedResult.ok) {
    return [await reply(
      context,
      event,
      stagedResult.reason === 'too-large'
        ? 'official.workspace-connector.mediaTooLarge'
        : 'official.workspace-connector.mediaUnavailable'
    )];
  }
  const staged = stagedResult.media;
  if (!mimeAccepted(staged.mimeType.toLowerCase(), session.acceptedMimeTypes)) {
    await context.mediaStore.delete(staged.id).catch(() => undefined);
    return [await reply(context, event, 'official.workspace-connector.mediaRejected')];
  }
  const reservation = await reserveWorkspaceMediaFile(context.dataStore, session, event.message.id);
  if (reservation.disposition !== 'reserved') {
    await context.mediaStore.delete(staged.id).catch(() => undefined);
    return reservation.disposition === 'limit'
      ? [await reply(context, event, 'official.workspace-connector.mediaLimitReached')]
      : undefined;
  }
  const activeSession = reservation.session;
  if (activeSession.schemaVersion !== 1) throw new Error('Workspace session version changed during media reservation.');
  const fileId = mediaFileId(activeSession.sessionId, event.message.id);
  let retry = newWorkspaceMediaRetry({
    sessionId: activeSession.sessionId,
    capabilityId: activeSession.capabilityId,
    fileId,
    mediaId: staged.id,
    responseChatId: event.message.chatId,
    expiresAt: activeSession.expiresAt,
    metadata: {
      protocolVersion: 1,
      actorIdentityId: event.actorIdentityId,
      chatId: activeSession.originatingChatId,
      messageId: event.message.id,
      idempotencyKey: `whatsapp-media:${event.message.id}`,
      filename: staged.filename,
      mimeType: staged.mimeType.toLowerCase(),
      sizeBytes: staged.sizeBytes,
      sha256: staged.sha256
    }
  });
  await storeWorkspaceMediaRetry(context.dataStore, retry);
  try {
    const receipt = await transferStagedMedia(context, client, installationId, retry);
    if (receipt.protocolVersion !== 1) throw new Error('Workspace media receipt version changed.');
    await Promise.all([
      deleteWorkspaceMediaRetry(context.dataStore, retry),
      context.mediaStore.delete(staged.id)
    ]);
    if (receipt.sessionState === 'complete') await forgetWorkspaceMediaSession(context.dataStore, activeSession);
    else await refreshWorkspaceSessionActions(context.dataStore, activeSession, receipt.actions);
    return [workspaceActionReply(event, receipt.actions)];
  } catch (error) {
    retry = rescheduleWorkspaceMediaRetry(retry);
    await storeWorkspaceMediaRetry(context.dataStore, retry);
    context.logger.warn({ error, sessionId: activeSession.sessionId }, 'Workspace media upload failed');
    return [await reply(context, event, 'official.workspace-connector.mediaUnavailable')];
  }
}

async function handleMediaMessageV2(
  context: PluginRuntimeContext,
  client: WorkspaceSessionClient,
  installationId: string,
  event: PluginMessageEvent,
  session: StoredWorkspaceSessionV2
): Promise<PluginAction[] | void> {
  if (!session.acceptedMessageKinds || !session.acceptedMimeTypes || !session.maximumFileBytes || !session.maximumFiles) return;
  const messageKind = workspaceMessageKind(event.message.type);
  if (!messageKind || !session.acceptedMessageKinds.includes(messageKind)) {
    return [await reply(context, event, 'official.workspace-connector.sendAsAcceptedKind')];
  }
  if (!context.mediaStore) {
    return [await reply(context, event, 'official.workspace-connector.mediaUnavailable')];
  }
  const declaredMimeType = (event.message.media?.mimeType ?? event.message.mediaMimeType ?? '').toLowerCase();
  if (!mimeAccepted(declaredMimeType, session.acceptedMimeTypes)) {
    return [await reply(context, event, 'official.workspace-connector.mediaRejected')];
  }
  const declaredBytes = event.message.media?.sizeBytes;
  if (declaredBytes !== undefined && declaredBytes > session.maximumFileBytes) {
    return [await reply(context, event, 'official.workspace-connector.mediaTooLarge')];
  }
  const stagedResult = await stageWorkspaceMedia(context, event, session.maximumFileBytes);
  if (!stagedResult.ok) {
    return [await reply(
      context,
      event,
      stagedResult.reason === 'too-large'
        ? 'official.workspace-connector.mediaTooLarge'
        : 'official.workspace-connector.mediaUnavailable'
    )];
  }
  const staged = stagedResult.media;
  if (!mimeAccepted(staged.mimeType.toLowerCase(), session.acceptedMimeTypes)) {
    await context.mediaStore.delete(staged.id).catch(() => undefined);
    return [await reply(context, event, 'official.workspace-connector.mediaRejected')];
  }
  const reservation = await reserveWorkspaceMediaFile(context.dataStore, session, event.message.id);
  if (reservation.disposition !== 'reserved') {
    await context.mediaStore.delete(staged.id).catch(() => undefined);
    return reservation.disposition === 'limit'
      ? [await reply(context, event, 'official.workspace-connector.mediaLimitReached')]
      : undefined;
  }
  const activeSession = reservation.session;
  if (activeSession.schemaVersion !== 2) throw new Error('Workspace session version changed during media reservation.');
  const fileId = mediaFileId(activeSession.sessionId, event.message.id);
  let retry = newWorkspaceMediaRetryV2({
    sessionId: activeSession.sessionId,
    capabilityId: activeSession.capabilityId,
    fileId,
    mediaId: staged.id,
    responseChatId: event.message.chatId,
    expiresAt: activeSession.expiresAt,
    metadata: {
      protocolVersion: 2,
      actorIdentityId: event.actorIdentityId,
      chatId: event.message.chatId,
      messageId: event.message.id,
      messageKind,
      idempotencyKey: `whatsapp-media-v2:${event.message.id}`,
      filename: staged.filename,
      mimeType: staged.mimeType.toLowerCase(),
      sizeBytes: staged.sizeBytes,
      sha256: staged.sha256
    }
  });
  await storeWorkspaceMediaRetry(context.dataStore, retry);
  try {
    const receipt = await transferStagedMedia(context, client, installationId, retry);
    if (receipt.protocolVersion !== 2) throw new Error('Workspace media receipt version changed.');
    await Promise.all([
      deleteWorkspaceMediaRetry(context.dataStore, retry),
      context.mediaStore.delete(staged.id)
    ]);
    if (receipt.sessionState === 'complete') {
      await forgetWorkspaceMediaSession(context.dataStore, activeSession);
    } else {
      const request = receipt.actions.find((action) => action.kind === 'request_media');
      const mediaChatId = request
        ? await resolveWorkspaceActionRouteV2(context, request.route, workspaceRouteContext(activeSession, event.message.chatId))
        : undefined;
      await refreshWorkspaceSessionActionsV2(context.dataStore, activeSession, receipt.actions, {
        ...(mediaChatId ? { mediaChatId } : {}),
        ...(receipt.timer ? { timer: receipt.timer } : {})
      });
    }
    const actions = await workspaceActionsToPluginActionsV2(context, receipt.actions, {
      ...workspaceRouteContext(activeSession, event.message.chatId),
      actorMentionWid: activeSession.actorMentionWid,
      quotedMessageId: event.message.id
    });
    if (receipt.timer && receipt.sessionState === 'accepting') {
      actions.push(workspaceTimerAction({ ...activeSession, timer: receipt.timer }));
    }
    return actions;
  } catch (error) {
    retry = rescheduleWorkspaceMediaRetry(retry);
    await storeWorkspaceMediaRetry(context.dataStore, retry);
    context.logger.warn({ error, sessionId: activeSession.sessionId }, 'Workspace v2 media upload failed');
    return [await reply(context, event, 'official.workspace-connector.mediaUnavailable')];
  }
}

async function stageWorkspaceMedia(
  context: PluginRuntimeContext,
  event: PluginMessageEvent,
  maximumFileBytes: number
) {
  if (!context.mediaStore) {
    return { ok: false, reason: 'not-found', message: 'Workspace media storage is unavailable.' } as const;
  }
  return context.mediaStore.stageMessage(event.message.id, {
    fallbackFilename: event.message.media?.filename ?? 'workspace-media.bin',
    maxBytes: maximumFileBytes
  });
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
      const session = await findWorkspaceMediaSession(context.dataStore, retry.metadata.actorIdentityId, retry.responseChatId);
      if (session?.sessionId !== retry.sessionId) continue;
      if (retry.schemaVersion === 1 && receipt.protocolVersion === 1 && session.schemaVersion === 1) {
        if (receipt.sessionState === 'complete') await forgetWorkspaceMediaSession(context.dataStore, session);
        else await refreshWorkspaceSessionActions(context.dataStore, session, receipt.actions);
        if (context.sendText) {
          await context.sendText(retry.responseChatId, renderWorkspaceActions(receipt.actions), {
            idempotencyKey: `workspace-media-receipt:${retry.fileId}`,
            waitForServerAck: true
          });
        }
      } else if (retry.schemaVersion === 2 && receipt.protocolVersion === 2 && session.schemaVersion === 2) {
        if (receipt.sessionState === 'complete') {
          await forgetWorkspaceMediaSession(context.dataStore, session);
        } else {
          const request = receipt.actions.find((action) => action.kind === 'request_media');
          const mediaChatId = request
            ? await resolveWorkspaceActionRouteV2(context, request.route, workspaceRouteContext(session, retry.responseChatId))
            : undefined;
          await refreshWorkspaceSessionActionsV2(context.dataStore, session, receipt.actions, {
            ...(mediaChatId ? { mediaChatId } : {}),
            ...(receipt.timer ? { timer: receipt.timer } : {})
          });
        }
        const actions = await workspaceActionsToPluginActionsV2(context, receipt.actions, {
          ...workspaceRouteContext(session, retry.responseChatId),
          actorMentionWid: session.actorMentionWid
        });
        await executeRetryActions(context, session, retry.fileId, actions);
        if (receipt.timer && receipt.sessionState === 'accepting') {
          const timedSession = { ...session, timer: receipt.timer };
          await enqueuePluginJob(context.queue, {
            pluginId: WORKSPACE_CONNECTOR_PLUGIN_ID,
            jobName: WORKSPACE_CONNECTOR_SESSION_TIMER_JOB,
            scopeId: session.scopeId,
            groupWid: session.groupWid,
            runAt: new Date(receipt.timer.fireAt),
            payload: workspaceTimerJobPayload(timedSession),
            dedupeKey: `${WORKSPACE_CONNECTOR_SESSION_TIMER_JOB}:${session.sessionId}:${receipt.timer.timerId}`
          });
        }
      }
    } catch (error) {
      await storeWorkspaceMediaRetry(context.dataStore, rescheduleWorkspaceMediaRetry(retry));
      context.logger.warn({ error, sessionId: retry.sessionId }, 'Workspace staged-media retry failed');
    }
  }
}

async function executeRetryActions(
  context: PluginRuntimeContext,
  session: StoredWorkspaceSessionV2,
  fileId: string,
  actions: PluginAction[]
): Promise<void> {
  if (!context.sendText) return;
  for (const action of actions) {
    if (action.type !== 'message.sendText') continue;
    await context.sendText(action.chatId, action.text, {
      idempotencyKey: `workspace-media-receipt-v2:${fileId}:${createHash('sha256').update(action.chatId).digest('hex')}`,
      waitForServerAck: true,
      ...(action.privateDeliveryFallback ? { privateDeliveryFallback: action.privateDeliveryFallback } : {})
    });
  }
}

async function transferStagedMedia(
  context: PluginRuntimeContext,
  client: WorkspaceSessionClient,
  installationId: string,
  retry: WorkspaceMediaRetry
) {
  if (!context.mediaStore) throw new Error('Workspace media store is unavailable.');
  const storedFile = context.mediaStore.openFile ? await context.mediaStore.openFile(retry.mediaId) : undefined;
  const body = storedFile
    ? Readable.toWeb(createReadStream(storedFile.path)) as ReadableStream<Uint8Array>
    : (await context.mediaStore.read(retry.mediaId))?.buffer;
  if (!body) throw new Error('Workspace staged media is unavailable.');
  if (retry.schemaVersion === 1) {
    const grant = await client.requestMediaGrant({
      protocolVersion: 1,
      installationId,
      capabilityId: retry.capabilityId,
      sessionId: retry.sessionId,
      fileId: retry.fileId,
      metadata: retry.metadata
    });
    return client.uploadGrantedMedia(grant, body);
  }
  if (!client.requestMediaGrantV2 || !client.uploadGrantedMediaV2) {
    throw new Error('Workspace connector v2 media client is unavailable.');
  }
  const grant = await client.requestMediaGrantV2({
    protocolVersion: 2,
    installationId,
    capabilityId: retry.capabilityId,
    sessionId: retry.sessionId,
    fileId: retry.fileId,
    metadata: retry.metadata
  });
  return client.uploadGrantedMediaV2(grant, body);
}

async function enqueueWorkspaceAmbientEvent(
  context: PluginRuntimeContext,
  installationId: string,
  event: PluginMessageEvent
): Promise<PluginAction[] | void> {
  if (event.message.fromMe || event.isCommandLike || event.message.context !== 'group') return;
  const catalog = WorkspaceConnectorCatalogV2Schema.safeParse(await context.dataStore.get('catalog:v2'));
  if (!catalog.success) return;
  const eventType = workspaceAmbientEventType(event.message.type);
  if (!eventType) return;
  const trigger = catalog.data.ambientTriggers.find((candidate) => candidate.eventType === eventType);
  if (!trigger) return;
  const scoped = parseWorkspaceConnectorConfig(await context.configFor(event.scopeId, event.actorIdentityId));
  if (!scoped.enabled || !scoped.allowedCapabilities.includes(trigger.capabilityId)) return;
  const locale = await context.i18n.resolveIdentityLocale(event.actorIdentityId, event.scopeId);
  const actorAddress = event.actor.identityAddress;
  const jobPayload = ambientJobPayloadSchema.parse({
    schemaVersion: 1,
    event: {
      protocolVersion: 2,
      installationId,
      catalogRevision: catalog.data.revision,
      catalogDigestSha256: catalog.data.digestSha256,
      triggerId: trigger.triggerId,
      capabilityId: trigger.capabilityId,
      eventType,
      scopeId: event.scopeId,
      origin: { chatId: event.message.chatId, surface: 'group' },
      scopeEvidence: {
        kind: 'group_membership',
        scopeId: event.scopeId,
        groupChatId: event.message.chatId,
        actorIsCurrentMember: true,
        checkedAt: event.receivedAt.toISOString()
      },
      locale: locale.locale,
      eventId: event.message.id,
      idempotencyKey: `whatsapp-ambient:${trigger.triggerId}:${event.message.id}`,
      actor: {
        identityId: event.actorIdentityId,
        ...(actorAddress.phoneNumber
          ? { verifiedWhatsappNumber: actorAddress.phoneNumber.startsWith('+') ? actorAddress.phoneNumber : `+${actorAddress.phoneNumber}` }
          : {}),
        ...(event.message.senderDisplayName ? { displayName: event.message.senderDisplayName } : {})
      },
      observedAt: event.receivedAt.toISOString(),
      payload: {
        messageId: event.message.id,
        messageType: event.message.type,
        hasMedia: event.message.hasMedia
      }
    },
    actorPrivateChatId: actorAddress.deliveryChatId,
    actorMentionWid: actorAddress.mentionWid
  });
  return [{
    type: 'plugin.enqueueJob',
    pluginId: WORKSPACE_CONNECTOR_PLUGIN_ID,
    jobName: WORKSPACE_CONNECTOR_AMBIENT_JOB,
    scopeId: event.scopeId,
    runAt: new Date(event.receivedAt.getTime() + trigger.delaySeconds * 1_000),
    payload: jobPayload,
    dedupeKey: `${WORKSPACE_CONNECTOR_AMBIENT_JOB}:${trigger.triggerId}:${event.message.id}`
  }];
}

async function handleWorkspaceAmbientJob(
  context: PluginRuntimeContext,
  client: WorkspaceSessionClient,
  job: PluginJobEvent
): Promise<PluginAction[] | void> {
  const payload = ambientJobPayloadSchema.safeParse(job.payload);
  if (!payload.success) return;
  if (!client.publishAmbientEventV2) throw new Error('Workspace connector v2 ambient client is unavailable.');
  try {
    const result = await client.publishAmbientEventV2(payload.data.event);
    return workspaceActionsToPluginActionsV2(context, result.actions, {
      originChatId: payload.data.event.origin.chatId,
      currentChatId: payload.data.event.origin.chatId,
      scopeId: payload.data.event.scopeId,
      actorPrivateChatId: payload.data.actorPrivateChatId,
      actorMentionWid: payload.data.actorMentionWid
    });
  } catch (error) {
    context.logger.warn({ error, eventId: payload.data.event.eventId }, 'Workspace ambient event failed');
    throw error;
  }
}

async function handleWorkspaceSessionTimer(
  context: PluginRuntimeContext,
  client: WorkspaceSessionClient,
  installationId: string,
  job: PluginJobEvent
): Promise<PluginAction[] | void> {
  const payload = timerJobPayloadSchema.safeParse(job.payload);
  if (!payload.success) return;
  if (!client.continueSessionV2) throw new Error('Workspace connector v2 session client is unavailable.');
  const session = await findWorkspaceMediaSession(context.dataStore, payload.data.actorIdentityId);
  if (
    !session || session.schemaVersion !== 2 || session.sessionId !== payload.data.sessionId
    || session.timer?.timerId !== payload.data.timerId
  ) return;
  const firedAt = new Date().toISOString();
  const result = await client.continueSessionV2({
    protocolVersion: 2,
    installationId,
    catalogRevision: session.catalogRevision,
    catalogDigestSha256: session.catalogDigestSha256,
    sessionId: session.sessionId,
    capabilityId: session.capabilityId,
    scopeId: session.scopeId,
    origin: session.origin,
    current: session.origin,
    scopeEvidence: session.scopeEvidence,
    locale: session.locale,
    eventId: `timer:${session.sessionId}:${payload.data.timerId}`,
    idempotencyKey: `timer:${session.sessionId}:${payload.data.timerId}`,
    actor: session.actor,
    input: { kind: 'timer', timerId: payload.data.timerId, firedAt }
  });
  const request = result.actions.find((action) => action.kind === 'request_media');
  const mediaChatId = request
    ? await resolveWorkspaceActionRouteV2(context, request.route, workspaceRouteContext(session, session.origin.chatId))
    : undefined;
  let next: StoredWorkspaceSessionV2 | undefined;
  if (result.session) {
    next = await rememberWorkspaceSessionV2({
      store: context.dataStore,
      result,
      actorIdentityId: session.actorIdentityId,
      actor: session.actor,
      actorPrivateChatId: session.actorPrivateChatId,
      actorMentionWid: session.actorMentionWid,
      scopeId: session.scopeId,
      origin: session.origin,
      groupWid: session.groupWid,
      scopeEvidence: session.scopeEvidence,
      capabilityId: session.capabilityId,
      catalogRevision: session.catalogRevision,
      catalogDigestSha256: session.catalogDigestSha256,
      locale: session.locale,
      ...(mediaChatId ? { mediaChatId } : {}),
      previousSession: session
    });
  } else {
    await forgetWorkspaceMediaSession(context.dataStore, session);
  }
  const actions = await workspaceActionsToPluginActionsV2(context, result.actions, {
    ...workspaceRouteContext(session, session.origin.chatId),
    actorMentionWid: session.actorMentionWid
  });
  if (next?.timer) actions.push(workspaceTimerAction(next));
  return actions;
}

function workspaceTimerAction(session: StoredWorkspaceSessionV2): PluginAction {
  if (!session.timer) throw new Error('Workspace session timer is unavailable.');
  return {
    type: 'plugin.enqueueJob',
    pluginId: WORKSPACE_CONNECTOR_PLUGIN_ID,
    jobName: WORKSPACE_CONNECTOR_SESSION_TIMER_JOB,
    scopeId: session.scopeId,
    runAt: new Date(session.timer.fireAt),
    payload: workspaceTimerJobPayload(session),
    dedupeKey: `${WORKSPACE_CONNECTOR_SESSION_TIMER_JOB}:${session.sessionId}:${session.timer.timerId}`
  };
}

function workspaceTimerJobPayload(session: StoredWorkspaceSessionV2) {
  if (!session.timer) throw new Error('Workspace session timer is unavailable.');
  return {
    sessionId: session.sessionId,
    actorIdentityId: session.actorIdentityId,
    timerId: session.timer.timerId
  };
}

function workspaceRouteContext(session: StoredWorkspaceSessionV2, currentChatId: string) {
  return {
    originChatId: session.origin.chatId,
    currentChatId,
    scopeId: session.scopeId,
    actorPrivateChatId: session.actorPrivateChatId
  };
}

async function workspaceV2IsInstalled(context: PluginRuntimeContext): Promise<boolean> {
  return WorkspaceConnectorCatalogV2Schema.safeParse(await context.dataStore.get('catalog:v2')).success;
}

function workspaceAmbientEventType(messageType: string | undefined): string | undefined {
  return (messageType ?? '').trim().toLowerCase() === 'album'
    ? 'whatsapp.media-album.v1'
    : undefined;
}

function workspaceMessageKind(type: string | undefined): 'document' | 'image' | 'video' | 'audio' | undefined {
  const normalized = (type ?? '').trim().toLowerCase();
  return ['document', 'image', 'video', 'audio'].includes(normalized)
    ? normalized as 'document' | 'image' | 'video' | 'audio'
    : undefined;
}

function mediaFileId(sessionId: string, messageId: string): string {
  return createHash('sha256').update(`${sessionId}\0${messageId}`).digest('hex');
}

function resolveWorkspaceChoice(
  choices: ReadonlyArray<{ id: string; label: string }>,
  answer: string
): string | undefined {
  if (/^[1-9][0-9]*$/u.test(answer)) return choices[Number(answer) - 1]?.id;
  const byId = choices.find((choice) => choice.id === answer);
  if (byId) return byId.id;
  const normalized = answer.toLowerCase();
  const byLabel = choices.filter((choice) => choice.label.trim().toLowerCase() === normalized);
  return byLabel.length === 1 ? byLabel[0]!.id : undefined;
}

function workspaceActionReply(event: PluginMessageEvent, actions: WorkspaceConnectorAction[]): PluginAction {
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

async function reply(context: PluginRuntimeContext, event: PluginMessageEvent, key: string): Promise<PluginAction> {
  const translator = await context.i18n.translatorForIdentity(event.actorIdentityId, event.scopeId);
  return {
    type: 'message.sendText',
    chatId: event.message.chatId,
    quotedMessageId: event.message.id,
    text: translator(key)
  };
}

function ackV1(
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

function ackV2(
  deliveryId: string,
  disposition: WorkspaceConnectorDeliveryAckV2['disposition'],
  providerMessageId?: string,
  safeFailureCode?: string
): WorkspaceConnectorDeliveryAckV2 {
  return {
    protocolVersion: 2,
    deliveryId,
    disposition,
    ...(providerMessageId ? { providerMessageId } : {}),
    ...(safeFailureCode ? { safeFailureCode } : {})
  };
}
