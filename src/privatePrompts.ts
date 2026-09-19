import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FlowPromptLock } from '@wabs/plugin-sdk/flow-prompts';
import type { WorkspaceConnectorClient } from './client';
import { resolveWorkspaceActionRouteV2, workspaceActionsToPluginActionsV2 } from './commands';
import { parseWorkspaceConnectorConfig } from './config';
import { WorkspaceConnectorInvocationResultV2Schema } from './contracts/workspace-connector-v0.3';
import { WORKSPACE_CONNECTOR_SESSION_TIMER_JOB } from './manifest';
import {
  findWorkspaceMediaSession, forgetWorkspaceMediaSession, rememberWorkspaceSessionV2,
  storedSessionV2Schema, storeWorkspaceSession, workspaceSessionContinuationCapabilityId,
  type StoredWorkspaceSessionV2
} from './mediaSessions';
import type { PluginRuntimeContext, WorkspacePromptEngine } from './runtime';

export const WORKSPACE_PRIVATE_CHOICE_PURPOSE = 'workspace-connector.private-choice.v1';
const promptRecordSchema = z.object({
  session: storedSessionV2Schema,
  question: z.string().min(1),
  idempotencyKey: z.string().min(1),
  expiresAt: z.string().datetime(),
  result: WorkspaceConnectorInvocationResultV2Schema.optional(),
  completed: z.boolean().optional()
});
type PromptRecord = z.infer<typeof promptRecordSchema>;
type PromptContext = Pick<PluginRuntimeContext,
  'flowEngine' | 'dataStore' | 'i18n' | 'sendText' | 'configFor' | 'resolveStableIdentityById'
  | 'currentMemberIdentityIdsForScope' | 'coveredGroupsForScope' | 'enqueuePluginJob'>;
const privateSessionOperations = new Map<string, Promise<unknown>>();

/** Serialize this plugin's delivery, reply and cancellation writes within the account runtime. */
export async function withWorkspacePrivateSessionLock<T>(
  context: Pick<PromptContext, 'flowEngine'>, actorIdentityId: string, operation: () => Promise<T>
): Promise<T> {
  if (!context.flowEngine) return operation();
  const key = JSON.stringify([context.flowEngine.workflowRuntimeBindingId, actorIdentityId]);
  const previous = privateSessionOperations.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  privateSessionOperations.set(key, current);
  try { return await current; }
  finally { if (privateSessionOperations.get(key) === current) privateSessionOperations.delete(key); }
}

function promptSubjectId(idempotencyKey: string): string {
  return `workspace-private-choice:${createHash('sha256').update(idempotencyKey).digest('hex')}`;
}

function promptSubjectType(engine: WorkspacePromptEngine): string {
  // WABP's runtime-bound:v1 prompt envelope fences observation and recovery to this account runtime.
  return `runtime-bound:v1:${Buffer.from(JSON.stringify({ version: 1,
    runtimeBindingId: engine.workflowRuntimeBindingId,
    subjectType: WORKSPACE_PRIVATE_CHOICE_PURPOSE, reconciliation: 'generic' })).toString('base64url')}`;
}

export async function workspacePrivatePromptReceipt(
  context: Pick<PromptContext, 'dataStore'>, idempotencyKey: string, actorIdentityId: string, sessionId: string
): Promise<string | undefined> {
  const record = promptRecordSchema.safeParse(await context.dataStore.get(promptSubjectId(idempotencyKey)));
  if (!record.success) return undefined;
  if (record.data.session.actorIdentityId !== actorIdentityId || record.data.session.sessionId !== sessionId) {
    throw new Error('Workspace prompt delivery changed its identity or session binding.');
  }
  const receipt = await context.dataStore.get<string>(`${promptSubjectId(idempotencyKey)}:receipt`);
  if (!receipt && record.data.completed) {
    // A closed host prompt cannot be sent again to reconstruct a missing receipt.
    throw new Error('Completed Workspace prompt is missing its exact delivery receipt.');
  }
  return receipt;
}

export async function markWorkspacePrivateChoiceCompleted(
  context: Pick<PromptContext, 'dataStore'>, session: StoredWorkspaceSessionV2
): Promise<void> {
  const subjectId = session.privatePromptSubjectId;
  if (!subjectId) return;
  const record = promptRecordSchema.parse(await context.dataStore.get(subjectId));
  if (record.session.actorIdentityId !== session.actorIdentityId || record.session.sessionId !== session.sessionId
    || record.session.privatePromptSubjectId !== subjectId || promptSubjectId(record.idempotencyKey) !== subjectId) {
    throw new Error('Workspace prompt completion changed its identity or session binding.');
  }
  await context.dataStore.set(subjectId, { ...record, completed: true });
}

