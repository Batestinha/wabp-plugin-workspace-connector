import type { IntegrationCommandContext, IntegrationRuntimeContext, IntegrationServiceContext, IntegrationPlugin } from '@wabs/plugin-sdk/integration-plugin';
import type { WorkspaceConnectorDeploymentConfig } from './config';
import type { PluginFlowEngine, FlowIdentityStartInspection } from '@wabs/plugin-sdk/flow-engine';
import type { FlowPromptLock, FlowPromptPromptInput, FlowPromptPromptResult } from '@wabs/plugin-sdk/flow-prompts';

/** Host capabilities already available at runtime but absent from the pinned integration SDK context. */
export interface WorkspacePromptEngine extends Pick<PluginFlowEngine, 'registerPromptHandler'> {
  readonly workflowRuntimeBindingId: string;
  whenTransportReady(): Promise<void>;
  promptChoice(input: FlowPromptPromptInput): Promise<FlowPromptPromptResult>;
  getLockedPromptLock(id: string): Promise<FlowPromptLock | undefined>;
  acknowledgePromptLock(id: string): Promise<boolean>;
  cancelPromptBySubject(input: { purpose: string; subjectId: string; includeLocked?: boolean }): Promise<number>;
  inspectIdentityFlowStart(input: { actorIdentityId: string }): Promise<FlowIdentityStartInspection>;
}
export type PluginCommandContext = IntegrationCommandContext<WorkspaceConnectorDeploymentConfig> & {
  flowEngine?: WorkspacePromptEngine | undefined;
};
export type PluginRuntimeContext = IntegrationRuntimeContext<WorkspaceConnectorDeploymentConfig> & {
  flowEngine?: WorkspacePromptEngine | undefined;
};
export type PluginServiceRegistrationContext = IntegrationServiceContext<WorkspaceConnectorDeploymentConfig>;
export type BotPlugin = IntegrationPlugin<WorkspaceConnectorDeploymentConfig>;
