import { defineControl } from '../../../platform/operatorConsole/controlCatalog/define';
import type { ControlDescriptor } from '../../../platform/operatorConsole/controlCatalog/types';
import { WORKSPACE_CONNECTOR_PLUGIN_ID } from './manifest';

export const workspaceConnectorControls: ControlDescriptor[] = [
  defineControl({
    id: `plugin.${WORKSPACE_CONNECTOR_PLUGIN_ID}.enabled`,
    label: 'Enabled',
    description: 'Enable the Workspace connector for this managed scope.',
    plane: 'plugin-scope-config',
    domain: 'official-plugin-settings',
    section: 'Workspace connector',
    order: 10,
    visibility: 'bot_admin',
    configurable: true,
    storage: { kind: 'plugin-scope-config', pluginId: WORKSPACE_CONNECTOR_PLUGIN_ID, path: 'enabled' },
    schema: { type: 'boolean' },
    ui: { widget: 'toggle', helpText: 'Enable the Workspace connector for this managed scope.' },
    restartRequirement: 'NO_RESTART',
    dangerous: false,
    sensitivity: { sensitive: false, redact: 'none' },
    auditAction: 'operator_console.plugin_config.update',
    relatedCommandIds: ['/workspace status'],
    relatedActionIds: []
  }),
  defineControl({
    id: `plugin.${WORKSPACE_CONNECTOR_PLUGIN_ID}.allowedCapabilities`,
    label: 'Allowed capabilities',
    description: 'Exact Workspace capability identifiers this scope may invoke or publish.',
    plane: 'plugin-scope-config',
    domain: 'official-plugin-settings',
    section: 'Workspace connector',
    order: 20,
    visibility: 'bot_admin',
    configurable: true,
    storage: { kind: 'plugin-scope-config', pluginId: WORKSPACE_CONNECTOR_PLUGIN_ID, path: 'allowedCapabilities' },
    schema: { type: 'array', max: 128, items: { type: 'string', min: 1, max: 160 } },
    ui: { widget: 'tags', helpText: 'Exact Workspace capability identifiers this scope may invoke or publish.' },
    restartRequirement: 'NO_RESTART',
    dangerous: false,
    sensitivity: { sensitive: false, redact: 'none' },
    auditAction: 'operator_console.plugin_config.update',
    relatedCommandIds: ['/workspace *'],
    relatedActionIds: []
  }),
  defineControl({
    id: `plugin.${WORKSPACE_CONNECTOR_PLUGIN_ID}.deliveryChatId`,
    label: 'Delivery chat',
    description: 'Exact WhatsApp chat ID for Workspace deliveries addressed to this configured scope.',
    plane: 'plugin-scope-config',
    domain: 'official-plugin-settings',
    section: 'Workspace connector',
    order: 30,
    visibility: 'bot_admin',
    configurable: true,
    storage: { kind: 'plugin-scope-config', pluginId: WORKSPACE_CONNECTOR_PLUGIN_ID, path: 'deliveryChatId' },
    schema: { type: 'string', min: 1, max: 512 },
    ui: { widget: 'text', helpText: 'Only this exact chat receives generic Workspace deliveries for the scope.' },
    restartRequirement: 'NO_RESTART',
    dangerous: false,
    sensitivity: { sensitive: false, redact: 'none' },
    auditAction: 'operator_console.plugin_config.update',
    relatedCommandIds: ['/workspace status'],
    relatedActionIds: []
  })
];
