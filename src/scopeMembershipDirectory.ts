import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  WorkspaceScopeMembershipReplaceV1Schema,
  workspaceConnectorCanonicalJson,
  type WorkspaceScopeMembershipReceiptV1,
  type WorkspaceScopeMembershipReplaceV1
} from './contracts/workspace-connector-v0.3';
import type { PluginRuntimeContext } from './runtime';

const SCOPE_MEMBERSHIP_STATE_KEY = 'scope-memberships:v1';
const MEMBERSHIP_HEARTBEAT_MS = 2 * 60_000;
const MEMBERSHIP_ADD_ACTIONS = new Set(['join', 'add', 'membership_approved']);
const MEMBERSHIP_REMOVE_ACTIONS = new Set(['leave', 'remove']);

const storedMembershipScopeSchema = z.object({
  scopeId: z.string().min(1),
  memberIdentityIds: z.array(z.string()),
  suspendedIdentityIds: z.array(z.string()).optional(),
  returningIdentityIds: z.array(z.string()).optional()
}).strict();

const storedMembershipGroupSchema = z.object({
  scopeId: z.string().min(1),
  groupWid: z.string().min(1),
  memberIdentityIds: z.array(z.string())
}).strict();

const scopeMembershipStateSchema = z.object({
  generation: z.number().int().nonnegative(),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  publishedAt: z.string().datetime(),
  scopes: z.array(storedMembershipScopeSchema).optional(),
  groups: z.array(storedMembershipGroupSchema).optional(),
  pending: WorkspaceScopeMembershipReplaceV1Schema.optional()
}).strict();

type StoredMembershipScope = z.infer<typeof storedMembershipScopeSchema>;
type StoredMembershipGroup = z.infer<typeof storedMembershipGroupSchema>;
type StoredMembershipState = z.infer<typeof scopeMembershipStateSchema>;

const SNAPSHOT_MAX_AGE_MS = 60_000;

export interface WorkspaceScopeMembershipClient {
  replaceScopeMembershipsV1(
    input: WorkspaceScopeMembershipReplaceV1,
    signal?: AbortSignal
  ): Promise<WorkspaceScopeMembershipReceiptV1>;
}

/** Members from the stored roster. A scope with no stored roster falls back to the host callback. */
export async function scopeMemberIdentityIds(
  context: Partial<Pick<PluginRuntimeContext, 'dataStore' | 'currentMemberIdentityIdsForScope'>>,
  scopeId: string,
  capabilityId?: string
): Promise<string[] | undefined> {
  const stored = scopeMembershipStateSchema.safeParse(await context.dataStore?.get(SCOPE_MEMBERSHIP_STATE_KEY));
  if (!stored.success || !stored.data.scopes) return context.currentMemberIdentityIdsForScope?.(scopeId);
  const scope = stored.data.scopes.find(candidate => candidate.scopeId === scopeId);
  if (!scope) return [];
  return capabilityId === 'account.registration.v1'
    ? [...scope.memberIdentityIds, ...(scope.suspendedIdentityIds ?? [])] : scope.memberIdentityIds;
}

export async function refreshWorkspaceScopeMemberships(
  context: PluginRuntimeContext,
  client: WorkspaceScopeMembershipClient,
  installationId: string
): Promise<boolean> {
  if (readsGroupsOneAtATime(context)) return refreshGroupsOneAtATime(context, client, installationId);
  return refreshScopesFromHostList(context, client, installationId);
}

