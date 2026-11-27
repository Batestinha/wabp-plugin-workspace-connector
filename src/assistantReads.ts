import { z } from 'zod';
import type { PluginServiceDeclaration, PluginServiceRegistration } from '@wabs/plugin-sdk/services';
import { workspaceConnectorConnection } from './config';
import type { PluginServiceRegistrationContext } from './runtime';
import { workspaceScope } from './ownership';

export const hubReadDeclaration: PluginServiceDeclaration = {
  serviceId: 'official.integration-manager.assistant.v1',
  methods: [{ name: 'hub', access: 'read', assistantRead: {
    name: 'official.integration-manager.hub', descriptionKey: 'official.integration-manager.assistant.read.hub',
    allowScopeMembers: true
  } }]
};

export function registerHubRead(context: PluginServiceRegistrationContext): PluginServiceRegistration {
  return { serviceId: hubReadDeclaration.serviceId, methods: [{
    name: 'hub', access: 'read', inputSchema: z.object({}).strict(),
    outputSchema: z.object({ url: z.string().url().nullable() }).strict(),
    assistantSchema: { input: { type: 'object', additionalProperties: false, properties: {} }, output: { type: 'object' } },
    async handler(_input, call) {
      const scope = await workspaceScope(context, call.scopeId, call.actorIdentityId);
      return { url: scope.enabled ? workspaceConnectorConnection(context.config)?.baseUrl ?? null : null };
    }
  }] };
}
