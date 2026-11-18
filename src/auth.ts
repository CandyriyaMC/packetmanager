// Shared-secret-per-process guard: one API key from PM_API_KEY protects the
// publish path. This is NOT an HSM or per-client key story — rotation means
// redeploying with a new env value.
import { createHash, timingSafeEqual } from 'node:crypto';
import { Elysia } from 'elysia';

const PUBLISH_PATH = '/api/v1/plugins/publish';

// compare via SHA-256 digests so both buffers are always 32 bytes — no length
// check, so no length leak; a short-circuit on unequal lengths would leak the
// configured key's length anyway
function keysEqual(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

// one structured line per auth decision; key material is never included, only
// its byte length — and never the configured key's length either
function logAuthDecision(method: string, path: string, keyLen: number, ok: boolean) {
  const line = JSON.stringify({
    event: 'auth',
    method,
    path,
    keyLen,
    result: ok ? 'pass' : 'fail',
  });
  if (ok) {
    console.log(line);
  } else {
    console.warn(line);
  }
}

/**
 * API-key guard for the publish path. If PM_API_KEY is unset the publish
 * endpoint rejects every request with the same 401 as a wrong key (no open
 * bypass) and a one-time warning is logged at startup; request-time behavior
 * is indistinguishable from a mismatch. dev-mode-only default, never a bypass.
 * Future test (deliberately not written yet): unset PM_API_KEY -> 401 for any
 * presented key + startup warn once; do not add permissive dev behavior instead.
 */
export function authGuard(apiKey: string | undefined) {
  const configured = apiKey && apiKey.length > 0 ? apiKey : undefined;
  if (configured === undefined) {
    console.warn(
      'PM_API_KEY is not set — publish endpoint will reject all requests with 401',
    );
  }
  // as: 'scoped' exports the hook to the parent app — plugin hooks default to
  // local scope and would never run for the publish route registered there
  return new Elysia().onBeforeHandle({ as: 'scoped' }, ({ path, request, set }) => {
    if (path !== PUBLISH_PATH) return;
    const provided = request.headers.get('x-api-key') ?? '';
    // never digest-compare against a sentinel: empty provided vs unset env must
    // fail closed explicitly, not by accidentally matching an empty secret
    const ok = configured !== undefined && keysEqual(provided, configured);
    logAuthDecision(request.method, path, Buffer.byteLength(provided, 'utf8'), ok);
    if (!ok) {
      set.status = 401;
      // exactly this body, nothing else — no set-cookie, no hint about env state
      return { ok: false, reason: 'unauthorized' };
    }
  });
}