export async function deliverWorkspacePrivateChoice(
  context: PromptContext, session: StoredWorkspaceSessionV2, prompt: string,
  idempotencyKey: string, expiresAt = new Date(session.expiresAt)
): Promise<string> {
  const engine = context.flowEngine;
  if (!engine) throw new Error('Workspace private choices require FlowEngine.');
  const subjectId = promptSubjectId(idempotencyKey);
  const previous = promptRecordSchema.safeParse(await context.dataStore.get(subjectId));
  const receipt = await workspacePrivatePromptReceipt(context, idempotencyKey, session.actorIdentityId, session.sessionId);
  if (receipt) return receipt;
  const bound = { ...session, privatePromptSubjectId: subjectId };
  const record = { ...(previous.success ? previous.data : {}), session: bound,
    question: prompt, idempotencyKey, expiresAt: expiresAt.toISOString() };
  await context.dataStore.set(subjectId, record);
  await storeWorkspaceSession(context.dataStore, bound);
  return persistWorkspacePrivatePromptReceipt(context, record);
}

async function persistWorkspacePrivatePromptReceipt(context: PromptContext, record: PromptRecord): Promise<string> {
  const engine = context.flowEngine;
  if (!engine) throw new Error('Workspace private choices require FlowEngine.');
  const { session, question: prompt, idempotencyKey } = record;
  const subjectId = promptSubjectId(idempotencyKey), expiresAt = new Date(record.expiresAt);
  const delivered = await engine.promptChoice({
    purpose: WORKSPACE_PRIVATE_CHOICE_PURPOSE, subjectType: promptSubjectType(engine), subjectId,
    question: prompt, options: session.choices,
    ...(session.choices.length ? {} : { freeTextOption: { id: 'workspace-text' } }),
    recipientWids: [session.actorPrivateChatId], eligibleVoterIdentityIds: [session.actorIdentityId],
    selectionRule: 'SINGLE', presentation: 'text', announceLock: false,
    expiresAt: new Date(Math.min(expiresAt.getTime(), new Date(session.expiresAt).getTime())),
    questionSendOptions: { idempotencyKey: `workspace-private:${engine.workflowRuntimeBindingId}:${idempotencyKey}`,
      notAfter: expiresAt, waitForServerAck: true },
    t: await context.i18n.translatorForIdentity(session.actorIdentityId, session.scopeId)
  });
  const messageId = delivered.messageIds[0];
  if (!messageId) throw new Error('Workspace private prompt has no delivery receipt.');
  // Keep send receipts separate: a fast human callback can concurrently persist its result.
  await context.dataStore.set(`${subjectId}:receipt`, messageId);
  return messageId;
}

export function registerWorkspacePrivateChoiceHandler(
  context: PromptContext, client: Pick<WorkspaceConnectorClient, 'continueSessionV2'>, installationId: string
): void {
  const engine = context.flowEngine;
  if (!engine) return;
  const running = new Map<string, Promise<boolean>>();
  engine.registerPromptHandler(WORKSPACE_PRIVATE_CHOICE_PURPOSE, lock => {
    const current = running.get(lock.flowPromptId);
    if (current) return current;
    const work = withWorkspacePrivateSessionLock(context, lock.voterIdentityId,
      () => continuePrivateChoice(context, engine, client, installationId, lock))
      .finally(() => running.delete(lock.flowPromptId));
    running.set(lock.flowPromptId, work);
    return work;
  }, { recoverLocked: true });
}

/** Re-prompt persisted pre-FlowEngine choices; never replay or manufacture a user's answer. */
export async function recoverWorkspacePrivateChoices(context: PromptContext, installationId: string): Promise<void> {
  if (!context.flowEngine) return;
  await context.flowEngine.whenTransportReady();
  const actors = new Set<string>();
  for (const row of await context.dataStore.list()) {
    const parsed = storedSessionV2Schema.safeParse(row.valueJson);
    if (!parsed.success || actors.has(parsed.data.actorIdentityId)) continue;
    actors.add(parsed.data.actorIdentityId);
    await adoptWorkspacePrivateChoice(context, installationId, parsed.data.actorIdentityId);
  }
}

export async function adoptWorkspacePrivateChoice(
  context: PromptContext, installationId: string, actorIdentityId: string
): Promise<boolean> {
  return withWorkspacePrivateSessionLock(context, actorIdentityId,
    () => adoptWorkspacePrivateChoiceUnlocked(context, installationId, actorIdentityId));
}

