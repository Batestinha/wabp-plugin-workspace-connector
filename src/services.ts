import type { PluginServiceRegistration } from '@wabs/plugin-sdk/services';
import type { PluginServiceRegistrationContext } from './runtime';
import { WorkspaceConnectorClient } from './client';
import { parseWorkspaceConnectorConfig, workspaceConnectorConnection } from './config';
import {
  WORKSPACE_CONNECTOR_PROJECTION_REPLACE_METHOD,
  WORKSPACE_CONNECTOR_PROJECTION_SERVICE_ID,
  type WorkspaceConnectorProjectionServiceInput,
  workspaceConnectorProjectionServiceInputSchema,
  workspaceConnectorProjectionServiceOutputSchema
} from './serviceApi';

export function registerWorkspaceConnectorServices(
  context: PluginServiceRegistrationContext
): PluginServiceRegistration[] {
  return [{
    serviceId: WORKSPACE_CONNECTOR_PROJECTION_SERVICE_ID,
    methods: [{
      name: WORKSPACE_CONNECTOR_PROJECTION_REPLACE_METHOD,
      access: 'mutation',
      inputSchema: workspaceConnectorProjectionServiceInputSchema,
      outputSchema: workspaceConnectorProjectionServiceOutputSchema,
      timeoutMs: 30_000,
      async handler(rawInput, call) {
        const input = rawInput as WorkspaceConnectorProjectionServiceInput;
        const scopedConfig = parseWorkspaceConnectorConfig(
          await context.configFor(call.scopeId, call.actorIdentityId)
        );
        if (!scopedConfig.enabled) {
          throw new Error('Workspace connector is disabled for this scope.');
        }
        if (!scopedConfig.allowedCapabilities.includes(input.capabilityId)) {
          throw new Error('Workspace connector capability is not allowed for this scope.');
        }
        const connection = workspaceConnectorConnection(context.config);
        if (!connection) {
          throw new Error('Workspace connector deployment identity is incomplete.');
        }
        return new WorkspaceConnectorClient(connection).replaceProjection({
          protocolVersion: 1,
          installationId: connection.installationId,
          scopeId: call.scopeId,
          ...input
        }, call.signal);
      }
    }]
  }];
}