async function refreshScopesFromHostList(
  context: PluginRuntimeContext,
  client: WorkspaceScopeMembershipClient,
  installationId: string
): Promise<boolean> {
  if (!context.listEnabledScopes || !context.currentMemberIdentityIdsForScope) return false;

  // Timestamp the start of authoritative reads, never the end of cached processing.
  const capturedAt = new Date().toISOString();
  const enabledScopes = await context.listEnabledScopes();
  const stored = scopeMembershipStateSchema.safeParse(await context.dataStore.get(SCOPE_MEMBERSHIP_STATE_KEY));
  let current: StoredMembershipState = stored.success
    ? stored.data
    : {
        generation: 0,
        payloadSha256: '0'.repeat(64),
        publishedAt: new Date(0).toISOString()
      };
  let published = false;
  if (current.pending) {
    await publishPending(context, client, installationId, current.pending);
    current = {
      generation: current.pending.generation,
      payloadSha256: current.pending.payloadSha256,
      publishedAt: current.pending.capturedAt, scopes: current.pending.scopes
    };
    published = true;
  }
  const scopes = await Promise.all(enabledScopes.map(async scope => moderatedMembership(context, scope.scopeId,
    await context.currentMemberIdentityIdsForScope!(scope.scopeId),
    current.scopes?.find(previous => previous.scopeId === scope.scopeId))));
  scopes.sort((left, right) => left.scopeId.localeCompare(right.scopeId));
  const payloadSha256 = createHash('sha256').update(workspaceConnectorCanonicalJson(scopes)).digest('hex');
  if (
    current.payloadSha256 === payloadSha256
    && Date.now() - Date.parse(current.publishedAt) < MEMBERSHIP_HEARTBEAT_MS
  ) {
    return published;
  }

  const generation = current.generation + 1;
  const request: WorkspaceScopeMembershipReplaceV1 = {
    schemaVersion: 1,
    installationId,
    generation,
    capturedAt,
    payloadSha256,
    idempotencyKey: `scope-memberships:${installationId}:${generation}:${payloadSha256}`,
    scopes
  };
  await context.dataStore.set(SCOPE_MEMBERSHIP_STATE_KEY, {
    ...current,
    pending: request
  });
  await publishPending(context, client, installationId, request);
  return true;
}

function readsGroupsOneAtATime(context: PluginRuntimeContext): boolean {
  return Boolean(
    context.listEnabledScopes
    && context.coveredGroupsForScope
    && context.getAuthoritativeGroupParticipantSnapshot
    && context.resolveIdentityAddress
  );
}

/**
 * Read enrolled groups one after another. A group WhatsApp will not read keeps its previous members,
 * and the directory is still published.
 */
