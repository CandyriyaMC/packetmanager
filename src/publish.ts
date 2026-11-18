import { Elysia } from 'elysia';
import { PluginRegistry } from './registry';

// base64 inflates bytes by ~4/3; this caps the JSON envelope, not the module
// itself (the module cap lives in the registry and is enforced post-decode)
export function jsonBodyCapBytes(maxModuleBytes: number): number {
  return Math.ceil(maxModuleBytes / 3) * 4 + 64 * 1024;
}

/**
 * POST /api/v1/plugins/publish
 *
 * Convention (phase 1): the upload is application/json —
 *   { id, name, version, module: base64, signature?: base64 }
 * Raw application/octet-stream uploads are rejected with 400 (code
 * unsupported_media_type); the server has no way to carry id/name/version
 * next to raw bytes without either multipart (more moving parts) or query
 * params (ugly, easy to misuse), and the bootstrap already spoke JSON here.
 * Revisit when .plugin gets a container-format spec.
 *
 * Responses:
 *   200 { ok: true, plugin: { id, name, version, publishedAt, size } }
 *   400 { ok: false, error: { code, message, details? } }  bad input / bad signature
 *   401 { ok: false, error: { code: 'unauthorized', ... } } missing/wrong x-api-key
 *   409 { ok: false, error: { code: 'duplicate_version', ... } } version already published
 *   500 { ok: false, error: { code: 'internal', ... } }      storage/write failure
 */
export function publishPlugin(registry: PluginRegistry, maxModuleBytes: number) {
  const bodyCap = jsonBodyCapBytes(maxModuleBytes);

  return new Elysia()
    // scoped to this plugin only — sibling routes keep elysia defaults
    .onError(({ code, set }) => {
      if (code === 'PARSE') {
        set.status = 400;
        return { ok: false, error: { code: 'bad_json', message: 'request body is not valid JSON' } };
      }
      if (code === 'VALIDATION') {
        set.status = 400;
        return { ok: false, error: { code: 'validation', message: 'request failed validation' } };
      }
      console.error(`publish: unhandled error (${String(code)})`);
      set.status = 500;
      return { ok: false, error: { code: 'internal', message: 'internal error while publishing' } };
    })
    .post('/api/v1/plugins/publish', async ({ body, headers, set }) => {
      const contentType = headers['content-type'];
      if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
        set.status = 400;
        return {
          ok: false,
          error: {
            code: 'unsupported_media_type',
            message: 'expected application/json with a base64-encoded module field',
          },
        };
      }

      const contentLength = Number(headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > bodyCap) {
        set.status = 400;
        return {
          ok: false,
          error: { code: 'module_too_large', message: 'request body exceeds the allowed size' },
        };
      }

      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        set.status = 400;
        return {
          ok: false,
          error: { code: 'bad_json', message: 'request body must be a JSON object' },
        };
      }

      const raw = body as Record<string, unknown>;
      const report = await registry.publish({
        id: raw.id,
        name: raw.name,
        version: raw.version,
        module: raw.module,
        signature: raw.signature,
      });

      if (!report.ok) {
        set.status = statusFor(report.error.code);
        return { ok: false, error: report.error };
      }
      set.status = 200;
      return { ok: true, plugin: report.plugin };
    });
}

const STATUS_BY_CODE: Record<string, number> = {
  duplicate_version: 409,
  internal: 500,
};

function statusFor(code: string): number {
  return STATUS_BY_CODE[code] ?? 400;
}
