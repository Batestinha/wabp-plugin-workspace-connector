import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  WorkspaceConnectorActorSchema,
  WorkspaceConnectorConversationPointV2Schema,
  WorkspaceConnectorScopeEvidenceV2Schema,
  WorkspaceConnectorTimerV2Schema,
  type WorkspaceConnectorAction,
  type WorkspaceConnectorActionV2,
  type WorkspaceConnectorInvocationResult,
  type WorkspaceConnectorInvocationResultV2
} from './contracts/workspace-connector-v0.3';
import type { PluginDataStore } from '@wabs/plugin-sdk/data-store';

const choiceSchema = z.object({
  id: z.string().trim().min(1).max(512),
  label: z.string().min(1).max(240)
}).strict();

const storedSessionV1Schema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1).max(512),
  capabilityId: z.string().min(1).max(160),
  catalogRevision: z.number().int().nonnegative(),
  catalogDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime(),
  actorIdentityId: z.string().min(1).max(512),
  actor: WorkspaceConnectorActorSchema,
  scopeId: z.string().min(1).max(512),
  originatingChatId: z.string().min(1).max(512),
  groupWid: z.string().min(1).max(512),
  surface: z.enum(['private', 'group']),
  locale: z.string().trim().min(2).max(35),
  choices: z.array(choiceSchema).max(32),
  acceptedMimeTypes: z.array(z.string().min(1).max(160)).min(1).max(64).optional(),
  maximumFileBytes: z.number().int().positive().max(2 ** 31 - 1).optional(),
  maximumFiles: z.number().int().positive().max(1_000).optional(),
  mediaMessageIds: z.array(z.string().min(1).max(512)).max(1_000)
}).strict();

export const storedSessionV2Schema = z.object({
  schemaVersion: z.literal(2),
  sessionId: z.string().min(1).max(512),
  capabilityId: z.string().min(1).max(160),
  continuationCapabilityId: z.string().min(1).max(160).optional(),
  authenticatedInteractiveCapabilityIds: z.array(z.string().min(1).max(160)).max(128)
    .refine((value) => new Set(value).size === value.length, { message: 'interactive capability IDs must be unique' })
    .optional(),
  scopeAllowedCapabilityIds: z.array(z.string().min(1).max(160)).max(128)
    .refine((value) => new Set(value).size === value.length, { message: 'allowed capability IDs must be unique' })
    .optional(),
  catalogRevision: z.number().int().nonnegative(),
  catalogDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime(),
  actorIdentityId: z.string().min(1).max(512),
  actor: WorkspaceConnectorActorSchema,
  actorPrivateChatId: z.string().min(1).max(512),
  actorMentionWid: z.string().min(1).max(512),
  scopeId: z.string().min(1).max(512),
  origin: WorkspaceConnectorConversationPointV2Schema,
  groupWid: z.string().min(1).max(512),
  scopeEvidence: WorkspaceConnectorScopeEvidenceV2Schema,
  locale: z.string().trim().min(2).max(35),
  choices: z.array(choiceSchema).max(64),
  privatePromptSubjectId: z.string().min(1).max(512).optional(),
  acceptedMessageKinds: z.array(z.enum(['document', 'image', 'video', 'audio'])).min(1).max(4).optional(),
  acceptedMimeTypes: z.array(z.string().min(1).max(160)).min(1).max(64).optional(),
  maximumFileBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  maximumFiles: z.number().int().positive().max(10_000).optional(),
  mediaChatId: z.string().min(1).max(512).optional(),
  timer: WorkspaceConnectorTimerV2Schema.optional(),
  mediaMessageIds: z.array(z.string().min(1).max(512)).max(10_000)
}).strict();

const storedSessionSchema = z.discriminatedUnion('schemaVersion', [
  storedSessionV1Schema,
  storedSessionV2Schema
]).superRefine((value, context) => {
  if (value.schemaVersion === 1) {
    if (value.surface === 'private' && !value.scopeId.startsWith('direct:')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeId'],
        message: 'private Workspace v1 sessions require a direct scope'
      });
    }
    if (value.surface === 'group' && !value.groupWid.toLowerCase().endsWith('@g.us')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['groupWid'],
        message: 'group Workspace sessions require a group route'
      });
    }
    return;
  }
  if (value.scopeEvidence.scopeId !== value.scopeId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scopeEvidence', 'scopeId'],
      message: 'session scope evidence must bind the session scope'
    });
  }
  if ((value.acceptedMessageKinds !== undefined) !== (value.mediaChatId !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mediaChatId'],
      message: 'media collection requires an exact accepted chat'
    });
  }
});

export type StoredWorkspaceMediaSession = z.infer<typeof storedSessionSchema>;
export type StoredWorkspaceSessionV2 = z.infer<typeof storedSessionV2Schema>;

