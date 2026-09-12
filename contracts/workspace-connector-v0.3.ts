import { z } from 'zod';

export const WORKSPACE_CONNECTOR_PROTOCOL_VERSION = 1 as const;
export const WORKSPACE_CONNECTOR_PROTOCOL_VERSION_V2 = 2 as const;

const id = z.string().trim().min(1).max(160).regex(/^[a-z0-9][a-z0-9._:-]*$/);
const opaqueId = z.string().trim().min(1).max(512);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === 'https:', {
  message: 'HTTPS URL required'
});

export const WorkspaceConnectorCommandAliasSchema = z.object({
  namespace: z.string().trim().min(1).max(48).regex(/^[a-z][a-z0-9-]*$/),
  capabilityId: id,
  contexts: z.array(z.enum(['private', 'group'])).min(1).max(2),
  description: z.string().trim().min(1).max(240)
}).strict();
export type WorkspaceConnectorCommandAlias = z.infer<typeof WorkspaceConnectorCommandAliasSchema>;

export const WorkspaceConnectorCapabilitySchema = z.object({
  capabilityId: id,
  kind: z.enum(['interactive', 'projection']),
  maximumPayloadBytes: z.number().int().positive().max(64 * 1024 * 1024),
  mediaMimeTypes: z.array(z.string().trim().min(1).max(160)).max(64).default([])
}).strict();

export const WorkspaceConnectorCatalogSchema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION),
  workspaceId: id,
  workspaceLabel: z.string().trim().min(1).max(160),
  revision: z.number().int().nonnegative(),
  aliases: z.array(WorkspaceConnectorCommandAliasSchema).max(64),
  capabilities: z.array(WorkspaceConnectorCapabilitySchema).max(128),
  digestSha256: sha256
}).strict().superRefine((value, context) => {
  const capabilities = new Map<string, (typeof value.capabilities)[number]>();
  for (const [index, capability] of value.capabilities.entries()) {
    if (capabilities.has(capability.capabilityId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities', index, 'capabilityId'],
        message: 'capability IDs must be unique'
      });
    }
    capabilities.set(capability.capabilityId, capability);
  }
  const namespaces = new Set<string>();
  for (const [index, alias] of value.aliases.entries()) {
    if (namespaces.has(alias.namespace)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aliases', index, 'namespace'],
        message: 'command namespaces must be unique'
      });
    }
    namespaces.add(alias.namespace);
    if (capabilities.get(alias.capabilityId)?.kind !== 'interactive') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aliases', index, 'capabilityId'],
        message: 'command aliases must reference an interactive capability'
      });
    }
  }
});

export const WorkspaceConnectorActorSchema = z.object({
  identityId: opaqueId,
  verifiedWhatsappNumber: z.string().regex(/^\+[1-9][0-9]{6,14}$/).optional(),
  displayName: z.string().trim().min(1).max(240).optional()
}).strict();

export const WorkspaceConnectorInvocationSchema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION),
  installationId: id,
  catalogRevision: z.number().int().nonnegative(),
  catalogDigestSha256: sha256,
  capabilityId: id,
  scopeId: opaqueId,
  chatId: opaqueId,
  surface: z.enum(['private', 'group']),
  locale: z.string().trim().min(2).max(35),
  eventId: opaqueId,
  messageId: opaqueId,
  idempotencyKey: opaqueId,
  actor: WorkspaceConnectorActorSchema,
  arguments: z.array(z.string().max(2_000)).max(64)
}).strict();

export const WorkspaceConnectorSessionContinuationSchema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION),
  installationId: id,
  catalogRevision: z.number().int().nonnegative(),
  catalogDigestSha256: sha256,
  sessionId: opaqueId,
  capabilityId: id,
  scopeId: opaqueId,
  chatId: opaqueId,
  surface: z.enum(['private', 'group']),
  locale: z.string().trim().min(2).max(35),
  eventId: opaqueId,
  idempotencyKey: opaqueId,
  actor: WorkspaceConnectorActorSchema,
  input: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), text: z.string().max(8_000) }).strict(),
    z.object({ kind: z.literal('choice'), choiceId: opaqueId }).strict(),
    z.object({ kind: z.literal('cancel') }).strict()
  ])
}).strict();

const replyAction = z.object({
  kind: z.literal('reply'),
  text: z.string().min(1).max(8_000)
}).strict();

