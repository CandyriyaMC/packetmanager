import { readFile } from 'node:fs/promises';
import { Elysia } from 'elysia';
import { authGuard } from './auth';
import { PluginRegistry } from './registry';

// above this we hand Bun.file to the Response and stream from disk
const STREAM_THRESHOLD = 1024 * 1024; // ~1 MiB

export interface ServerConfig {
  apiKey: string | undefined;
  dataDir: string;
  baseUrl: string;
}

export function createServer(cfg: ServerConfig) {
  const registry = new PluginRegistry(cfg.dataDir);
  const app = new Elysia()
    .use(authGuard(cfg.apiKey))
    .get('/health', () => ({ status: 'ok' }))
    .get('/ready', () => ({ status: 'ready' }))
    .get('/api/v1/plugins', () => registry.listPublished())
    .get('/api/v1/plugins/:id', ({ params }) => registry.getDetail(params.id))
    .get('/api/v1/plugins/:id/core', ({ params }) => registry.getCore(params.id))
    .post(
      '/api/v1/plugins/publish',
      async ({ body, set }) => {
        const report = await registry.publish(body);
        if (!report.ok) {
          set.status = 400;
          return { ok: false, findings: report.findings };
        }
        return { ok: true, plugin: { id: body.id, version: body.version } };
      },
      {
        body: {
          id: 'string',
          name: 'string',
          version: 'string',
          module: 'string',
        },
      },
    )
    .get('/api/v1/plugins/:id/download', async ({ params }) => {
      const started = performance.now();
      // raw id goes into logs and headers, so strip control chars/semicolons up front
      const rawId = params.id;
      const logId = rawId.replace(/[^\x20-\x7e]/g, '_').slice(0, 128);
      const finish = (status: number, bytes: number) => {
        // never log the artifact body itself
        console.info(
          `download method=GET id=${logId} status=${status} bytes=${bytes} duration_ms=${(performance.now() - started).toFixed(1)}`,
        );
      };
      try {
        const artifact = await registry.resolveArtifact(rawId);
        if (!artifact) {
          finish(404, 0);
          return Response.json({ ok: false, reason: 'not found' }, { status: 404 });
        }
        // id passed validation by this point; still strip anything header-hostile (no CRLF, no ';')
        const filenameId = rawId.replace(/[^a-z0-9_.-]/gi, '_');
        const headers = {
          'content-type': artifact.contentType,
          'content-disposition': `inline; filename="${filenameId}.plugin"`,
        };
        if (artifact.sizeBytes > STREAM_THRESHOLD) {
          finish(200, artifact.sizeBytes);
          // Bun.file streams lazily; content-length taken from the stat we already did
          return new Response(Bun.file(artifact.path), {
            headers: { ...headers, 'content-length': String(artifact.sizeBytes) },
          });
        }
        const body = await readFile(artifact.path);
        finish(200, body.length);
        return new Response(body, {
          headers: { ...headers, 'content-length': String(body.length) },
        });
      } catch (err) {
        console.error(
          `download failed method=GET id=${logId} error=${err instanceof Error ? err.message : String(err)}`,
        );
        finish(500, 0);
        return Response.json({ ok: false, reason: 'internal error' }, { status: 500 });
      }
    });
  return app;
}

// root CLI entry: read config from env, start server on PORT
if (import.meta.main) {
  const port = Number(process.env.PORT ?? '8093');
  const cfg: ServerConfig = {
    apiKey: process.env.PM_API_KEY,
    dataDir: process.env.PM_DATA_DIR ?? './data',
    baseUrl: process.env.PM_BASE_URL ?? 'http://localhost:8093',
  };
  const app = createServer(cfg);
  app.listen(port);
  console.log(`packetmanager listening on http://localhost:${port}`);
}
