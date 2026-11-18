// Shared-secret-per-process guard: one API key from PM_API_KEY protects the
// publish path. This is NOT an HSM or per-client key story — rotation means
// redeploying with a new env value. `Provided` keys are compared to the
// configured shared key in constant time; if PM_API_KEY is unset the publish
// endpoint fails closed (503 publish_disabled).
import { createHash, timingSafeEqual } from 'node:crypto';
import { Elysia } from 'elysia';

// constant-time API key check. both sides are hashed first so the compare
// runs on equal-length digests — no early exit on length mismatch, no
// "how many leading bytes matched" signal leaking through timing
function apiKeyMatches(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

const publishPath = '/api/v1/plugins/publish';

const unauthorized = () => ({
  ok: false,
  error: { code: 'unauthorized', message: 'a valid x-api-key header is required' },
});

/**
 * Minimal API-key auth for the publish path. If PM_API_KEY is unset the
 * endpoint is disabled outright (503, fail closed) — an unauthenticated
 * publish endpoint on a public registry is a supply-chain hole, not a dev
 * convenience. Warning fires at startup either way so a missing key never
 * goes unnoticed. Request-time behavior is identical for missing vs wrong
 * key (constant-time compare where the configured key is weakly uniform).
 */
export function authGuard(apiKey: string | undefined) {
  if (!apiKey) {
    console.error(
      'PM_API_KEY is not set — publish endpoint is disabled (set PM_API_KEY to enable it)',
    );
    return new Elysia()
      .onBeforeHandle(({ path, set }) => {
        if (path === publishPath) {
          set.status = 503;
          return {
            ok: false,
            error: {
              code: 'publish_disabled',
              message:
                'publishing is disabled: PM_API_KEY is not configured on the server',
            },
          };
        }
      })
      .as('global');
  }
  if (apiKey.length < 16) {
    console.warn(
      'PM_API_KEY is shorter than 16 characters — use a long random value in production',
    );
  }
  return new Elysia()
    .derive(({ request }) => {
      const provided = request.headers.get('x-api-key') ?? '';
      return { apiKeyMatches: apiKeyMatches(provided, apiKey) };
    })
    .onBeforeHandle(({ path, apiKeyMatches, set }) => {
      if (path === publishPath && !apiKeyMatches) {
        set.status = 401;
        return unauthorized();
      }
    })
    .as('global');
}
