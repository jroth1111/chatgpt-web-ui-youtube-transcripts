import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcp } from '../lib/mcp-handler.mjs';

const key = 'synthetic-mcp-key-for-tests-only-43-characters';
const env = { OWNER_EMAIL: 'owner@example.test', MCP_AUTH_KEY: key };
const owner = { 'oai-authenticated-user-id': 'owner', 'oai-authenticated-user-email': 'owner@example.test' };
const request = (headers = {}, method = 'tools/list', params = {}) => new Request('https://example.test/mcp', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
});
const bearer = (value = key) => ({ Authorization: `Bearer ${value}` });

test('service key authenticates initialize and discovery through either header', async () => {
  for (const headers of [bearer(), { 'X-MCP-Auth-Key': key }]) {
    const init = await handleMcp(request(headers, 'initialize', { protocolVersion: '2025-06-18' }), env);
    assert.equal(init.status, 200);
    assert.equal((await init.json()).result.protocolVersion, '2025-06-18');
    const list = await handleMcp(request(headers), env);
    assert.equal((await list.json()).result.tools.length, 10);
  }
});

test('missing, malformed, wrong, duplicated and conflicting credentials never reach tools', async () => {
  for (const headers of [{}, bearer('wrong'), bearer(''), { Authorization: `Basic ${key}` },
    { Authorization: `Bearer ${key}, Bearer ${key}` }, { 'X-MCP-Auth-Key': `${key}, ${key}` },
    { ...bearer(), 'X-MCP-Auth-Key': key }, bearer('x'.repeat(513))]) {
    const response = await handleMcp(request(headers, 'tools/call', { name: 'get_transcript', arguments: { url: 'AJpK3YTTKZ4' } }), env,
      { serviceFactory: () => assert.fail('Unauthorized request reached service') });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /^Bearer/);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert(!(await response.text()).includes(key));
  }
});

test('query keys are not credentials', async () => {
  const req = request();
  const queryReq = new Request(`${req.url}?api_key=${key}&MCP_AUTH_KEY=${key}`, req);
  assert.equal((await handleMcp(queryReq, env)).status, 401);
});

test('unconfigured or invalid server key fails closed for service clients', async () => {
  for (const configured of [undefined, '', 'short', 'x'.repeat(513), ' '.repeat(32)]) {
    const response = await handleMcp(request(bearer()), { ...env, MCP_AUTH_KEY: configured });
    assert.equal(response.status, 503);
    assert(!(await response.text()).includes(key));
  }
});

test('owner OAuth remains functional even with no key or a forwarded OAuth bearer', async () => {
  for (const headers of [owner, { ...owner, Authorization: 'Bearer platform-oauth-token' }]) {
    const response = await handleMcp(request(headers), { OWNER_EMAIL: env.OWNER_EMAIL });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.tools.length, 10);
  }
});

test('valid key cannot override a non-owner or incomplete Sites identity', async () => {
  for (const [identity, expected] of [[{ ...owner, 'oai-authenticated-user-email': 'other@example.test' }, 403],
    [{ 'oai-authenticated-user-id': '' }, 401], [{ 'oai-authenticated-user-email': 'owner@example.test' }, 401]]) {
    const response = await handleMcp(request({ ...identity, ...bearer() }), env,
      { serviceFactory: () => assert.fail('Rejected identity reached service') });
    assert.equal(response.status, expected);
  }
});

test('service calls use a stable isolated namespace across key rotation', async () => {
  const principals = [];
  const options = { serviceFactory: () => ({ call: async (_name, _args, principal) => { principals.push(principal); return { ok: true }; } }) };
  const rotated = 'another-synthetic-test-key-for-rotation-43-chars';
  for (const current of [key, rotated]) {
    const response = await handleMcp(request(bearer(current), 'tools/call', { name: 'get_video_info', arguments: { url: 'AJpK3YTTKZ4' } }),
      { ...env, MCP_AUTH_KEY: current }, options);
    assert.equal((await response.json()).result.isError, false);
  }
  assert.deepEqual(principals, ['service:mcp', 'service:mcp']);
  assert.equal((await handleMcp(request(bearer()), { ...env, MCP_AUTH_KEY: rotated })).status, 401);
});

test('key requests retain same-origin checks', async () => {
  assert.equal((await handleMcp(request({ ...bearer(), Origin: 'https://evil.example' }), env)).status, 403);
});