const openUrlAction = z.object({
  kind: z.literal('open_url'),
  text: z.string().min(1).max(2_000),
  url: httpsUrl
}).strict();

const choiceAction = z.object({
  kind: z.literal('choice'),
  prompt: z.string().min(1).max(4_000),
  choices: z.array(z.object({
    id: opaqueId,
    label: z.string().min(1).max(240)
  }).strict()).min(1).max(32)
}).strict();

const requestMediaAction = z.object({
  kind: z.literal('request_media'),
  prompt: z.string().min(1).max(4_000),
  acceptedMimeTypes: z.array(z.string().min(1).max(160)).min(1).max(64),
  maximumFileBytes: z.number().int().positive().max(2 ** 31 - 1),
  maximumFiles: z.number().int().positive().max(1_000)
}).strict();

export const WorkspaceConnectorActionSchema = z.discriminatedUnion('kind', [
  replyAction,
  openUrlAction,
  choiceAction,
  requestMediaAction,
  z.object({ kind: z.literal('complete'), text: z.string().min(1).max(8_000) }).strict(),
  z.object({ kind: z.literal('denied'), text: z.string().min(1).max(8_000) }).strict()
]);

export const WorkspaceConnectorInvocationResultSchema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION),
  invocationId: opaqueId,
  sessionId: opaqueId.optional(),
  sessionExpiresAt: z.string().datetime().optional(),
  actions: z.array(WorkspaceConnectorActionSchema).min(1).max(16)
}).strict().superRefine((value, context) => {
  const requestsMedia = value.actions.some((action) => action.kind === 'request_media');
  if (
    (value.sessionId === undefined) !== (value.sessionExpiresAt === undefined)
    || (requestsMedia && value.sessionId === undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sessionId'],
      message: 'media requests require one expiring session'
    });
  }
});

export const WorkspaceConnectorProjectionReplaceSchema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION),
  installationId: id,
  capabilityId: id,
  scopeId: opaqueId,
  resourceKey: id,
  generation: z.number().int().positive(),
  payloadSha256: sha256,
  idempotencyKey: opaqueId,
  payload: z.unknown()
}).strict().superRefine((value, context) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value.payload)).byteLength;
  if (bytes > 16 * 1024 * 1024) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['payload'], message: 'projection payload is too large' });
  }
});

export const WorkspaceConnectorProjectionReceiptSchema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION),
  capabilityId: id,
  scopeId: opaqueId,
  resourceKey: id,
  generation: z.number().int().positive(),
  payloadSha256: sha256,
  disposition: z.enum(['accepted', 'idempotent'])
}).strict();

export const WorkspaceConnectorDeliverySchema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION),
  deliveryId: opaqueId,
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('identity'), identityId: opaqueId }).strict(),
    z.object({ kind: z.literal('scope'), scopeId: opaqueId }).strict()
  ]),
  action: z.discriminatedUnion('kind', [replyAction, openUrlAction]),
  idempotencyKey: opaqueId,
  expiresAt: z.string().datetime()
}).strict();

export const WorkspaceConnectorDeliveryClaimResponseSchema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION),
  deliveries: z.array(WorkspaceConnectorDeliverySchema).max(100)
}).strict();

export const WorkspaceConnectorDeliveryAckSchema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION),
  deliveryId: opaqueId,
  disposition: z.enum(['delivered', 'retryable_failure', 'terminal_failure']),
  providerMessageId: opaqueId.optional(),
  safeFailureCode: id.optional()
}).strict();

export const WorkspaceConnectorMediaGrantSchema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION),
  grantId: z.string().uuid(),
  uploadUrl: httpsUrl,
  bearerToken: z.string().min(43).max(512),
  expiresAt: z.string().datetime(),
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(160),
  sizeBytes: z.number().int().positive().max(2 ** 31 - 1),
  sha256
}).strict();

export const WorkspaceConnectorMediaUploadMetadataSchema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION),
  actorIdentityId: opaqueId,
  chatId: opaqueId,
  messageId: opaqueId,
  idempotencyKey: opaqueId,
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(160),
  sizeBytes: z.number().int().positive().max(2 ** 31 - 1),
  sha256
}).strict();

export const WorkspaceConnectorMediaGrantRequestSchema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION),
  installationId: id,
  capabilityId: id,
  sessionId: opaqueId,
  fileId: opaqueId,
  metadata: WorkspaceConnectorMediaUploadMetadataSchema
}).strict();