async function refreshGroupsOneAtATime(
  context: PluginRuntimeContext,
  client: WorkspaceScopeMembershipClient,
  installationId: string
): Promise<boolean> {
  const listEnabledScopes = context.listEnabledScopes;
  const coveredGroupsForScope = context.coveredGroupsForScope;
  if (!listEnabledScopes || !coveredGroupsForScope) return false;
  const stored = scopeMembershipStateSchema.safeParse(await context.dataStore.get(SCOPE_MEMBERSHIP_STATE_KEY));
  let current: StoredMembershipState = stored.success
    ? stored.data
    : { generation: 0, payloadSha256: '0'.repeat(64), publishedAt: new Date(0).toISOString() };
  if (current.pending) {
    await publishPending(context, client, installationId, current.pending, current.groups);
    current = {
      generation: current.pending.generation,
      payloadSha256: current.pending.payloadSha256,
      publishedAt: current.pending.capturedAt,
      scopes: current.pending.scopes,
      ...(current.groups?.length ? { groups: current.groups } : {})
    };
  }
  const previousScopes = new Map((current.scopes ?? []).map((scope) => [scope.scopeId, scope]));
  const groups = new Map((current.groups ?? []).map((group) => [groupKey(group.scopeId, group.groupWid), group]));
  const enabledScopes = [...await listEnabledScopes()].sort((left, right) => left.scopeId.localeCompare(right.scopeId));
  const enabledScopeIds = new Set(enabledScopes.map((scope) => scope.scopeId));
  let rateLimit: unknown;
  const coveredByScope = new Map<string, string[]>();
  for (const scope of enabledScopes) {
    const covered = [...await coveredGroupsForScope(scope.scopeId)]
      .map((group) => group.groupWid.trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    coveredByScope.set(scope.scopeId, covered);
    const seen = new Set(covered);
    for (const groupWid of covered) {
      const key = groupKey(scope.scopeId, groupWid);
      try {
        groups.set(key, {
          scopeId: scope.scopeId,
          groupWid,
          memberIdentityIds: await readGroupMemberIdentityIds(context, groupWid)
        });
      } catch (error) {
        if (isGroupNotFound(error)) {
          groups.delete(key);
          continue;
        }
        if (isRateLimited(error)) rateLimit ??= error;
      }
    }
    for (const key of [...groups.keys()]) {
      const [scopeId, groupWid] = key.split('\0');
      if (scopeId === scope.scopeId && groupWid && !seen.has(groupWid)) groups.delete(key);
    }
  }
  for (const key of [...groups.keys()]) {
    const scopeId = key.split('\0')[0];
    if (scopeId && !enabledScopeIds.has(scopeId)) groups.delete(key);
  }
  const nextGroups = [...groups.values()].sort((left, right) =>
    left.scopeId.localeCompare(right.scopeId) || left.groupWid.localeCompare(right.groupWid));
  const scopes: StoredMembershipScope[] = [];
  for (const scope of enabledScopes) {
    const covered = coveredByScope.get(scope.scopeId) ?? [];
    const rows = nextGroups.filter((group) => group.scopeId === scope.scopeId);
    const previous = previousScopes.get(scope.scopeId);
    const unread = covered.filter((groupWid) => !groups.has(groupKey(scope.scopeId, groupWid)));
    // Keep the last published union when a group has never been stored and could not be read.
    const memberIdentityIds = previous && unread.length
      ? previous.memberIdentityIds
      : unionIdentityIds(rows);
    scopes.push(await moderatedMembership(context, scope.scopeId, memberIdentityIds, previous));
  }
  const published = await publishScopesIfChanged(context, client, installationId, current, scopes, nextGroups);
  if (rateLimit) throw preservedRateLimit(rateLimit);
  return published;
}

async function readGroupMemberIdentityIds(context: PluginRuntimeContext, groupWid: string): Promise<string[]> {
  const snapshot = await context.getAuthoritativeGroupParticipantSnapshot!(groupWid);
  const observedAt = snapshot.observedAt instanceof Date ? snapshot.observedAt.getTime() : Date.parse(String(snapshot.observedAt));
  const age = Date.now() - observedAt;
  if (snapshot.providerId !== 'whatsmeow' || !snapshot.botWid.trim() || !Number.isFinite(age) || age < -SNAPSHOT_MAX_AGE_MS || age > SNAPSHOT_MAX_AGE_MS) {
    throw new Error('Authoritative group membership is unavailable');
  }
  const identityIds = new Set<string>();
  for (const participant of snapshot.participants) {
    const wid = participant.wid.trim();
    if (!wid) continue;
    const identity = await context.resolveIdentityAddress!(wid);
    const identityId = identity.identityId.trim();
    if (!identityId) throw new Error('Authoritative group membership is unavailable');
    identityIds.add(identityId);
  }
  return [...identityIds].sort((left, right) => left.localeCompare(right));
}

function unionIdentityIds(rows: ReadonlyArray<{ memberIdentityIds: readonly string[] }>): string[] {
  const identityIds = new Set<string>();
  for (const row of rows) for (const identityId of row.memberIdentityIds) identityIds.add(identityId);
  return [...identityIds].sort((left, right) => left.localeCompare(right));
}

function groupKey(scopeId: string, groupWid: string): string {
  return `${scopeId}\0${groupWid}`;
}

function isRateLimited(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return candidate.code === 'rate_overlimit' || candidate.name === 'TransportRateLimitError';
}

function isGroupNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'TransportGroupNotFoundError');
}

function preservedRateLimit(error: unknown): Error {
  const source = error as { code?: unknown; name?: unknown; retryAt?: unknown; retryAfterMs?: unknown };
  const preserved = new Error('Membership repair kept the previous roster for a group WhatsApp would not read');
  preserved.name = typeof source.name === 'string' ? source.name : 'TransportRateLimitError';
  Object.assign(preserved, {
    code: source.code ?? 'rate_overlimit',
    ...(source.retryAt === undefined ? {} : { retryAt: source.retryAt }),
    ...(typeof source.retryAfterMs === 'number' ? { retryAfterMs: source.retryAfterMs } : {}),
    directoryPreserved: true
  });
  return preserved;
}

/**
 * Re-date the last published roster so archive reads stay authorized.
 * This does not read WhatsApp.
 */
