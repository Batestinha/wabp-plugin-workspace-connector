import { z } from 'zod';
import { WorkspaceConnectorProjectionReceiptSchema } from './contracts/workspace-connector-v0.3';

export const WORKSPACE_CONNECTOR_PROJECTION_SERVICE_ID = 'official.integration-manager.projection.v1';
export const LEGACY_PROJECTION_SERVICE_ID = 'official.workspace-connector.projection.v1';
export const INVOCATION_SERVICE_ID = 'official.integration-manager.capability.v1';
export const MESSAGE_LINK_SERVICE_ID = 'official.integration-manager.message-links.v1';
export const messageLinkInput = z.discriminatedUnion('target', [
  z.object({ target: z.literal('calendarPage'), resourceKey: z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9._:-]*$/) }).strict(),
  z.object({ target: z.literal('archiveOrigin') }).strict()
]);
export const messageLinkOutput = z.object({
  url: z.string().max(2048).url().refine(value => {
    const url = URL.canParse(value) ? new URL(value) : undefined;
    return url?.protocol === 'https:' && !url.username && !url.password && !url.hash;
  }).nullable()
}).strict();
export type MessageLinkInput = z.infer<typeof messageLinkInput>;
export const invocationInput = z.object({
  capabilityId: z.string().min(1).max(160),
  command: z.string().regex(/^[a-z][a-z0-9-]*$/),
  messageId: z.string().min(1).max(512),
  chatId: z.string().min(1).max(512),
  surface: z.enum(['private', 'group']),
  args: z.array(z.string().max(8000)).max(128)
}).strict();

export const WORKSPACE_CONNECTOR_PROJECTION_REPLACE_METHOD = 'replace';

export const workspaceConnectorProjectionServiceInputSchema = z.object({
  capabilityId: z.string().trim().min(1).max(160).regex(/^[a-z0-9][a-z0-9._:-]*$/),
  resourceKey: z.string().trim().min(1).max(160).regex(/^[a-z0-9][a-z0-9._:-]*$/),
  generation: z.number().int().positive(),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().trim().min(1).max(512),
  payload: z.unknown()
}).strict();

export const workspaceConnectorProjectionServiceOutputSchema = WorkspaceConnectorProjectionReceiptSchema;
export type WorkspaceConnectorProjectionServiceInput = z.infer<typeof workspaceConnectorProjectionServiceInputSchema>;