export const WorkspaceConnectorMediaUploadReceiptSchema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION),
  sessionId: opaqueId,
  fileId: opaqueId,
  disposition: z.enum(['accepted', 'idempotent']),
  sessionState: z.enum(['accepting', 'complete']),
  actions: z.array(WorkspaceConnectorActionSchema).min(1).max(16)
}).strict();

const localizedCatalogText = z.record(
  z.string().trim().min(2).max(35),
  z.string().trim().min(1).max(1_000)
).refine((value) => Object.keys(value).length > 0, {
  message: 'at least one localized value is required'
});

export const WorkspaceConnectorCommandAliasV2Schema = z.object({
  namespace: z.string().trim().min(1).max(48).regex(/^[a-z][a-z0-9-]*$/),
  capabilityId: id,
  contexts: z.array(z.enum(['private', 'group'])).min(1).max(2),
  descriptionByLocale: localizedCatalogText,
  usageByLocale: localizedCatalogText
}).strict();
export type WorkspaceConnectorCommandAliasV2 = z.infer<typeof WorkspaceConnectorCommandAliasV2Schema>;

export const WorkspaceConnectorAmbientTriggerV2Schema = z.object({
  triggerId: id,
  capabilityId: id,
  eventType: id,
  delaySeconds: z.number().int().nonnegative().max(24 * 60 * 60)
}).strict();

export const WorkspaceConnectorCapabilityV2Schema = z.object({
  capabilityId: id,
  interfaces: z.array(z.enum(['interactive', 'projection', 'ambient'])).min(1).max(3)
    .refine((value) => new Set(value).size === value.length, { message: 'interfaces must be unique' }),
  maximumPayloadBytes: z.number().int().positive().max(64 * 1024 * 1024),
  mediaMimeTypes: z.array(z.string().trim().min(1).max(160)).max(64),
  cancellationSupported: z.boolean()
}).strict();

export const WorkspaceConnectorCatalogV2Schema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION_V2),
  workspaceId: id,
  workspaceLabel: z.string().trim().min(1).max(160),
  revision: z.number().int().nonnegative(),
  aliases: z.array(WorkspaceConnectorCommandAliasV2Schema).max(64),
  capabilities: z.array(WorkspaceConnectorCapabilityV2Schema).max(128),
  ambientTriggers: z.array(WorkspaceConnectorAmbientTriggerV2Schema).max(64),
  digestSha256: sha256
}).strict().superRefine((value, context) => {
  const capabilities = new Map<string, (typeof value.capabilities)[number]>();
  for (const [index, capability] of value.capabilities.entries()) {
    if (capabilities.has(capability.capabilityId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities', index, 'capabilityId'],
        message: 'capability IDs must be unique'
      });
    }
    capabilities.set(capability.capabilityId, capability);
  }
  const namespaces = new Set<string>();
  for (const [index, alias] of value.aliases.entries()) {
    if (namespaces.has(alias.namespace)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aliases', index, 'namespace'],
        message: 'command namespaces must be unique'
      });
    }
    namespaces.add(alias.namespace);
    if (!capabilities.get(alias.capabilityId)?.interfaces.includes('interactive')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aliases', index, 'capabilityId'],
        message: 'command aliases must reference an interactive capability'
      });
    }
  }
  const triggerIds = new Set<string>();
  for (const [index, trigger] of value.ambientTriggers.entries()) {
    if (triggerIds.has(trigger.triggerId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ambientTriggers', index, 'triggerId'],
        message: 'ambient trigger IDs must be unique'
      });
    }
    triggerIds.add(trigger.triggerId);
    if (!capabilities.get(trigger.capabilityId)?.interfaces.includes('ambient')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ambientTriggers', index, 'capabilityId'],
        message: 'ambient triggers must reference an ambient capability'
      });
    }
  }
});

export const WorkspaceConnectorScopeEvidenceV2Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('group_membership'),
    scopeId: opaqueId,
    groupChatId: opaqueId,
    actorIsCurrentMember: z.literal(true),
    checkedAt: z.string().datetime()
  }).strict(),
  z.object({
    kind: z.literal('private_resolution'),
    scopeId: opaqueId,
    basis: z.enum(['managed_scope_membership', 'connector_binding']),
    checkedAt: z.string().datetime()
  }).strict(),
  z.object({
    kind: z.literal('system_projection'),
    scopeId: opaqueId,
    checkedAt: z.string().datetime()
  }).strict()
]);

