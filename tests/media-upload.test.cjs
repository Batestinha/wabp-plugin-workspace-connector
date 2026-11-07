const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('node:http');
const { mkdtemp, open, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { WorkspaceConnectorClient } = require('../dist/client');
const { openFileUpload } = require('../dist/fileUpload');

const grantId = 'c242e870-c2cc-4c2d-bcf1-5dde16df1564';
const suffix = `/v1/workspace-connector/v2/media-grants/${grantId}`;
const receipt = { protocolVersion: 2, sessionId: grantId, fileId: 'file', disposition: 'accepted', sessionState: 'accepting', actions: [{ kind: 'reply', text: 'Uploaded', route: { kind: 'current' } }] };
const tokens = { accessToken: async () => 'fixture-only', invalidate() {} };
const grant = (uploadUrl, sizeBytes) => ({ protocolVersion: 2, grantId, uploadUrl, bearerToken: 'a'.repeat(43),
  expiresAt: new Date(Date.now() + 60_000).toISOString(), filename: 'original.jpg', mimeType: 'image/jpeg', sizeBytes, sha256: 'a'.repeat(64) });

test('media URL trust includes the configured API path and rejects unrelated routes', async () => {
  for (const prefix of ['', '/api']) {
    const baseUrl = `https://workspace.example${prefix}`;
    const calls = [];
    const client = new WorkspaceConnectorClient({ baseUrl, audience: 'fixture', installationId: 'fixture' }, {
      tokens, fetch: async (url) => { calls.push(url); return Response.json(receipt); },
    });
    await client.uploadGrantedMediaV2(grant(baseUrl + suffix, 1), Buffer.from('x'));
    assert.deepEqual(calls, [baseUrl + suffix]);
    for (const url of [
      `https://bot.example${prefix}${suffix}`, `${baseUrl}${suffix}?redirect=x`,
      `${baseUrl}${suffix}#x`, `https://user@workspace.example${prefix}${suffix}`,
      `${baseUrl}/other${suffix}`, `https://workspace.example${prefix === '/api' ? '' : '/api'}${suffix}`,
    ]) assert.throws(() => client.uploadGrantedMediaV2(grant(url, 1), Buffer.from('x')), /untrusted/);
    assert.equal(calls.length, 1);
  }
});

test('real disk uploads survive early rejection, disconnect and subsequent successful retry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workspace-upload-test-'));
  const filePath = path.join(directory, 'original.bin');
  const file = await open(filePath, 'w');
  await file.truncate(16 * 1024 * 1024);
  await file.close();
  let mode = 'reject';
  let received;
  const server = createServer((req, res) => {
    if (mode === 'reject') { res.writeHead(405); res.end(); return; }
    if (mode === 'disconnect') { req.socket.destroy(); return; }
    const hash = createHash('sha256'); let size = 0;
    req.on('data', chunk => { size += chunk.length; hash.update(chunk); });
    req.on('end', () => { received = { size, sha256: hash.digest('hex') }; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(receipt)); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'https://workspace.example/api';
  const client = new WorkspaceConnectorClient({ baseUrl, audience: 'fixture', installationId: 'fixture' }, {
    tokens, fetch: (url, init) => fetch(String(url).replace('https://workspace.example', `http://127.0.0.1:${server.address().port}`), init),
  });
  try {
    for (const outcome of ['reject', 'disconnect', 'reject', 'success']) {
      mode = outcome;
      const upload = await openFileUpload(filePath);
      try {
        const result = client.uploadGrantedMediaV2(grant(baseUrl + suffix, 16 * 1024 * 1024), upload.body);
        if (mode === 'success') assert.deepEqual(await result, receipt);
        else await assert.rejects(result, mode === 'reject' ? /HTTP 405/ : /fetch failed/);
      } finally { await upload.close(); }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.deepEqual(received, { size: 16 * 1024 * 1024, sha256: createHash('sha256').update(await readFile(filePath)).digest('hex') });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