export async function rememberWorkspaceSession(input: {
  store: PluginDataStore;
  result: WorkspaceConnectorInvocationResult;
  actorIdentityId: string;
  actor: z.infer<typeof WorkspaceConnectorActorSchema>;
  scopeId: string;
  chatId: string;
  groupWid: string;
  capabilityId: string;
  catalogRevision: number;
  catalogDigestSha256: string;
  surface: 'private' | 'group';
  locale: string;
  previousSession?: StoredWorkspaceMediaSession | undefined;
}): Promise<void> {
  const request = input.result.actions.find((action) => action.kind === 'request_media');
  if (!input.result.sessionId || !input.result.sessionExpiresAt) return;
  const choice = input.result.actions.find((action) => action.kind === 'choice');
  const previousV1 = input.previousSession?.schemaVersion === 1 ? input.previousSession : undefined;
  const sameSession = previousV1?.sessionId === input.result.sessionId;
  const parsed = storedSessionSchema.parse({
    schemaVersion: 1,
    sessionId: input.result.sessionId,
    capabilityId: input.capabilityId,
    catalogRevision: input.catalogRevision,
    catalogDigestSha256: input.catalogDigestSha256,
    expiresAt: input.result.sessionExpiresAt,
    actorIdentityId: input.actorIdentityId,
    actor: input.actor,
    scopeId: input.scopeId,
    originatingChatId: input.chatId,
    groupWid: input.groupWid,
    surface: input.surface,
    locale: input.locale,
    choices: choice?.choices ?? [],
    ...(request ? {
      acceptedMimeTypes: request.acceptedMimeTypes,
      maximumFileBytes: request.maximumFileBytes,
      maximumFiles: request.maximumFiles
    } : {}),
    mediaMessageIds: sameSession ? previousV1?.mediaMessageIds ?? [] : []
  });
  if (parsed.schemaVersion !== 1) throw new Error('Workspace session version changed during validation.');
  const session = parsed;
  if (input.previousSession && !sameSession) {
    await forgetWorkspaceMediaSession(input.store, input.previousSession);
  }
  await storeWorkspaceSession(input.store, session);
}

export async function rememberWorkspaceSessionV2(input: {
  store: PluginDataStore;
  result: WorkspaceConnectorInvocationResultV2;
  actorIdentityId: string;
  actor: z.infer<typeof WorkspaceConnectorActorSchema>;
  actorPrivateChatId: string;
  actorMentionWid: string;
  scopeId: string;
  origin: z.infer<typeof WorkspaceConnectorConversationPointV2Schema>;
  groupWid: string;
  scopeEvidence: z.infer<typeof WorkspaceConnectorScopeEvidenceV2Schema>;
  capabilityId: string;
  catalogRevision: number;
  catalogDigestSha256: string;
  authenticatedInteractiveCapabilityIds?: readonly string[] | undefined;
  scopeAllowedCapabilityIds?: readonly string[] | undefined;
  locale: string;
  mediaChatId?: string | undefined;
  previousSession?: StoredWorkspaceMediaSession | undefined;
}): Promise<StoredWorkspaceSessionV2 | undefined> {
  if (!input.result.session) return undefined;
  const request = input.result.actions.find((action) => action.kind === 'request_media');
  const choice = input.result.actions.find((action) => action.kind === 'choice');
  const previousV2 = input.previousSession?.schemaVersion === 2 ? input.previousSession : undefined;
  const sameSession = previousV2?.sessionId === input.result.session.sessionId;
  const authenticatedInteractiveCapabilityIds = immutableCapabilitySnapshot(
    'authenticated interactive capabilities',
    input.authenticatedInteractiveCapabilityIds,
    previousV2?.authenticatedInteractiveCapabilityIds
  );
  const scopeAllowedCapabilityIds = immutableCapabilitySnapshot(
    'scope-allowed capabilities',
    input.scopeAllowedCapabilityIds,
    previousV2?.scopeAllowedCapabilityIds
  );
  const continuationCapabilityId = lockedContinuationCapabilityId({
    originatingCapabilityId: input.capabilityId,
    requestedCapabilityId: input.result.session.continuationCapabilityId,
    lockedCapabilityId: previousV2?.continuationCapabilityId,
    authenticatedInteractiveCapabilityIds,
    scopeAllowedCapabilityIds
  });
  const parsed = storedSessionSchema.parse({
    schemaVersion: 2,
    sessionId: input.result.session.sessionId,
    capabilityId: input.capabilityId,
    ...(continuationCapabilityId ? { continuationCapabilityId } : {}),
    ...(authenticatedInteractiveCapabilityIds ? { authenticatedInteractiveCapabilityIds } : {}),
    ...(scopeAllowedCapabilityIds ? { scopeAllowedCapabilityIds } : {}),
    catalogRevision: input.catalogRevision,
    catalogDigestSha256: input.catalogDigestSha256,
    expiresAt: input.result.session.expiresAt,
    actorIdentityId: input.actorIdentityId,
    actor: input.actor,
    actorPrivateChatId: input.actorPrivateChatId,
    actorMentionWid: input.actorMentionWid,
    scopeId: input.scopeId,
    origin: input.origin,
    groupWid: input.groupWid,
    scopeEvidence: input.scopeEvidence,
    locale: input.locale,
    choices: choice?.choices ?? [],
    ...(request ? {
      acceptedMessageKinds: request.acceptedMessageKinds,
      acceptedMimeTypes: request.acceptedMimeTypes,
      maximumFileBytes: request.maximumFileBytes,
      maximumFiles: request.maximumFiles,
      mediaChatId: input.mediaChatId
    } : {}),
    ...(input.result.session.timer ? { timer: input.result.session.timer } : {}),
    mediaMessageIds: sameSession ? previousV2?.mediaMessageIds ?? [] : []
  });
  if (parsed.schemaVersion !== 2) throw new Error('Workspace session version changed during validation.');
  const session = parsed;
  if (input.previousSession && !sameSession) {
    await forgetWorkspaceMediaSession(input.store, input.previousSession);
  }
  await storeWorkspaceSession(input.store, session);
  return session;
}