export const WorkspaceConnectorConversationPointV2Schema = z.object({
  chatId: opaqueId,
  surface: z.enum(['private', 'group'])
}).strict();

export const WorkspaceConnectorInvocationV2Schema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION_V2),
  installationId: id,
  catalogRevision: z.number().int().nonnegative(),
  catalogDigestSha256: sha256,
  capabilityId: id,
  scopeId: opaqueId,
  origin: WorkspaceConnectorConversationPointV2Schema,
  current: WorkspaceConnectorConversationPointV2Schema,
  scopeEvidence: WorkspaceConnectorScopeEvidenceV2Schema,
  locale: z.string().trim().min(2).max(35),
  eventId: opaqueId,
  messageId: opaqueId,
  idempotencyKey: opaqueId,
  actor: WorkspaceConnectorActorSchema,
  arguments: z.array(z.string().max(2_000)).max(64)
}).strict().superRefine((value, context) => {
  if (value.scopeEvidence.scopeId !== value.scopeId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scopeEvidence', 'scopeId'],
      message: 'scope evidence must bind the invocation scope'
    });
  }
  if (
    value.scopeEvidence.kind === 'group_membership'
    && value.scopeEvidence.groupChatId !== value.origin.chatId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scopeEvidence', 'groupChatId'],
      message: 'group membership evidence must bind the origin chat'
    });
  }
});

export const WorkspaceConnectorSessionInputV2Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().max(8_000) }).strict(),
  z.object({ kind: z.literal('choice'), choiceId: opaqueId }).strict(),
  z.object({ kind: z.literal('cancel'), reason: z.enum(['user', 'cutover', 'expired']) }).strict(),
  z.object({ kind: z.literal('timer'), timerId: opaqueId, firedAt: z.string().datetime() }).strict()
]);

export const WorkspaceConnectorSessionContinuationV2Schema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION_V2),
  installationId: id,
  catalogRevision: z.number().int().nonnegative(),
  catalogDigestSha256: sha256,
  sessionId: opaqueId,
  capabilityId: id,
  scopeId: opaqueId,
  origin: WorkspaceConnectorConversationPointV2Schema,
  current: WorkspaceConnectorConversationPointV2Schema,
  scopeEvidence: WorkspaceConnectorScopeEvidenceV2Schema,
  locale: z.string().trim().min(2).max(35),
  eventId: opaqueId,
  idempotencyKey: opaqueId,
  actor: WorkspaceConnectorActorSchema,
  input: WorkspaceConnectorSessionInputV2Schema
}).strict().superRefine((value, context) => {
  if (value.scopeEvidence.scopeId !== value.scopeId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scopeEvidence', 'scopeId'],
      message: 'scope evidence must bind the continuation scope'
    });
  }
});

export const WorkspaceConnectorActionRouteV2Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('origin') }).strict(),
  z.object({ kind: z.literal('current') }).strict(),
  z.object({
    kind: z.literal('actor_private'),
    fallback: z.enum(['origin', 'current', 'none'])
  }).strict(),
  z.object({
    kind: z.literal('scope_chat'),
    scopeId: opaqueId,
    chatId: opaqueId
  }).strict()
]);

const replyActionV2 = z.object({
  kind: z.literal('reply'),
  route: WorkspaceConnectorActionRouteV2Schema,
  text: z.string().min(1).max(8_000)
}).strict();

const openUrlActionV2 = z.object({
  kind: z.literal('open_url'),
  route: WorkspaceConnectorActionRouteV2Schema,
  text: z.string().min(1).max(2_000),
  url: httpsUrl
}).strict();

const choiceActionV2 = z.object({
  kind: z.literal('choice'),
  route: WorkspaceConnectorActionRouteV2Schema,
  prompt: z.string().min(1).max(4_000),
  choices: z.array(z.object({
    id: opaqueId,
    label: z.string().min(1).max(240)
  }).strict()).min(1).max(64)
}).strict();