async function adoptWorkspacePrivateChoiceUnlocked(
  context: PromptContext, installationId: string, actorIdentityId: string
): Promise<boolean> {
  const engine = context.flowEngine;
  if (!engine) return false;
  const session = await findWorkspaceMediaSession(context.dataStore, actorIdentityId);
  if (!session || session.schemaVersion !== 2 || session.origin.surface !== 'private'
    || (!session.choices.length && session.timer) || session.acceptedMessageKinds) return false;
  const pending = session.privatePromptSubjectId
    ? promptRecordSchema.safeParse(await context.dataStore.get(session.privatePromptSubjectId)) : undefined;
  if (session.privatePromptSubjectId && (!pending?.success
    || await context.dataStore.get(`${session.privatePromptSubjectId}:receipt`) || pending.data.completed
    || new Date(pending.data.expiresAt).getTime() <= Date.now())) return false;
  const actor = await context.resolveStableIdentityById?.(actorIdentityId);
  const members = await context.currentMemberIdentityIdsForScope?.(session.scopeId);
  const config = parseWorkspaceConnectorConfig(await context.configFor(session.scopeId));
  if (!actor || actor.identityId !== session.actorIdentityId || actor.deliveryChatId !== session.actorPrivateChatId
    || !members?.includes(actorIdentityId) || !config.enabled
    || !config.allowedCapabilities.includes(workspaceSessionContinuationCapabilityId(session))) return false;
  if ((await engine.inspectIdentityFlowStart({ actorIdentityId })).kind !== 'available') return false;
  const t = await context.i18n.translatorForIdentity(actorIdentityId, session.scopeId);
  await deliverWorkspacePrivateChoice(context, session,
    pending?.success ? pending.data.question : t(session.choices.length
      ? 'official.workspace-connector.resumePrivatePrompt' : 'official.workspace-connector.resumePrivateTextPrompt'),
    pending?.success ? pending.data.idempotencyKey : `workspace-private-resume:${installationId}:${actorIdentityId}:${session.sessionId}`,
    pending?.success ? new Date(pending.data.expiresAt) : new Date(session.expiresAt));
  return true;
}

