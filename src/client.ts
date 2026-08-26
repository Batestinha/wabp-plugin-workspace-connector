import { z } from 'zod';
import {
  WorkspaceConnectorCatalogSchema,
  WorkspaceConnectorDeliveryAckSchema,
  WorkspaceConnectorDeliveryClaimResponseSchema,
  WorkspaceConnectorInvocationResultSchema,
  WorkspaceConnectorInvocationSchema,
  WorkspaceConnectorSessionContinuationSchema,
  WorkspaceConnectorMediaUploadMetadataSchema,
  WorkspaceConnectorMediaGrantRequestSchema,
  WorkspaceConnectorMediaGrantSchema,
  WorkspaceConnectorMediaUploadReceiptSchema,
  WorkspaceConnectorProjectionReceiptSchema,
  WorkspaceConnectorProjectionReplaceSchema,
  WorkspaceConnectorScopeDirectoryReceiptV2Schema,
  WorkspaceConnectorScopeDirectoryReplaceV2Schema,
  WorkspaceConnectorAmbientEventV2Schema,
  WorkspaceConnectorCatalogV2Schema,
  WorkspaceConnectorDeliveryAckV2Schema,
  WorkspaceConnectorDeliveryClaimResponseV2Schema,
  WorkspaceConnectorDeliveryMediaGrantV2Schema,
  WorkspaceConnectorInvocationResultV2Schema,
  WorkspaceConnectorInvocationV2Schema,
  WorkspaceConnectorMediaGrantRequestV2Schema,
  WorkspaceConnectorMediaGrantV2Schema,
  WorkspaceConnectorMediaUploadReceiptV2Schema,
  WorkspaceConnectorSessionContinuationV2Schema,
  type WorkspaceConnectorCatalog,
  type WorkspaceConnectorCatalogV2,
  type WorkspaceConnectorDeliveryAck,
  type WorkspaceConnectorDelivery,
  type WorkspaceConnectorInvocation,
  type WorkspaceConnectorInvocationResult,
  type WorkspaceConnectorSessionContinuation,
  type WorkspaceConnectorMediaUploadMetadata,
  type WorkspaceConnectorMediaUploadReceipt,
  type WorkspaceConnectorMediaGrantRequest,
  type WorkspaceConnectorMediaGrant,
  type WorkspaceConnectorProjectionReceipt,
  type WorkspaceConnectorProjectionReplace,
  type WorkspaceConnectorAmbientEventV2,
  type WorkspaceConnectorDeliveryAckV2,
  type WorkspaceConnectorDeliveryMediaGrantV2,
  type WorkspaceConnectorDeliveryV2,
  type WorkspaceConnectorInvocationResultV2,
  type WorkspaceConnectorInvocationV2,
  type WorkspaceConnectorMediaGrantRequestV2,
  type WorkspaceConnectorMediaGrantV2,
  type WorkspaceConnectorScopeDirectoryReceiptV2,
  type WorkspaceConnectorScopeDirectoryReplaceV2,
  type WorkspaceConnectorSessionContinuationV2
} from '../../../../packages/workspace-connector-contracts/src';
import {
  OidcClientCredentialsTokenProvider,
  type ClientCredentialsTokenProvider
} from '../../../platform/identity/clientCredentialsTokenProvider';
import type { WorkspaceConnectorConnection } from './config';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MEDIA_UPLOAD_TIMEOUT_MS = 10 * 60_000;

export class WorkspaceConnectorClient {
  readonly #connection: WorkspaceConnectorConnection;
  readonly #tokens: ClientCredentialsTokenProvider;
  readonly #fetch: typeof fetch;