const requestMediaActionV2 = z.object({
  kind: z.literal('request_media'),
  route: WorkspaceConnectorActionRouteV2Schema,
  prompt: z.string().min(1).max(4_000),
  acceptedMessageKinds: z.array(z.enum(['document', 'image', 'video', 'audio']))
    .min(1).max(4)
    .refine((value) => new Set(value).size === value.length, { message: 'message kinds must be unique' }),
  acceptedMimeTypes: z.array(z.string().min(1).max(160)).min(1).max(64),
  maximumFileBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maximumFiles: z.number().int().positive().max(10_000),
  collectionMode: z.enum(['append_until_finalize', 'single_batch'])
}).strict();

export const WorkspaceConnectorActionV2Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('noop') }).strict(),
  replyActionV2,
  openUrlActionV2,
  choiceActionV2,
  requestMediaActionV2,
  z.object({
    kind: z.literal('complete'),
    route: WorkspaceConnectorActionRouteV2Schema,
    text: z.string().min(1).max(8_000)
  }).strict(),
  z.object({
    kind: z.literal('denied'),
    route: WorkspaceConnectorActionRouteV2Schema,
    text: z.string().min(1).max(8_000)
  }).strict()
]);

export const WorkspaceConnectorTimerV2Schema = z.object({
  timerId: opaqueId,
  fireAt: z.string().datetime()
}).strict();

export const WorkspaceConnectorSessionDescriptorV2Schema = z.object({
  sessionId: opaqueId,
  expiresAt: z.string().datetime(),
  continuationCapabilityId: id.optional(),
  timer: WorkspaceConnectorTimerV2Schema.optional()
}).strict();

export const WorkspaceConnectorInvocationResultV2Schema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION_V2),
  invocationId: opaqueId,
  session: WorkspaceConnectorSessionDescriptorV2Schema.optional(),
  actions: z.array(WorkspaceConnectorActionV2Schema).min(1).max(32)
}).strict().superRefine((value, context) => {
  const requestsMedia = value.actions.some((action) => action.kind === 'request_media');
  if (requestsMedia && value.session === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['session'],
      message: 'media requests require one expiring session'
    });
  }
});

export const WorkspaceConnectorAmbientEventV2Schema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION_V2),
  installationId: id,
  catalogRevision: z.number().int().nonnegative(),
  catalogDigestSha256: sha256,
  triggerId: id,
  capabilityId: id,
  eventType: id,
  scopeId: opaqueId,
  origin: WorkspaceConnectorConversationPointV2Schema,
  scopeEvidence: WorkspaceConnectorScopeEvidenceV2Schema,
  locale: z.string().trim().min(2).max(35),
  eventId: opaqueId,
  idempotencyKey: opaqueId,
  actor: WorkspaceConnectorActorSchema,
  observedAt: z.string().datetime(),
  payload: z.unknown()
}).strict().superRefine((value, context) => {
  if (value.scopeEvidence.scopeId !== value.scopeId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scopeEvidence', 'scopeId'],
      message: 'scope evidence must bind the ambient event scope'
    });
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value.payload)).byteLength;
  if (bytes > 1024 * 1024) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['payload'],
      message: 'ambient event payload is too large'
    });
  }
});

export const WorkspaceConnectorMediaUploadMetadataV2Schema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION_V2),
  actorIdentityId: opaqueId,
  chatId: opaqueId,
  messageId: opaqueId,
  messageKind: z.enum(['document', 'image', 'video', 'audio']),
  mediaGroupId: opaqueId.optional(),
  idempotencyKey: opaqueId,
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(160),
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256
}).strict();

export const WorkspaceConnectorMediaGrantRequestV2Schema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION_V2),
  installationId: id,
  capabilityId: id,
  sessionId: opaqueId,
  fileId: opaqueId,
  metadata: WorkspaceConnectorMediaUploadMetadataV2Schema
}).strict();

export const WorkspaceConnectorMediaGrantV2Schema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION_V2),
  grantId: z.string().uuid(),
  uploadUrl: httpsUrl,
  bearerToken: z.string().min(43).max(512),
  expiresAt: z.string().datetime(),
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(160),
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256
}).strict();

export const WorkspaceConnectorMediaUploadReceiptV2Schema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION_V2),
  sessionId: opaqueId,
  fileId: opaqueId,
  disposition: z.enum(['accepted', 'idempotent']),
  sessionState: z.enum(['accepting', 'complete']),
  timer: WorkspaceConnectorTimerV2Schema.optional(),
  actions: z.array(WorkspaceConnectorActionV2Schema).min(1).max(32)
}).strict();

