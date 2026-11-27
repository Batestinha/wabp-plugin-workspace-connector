import { isPluginServiceNotInvokedError } from '@wabs/plugin-sdk/services';
import {
  WorkspaceConnectorCapabilityContextV2Schema,
  type WorkspaceConnectorInvocationV2
} from './contracts/workspace-connector-v0.3';
import type { PluginRuntimeContext } from './runtime';

type CapabilityOperation =
  | { operation: 'invoke'; args: string[] }
  | { operation: 'choice'; choiceId: string };

/** The enabled owner may supply typed application data for the authenticated request. */
export async function workspaceCapabilityContext(
  context: Pick<PluginRuntimeContext, 'catalog' | 'services'>,
  binding: {
    owner: string; capabilityId: string; scopeId: string; actorIdentityId: string;
    groupWid?: string | undefined; signal?: AbortSignal | undefined;
  },
  operation: CapabilityOperation
): Promise<Pick<WorkspaceConnectorInvocationV2, 'capabilityContext'>> {
  if (!context.services) return {};
  const { owner, capabilityId, ...scope } = binding;
  const serviceId = `${owner}.capability-context.v1`;
  const declared = context.catalog?.listManifests().find(manifest => manifest.pluginId === owner);
  if (!declared?.services?.some(service => service.serviceId === serviceId &&
      service.methods.some(method => method.name === 'prepare' && method.access === 'read'))) return {};
  try {
    const result = await context.services.call({
      ...scope, serviceId, method: 'prepare', input: { capabilityId, ...operation }
    });
    return result === null ? {} : { capabilityContext: WorkspaceConnectorCapabilityContextV2Schema.parse(result) };
  } catch (error) {
    if (isPluginServiceNotInvokedError(error)) return {};
    throw error;
  }
}
