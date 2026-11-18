import { Elysia } from 'elysia';
import { authGuard } from './auth';
import { PluginRegistry } from './registry';

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
    .get('/api/v1/plugins/:id/download', async ({ params, set }) => {
      const body = await registry.readManifest(params.id);
      if (!body) {
        set.status = 404;
        return { ok: false, reason: 'not found' };
      }
      set.headers['content-type'] = 'application/wasm';
      return body;
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