export const WorkspaceConnectorDeliveryMediaGrantV2Schema = z.object({
  grantId: z.string().uuid(),
  downloadUrl: httpsUrl,
  bearerToken: z.string().min(43).max(512),
  expiresAt: z.string().datetime(),
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(160),
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256
}).strict();

const deliveryMediaActionV2 = z.object({
  kind: z.literal('media'),
  caption: z.string().min(1).max(8_000).optional(),
  media: WorkspaceConnectorDeliveryMediaGrantV2Schema
}).strict();

export const WorkspaceConnectorDeliveryV2Schema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION_V2),
  deliveryId: opaqueId,
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('identity'), identityId: opaqueId }).strict(),
    z.object({ kind: z.literal('scope'), scopeId: opaqueId }).strict(),
    z.object({ kind: z.literal('scope_chat'), scopeId: opaqueId, chatId: opaqueId }).strict()
  ]),
  action: z.discriminatedUnion('kind', [replyActionV2.omit({ route: true }), openUrlActionV2.omit({ route: true }), deliveryMediaActionV2]),
  sequence: z.object({
    sequenceId: opaqueId,
    index: z.number().int().nonnegative(),
    total: z.number().int().positive()
  }).strict().superRefine((value, context) => {
    if (value.index >= value.total) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['index'], message: 'sequence index must be less than total' });
    }
  }).optional(),
  idempotencyKey: opaqueId,
  expiresAt: z.string().datetime()
}).strict();

export const WorkspaceConnectorDeliveryClaimResponseV2Schema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION_V2),
  deliveries: z.array(WorkspaceConnectorDeliveryV2Schema).max(100)
}).strict();

export const WorkspaceConnectorDeliveryAckV2Schema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION_V2),
  deliveryId: opaqueId,
  disposition: z.enum(['delivered', 'retryable_failure', 'terminal_failure']),
  providerMessageId: opaqueId.optional(),
  safeFailureCode: id.optional()
}).strict();

export const WorkspaceConnectorScopeDirectoryReplaceV2Schema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION_V2),
  installationId: id,
  generation: z.number().int().positive(),
  payloadSha256: sha256,
  idempotencyKey: opaqueId,
  scopes: z.array(z.object({
    scopeId: opaqueId,
    label: z.string().trim().min(1).max(240),
    chats: z.array(z.object({
      chatId: opaqueId,
      label: z.string().trim().min(1).max(240),
      kind: z.literal('group')
    }).strict()).max(10_000)
  }).strict()).max(10_000)
}).strict();

export const WorkspaceConnectorScopeDirectoryReceiptV2Schema = z.object({
  protocolVersion: z.literal(WORKSPACE_CONNECTOR_PROTOCOL_VERSION_V2),
  installationId: id,
  acceptedGeneration: z.number().int().positive(),
  payloadSha256: sha256,
  appliedAt: z.string().datetime()
}).strict();

export const WorkspaceScopeMembershipReplaceV1Schema = z.object({
  schemaVersion: z.literal(1),
  installationId: id,
  generation: z.number().int().positive(),
  capturedAt: z.string().datetime(),
  payloadSha256: sha256,
  idempotencyKey: opaqueId,
  scopes: z.array(z.object({
    scopeId: opaqueId,
    memberIdentityIds: z.array(opaqueId).max(50_000)
      .refine((values) => new Set(values).size === values.length, {
        message: 'member identity IDs must be unique'
      })
  }).strict()).max(5_000)
}).strict().superRefine((value, context) => {
  const scopeIds = new Set<string>();
  for (const [index, scope] of value.scopes.entries()) {
    if (scopeIds.has(scope.scopeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopes', index, 'scopeId'],
        message: 'scope IDs must be unique'
      });
    }
    scopeIds.add(scope.scopeId);
  }
});

export const WorkspaceScopeMembershipReceiptV1Schema = z.object({
  schemaVersion: z.literal(1),
  installationId: id,
  acceptedGeneration: z.number().int().positive(),
  payloadSha256: sha256,
  appliedAt: z.string().datetime()
}).strict();

export function workspaceConnectorCanonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonicalValue(value));
}

export function workspaceConnectorCatalogDigestPreimage(
  value: { digestSha256: string } & Record<string, unknown>
): string {
  const { digestSha256: _digestSha256, ...catalog } = value;
  return workspaceConnectorCanonicalJson(catalog);
}

function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, sortCanonicalValue(entry)])
    );
  }
  return value;
}

