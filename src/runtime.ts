import type { ManagedGroupCapabilities } from '@wabs/plugin-sdk/managed-group-plugin';
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
export type PluginCommandContext = IntegrationCommandContext<WorkspaceConnectorDeploymentConfig> & Pick<ManagedGroupCapabilities, 'catalog'> & {
  flowEngine?: WorkspacePromptEngine | undefined;
};
export type PluginRuntimeContext = IntegrationRuntimeContext<WorkspaceConnectorDeploymentConfig> & Pick<ManagedGroupCapabilities, 'catalog'> & {
  flowEngine?: WorkspacePromptEngine | undefined;
  /** WABP core API 0.3.24: active moderation standings of a scope where this plugin is enabled. */
  memberStandingsForScope?: ((scopeId: string) => Promise<Array<{ identityId: string; standing: 'suspended' | 'expelled' }>>) | undefined;
  getAuthoritativeGroupParticipantSnapshot?: ((groupWid: string) => Promise<{
    participants: ReadonlyArray<{ wid: string }>;
    providerId: string;
    observedAt: Date;
    botWid: string;
  }>) | undefined;
  resolveIdentityAddress?: ((wid: string) => Promise<{ identityId: string }>) | undefined;
};
export type PluginServiceRegistrationContext = IntegrationServiceContext<WorkspaceConnectorDeploymentConfig> &
  Pick<PluginRuntimeContext, 'catalog'> & Partial<Pick<PluginRuntimeContext, 'flowEngine' | 'dataStore' | 'enqueuePluginJob' |
    'coveredGroupsForScope' | 'currentMemberIdentityIdsForScope' | 'resolveStableIdentityById' | 'i18n'>>;
export type BotPlugin = IntegrationPlugin<WorkspaceConnectorDeploymentConfig>;
