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

const scopeMembershipStateSchema = z.object({
  generation: z.number().int().nonnegative(),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  publishedAt: z.string().datetime(),
  pending: WorkspaceScopeMembershipReplaceV1Schema.optional()
}).strict();

export interface WorkspaceScopeMembershipClient {
  replaceScopeMembershipsV1(
    input: WorkspaceScopeMembershipReplaceV1,
    signal?: AbortSignal
  ): Promise<WorkspaceScopeMembershipReceiptV1>;
}

export async function refreshWorkspaceScopeMemberships(
  context: PluginRuntimeContext,
  client: WorkspaceScopeMembershipClient,
  installationId: string
): Promise<boolean> {
  if (!context.listEnabledScopes || !context.currentMemberIdentityIdsForScope) return false;

  const enabledScopes = await context.listEnabledScopes();
  const scopes = await Promise.all(enabledScopes.map(async (scope) => ({
    scopeId: scope.scopeId,
    memberIdentityIds: [...new Set(
      await context.currentMemberIdentityIdsForScope!(scope.scopeId)
    )].sort((left, right) => left.localeCompare(right))
  })));
  scopes.sort((left, right) => left.scopeId.localeCompare(right.scopeId));

  const payloadSha256 = createHash('sha256')
    .update(workspaceConnectorCanonicalJson(scopes))
    .digest('hex');
  const stored = scopeMembershipStateSchema.safeParse(
    await context.dataStore.get(SCOPE_MEMBERSHIP_STATE_KEY)
  );
  let current = stored.success
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
      publishedAt: current.pending.capturedAt
    };
    published = true;
  }
  if (
    current.payloadSha256 === payloadSha256
    && Date.now() - Date.parse(current.publishedAt) < MEMBERSHIP_HEARTBEAT_MS
  ) {
    return published;
  }

  const generation = current.generation + 1;
  const capturedAt = new Date().toISOString();
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

async function publishPending(
  context: PluginRuntimeContext,
  client: WorkspaceScopeMembershipClient,
  installationId: string,
  request: WorkspaceScopeMembershipReplaceV1
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
    publishedAt: request.capturedAt
  });
}