  constructor(connection: WorkspaceConnectorConnection, options: {
    tokens?: ClientCredentialsTokenProvider;
    fetch?: typeof fetch;
  } = {}) {
    this.#connection = connection;
    this.#tokens = options.tokens ?? new OidcClientCredentialsTokenProvider({
      issuer: connection.oidcIssuer,
      clientId: connection.clientId,
      clientSecret: connection.clientSecret
    });
    this.#fetch = options.fetch ?? fetch;
  }

  catalog(signal?: AbortSignal): Promise<WorkspaceConnectorCatalog> {
    return this.#request('/v1/workspace-connector/v1/catalog', {
      method: 'GET', ...(signal ? { signal } : {})
    }, WorkspaceConnectorCatalogSchema);
  }

  catalogV2(signal?: AbortSignal): Promise<WorkspaceConnectorCatalogV2> {
    return this.#request('/v1/workspace-connector/v2/catalog', {
      method: 'GET', ...(signal ? { signal } : {})
    }, WorkspaceConnectorCatalogV2Schema);
  }

  invoke(input: WorkspaceConnectorInvocation, signal?: AbortSignal): Promise<WorkspaceConnectorInvocationResult> {
    return this.#request('/v1/workspace-connector/v1/invocations', {
      method: 'POST', body: JSON.stringify(WorkspaceConnectorInvocationSchema.parse(input)), ...(signal ? { signal } : {})
    }, WorkspaceConnectorInvocationResultSchema);
  }

  invokeV2(
    input: WorkspaceConnectorInvocationV2,
    signal?: AbortSignal
  ): Promise<WorkspaceConnectorInvocationResultV2> {
    return this.#request('/v1/workspace-connector/v2/invocations', {
      method: 'POST',
      body: JSON.stringify(WorkspaceConnectorInvocationV2Schema.parse(input)),
      ...(signal ? { signal } : {})
    }, WorkspaceConnectorInvocationResultV2Schema);
  }

  continueSession(
    input: WorkspaceConnectorSessionContinuation,
    signal?: AbortSignal
  ): Promise<WorkspaceConnectorInvocationResult> {
    const parsed = WorkspaceConnectorSessionContinuationSchema.parse(input);
    return this.#request(
      `/v1/workspace-connector/v1/sessions/${encodeURIComponent(parsed.sessionId)}/continue`,
      {
        method: 'POST',
        body: JSON.stringify(parsed),
        ...(signal ? { signal } : {})
      },
      WorkspaceConnectorInvocationResultSchema
    );
  }

  continueSessionV2(
    input: WorkspaceConnectorSessionContinuationV2,
    signal?: AbortSignal
  ): Promise<WorkspaceConnectorInvocationResultV2> {
    const parsed = WorkspaceConnectorSessionContinuationV2Schema.parse(input);
    return this.#request(
      `/v1/workspace-connector/v2/sessions/${encodeURIComponent(parsed.sessionId)}/continue`,
      {
        method: 'POST',
        body: JSON.stringify(parsed),
        ...(signal ? { signal } : {})
      },
      WorkspaceConnectorInvocationResultV2Schema
    );
  }

  publishAmbientEventV2(
    input: WorkspaceConnectorAmbientEventV2,
    signal?: AbortSignal
  ): Promise<WorkspaceConnectorInvocationResultV2> {
    return this.#request('/v1/workspace-connector/v2/events', {
      method: 'POST',
      body: JSON.stringify(WorkspaceConnectorAmbientEventV2Schema.parse(input)),
      ...(signal ? { signal } : {})
    }, WorkspaceConnectorInvocationResultV2Schema);
  }

  replaceScopeDirectoryV2(
    input: WorkspaceConnectorScopeDirectoryReplaceV2,
    signal?: AbortSignal
  ): Promise<WorkspaceConnectorScopeDirectoryReceiptV2> {
    return this.#request('/v1/workspace-connector/v2/scope-directory', {
      method: 'POST',
      body: JSON.stringify(WorkspaceConnectorScopeDirectoryReplaceV2Schema.parse(input)),
      ...(signal ? { signal } : {})
    }, WorkspaceConnectorScopeDirectoryReceiptV2Schema);
  }

  replaceProjection(input: WorkspaceConnectorProjectionReplace, signal?: AbortSignal): Promise<WorkspaceConnectorProjectionReceipt> {
    return this.#request('/v1/workspace-connector/v1/projections', {
      method: 'POST', body: JSON.stringify(WorkspaceConnectorProjectionReplaceSchema.parse(input)), ...(signal ? { signal } : {})
    }, WorkspaceConnectorProjectionReceiptSchema);
  }

  async claimDeliveries(limit = 20, signal?: AbortSignal): Promise<WorkspaceConnectorDelivery[]> {
    const response = await this.#request(`/v1/workspace-connector/v1/deliveries?limit=${Math.max(1, Math.min(100, limit))}`, {
      method: 'GET', ...(signal ? { signal } : {})
    }, WorkspaceConnectorDeliveryClaimResponseSchema);
    return response.deliveries;
  }

  async claimDeliveriesV2(limit = 20, signal?: AbortSignal): Promise<WorkspaceConnectorDeliveryV2[]> {
    const response = await this.#request(
      `/v1/workspace-connector/v2/deliveries?limit=${Math.max(1, Math.min(100, limit))}`,
      { method: 'GET', ...(signal ? { signal } : {}) },
      WorkspaceConnectorDeliveryClaimResponseV2Schema
    );
    return response.deliveries;
  }

  async acknowledgeDelivery(input: WorkspaceConnectorDeliveryAck, signal?: AbortSignal): Promise<void> {
    await this.#requestEmpty('/v1/workspace-connector/v1/deliveries/ack', {
      method: 'POST',
      body: JSON.stringify(WorkspaceConnectorDeliveryAckSchema.parse(input)),
      ...(signal ? { signal } : {})
    });
  }

  async acknowledgeDeliveryV2(input: WorkspaceConnectorDeliveryAckV2, signal?: AbortSignal): Promise<void> {
    await this.#requestEmpty('/v1/workspace-connector/v2/deliveries/ack', {
      method: 'POST',
      body: JSON.stringify(WorkspaceConnectorDeliveryAckV2Schema.parse(input)),
      ...(signal ? { signal } : {})
    });
  }

  uploadMedia(
    sessionId: string,
    fileId: string,
    metadata: WorkspaceConnectorMediaUploadMetadata,
    body: Buffer,
    signal?: AbortSignal
  ): Promise<WorkspaceConnectorMediaUploadReceipt> {
    const parsed = WorkspaceConnectorMediaUploadMetadataSchema.parse(metadata);
    if (body.byteLength !== parsed.sizeBytes) {
      throw new Error('Workspace media bytes did not match their declared size.');
    }
    return this.#request(
      `/v1/workspace-connector/v1/media-sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`,
      {
        method: 'PUT',
        body: Uint8Array.from(body).buffer,
        headers: {
          'content-type': 'application/octet-stream',
          'x-workspace-media-metadata': Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url')
        },
        ...(signal ? { signal } : {})
      },
      WorkspaceConnectorMediaUploadReceiptSchema
    );
  }

  requestMediaGrant(
    input: WorkspaceConnectorMediaGrantRequest,
    signal?: AbortSignal
  ): Promise<WorkspaceConnectorMediaGrant> {
    return this.#request('/v1/workspace-connector/v1/media-grants', {
      method: 'POST',
      body: JSON.stringify(WorkspaceConnectorMediaGrantRequestSchema.parse(input)),
      ...(signal ? { signal } : {})
    }, WorkspaceConnectorMediaGrantSchema);
  }

  requestMediaGrantV2(
    input: WorkspaceConnectorMediaGrantRequestV2,
    signal?: AbortSignal
  ): Promise<WorkspaceConnectorMediaGrantV2> {
    return this.#request('/v1/workspace-connector/v2/media-grants', {
      method: 'POST',
      body: JSON.stringify(WorkspaceConnectorMediaGrantRequestV2Schema.parse(input)),
      ...(signal ? { signal } : {})
    }, WorkspaceConnectorMediaGrantV2Schema);
  }

  uploadGrantedMedia(
    grantInput: WorkspaceConnectorMediaGrant,
    body: Buffer | ReadableStream<Uint8Array>,
    signal?: AbortSignal
  ): Promise<WorkspaceConnectorMediaUploadReceipt> {
    const grant = WorkspaceConnectorMediaGrantSchema.parse(grantInput);
    const upload = new URL(grant.uploadUrl);
    const base = new URL(this.#connection.baseUrl);
    if (
      upload.origin !== base.origin || upload.username || upload.password ||
      upload.search || upload.hash ||
      upload.pathname !== `/v1/workspace-connector/v1/media-grants/${encodeURIComponent(grant.grantId)}`
    ) {
      throw new Error('Workspace media grant returned an untrusted upload URL.');
    }
    if (Buffer.isBuffer(body) && body.byteLength !== grant.sizeBytes) {
      throw new Error('Workspace media bytes did not match their exact grant.');
    }
    const uploadBody = Buffer.isBuffer(body) ? Uint8Array.from(body).buffer : body;
    return this.#requestAbsolute(grant.uploadUrl, {
      method: 'PUT',
      body: uploadBody,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(grant.sizeBytes),
        'x-workspace-media-capability': grant.bearerToken
      },
      timeoutMs: MEDIA_UPLOAD_TIMEOUT_MS,
      ...(signal ? { signal } : {})
    }, WorkspaceConnectorMediaUploadReceiptSchema);
  }

  uploadGrantedMediaV2(
    grantInput: WorkspaceConnectorMediaGrantV2,
    body: Buffer | ReadableStream<Uint8Array>,
    signal?: AbortSignal
  ) {
    const grant = WorkspaceConnectorMediaGrantV2Schema.parse(grantInput);
    this.#assertTrustedMediaGrantUrl(grant.uploadUrl, grant.grantId, 2);
    if (Buffer.isBuffer(body) && body.byteLength !== grant.sizeBytes) {
      throw new Error('Workspace media bytes did not match their exact grant.');
    }
    const uploadBody = Buffer.isBuffer(body) ? Uint8Array.from(body).buffer : body;
    return this.#requestAbsolute(grant.uploadUrl, {
      method: 'PUT',
      body: uploadBody,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(grant.sizeBytes),
        'x-workspace-media-capability': grant.bearerToken
      },
      timeoutMs: MEDIA_UPLOAD_TIMEOUT_MS,
      ...(signal ? { signal } : {})
    }, WorkspaceConnectorMediaUploadReceiptV2Schema);
  }

  async downloadGrantedMediaV2(
    grantInput: WorkspaceConnectorDeliveryMediaGrantV2,
    signal?: AbortSignal
  ): Promise<Response> {
    const grant = WorkspaceConnectorDeliveryMediaGrantV2Schema.parse(grantInput);
    this.#assertTrustedMediaGrantUrl(grant.downloadUrl, grant.grantId, 2);
    const response = await this.#fetch(grant.downloadUrl, {
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/octet-stream',
        'x-workspace-media-capability': grant.bearerToken
      },
      ...(signal ? { signal } : {})
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Workspace media download was rejected with HTTP ${response.status}.`);
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && contentLength !== String(grant.sizeBytes)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Workspace media download length did not match its grant.');
    }
    return response;
  }

  #assertTrustedMediaGrantUrl(url: string, grantId: string, protocolVersion: 1 | 2): void {
    const grantUrl = new URL(url);
    const base = new URL(this.#connection.baseUrl);
    if (
      grantUrl.origin !== base.origin || grantUrl.username || grantUrl.password
      || grantUrl.search || grantUrl.hash
      || grantUrl.pathname !== `/v1/workspace-connector/v${protocolVersion}/media-grants/${encodeURIComponent(grantId)}`
    ) {
      throw new Error('Workspace media grant returned an untrusted URL.');
    }
  }

  async #request<T>(
    path: string,
    init: {
      method: 'GET' | 'POST' | 'PUT';
      body?: BodyInit;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
    schema: z.ZodType<T, z.ZodTypeDef, unknown>
  ): Promise<T> {
    return this.#requestAbsolute(`${this.#connection.baseUrl}${path}`, init, schema);
  }

  async #requestAbsolute<T>(
    url: string,
    init: {
      method: 'GET' | 'POST' | 'PUT';
      body?: BodyInit | ReadableStream<Uint8Array>;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
    schema: z.ZodType<T, z.ZodTypeDef, unknown>
  ): Promise<T> {
    const cancellation = requestCancellation(init.signal, init.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const request = async (): Promise<Response> => {
      const token = await this.#tokens.accessToken();
      const requestInit: RequestInit & { duplex?: 'half' } = {
        method: init.method,
        redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(init.body && !init.headers?.['content-type'] ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
          'x-workspace-connector-audience': this.#connection.audience,
          'x-workspace-connector-installation-id': this.#connection.installationId
        },
        ...(init.body ? { body: init.body } : {}),
        ...(init.body instanceof ReadableStream ? { duplex: 'half' as const } : {}),
        signal: cancellation.signal
      };
      return this.#fetch(url, requestInit);
    };
    try {
      let response = await request();
      if (response.status === 401) {
        this.#tokens.invalidate();
        if (!(init.body instanceof ReadableStream)) {
          response = await request();
        }
      }
      const text = await readBoundedResponseText(response, MAX_JSON_BYTES);
      if (!response.ok) throw new Error(`Workspace connector request was rejected with HTTP ${response.status}.`);
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { throw new Error('Workspace connector response was not valid JSON.'); }
      return schema.parse(payload);
    } finally {
      cancellation.dispose();
    }
  }

  async #requestEmpty(
    path: string,
    init: { method: 'POST'; body: string; signal?: AbortSignal }
  ): Promise<void> {
    const cancellation = requestCancellation(init.signal, REQUEST_TIMEOUT_MS);
    const request = async (): Promise<Response> => {
      const token = await this.#tokens.accessToken();
      return this.#fetch(`${this.#connection.baseUrl}${path}`, {
        method: init.method,
        redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'content-type': 'application/json',
          'x-workspace-connector-audience': this.#connection.audience,
          'x-workspace-connector-installation-id': this.#connection.installationId
        },
        body: init.body,
        signal: cancellation.signal
      });
    };
    try {
      let response = await request();
      if (response.status === 401) {
        this.#tokens.invalidate();
        response = await request();
      }
      if (!response.ok) {
        throw new Error(`Workspace connector request was rejected with HTTP ${response.status}.`);
      }
    } finally {
      cancellation.dispose();
    }
  }
}

async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const lengthHeader = response.headers.get('content-length');
  if (
    lengthHeader !== null
    && (!/^(?:0|[1-9][0-9]*)$/u.test(lengthHeader) || Number(lengthHeader) > maximumBytes)
  ) {
    throw new Error('Workspace connector response exceeded the size limit.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Workspace connector response exceeded the size limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, receivedBytes));
}

function requestCancellation(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('Workspace connector request timed out.')), timeoutMs);
  timeout.unref();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abortFromParent);
    }
  };
}
