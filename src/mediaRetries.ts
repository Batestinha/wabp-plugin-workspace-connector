import { z } from 'zod';
import {
  WorkspaceConnectorMediaUploadMetadataSchema,
  type WorkspaceConnectorMediaUploadMetadata
} from '../../../../packages/workspace-connector-contracts/src';
import type { PluginDataStore } from '../../../platform/pluginRuntime/manager/pluginDataStore';

const RETRY_PREFIX = 'media-retry:v1:';

const mediaRetrySchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1).max(512),
  capabilityId: z.string().min(1).max(160),
  fileId: z.string().min(1).max(512),
  mediaId: z.string().min(1).max(512),
  responseChatId: z.string().min(1).max(512),
  metadata: WorkspaceConnectorMediaUploadMetadataSchema,
  attemptCount: z.number().int().nonnegative().max(1000),
  nextAttemptAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict();

export type WorkspaceMediaRetry = z.infer<typeof mediaRetrySchema>;

export function newWorkspaceMediaRetry(input: {
  sessionId: string;
  capabilityId: string;
  fileId: string;
  mediaId: string;
  responseChatId: string;
  metadata: WorkspaceConnectorMediaUploadMetadata;
  expiresAt: string;
}): WorkspaceMediaRetry {
  return mediaRetrySchema.parse({
    schemaVersion: 1,
    ...input,
    attemptCount: 0,
    nextAttemptAt: new Date().toISOString()
  });
}

export async function storeWorkspaceMediaRetry(
  store: PluginDataStore,
  retry: WorkspaceMediaRetry
): Promise<void> {
  await store.set(retryKey(retry.fileId), mediaRetrySchema.parse(retry));
}

export async function deleteWorkspaceMediaRetry(
  store: PluginDataStore,
  retry: WorkspaceMediaRetry
): Promise<void> {
  await store.delete(retryKey(retry.fileId));
}

export async function dueWorkspaceMediaRetries(
  store: PluginDataStore,
  now = new Date()
): Promise<WorkspaceMediaRetry[]> {
  const records = await store.list();
  return records
    .filter((record) => record.scopeId === null && record.key.startsWith(RETRY_PREFIX))
    .flatMap((record) => {
      const parsed = mediaRetrySchema.safeParse(record.valueJson);
      return parsed.success ? [parsed.data] : [];
    })
    .filter((retry) => new Date(retry.nextAttemptAt).getTime() <= now.getTime());
}

export function rescheduleWorkspaceMediaRetry(
  retry: WorkspaceMediaRetry,
  now = new Date()
): WorkspaceMediaRetry {
  const attemptCount = retry.attemptCount + 1;
  const delayMs = Math.min(15 * 60_000, 5_000 * (2 ** Math.min(8, attemptCount - 1)));
  return mediaRetrySchema.parse({
    ...retry,
    attemptCount,
    nextAttemptAt: new Date(now.getTime() + delayMs).toISOString()
  });
}

function retryKey(fileId: string): string {
  return `${RETRY_PREFIX}${fileId}`;
}
