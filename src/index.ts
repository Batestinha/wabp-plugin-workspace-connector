import type { BotPlugin } from '../../../platform/pluginRuntime/types';
import { registerWorkspaceConnectorCommands } from './commands';
import { workspaceConnectorManifest } from './manifest';
import { createWorkspaceConnectorHooks } from './hooks';
import { registerWorkspaceConnectorServices } from './services';

export const workspaceConnectorPlugin: BotPlugin = {
  manifest: workspaceConnectorManifest,
  registerCommands(context) {
    return registerWorkspaceConnectorCommands(context);
  },
  registerServices(context) {
    return registerWorkspaceConnectorServices(context);
  },
  registerHooks(context) {
    return createWorkspaceConnectorHooks(context);
  }
};

export default workspaceConnectorPlugin;
