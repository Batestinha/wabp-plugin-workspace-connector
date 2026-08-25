import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  WorkspaceConnectorActorSchema,
  type WorkspaceConnectorAction,
  type WorkspaceConnectorInvocationResult
} from '../../../../packages/workspace-connector-contracts/src';
import type { PluginDataStore } from '../../../platform/pluginRuntime/manager/pluginDataStore';

const storedSessionSchema = z.object({
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
  choices: z.array(z.object({
    id: z.string().trim().min(1).max(512),
    label: z.string().min(1).max(240)
  }).strict()).max(32),
  acceptedMimeTypes: z.array(z.string().min(1).max(160)).min(1).max(64).optional(),
  maximumFileBytes: z.number().int().positive().max(2 ** 31 - 1).optional(),
  maximumFiles: z.number().int().positive().max(1_000).optional(),
  mediaMessageIds: z.array(z.string().min(1).max(512)).max(1_000)
}).strict().superRefine((value, context) => {
  if (value.surface === 'private' && !value.scopeId.startsWith('direct:')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scopeId'],
      message: 'private Workspace sessions require a direct scope'
    });
  }
  if (value.surface === 'group' && !value.groupWid.toLowerCase().endsWith('@g.us')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['groupWid'],
      message: 'group Workspace sessions require a group route'
    });
  }
});

export type StoredWorkspaceMediaSession = z.infer<typeof storedSessionSchema>;

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
  const sameSession = input.previousSession?.sessionId === input.result.sessionId;
  const session = storedSessionSchema.parse({
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
    mediaMessageIds: sameSession ? input.previousSession?.mediaMessageIds ?? [] : []
  });
  if (input.previousSession && !sameSession) {
    await forgetWorkspaceMediaSession(input.store, input.previousSession);
  }
  await storeWorkspaceSession(input.store, session);
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
  session: StoredWorkspaceMediaSession,
  actions: WorkspaceConnectorAction[]
): Promise<StoredWorkspaceMediaSession> {
  const choice = actions.find((action) => action.kind === 'choice');
  const request = actions.find((action) => action.kind === 'request_media');
  const sessionWithoutMediaRequest = { ...session };
  delete sessionWithoutMediaRequest.acceptedMimeTypes;
  delete sessionWithoutMediaRequest.maximumFileBytes;
  delete sessionWithoutMediaRequest.maximumFiles;
  const updated = storedSessionSchema.parse({
    ...sessionWithoutMediaRequest,
    choices: choice?.choices ?? [],
    ...(request ? {
      acceptedMimeTypes: request.acceptedMimeTypes,
      maximumFileBytes: request.maximumFileBytes,
      maximumFiles: request.maximumFiles
    } : {})
  });
  await storeWorkspaceSession(store, updated);
  return updated;
}

async function storeWorkspaceSession(
  store: PluginDataStore,
  session: StoredWorkspaceMediaSession
): Promise<void> {
  await Promise.all([
    store.set(exactSessionKey(session.actorIdentityId, session.originatingChatId), session),
    store.set(actorSessionKey(session.actorIdentityId), session)
  ]);
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
      await store.delete(key);
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
  await Promise.all([
    store.delete(exactSessionKey(session.actorIdentityId, session.originatingChatId)),
    store.delete(actorSessionKey(session.actorIdentityId))
  ]);
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