async function continuePrivateChoice(
  context: PromptContext, engine: WorkspacePromptEngine,
  client: Pick<WorkspaceConnectorClient, 'continueSessionV2'>, installationId: string, observed: FlowPromptLock
): Promise<boolean> {
  if (observed.purpose !== WORKSPACE_PRIVATE_CHOICE_PURPOSE || observed.subjectType !== promptSubjectType(engine)) return false;
  const lock = await engine.getLockedPromptLock(observed.flowPromptId);
  if (!lock || lock.subjectId !== observed.subjectId || lock.subjectType !== observed.subjectType
    || lock.purpose !== observed.purpose || !lock.subjectId) return false;
  const parsed = promptRecordSchema.safeParse(await context.dataStore.get(lock.subjectId));
  if (!parsed.success) return false;
  const record = parsed.data, session = record.session;
  if (session.privatePromptSubjectId !== lock.subjectId || session.actorIdentityId !== lock.voterIdentityId
    || lock.selectionRule !== 'SINGLE' || lock.selectedOptions.length !== 1) return false;
  const choice = lock.selectedOptions[0]!;
  if (session.choices.length ? !session.choices.some(option => option.id === choice.id)
    : choice.id !== 'workspace-text' || choice.isFreeText !== true || !choice.label.trim()) return false;
  if (record.completed) { await engine.acknowledgePromptLock(lock.flowPromptId); return true; }

  // Capture the host's durable send receipt before completing this lock: host acknowledgement
  // cancels the prompt, after which an outbox retry cannot recover it through promptChoice.
  if (!await workspacePrivatePromptReceipt(context, record.idempotencyKey, session.actorIdentityId, session.sessionId)) {
    await persistWorkspacePrivatePromptReceipt(context, record);
  }

  const current = await findWorkspaceMediaSession(context.dataStore, session.actorIdentityId);
  if (!record.result && (!current || current.schemaVersion !== 2 || current.sessionId !== session.sessionId
    || current.privatePromptSubjectId !== lock.subjectId)) {
    await engine.acknowledgePromptLock(lock.flowPromptId);
    return true;
  }
  const actor = await context.resolveStableIdentityById?.(session.actorIdentityId);
  const members = await context.currentMemberIdentityIdsForScope?.(session.scopeId);
  const config = parseWorkspaceConnectorConfig(await context.configFor(session.scopeId));
  if (!actor || actor.identityId !== session.actorIdentityId || actor.deliveryChatId !== session.actorPrivateChatId
    || !members?.includes(actor.identityId) || !config.enabled
    || !config.allowedCapabilities.includes(workspaceSessionContinuationCapabilityId(session))) {
    await engine.acknowledgePromptLock(lock.flowPromptId);
    return true;
  }

  if (!record.result) {
    record.result = await client.continueSessionV2({
      protocolVersion: 2, installationId, catalogRevision: session.catalogRevision,
      catalogDigestSha256: session.catalogDigestSha256, sessionId: session.sessionId,
      capabilityId: workspaceSessionContinuationCapabilityId(session), scopeId: session.scopeId,
      origin: session.origin, current: { chatId: session.actorPrivateChatId, surface: 'private' },
      scopeEvidence: { ...session.scopeEvidence, checkedAt: new Date().toISOString() }, locale: session.locale,
      eventId: `flow-prompt:${lock.flowPromptId}`, idempotencyKey: `workspace-choice-v2:${lock.flowPromptId}`,
      actor: { identityId: actor.identityId, ...(actor.phoneNumber ? {
        verifiedWhatsappNumber: actor.phoneNumber.startsWith('+') ? actor.phoneNumber : `+${actor.phoneNumber}`
      } : {}) }, input: session.choices.length
        ? { kind: 'choice', choiceId: choice.id } : { kind: 'text', text: choice.label }
    });
    // Replayed locks reuse the remote result, including after a local send failure.
    await context.dataStore.set(lock.subjectId, record);
  }
  const result = record.result;
  const route = { originChatId: session.origin.chatId, currentChatId: session.actorPrivateChatId,
    scopeId: session.scopeId, actorPrivateChatId: session.actorPrivateChatId, actorMentionWid: session.actorMentionWid };
  const nextChoice = result.actions.find(action => action.kind === 'choice');
  const request = result.actions.find(action => action.kind === 'request_media');
  const nextText = result.session && !nextChoice && !request
    ? [...result.actions].reverse().find(action => action.kind === 'reply') : undefined;
  const nextPrompt = nextChoice ?? nextText;
  const nextKey = `workspace-choice-v2:${lock.flowPromptId}:next`;
  const nextReceipt = result.session && nextPrompt
    ? await workspacePrivatePromptReceipt(context, nextKey, session.actorIdentityId, result.session.sessionId) : undefined;
  let next: StoredWorkspaceSessionV2 | undefined;
  if (result.session && !nextReceipt) {
    const mediaChatId = request ? await resolveWorkspaceActionRouteV2(context, request.route, route) : undefined;
    next = await rememberWorkspaceSessionV2({
      store: context.dataStore, result, actorIdentityId: session.actorIdentityId, actor: session.actor,
      actorPrivateChatId: session.actorPrivateChatId, actorMentionWid: session.actorMentionWid,
      scopeId: session.scopeId, origin: session.origin, groupWid: session.groupWid,
      scopeEvidence: session.scopeEvidence, capabilityId: session.capabilityId, catalogRevision: session.catalogRevision,
      catalogDigestSha256: session.catalogDigestSha256, locale: session.locale,
      ...(mediaChatId ? { mediaChatId } : {}), previousSession: session
    });
  }
  const actions = await workspaceActionsToPluginActionsV2(context,
    result.actions.filter(action => action.kind !== 'choice' && action !== nextText), route);
  for (const [index, action] of actions.entries()) {
    if (action.type !== 'message.sendText' || !context.sendText) throw new Error('Workspace reply delivery unavailable.');
    await context.sendText(action.chatId, action.text, { idempotencyKey: `workspace-choice-v2:${lock.flowPromptId}:reply:${index}`, waitForServerAck: true });
  }
  if (nextPrompt && next && !nextReceipt) {
    const chatId = await resolveWorkspaceActionRouteV2(context, nextPrompt.route, route);
    if (chatId !== session.actorPrivateChatId) throw new Error('Workspace private choice left its bound conversation.');
    await deliverWorkspacePrivateChoice(context, next,
      nextPrompt.kind === 'choice' ? nextPrompt.prompt : nextPrompt.text, nextKey);
  }
  if (next?.timer) {
    if (!context.enqueuePluginJob) throw new Error('Workspace session timer scheduling unavailable.');
    await context.enqueuePluginJob({ jobName: WORKSPACE_CONNECTOR_SESSION_TIMER_JOB, scopeId: next.scopeId, groupWid: next.groupWid,
      runAt: new Date(next.timer.fireAt), payload: { sessionId: next.sessionId, actorIdentityId: next.actorIdentityId, timerId: next.timer.timerId },
      dedupeKey: `${WORKSPACE_CONNECTOR_SESSION_TIMER_JOB}:${next.sessionId}:${next.timer.timerId}` });
  }
  if (!result.session && current?.sessionId === session.sessionId) await forgetWorkspaceMediaSession(context.dataStore, session);
  await context.dataStore.set(lock.subjectId, { ...record, completed: true });
  await engine.acknowledgePromptLock(lock.flowPromptId);
  return true;
}