export async function heartbeatWorkspaceScopeMemberships(
  context: PluginRuntimeContext,
  client: WorkspaceScopeMembershipClient,
  installationId: string
): Promise<boolean> {
  const stored = scopeMembershipStateSchema.safeParse(
    await context.dataStore.get(SCOPE_MEMBERSHIP_STATE_KEY)
  );
  if (!stored.success) return false;
  if (stored.data.pending) {
    await publishPending(context, client, installationId, stored.data.pending, stored.data.groups);
    return true;
  }
  if (!stored.data.scopes) return false;
  if (Date.now() - Date.parse(stored.data.publishedAt) < MEMBERSHIP_HEARTBEAT_MS) return false;
  const scopes = await Promise.all(stored.data.scopes.map(scope =>
    moderatedMembership(context, scope.scopeId, scope.memberIdentityIds, scope)));
  await publishScopes(context, client, installationId, stored.data, scopes);
  return true;
}

/** Apply one participant event to the stored roster. This does not read WhatsApp. */
export async function noteParticipantMembership(
  context: PluginRuntimeContext,
  client: WorkspaceScopeMembershipClient,
  installationId: string,
  change: { scopeId: string; action: string; identityIds: readonly string[]; groupWid?: string | undefined }
): Promise<boolean> {
  const adding = MEMBERSHIP_ADD_ACTIONS.has(change.action);
  const removing = MEMBERSHIP_REMOVE_ACTIONS.has(change.action);
  if (!adding && !removing) return false;
  const stored = scopeMembershipStateSchema.safeParse(
    await context.dataStore.get(SCOPE_MEMBERSHIP_STATE_KEY)
  );
  if (!stored.success || stored.data.pending || !stored.data.scopes) return false;
  const identityIds = [...new Set(change.identityIds.map((id) => id.trim()).filter(Boolean))];
  if (!identityIds.length) return false;
  const groupWid = change.groupWid?.trim();
  let groups = stored.data.groups?.map((group) => ({ ...group, memberIdentityIds: [...group.memberIdentityIds] }));
  const scopes = [...stored.data.scopes];
  let scope = scopes.find((candidate) => candidate.scopeId === change.scopeId);
  if (!scope) {
    if (!adding) return false;
    scope = { scopeId: change.scopeId, memberIdentityIds: [] };
    scopes.push(scope);
  }
  const target = scope;
  let memberIdentityIds: string[];
  const storedGroup = groups?.find((group) => group.scopeId === change.scopeId && group.groupWid === groupWid);
  if (groups && groupWid && storedGroup) {
    const groupMembers = new Set(storedGroup.memberIdentityIds);
    if (adding) for (const identityId of identityIds) groupMembers.add(identityId);
    else for (const identityId of identityIds) groupMembers.delete(identityId);
    storedGroup.memberIdentityIds = [...groupMembers].sort((left, right) => left.localeCompare(right));
    memberIdentityIds = unionIdentityIds(groups.filter((group) => group.scopeId === change.scopeId));
  } else {
    const members = new Set(target.memberIdentityIds);
    if (adding) for (const identityId of identityIds) members.add(identityId);
    else for (const identityId of identityIds) members.delete(identityId);
    memberIdentityIds = [...members].sort((left, right) => left.localeCompare(right));
  }
  const next = await moderatedMembership(context, target.scopeId, memberIdentityIds, target);
  const index = scopes.findIndex((candidate) => candidate.scopeId === target.scopeId);
  scopes[index] = next;
  scopes.sort((left, right) => left.scopeId.localeCompare(right.scopeId));
  const payloadSha256 = createHash('sha256')
    .update(workspaceConnectorCanonicalJson(scopes))
    .digest('hex');
  if (payloadSha256 === stored.data.payloadSha256) {
    if (groups?.length) {
      await context.dataStore.set(SCOPE_MEMBERSHIP_STATE_KEY, { ...stored.data, groups });
    }
    return false;
  }
  await publishScopes(context, client, installationId, {
    generation: stored.data.generation,
    payloadSha256: stored.data.payloadSha256,
    publishedAt: stored.data.publishedAt,
    ...(groups?.length ? { groups } : {})
  }, scopes);
  return true;
}

