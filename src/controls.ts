import { defineControl } from '@wabs/plugin-sdk/controls';
import type { ControlDescriptor } from '@wabs/plugin-sdk/controls-types';
import { WORKSPACE_CONNECTOR_PLUGIN_ID } from './manifest';

export const workspaceConnectorControls: ControlDescriptor[] = [
  ...([
    ['otpCodeSeparate', 'Send sign-in codes separately', 'Send only the code first, then quote-reply to it with the explanation. These settings apply to private sign-in, registration, and password recovery for this account. Use the Global scope when present; otherwise, enabled Integration Manager scopes must use matching settings.', true],
    ['otpLoginExplanation', 'Sign-in code explanation', 'Optional explanation sent as a reply to the isolated code. Leave blank for the localized default. Use the Global scope when present; otherwise, keep this setting identical across enabled Integration Manager scopes.', false],
    ['otpRegistrationExplanation', 'Registration code explanation', 'Optional registration explanation sent as a reply to the isolated code. Leave blank for the localized default. Use the Global scope when present; otherwise, keep this setting identical across enabled Integration Manager scopes.', false],
    ['otpRecoveryExplanation', 'Password-recovery code explanation', 'Optional recovery explanation sent as a reply to the isolated code. Leave blank for the localized default. Use the Global scope when present; otherwise, keep this setting identical across enabled Integration Manager scopes.', false]
  ] as const).map(([path, label, description, toggle], index) => defineControl({
    id: `plugin.${WORKSPACE_CONNECTOR_PLUGIN_ID}.${path}`, label, description,
    plane: 'plugin-scope-config', domain: 'official-plugin-settings', section: 'Sign-in codes', order: 40 + index,
    visibility: 'bot_admin', configurable: true,
    storage: { kind: 'plugin-scope-config', pluginId: WORKSPACE_CONNECTOR_PLUGIN_ID, path },
    schema: toggle ? { type: 'boolean' } : { type: 'string', max: 400 },
    ui: toggle ? { widget: 'toggle', helpText: description } : { widget: 'text', multiline: true, helpText: description },
    restartRequirement: 'NO_RESTART', dangerous: false, sensitivity: { sensitive: false, redact: 'none' },
    auditAction: 'operator_console.plugin_config.update', relatedCommandIds: [], relatedActionIds: []
  })),
  defineControl({
    id: `plugin.${WORKSPACE_CONNECTOR_PLUGIN_ID}.enabled`,
    label: 'Enabled',
    description: 'Enable the Integration Manager for this managed scope.',
    plane: 'plugin-scope-config',
    domain: 'official-plugin-settings',
    section: 'Integration Manager',
    order: 10,
    visibility: 'bot_admin',
    configurable: true,
    storage: { kind: 'plugin-scope-config', pluginId: WORKSPACE_CONNECTOR_PLUGIN_ID, path: 'enabled' },
    schema: { type: 'boolean' },
    ui: { widget: 'toggle', helpText: 'Enable the Integration Manager for this managed scope.' },
    restartRequirement: 'NO_RESTART',
    dangerous: false,
    sensitivity: { sensitive: false, redact: 'none' },
    auditAction: 'operator_console.plugin_config.update',
    relatedCommandIds: ['/workspace status'],
    relatedActionIds: []
  }),
  defineControl({
    id: `plugin.${WORKSPACE_CONNECTOR_PLUGIN_ID}.websiteAccountAccess`,
    label: 'Website account access',
    description: 'Allow website registration, account linking and WhatsApp verification codes for this scope.',
    plane: 'plugin-scope-config',
    domain: 'official-plugin-settings',
    section: 'Integration Manager',
    order: 20,
    visibility: 'bot_admin',
    configurable: true,
    storage: { kind: 'plugin-scope-config', pluginId: WORKSPACE_CONNECTOR_PLUGIN_ID, path: 'websiteAccountAccess' },
    schema: { type: 'boolean' },
    ui: { widget: 'toggle', helpText: 'Allow website registration, account linking and WhatsApp verification codes for this scope.' },
    restartRequirement: 'NO_RESTART',
    dangerous: false,
    sensitivity: { sensitive: false, redact: 'none' },
    auditAction: 'operator_console.plugin_config.update',
    relatedCommandIds: ['/workspace status'],
    relatedActionIds: []
  }),
  defineControl({
    id: `plugin.${WORKSPACE_CONNECTOR_PLUGIN_ID}.deliveryChatId`,
    label: 'Delivery chat',
    description: 'Exact WhatsApp chat ID for Workspace deliveries addressed to this configured scope.',
    plane: 'plugin-scope-config',
    domain: 'official-plugin-settings',
    section: 'Integration Manager',
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
