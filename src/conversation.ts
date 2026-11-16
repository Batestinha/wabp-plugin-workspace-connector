import type { WorkspaceConnectorInvocationResultV2 } from './contracts/workspace-connector-v0.3';

/** Personal setup stays private; explicit scope publications keep their authorized destination. */
export function privateWorkspaceConversation<T extends { actions: WorkspaceConnectorInvocationResultV2['actions'] }>(result: T): T {
  return { ...result, actions: result.actions.map(action => action.kind !== 'noop' && action.route.kind !== 'scope_chat'
    ? { ...action, route: { kind: 'actor_private' as const, fallback: 'none' as const } } : action) };
}