/** Backwards-compatible media-specific entry point for command callers. */
export const rememberWorkspaceMediaSession = rememberWorkspaceSession;

export async function reserveWorkspaceMediaFile(
  store: PluginDataStore,
  session: StoredWorkspaceMediaSession,
  messageId: string
): Promise<{ disposition: 'reserved' | 'duplicate' | 'limit'; session: StoredWorkspaceMediaSession }> {
  if (session.mediaMessageIds.includes(messageId)) {
    return { disposition: 'duplicate', session };
  }
  if (!session.maximumFiles || session.mediaMessageIds.length >= session.maximumFiles) {
    return { disposition: 'limit', session };
  }
  const updated = storedSessionSchema.parse({
    ...session,
    mediaMessageIds: [...session.mediaMessageIds, messageId]
  });
  await storeWorkspaceSession(store, updated);
  return { disposition: 'reserved', session: updated };
}

export async function refreshWorkspaceSessionActions(
  store: PluginDataStore,
  session: Extract<StoredWorkspaceMediaSession, { schemaVersion: 1 }>,
  actions: WorkspaceConnectorAction[]
): Promise<StoredWorkspaceMediaSession> {
  const choice = actions.find((action) => action.kind === 'choice');
  const request = actions.find((action) => action.kind === 'request_media');
  const withoutRequest: Record<string, unknown> = { ...session };
  delete withoutRequest.acceptedMimeTypes;
  delete withoutRequest.maximumFileBytes;
  delete withoutRequest.maximumFiles;
  const parsed = storedSessionSchema.parse({
    ...withoutRequest,
    choices: choice?.choices ?? [],
    ...(request ? {
      acceptedMimeTypes: request.acceptedMimeTypes,
      maximumFileBytes: request.maximumFileBytes,
      maximumFiles: request.maximumFiles
    } : {})
  });
  if (parsed.schemaVersion !== 1) throw new Error('Workspace session version changed during validation.');
  const updated = parsed;
  await storeWorkspaceSession(store, updated);
  return updated;
}

export async function refreshWorkspaceSessionActionsV2(
  store: PluginDataStore,
  session: StoredWorkspaceSessionV2,
  actions: WorkspaceConnectorActionV2[],
  input: { mediaChatId?: string | undefined; timer?: z.infer<typeof WorkspaceConnectorTimerV2Schema> | undefined }
): Promise<StoredWorkspaceSessionV2> {
  const choice = actions.find((action) => action.kind === 'choice');
  const request = actions.find((action) => action.kind === 'request_media');
  const withoutRequest: Record<string, unknown> = { ...session };
  delete withoutRequest.acceptedMessageKinds;
  delete withoutRequest.acceptedMimeTypes;
  delete withoutRequest.maximumFileBytes;
  delete withoutRequest.maximumFiles;
  delete withoutRequest.mediaChatId;
  delete withoutRequest.timer;
  const parsed = storedSessionSchema.parse({
    ...withoutRequest,
    choices: choice?.choices ?? [],
    ...(request ? {
      acceptedMessageKinds: request.acceptedMessageKinds,
      acceptedMimeTypes: request.acceptedMimeTypes,
      maximumFileBytes: request.maximumFileBytes,
      maximumFiles: request.maximumFiles,
      mediaChatId: input.mediaChatId
    } : {}),
    ...(input.timer ? { timer: input.timer } : {})
  });
  if (parsed.schemaVersion !== 2) throw new Error('Workspace session version changed during validation.');
  const updated = parsed;
  await storeWorkspaceSession(store, updated);
  return updated;
}

