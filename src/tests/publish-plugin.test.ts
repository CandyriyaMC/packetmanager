import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../index';

const API_KEY = 'test-api-key-0123456789abcdef';

const cleanup: string[] = [];

async function setup(opts?: { apiKey?: string | undefined; maxModuleBytes?: number }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pm-pub-test-'));
  cleanup.push(dataDir);
  const app = createServer({
    apiKey: opts && 'apiKey' in opts ? opts.apiKey : API_KEY,
    dataDir,
    baseUrl: 'http://localhost:8093',
    maxModuleBytes: opts?.maxModuleBytes,
  });
  return { app, dataDir };
}

afterEach(async () => {
  while (cleanup.length) {
    const dir = cleanup.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// res.json() is typed unknown in bun-types; the tests assert the shape anyway
async function jsonOf(res: Response): Promise<any> {
  return (await res.json()) as any;
}

const moduleBytes = Buffer.from('fake .plugin bundle bytes, wasm magic and all', 'utf8');

function goodBody(overrides?: Record<string, unknown>) {
  return {
    id: 'demo_plugin',
    name: 'demo-plugin.example',
    version: '1.2.3',
    module: moduleBytes.toString('base64'),
    ...overrides,
  };
}

function publish(
  app: ReturnType<typeof createServer>,
  init: { apiKey?: string | null; contentType?: string | null; body?: unknown; rawBody?: string },
) {
  const headers: Record<string, string> = {};
  if (init.contentType !== null) headers['content-type'] = init.contentType ?? 'application/json';
  if (init.apiKey !== null && init.apiKey !== undefined) headers['x-api-key'] = init.apiKey;
  return app.handle(
    new Request('http://localhost/api/v1/plugins/publish', {
      method: 'POST',
      headers,
      body: init.rawBody ?? JSON.stringify(init.body),
    }),
  );
}

describe('POST /api/v1/plugins/publish', () => {
  test('accepts a good upload and stores it on disk', async () => {
    const { app, dataDir } = await setup();
    const res = await publish(app, { apiKey: API_KEY, body: goodBody() });
    expect(res.status).toBe(200);
    const json = await jsonOf(res);
    expect(json.ok).toBe(true);
    expect(json.plugin.id).toBe('demo_plugin');
    expect(json.plugin.name).toBe('demo-plugin.example');
    expect(json.plugin.version).toBe('1.2.3');
    expect(json.plugin.size).toBe(moduleBytes.length);
    expect(Number.isNaN(Date.parse(json.plugin.publishedAt))).toBe(false);
    // never echo the payload back
    expect('module' in json.plugin).toBe(false);

    const stored = await readFile(join(dataDir, 'plugins', 'demo_plugin', '1.2.3', 'plugin.plugin'));
    expect(stored.equals(moduleBytes)).toBe(true);

    const manifest = JSON.parse(
      await readFile(join(dataDir, 'plugins', 'demo_plugin', '1.2.3', 'manifest.json'), 'utf8'),
    );
    expect(manifest.id).toBe('demo_plugin');
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.size).toBe(moduleBytes.length);
    expect(manifest.sha256).toBe(createHash('sha256').update(moduleBytes).digest('hex'));
    expect(manifest.signature).toBeUndefined();
  });

  test('accepts a prerelease version', async () => {
    const { app } = await setup();
    const res = await publish(app, { apiKey: API_KEY, body: goodBody({ version: '1.2.3-alpha.1' }) });
    expect(res.status).toBe(200);
  });

  test('accepts an upload whose signature verifies against the installed publisher key', async () => {
    const { app, dataDir } = await setup();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawPub = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
    await mkdir(join(dataDir, 'publishers'), { recursive: true });
    await writeFile(join(dataDir, 'publishers', 'demo_plugin.pub'), rawPub.toString('base64'));

    const signature = sign(null, moduleBytes, privateKey);
    const res = await publish(app, {
      apiKey: API_KEY,
      body: goodBody({ signature: signature.toString('base64') }),
    });
    expect(res.status).toBe(200);

    const storedSig = await readFile(join(dataDir, 'plugins', 'demo_plugin', '1.2.3', 'sig'));
    expect(storedSig.equals(signature)).toBe(true);
    const manifest = JSON.parse(
      await readFile(join(dataDir, 'plugins', 'demo_plugin', '1.2.3', 'manifest.json'), 'utf8'),
    );
    expect(manifest.signature).toEqual({ verified: true });
  });

  test('rejects a signature that does not verify', async () => {
    const { app, dataDir } = await setup();
    const trusted = generateKeyPairSync('ed25519');
    const attacker = generateKeyPairSync('ed25519');
    const rawPub = Buffer.from(trusted.publicKey.export({ format: 'jwk' }).x as string, 'base64url');
    await mkdir(join(dataDir, 'publishers'), { recursive: true });
    await writeFile(join(dataDir, 'publishers', 'demo_plugin.pub'), rawPub.toString('base64'));

    const badSig = sign(null, moduleBytes, attacker.privateKey);
    const res = await publish(app, {
      apiKey: API_KEY,
      body: goodBody({ signature: badSig.toString('base64') }),
    });
    expect(res.status).toBe(400);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('invalid_signature');
  });

  test('rejects a signature when no trusted publisher key is on file', async () => {
    const { app } = await setup();
    const { privateKey } = generateKeyPairSync('ed25519');
    const signature = sign(null, moduleBytes, privateKey);
    const res = await publish(app, {
      apiKey: API_KEY,
      body: goodBody({ signature: signature.toString('base64') }),
    });
    expect(res.status).toBe(400);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('untrusted_publisher');
  });

  test('rejects a missing x-api-key header', async () => {
    const { app } = await setup();
    const res = await publish(app, { apiKey: null, body: goodBody() });
    expect(res.status).toBe(401);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('unauthorized');
  });

  test('rejects a wrong x-api-key', async () => {
    const { app } = await setup();
    const res = await publish(app, { apiKey: 'definitely-not-the-key', body: goodBody() });
    expect(res.status).toBe(401);
  });

  test('publish endpoint is disabled when PM_API_KEY is not configured', async () => {
    const { app } = await setup({ apiKey: undefined });
    const res = await publish(app, { apiKey: null, body: goodBody() });
    expect(res.status).toBe(503);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('publish_disabled');
  });

  test.each(['UPPER', 'has space', '../escape', 'a/b', '..', '', 'x'.repeat(65), 'dot.name'])(
    'rejects invalid id %j',
    async (id) => {
      const { app } = await setup();
      const res = await publish(app, { apiKey: API_KEY, body: goodBody({ id }) });
      expect(res.status).toBe(400);
      const json = await jsonOf(res);
      expect(json.error.code).toBe('invalid_id');
    },
  );

  test('rejects path traversal in id even though the charset already forbids it', async () => {
    const { app, dataDir } = await setup();
    const res = await publish(app, {
      apiKey: API_KEY,
      body: goodBody({ id: '....//....//tmp/pwn' }),
    });
    expect(res.status).toBe(400);
    // nothing may have been written outside the temp root
    const stored = await readFile(join(dataDir, 'plugins')).catch(() => null);
    expect(stored).toBeNull();
  });

  test.each(['1.2', 'v1.2.3', '01.2.3', '1.2.x', '1.2.3+build.1', 'x'.repeat(65)])(
    'rejects invalid version %j',
    async (version) => {
      const { app } = await setup();
      const res = await publish(app, { apiKey: API_KEY, body: goodBody({ version }) });
      expect(res.status).toBe(400);
      const json = await jsonOf(res);
      expect(json.error.code).toBe('invalid_version');
    },
  );

  test.each(['Name', '-leading-hyphen', '.leading-dot', 'has space', 'x'.repeat(129)])(
    'rejects invalid name %j',
    async (name) => {
      const { app } = await setup();
      const res = await publish(app, { apiKey: API_KEY, body: goodBody({ name }) });
      expect(res.status).toBe(400);
      const json = await jsonOf(res);
      expect(json.error.code).toBe('invalid_name');
    },
  );

  test('rejects a missing module', async () => {
    const { app } = await setup();
    const { module: _omit, ...withoutModule } = goodBody();
    const res = await publish(app, { apiKey: API_KEY, body: withoutModule });
    expect(res.status).toBe(400);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('missing_module');
  });

  test('rejects an empty module', async () => {
    const { app } = await setup();
    const res = await publish(app, { apiKey: API_KEY, body: goodBody({ module: '' }) });
    expect(res.status).toBe(400);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('missing_module');
  });

  test('rejects a module that is not valid base64', async () => {
    const { app } = await setup();
    const res = await publish(app, { apiKey: API_KEY, body: goodBody({ module: '!!!not-base64!!!' }) });
    expect(res.status).toBe(400);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('invalid_module');
  });

  test('rejects a module larger than the configured limit', async () => {
    const { app } = await setup({ maxModuleBytes: 16 });
    const big = Buffer.alloc(64, 0x61).toString('base64');
    const res = await publish(app, { apiKey: API_KEY, body: goodBody({ module: big }) });
    expect(res.status).toBe(400);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('module_too_large');
  });

  test('rejects a re-publish of the same id+version with 409', async () => {
    const { app } = await setup();
    const first = await publish(app, { apiKey: API_KEY, body: goodBody() });
    expect(first.status).toBe(200);
    const second = await publish(app, { apiKey: API_KEY, body: goodBody() });
    expect(second.status).toBe(409);
    const json = await jsonOf(second);
    expect(json.error.code).toBe('duplicate_version');
  });

  test('a different version of the same plugin publishes fine', async () => {
    const { app } = await setup();
    await publish(app, { apiKey: API_KEY, body: goodBody({ version: '1.2.3' }) });
    const res = await publish(app, { apiKey: API_KEY, body: goodBody({ version: '1.2.4' }) });
    expect(res.status).toBe(200);
  });

  test('rejects a body that is not valid JSON', async () => {
    const { app } = await setup();
    const res = await publish(app, { apiKey: API_KEY, rawBody: '{nope' });
    expect(res.status).toBe(400);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('bad_json');
  });

  test('rejects a non-JSON content type', async () => {
    const { app } = await setup();
    const res = await publish(app, { apiKey: API_KEY, contentType: 'application/octet-stream', rawBody: 'rawbytes' });
    expect(res.status).toBe(400);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('unsupported_media_type');
  });

  test('health endpoint is untouched', async () => {
    const { app } = await setup();
    const res = await app.handle(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ status: 'ok' });
  });
});