export type WorkspaceConnectorCatalog = z.infer<typeof WorkspaceConnectorCatalogSchema>;
export type WorkspaceConnectorAction = z.infer<typeof WorkspaceConnectorActionSchema>;
export type WorkspaceConnectorInvocation = z.infer<typeof WorkspaceConnectorInvocationSchema>;
export type WorkspaceConnectorInvocationResult = z.infer<typeof WorkspaceConnectorInvocationResultSchema>;
export type WorkspaceConnectorSessionContinuation = z.infer<typeof WorkspaceConnectorSessionContinuationSchema>;
export type WorkspaceConnectorProjectionReplace = z.infer<typeof WorkspaceConnectorProjectionReplaceSchema>;
export type WorkspaceConnectorProjectionReceipt = z.infer<typeof WorkspaceConnectorProjectionReceiptSchema>;
export type WorkspaceConnectorDelivery = z.infer<typeof WorkspaceConnectorDeliverySchema>;
export type WorkspaceConnectorDeliveryAck = z.infer<typeof WorkspaceConnectorDeliveryAckSchema>;
export type WorkspaceConnectorMediaUploadMetadata = z.infer<typeof WorkspaceConnectorMediaUploadMetadataSchema>;
export type WorkspaceConnectorMediaUploadReceipt = z.infer<typeof WorkspaceConnectorMediaUploadReceiptSchema>;
export type WorkspaceConnectorMediaGrantRequest = z.infer<typeof WorkspaceConnectorMediaGrantRequestSchema>;
export type WorkspaceConnectorMediaGrant = z.infer<typeof WorkspaceConnectorMediaGrantSchema>;
export type WorkspaceConnectorCatalogV2 = z.infer<typeof WorkspaceConnectorCatalogV2Schema>;
export type WorkspaceConnectorCapabilityV2 = z.infer<typeof WorkspaceConnectorCapabilityV2Schema>;
export type WorkspaceConnectorInvocationV2 = z.infer<typeof WorkspaceConnectorInvocationV2Schema>;
export type WorkspaceConnectorInvocationResultV2 = z.infer<typeof WorkspaceConnectorInvocationResultV2Schema>;
export type WorkspaceConnectorSessionContinuationV2 = z.infer<typeof WorkspaceConnectorSessionContinuationV2Schema>;
export type WorkspaceConnectorActionV2 = z.infer<typeof WorkspaceConnectorActionV2Schema>;
export type WorkspaceConnectorScopeEvidenceV2 = z.infer<typeof WorkspaceConnectorScopeEvidenceV2Schema>;
export type WorkspaceConnectorAmbientEventV2 = z.infer<typeof WorkspaceConnectorAmbientEventV2Schema>;
export type WorkspaceConnectorMediaUploadMetadataV2 = z.infer<typeof WorkspaceConnectorMediaUploadMetadataV2Schema>;
export type WorkspaceConnectorMediaGrantRequestV2 = z.infer<typeof WorkspaceConnectorMediaGrantRequestV2Schema>;
export type WorkspaceConnectorMediaGrantV2 = z.infer<typeof WorkspaceConnectorMediaGrantV2Schema>;
export type WorkspaceConnectorMediaUploadReceiptV2 = z.infer<typeof WorkspaceConnectorMediaUploadReceiptV2Schema>;
export type WorkspaceConnectorDeliveryV2 = z.infer<typeof WorkspaceConnectorDeliveryV2Schema>;
export type WorkspaceConnectorDeliveryMediaGrantV2 = z.infer<typeof WorkspaceConnectorDeliveryMediaGrantV2Schema>;
export type WorkspaceConnectorDeliveryAckV2 = z.infer<typeof WorkspaceConnectorDeliveryAckV2Schema>;
export type WorkspaceConnectorScopeDirectoryReplaceV2 = z.infer<typeof WorkspaceConnectorScopeDirectoryReplaceV2Schema>;
export type WorkspaceConnectorScopeDirectoryReceiptV2 = z.infer<typeof WorkspaceConnectorScopeDirectoryReceiptV2Schema>;
export type WorkspaceScopeMembershipReplaceV1 = z.infer<typeof WorkspaceScopeMembershipReplaceV1Schema>;
export type WorkspaceScopeMembershipReceiptV1 = z.infer<typeof WorkspaceScopeMembershipReceiptV1Schema>;