export async function storeWorkspaceSession(
  store: PluginDataStore,
  session: StoredWorkspaceMediaSession
): Promise<void> {
  await Promise.all(workspaceSessionRouteChatIds(session).map((chatId) =>
    store.set(exactSessionKey(session.actorIdentityId, chatId), session)
  ).concat(store.set(actorSessionKey(session.actorIdentityId), session)));
}

export async function findWorkspaceMediaSession(
  store: PluginDataStore,
  actorIdentityId: string,
  chatId?: string
): Promise<StoredWorkspaceMediaSession | undefined> {
  const keys = [
    ...(chatId ? [exactSessionKey(actorIdentityId, chatId)] : []),
    actorSessionKey(actorIdentityId)
  ];
  for (const key of keys) {
    const parsed = storedSessionSchema.safeParse(await store.get(key));
    if (!parsed.success) continue;
    if (new Date(parsed.data.expiresAt).getTime() <= Date.now()) {
      await forgetWorkspaceMediaSession(store, parsed.data);
      continue;
    }
    return parsed.data;
  }
  return undefined;
}

export async function forgetWorkspaceMediaSession(
  store: PluginDataStore,
  session: StoredWorkspaceMediaSession
): Promise<void> {
  await Promise.all(workspaceSessionRouteChatIds(session).map((chatId) =>
    store.delete(exactSessionKey(session.actorIdentityId, chatId))
  ).concat(store.delete(actorSessionKey(session.actorIdentityId))));
}

export function workspaceSessionRouteChatIds(session: StoredWorkspaceMediaSession): string[] {
  return [...new Set(session.schemaVersion === 1
    ? [session.originatingChatId]
    : [session.origin.chatId, session.actorPrivateChatId, session.mediaChatId].filter(
        (value): value is string => Boolean(value)
      ))];
}

export function workspaceSessionContinuationCapabilityId(session: StoredWorkspaceSessionV2): string {
  return session.continuationCapabilityId ?? session.capabilityId;
}

function immutableCapabilitySnapshot(
  label: string,
  incoming: readonly string[] | undefined,
  existing: readonly string[] | undefined
): string[] | undefined {
  const normalizedIncoming = incoming
    ? [...new Set(incoming.map((value) => value.trim()).filter(Boolean))].sort()
    : undefined;
  const normalizedExisting = existing ? [...existing].sort() : undefined;
  if (
    normalizedIncoming
    && normalizedExisting
    && JSON.stringify(normalizedIncoming) !== JSON.stringify(normalizedExisting)
  ) {
    throw new Error(`Workspace session ${label} changed after creation.`);
  }
  return normalizedExisting ?? normalizedIncoming;
}

function lockedContinuationCapabilityId(input: {
  originatingCapabilityId: string;
  requestedCapabilityId?: string | undefined;
  lockedCapabilityId?: string | undefined;
  authenticatedInteractiveCapabilityIds?: readonly string[] | undefined;
  scopeAllowedCapabilityIds?: readonly string[] | undefined;
}): string | undefined {
  if (
    input.lockedCapabilityId
    && input.requestedCapabilityId
    && input.lockedCapabilityId !== input.requestedCapabilityId
  ) {
    throw new Error('Workspace session continuation capability changed after it was locked.');
  }
  const candidate = input.lockedCapabilityId ?? input.requestedCapabilityId;
  if (!candidate) return undefined;
  const interactiveCapabilityIds = input.authenticatedInteractiveCapabilityIds;
  const allowedCapabilityIds = input.scopeAllowedCapabilityIds;
  if (
    !interactiveCapabilityIds?.includes(candidate)
    || !allowedCapabilityIds?.includes(candidate)
  ) {
    throw new Error('Workspace session continuation capability is not interactive and allowed in the authenticated catalog scope.');
  }
  if (
    !interactiveCapabilityIds.includes(input.originatingCapabilityId)
    || !allowedCapabilityIds.includes(input.originatingCapabilityId)
  ) {
    throw new Error('Workspace session originating capability is not bound to the authenticated catalog scope.');
  }
  return candidate;
}

function exactSessionKey(actorIdentityId: string, chatId: string): string {
  return `media-session:exact:${digest(`${actorIdentityId}\0${chatId}`)}`;
}

function actorSessionKey(actorIdentityId: string): string {
  return `media-session:actor:${digest(actorIdentityId)}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
