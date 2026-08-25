import type { PluginManifest } from '../../../platform/pluginRuntime/manifest';
import { workspaceConnectorConfigSchema } from './config';
import { workspaceConnectorMessages } from './messages';
import {
  WORKSPACE_CONNECTOR_PROJECTION_REPLACE_METHOD,
  WORKSPACE_CONNECTOR_PROJECTION_SERVICE_ID
} from './serviceApi';

export const WORKSPACE_CONNECTOR_PLUGIN_ID = 'official.workspace-connector';

export const workspaceConnectorManifest: PluginManifest = {
  pluginId: WORKSPACE_CONNECTOR_PLUGIN_ID,
  kind: 'managed_group',
  version: '0.3.0',
  coreApiRange: '>=0.2.0',
  messageNamespace: 'official.workspace-connector',
  descriptionKey: 'official.workspace-connector.description',
  defaultMessages: workspaceConnectorMessages,
  commands: ['/workspace', '/workspace status'],
  help: {
    featureId: 'workspace-connector',
    titleKey: 'official.workspace-connector.help.feature.title',
    summaryKey: 'official.workspace-connector.help.feature.summary',
    order: 110,
    aliases: ['workspace', 'hub'],
    topics: [{
      topicId: 'workspace-status',
      titleKey: 'official.workspace-connector.help.status.title',
      summaryKey: 'official.workspace-connector.help.status.summary',
      order: 10,
      commands: ['/workspace', '/workspace status'],
      instructionKeys: ['official.workspace-connector.help.status.instruction'],
      exampleKeys: ['official.workspace-connector.help.status.example'],
      keywords: ['workspace', 'status', 'capability'],
      availability: { invocation: 'group_only', requiredAccessPlane: 'group_member' }
    }, {
      topicId: 'workspace-invoke',
      titleKey: 'official.workspace-connector.help.invoke.title',
      summaryKey: 'official.workspace-connector.help.invoke.summary',
      order: 20,
      commands: ['/workspace'],
      instructionKeys: ['official.workspace-connector.help.invoke.instruction'],
      exampleKeys: ['official.workspace-connector.help.invoke.example'],
      keywords: ['workspace', 'capability', 'register'],
      availability: { invocation: 'either' }
    }]
  },
  eventSubscriptions: ['message', 'private.message'],
  services: [{
    serviceId: WORKSPACE_CONNECTOR_PROJECTION_SERVICE_ID,
    description: 'Publish an idempotent, generation-fenced projection to the configured Workspace.',
    methods: [{
      name: WORKSPACE_CONNECTOR_PROJECTION_REPLACE_METHOD,
      access: 'mutation',
      timeoutMs: 30_000
    }]
  }],
  requiredPermissions: [],
  requiredBotCapabilities: [],
  configSchema: workspaceConnectorConfigSchema,
  dangerousActions: [],
  backgroundJobs: [],
  cancellation: { workflows: [] },
  assistant: {
    summary: 'Application-neutral Workspace capability discovery, invocation, projection publication, outbound delivery, and bounded media handoff.',
    useCases: [
      'Inspect whether the Workspace connector is configured for a managed scope.',
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
