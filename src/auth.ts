import { Elysia } from 'elysia';

export type Middleware = (req: {
  headers: Record<string, string | undefined>;
}) => void;

/**
 * Minimal API-key auth for the publish path. If PM_API_KEY is unset, the
 * endpoint is effectively "open for testing" and the server logs a warning;
 * published in production it must be set.
 */
export function authGuard(apiKey: string | undefined) {
  if (!apiKey) {
    console.warn(
      'PM_API_KEY is not set — publish endpoint is unauthenticated (dev only)',
    );
    return new Elysia();
  }
  return new Elysia()
    .derive(({ request }) => {
      const provided = request.headers.get('x-api-key') ?? '';
      return { apiKeyMatches: provided === apiKey };
    })
    .onBeforeHandle(({ path, apiKeyMatches, set }) => {
      const publishPath = '/api/v1/plugins/publish';
      if (path === publishPath && !apiKeyMatches) {
        set.status = 401;
        return { ok: false, reason: 'unauthorized' };
      }
    });
}