async function publishScopesIfChanged(
  context: PluginRuntimeContext,
  client: WorkspaceScopeMembershipClient,
  installationId: string,
  current: StoredMembershipState,
  scopes: StoredMembershipScope[],
  groups: StoredMembershipGroup[]
): Promise<boolean> {
  const payloadSha256 = createHash('sha256').update(workspaceConnectorCanonicalJson(scopes)).digest('hex');
  const retainedGroups = groups.length ? groups : undefined;
  if (current.scopes && current.payloadSha256 === payloadSha256) {
    await context.dataStore.set(SCOPE_MEMBERSHIP_STATE_KEY, {
      generation: current.generation,
      payloadSha256: current.payloadSha256,
      publishedAt: current.publishedAt,
      scopes: current.scopes,
      ...(retainedGroups ? { groups: retainedGroups } : {})
    });
    return false;
  }
  await publishScopes(context, client, installationId, {
    generation: current.generation,
    payloadSha256: current.payloadSha256,
    publishedAt: current.publishedAt,
    ...(retainedGroups ? { groups: retainedGroups } : {})
  }, scopes);
  return true;
}

async function publishScopes(
  context: PluginRuntimeContext,
  client: WorkspaceScopeMembershipClient,
  installationId: string,
  current: { generation: number; payloadSha256: string; publishedAt: string; groups?: StoredMembershipGroup[] | undefined },
  scopes: StoredMembershipScope[]
): Promise<void> {
  const capturedAt = new Date().toISOString();
  const payloadSha256 = createHash('sha256')
    .update(workspaceConnectorCanonicalJson(scopes))
    .digest('hex');
  const generation = current.generation + 1;
  const request: WorkspaceScopeMembershipReplaceV1 = {
    schemaVersion: 1,
    installationId,
    generation,
    capturedAt,
    payloadSha256,
    idempotencyKey: `scope-memberships:${installationId}:${generation}:${payloadSha256}`,
    scopes
  };
  await context.dataStore.set(SCOPE_MEMBERSHIP_STATE_KEY, {
    generation: current.generation,
    payloadSha256: current.payloadSha256,
    publishedAt: current.publishedAt,
    pending: request,
    ...(current.groups?.length ? { groups: current.groups } : {})
  });
  await publishPending(context, client, installationId, request, current.groups);
}

/** A lifted suspension preserves approval while WhatsApp waits for the member to accept an invitation.
 * A pending return carries no membership or archive rights. An expulsion cancels it. */
async function moderatedMembership(context: PluginRuntimeContext, scopeId: string, observed: readonly string[],
  previous?: StoredMembershipScope): Promise<StoredMembershipScope> {
  const standings = await context.memberStandingsForScope?.(scopeId) ?? [];
  const held = new Map(standings.map(row => [row.identityId, row.standing]));
  const members = new Set(observed.filter(id => !held.has(id)));
  const suspended = [...held].filter(([,kind]) => kind === 'suspended').map(([id]) => id).sort();
  const returning = [...new Set([...(previous?.suspendedIdentityIds ?? []), ...(previous?.returningIdentityIds ?? [])])]
    .filter(id => !members.has(id) && !held.has(id)).sort();
  return { scopeId, memberIdentityIds: [...members].sort((left, right) => left.localeCompare(right)),
    ...(suspended.length ? { suspendedIdentityIds: suspended } : {}),
    ...(returning.length ? { returningIdentityIds: returning } : {}) };
}

async function publishPending(
  context: PluginRuntimeContext,
  client: WorkspaceScopeMembershipClient,
  installationId: string,
  request: WorkspaceScopeMembershipReplaceV1,
  groups?: StoredMembershipGroup[] | undefined
): Promise<void> {
  if (request.installationId !== installationId) {
    throw new Error('Workspace scope-membership pending request belongs to another installation.');
  }
  const receipt = await client.replaceScopeMembershipsV1(request);
  if (
    receipt.installationId !== installationId
    || receipt.acceptedGeneration !== request.generation
    || receipt.payloadSha256 !== request.payloadSha256
  ) {
    throw new Error('Workspace scope-membership receipt did not match the published generation.');
  }
  await context.dataStore.set(SCOPE_MEMBERSHIP_STATE_KEY, {
    generation: request.generation,
    payloadSha256: request.payloadSha256,
    publishedAt: request.capturedAt,
    scopes: request.scopes,
    ...(groups?.length ? { groups } : {})
  });
}
