import type { BotPlugin } from './runtime';
import { registerWorkspaceConnectorCommands } from './commands';
import { workspaceConnectorManifest } from './manifest';
import { createWorkspaceConnectorHooks } from './hooks';
import { registerWorkspaceConnectorServices } from './services';
import { registerWorkspaceConnectorCancellations } from './cancellations';

export const workspaceConnectorPlugin: BotPlugin = {
  manifest: workspaceConnectorManifest,
  registerCommands(context) {
    return registerWorkspaceConnectorCommands(context);
  },
  registerCancellations(context) {
    return registerWorkspaceConnectorCancellations(context);
  },
  registerServices(context) {
    return registerWorkspaceConnectorServices(context);
  },
  registerHooks(context) {
    return createWorkspaceConnectorHooks(context);
  }
};

export default workspaceConnectorPlugin;
