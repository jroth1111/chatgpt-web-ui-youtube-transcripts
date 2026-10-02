import { authorize } from './transcript-service.mjs';
import { TranscriptError } from './transcript-errors.mjs';

const encoder = new TextEncoder();
const proof = encoder.encode('youtube-transcripts:mcp-auth:v1');
const tokenPattern = /^[A-Za-z0-9._~+\/-]+=*$/;
const servicePrincipal = 'service:mcp';

function unauthorized() {
  return new TranscriptError('unauthorized', 'A valid MCP auth key is required.');
}

async function verifyKey(expected, supplied) {
  // Web Crypto verifies the MAC without a secret-dependent JavaScript comparison.
  const algorithm = { name: 'HMAC', hash: 'SHA-256' };
  const expectedKey = await crypto.subtle.importKey('raw', encoder.encode(expected), algorithm, false, ['verify']);
  const suppliedKey = await crypto.subtle.importKey('raw', encoder.encode(supplied), algorithm, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', suppliedKey, proof);
  return crypto.subtle.verify('HMAC', expectedKey, signature, proof);
}

export async function authorizeMcp(headers, env) {
  // Sites dispatch supplies trusted identity; it must strip caller-supplied headers.
  const hasIdentity = headers.has('oai-authenticated-user-id') || headers.has('oai-authenticated-user-email');
  // Sites may forward the original OAuth Authorization header. Trusted owner
  // identity is a complete authentication path and takes precedence over keys.
  if (hasIdentity) return authorize(headers, env.OWNER_EMAIL);
  const hasBearer = headers.has('authorization');
  const hasKeyHeader = headers.has('x-mcp-auth-key');

  const expected = env.MCP_AUTH_KEY;
  if (typeof expected !== 'string' || expected.length < 32 || expected.length > 512 || !tokenPattern.test(expected)) {
    throw new TranscriptError('configuration_error', 'MCP service authentication has not been configured.');
  }
  // Reject ambiguous or duplicated credentials instead of choosing one silently.
  if (hasBearer && hasKeyHeader) throw unauthorized();
  const bearer = hasBearer ? /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/i.exec(headers.get('authorization')) : null;
  const supplied = hasKeyHeader ? headers.get('x-mcp-auth-key') : bearer?.[1];
  if (!supplied || supplied.length > 512 || !tokenPattern.test(supplied) || !(await verifyKey(expected, supplied))) throw unauthorized();
  // A stable namespace keeps service pagination valid when the key is rotated.
  return servicePrincipal;
}
