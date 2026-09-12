import type { IntegrationCommandContext, IntegrationRuntimeContext, IntegrationServiceContext, IntegrationPlugin } from '@wabs/plugin-sdk/integration-plugin';
import type { WorkspaceConnectorDeploymentConfig } from './config';
export type PluginCommandContext = IntegrationCommandContext<WorkspaceConnectorDeploymentConfig>;
export type PluginRuntimeContext = IntegrationRuntimeContext<WorkspaceConnectorDeploymentConfig>;
export type PluginServiceRegistrationContext = IntegrationServiceContext<WorkspaceConnectorDeploymentConfig>;
export type BotPlugin = IntegrationPlugin<WorkspaceConnectorDeploymentConfig>;
