import type { PluginManifest } from '@wabs/plugin-sdk/manifest';
import { workspaceConnectorConfigSchema } from './config';
import { workspaceConnectorMessages } from './messages';
import {
  INVOCATION_SERVICE_ID, LEGACY_PROJECTION_SERVICE_ID,
  WORKSPACE_CONNECTOR_PROJECTION_REPLACE_METHOD,
  WORKSPACE_CONNECTOR_PROJECTION_SERVICE_ID
} from './serviceApi';

export const WORKSPACE_CONNECTOR_PLUGIN_ID = 'official.integration-manager';
export const WORKSPACE_CONNECTOR_SESSION_TIMER_JOB = 'workspace-connector.session-timer';
export const WORKSPACE_CONNECTOR_AMBIENT_JOB = 'workspace-connector.ambient-event';

export const workspaceConnectorManifest: PluginManifest = {
  pluginId: WORKSPACE_CONNECTOR_PLUGIN_ID,
  kind: 'managed_group',
  version: '1.0.1',
  coreApiRange: '^0.3.28',
  messageNamespace: 'official.integration-manager',
  descriptionKey: 'official.integration-manager.description',
  defaultMessages: workspaceConnectorMessages,
  commands: ['/workspace', '/workspace status', '/register'],
  workspaceCapabilities: [
    { capabilityId: 'account.registration.v1', commands: ['/register'], enabledSetting: 'websiteAccountAccess' },
    { capabilityId: 'account.whatsapp-link.v1', enabledSetting: 'websiteAccountAccess' }
  ],
  help: {
    featureId: 'workspace-connector',
    titleKey: 'official.integration-manager.help.feature.title',
    summaryKey: 'official.integration-manager.help.feature.summary',
    order: 110,
    aliases: ['workspace', 'hub'],
    topics: [{
      topicId: 'workspace-status',
      titleKey: 'official.integration-manager.help.status.title',
      summaryKey: 'official.integration-manager.help.status.summary',
      order: 10,
      commands: ['/workspace', '/workspace status'],
      instructionKeys: ['official.integration-manager.help.status.instruction'],
      exampleKeys: ['official.integration-manager.help.status.example'],
      keywords: ['workspace', 'status', 'capability'],
      availability: { invocation: 'group_only', requiredAccessPlane: 'group_member' }
    }, {
      topicId: 'workspace-invoke',
      titleKey: 'official.integration-manager.help.invoke.title',
      summaryKey: 'official.integration-manager.help.invoke.summary',
      order: 20,
      commands: ['/workspace', '/register'],
      instructionKeys: ['official.integration-manager.help.invoke.instruction'],
      exampleKeys: ['official.integration-manager.help.invoke.example'],
      keywords: ['workspace', 'capability', 'register'],
      availability: { invocation: 'either' }
    }]
  },
  eventSubscriptions: ['message', 'private.message', 'participant.change', 'group.scope.covered', 'plugin.job'],
  services: [{
    serviceId: INVOCATION_SERVICE_ID,
    methods: [{ name: 'invoke', access: 'mutation', timeoutMs: 30_000 }]
  }, ...[WORKSPACE_CONNECTOR_PROJECTION_SERVICE_ID, LEGACY_PROJECTION_SERVICE_ID].map(serviceId => ({
    serviceId,
    description: 'Publish an idempotent, generation-fenced projection to the configured Workspace.',
    methods: [{
      name: WORKSPACE_CONNECTOR_PROJECTION_REPLACE_METHOD,
      access: 'mutation' as const,
      timeoutMs: 30_000
    }]
  }))],
  requiredPermissions: [],
  requiredBotCapabilities: [],
  configSchema: workspaceConnectorConfigSchema,
  dangerousActions: [],
  backgroundJobs: [WORKSPACE_CONNECTOR_SESSION_TIMER_JOB, WORKSPACE_CONNECTOR_AMBIENT_JOB],
  cancellation: {
    workflows: [{
      id: 'workspace-remote-session',
      description: 'An active cancellable session owned by the connected Workspace.',
      mode: 'plugin-handler',
      scope: 'actor-chat',
      commands: ['/workspace'],
      cancellableStates: ['active', 'collecting'],
      terminalStates: ['completed', 'cancelled', 'expired', 'failed'],
      effects: ['cancel-remote-session', 'delete-staged-media'],
      auditAction: 'workspace-connector.session.cancel'
    }]
  },
  assistant: {
    summary: 'Application-neutral Workspace capability discovery, invocation, projection publication, outbound delivery, and bounded media handoff.',
    useCases: [
      'Inspect whether the Integration Manager is configured for a managed scope.',
      'Invoke a Workspace-published capability through its current command alias.',
      'Publish generation-fenced projections and deliver generic Workspace replies without embedding application business rules.'
    ],
    prerequisites: [
      'The deployment-scoped Workspace connection and file-backed OIDC client secret must be configured.',
      'The plugin and each required capability must be enabled for the target managed scope.'
    ],
    workflows: [{
      intent: 'workspace_capability',
      description: 'Inspect or invoke a capability declared by the authenticated Workspace catalog.',
      commands: ['/workspace', '/workspace status']
    }]
  }
};
