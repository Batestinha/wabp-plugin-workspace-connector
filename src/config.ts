import { z } from 'zod';

export const workspaceConnectorConfigSchema = z.object({
  enabled: z.boolean().default(false),
  otpCodeSeparate: z.boolean().default(false),
  otpLoginExplanation: z.string().trim().max(400).default(''),
  otpRecoveryExplanation: z.string().trim().max(400).default(''),
  deliveryChatId: z.union([
    z.literal(''),
    z.string().trim().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._:@\/-]*$/)
  ]).default(''),
  allowedCapabilities: z.array(
    z.string().trim().min(1).max(160).regex(/^[a-z0-9][a-z0-9._:-]*$/)
  ).max(128).default([])
}).strip();

export type WorkspaceConnectorConfig = z.infer<typeof workspaceConnectorConfigSchema>;

export interface WorkspaceConnectorConnection {
  baseUrl: string;
  oidcIssuer: string;
  audience: string;
  clientId: string;
  clientSecret: string;
  installationId: string;
}

export function parseWorkspaceConnectorConfig(input: unknown): WorkspaceConnectorConfig {
  return workspaceConnectorConfigSchema.parse(input);
}

export function workspaceConnectorConnection(
  config: WorkspaceConnectorDeploymentConfig
): WorkspaceConnectorConnection | undefined {
  const candidate = {
    baseUrl: canonicalHttpsBaseUrl(config.WORKSPACE_CONNECTOR_BASE_URL),
    oidcIssuer: config.WORKSPACE_CONNECTOR_OIDC_ISSUER?.trim() ?? '',
    audience: config.WORKSPACE_CONNECTOR_OIDC_AUDIENCE?.trim() ?? '',
    clientId: config.WORKSPACE_CONNECTOR_OIDC_CLIENT_ID?.trim() ?? '',
    clientSecret: config.workspaceConnectorOidcClientSecret?.trim() ?? '',
    installationId: config.WORKSPACE_CONNECTOR_INSTALLATION_ID?.trim() ?? ''
  };
  return Object.values(candidate).every(Boolean) ? candidate : undefined;
}

function canonicalHttpsBaseUrl(input: string | undefined): string {
  const value = input?.trim() ?? '';
  if (!value) return '';
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password ||
    parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname.endsWith('/'))
  ) {
    throw new Error('Workspace connector base URL must be a canonical HTTPS URL without credentials, query, or fragment.');
  }
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export interface WorkspaceConnectorDeploymentConfig {
  WORKSPACE_CONNECTOR_BASE_URL?: string | undefined;
  WORKSPACE_CONNECTOR_OIDC_ISSUER?: string | undefined;
  WORKSPACE_CONNECTOR_OIDC_AUDIENCE?: string | undefined;
  WORKSPACE_CONNECTOR_OIDC_CLIENT_ID?: string | undefined;
  WORKSPACE_CONNECTOR_INSTALLATION_ID?: string | undefined;
  WORKSPACE_CONNECTOR_DELIVERY_POLL_ENABLED?: boolean | undefined;
  workspaceConnectorOidcClientSecret?: string | undefined;
}
