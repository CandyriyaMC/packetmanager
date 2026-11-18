// Production-correct download fixture tests.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../index';

const WASM_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  Buffer.alloc(120, 0x7f),
]);

describe('GET /api/v1/plugins/:id/download', () => {
  let testRoot: string;
  let dataDir: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'pm-dl-test-'));
    dataDir = join(testRoot, 'data');
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  const handle = (path: string) => {
    const app = createServer({ apiKey: 'test-key-needs-16-chars', dataDir, baseUrl: 'http://localhost' });
    return app.handle(new Request(`http://localhost${path}`));
  };

  const publishFixture = async (
    id: string,
    artifact: Buffer,
    manifestExtra: Record<string, unknown> = {},
    version = '1.0.0',
  ) => {
    const versionDir = join(dataDir, 'plugins', id, version);
    await mkdir(versionDir, { recursive: true });
    await writeFile(join(versionDir, 'plugin.plugin'), artifact);
    await writeFile(
      join(versionDir, 'manifest.json'),
      JSON.stringify({
        id,
        name: id,
        version,
        publishedAt: new Date().toISOString(),
        size: artifact.length,
        sha256: 'abc',
        ...manifestExtra,
      }),
    );
  };

  test('found plugin: correct headers, size and body', async () => {
    await publishFixture('goodplugin', WASM_BYTES);

    const res = await handle('/api/v1/plugins/goodplugin/download');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/wasm');
    expect(res.headers.get('content-length')).toBe(String(WASM_BYTES.length));
    expect(res.headers.get('content-disposition')).toBe(
      'inline; filename="goodplugin.plugin"',
    );

    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(WASM_BYTES.length);
    expect(body.equals(WASM_BYTES)).toBe(true);

    // manifest-declared allowlisted contentType wins over sniffing
    await publishFixture('octetplugin', WASM_BYTES, { contentType: 'application/octet-stream' });
    const res2 = await handle('/api/v1/plugins/octetplugin/download');
    expect(res2.status).toBe(200);
    expect(res2.headers.get('content-type')).toBe('application/octet-stream');

    // non-wasm bytes with no manifest hint sniff to octet-stream
    await publishFixture('plainplugin', Buffer.from('just some bytes'));
    const res3 = await handle('/api/v1/plugins/plainplugin/download');
    expect(res3.status).toBe(200);
    expect(res3.headers.get('content-type')).toBe('application/octet-stream');
    expect(res3.headers.get('content-length')).toBe(String(Buffer.from('just some bytes').length));

    // over the ~1 MiB threshold the handler streams via Bun.file
    const big = Buffer.concat([
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
      Buffer.alloc(1024 * 1024 + 512, 0xaa),
    ]);
    await publishFixture('bigplugin', big);
    const res4 = await handle('/api/v1/plugins/bigplugin/download');
    expect(res4.status).toBe(200);
    expect(res4.headers.get('content-type')).toBe('application/wasm');
    expect(res4.headers.get('content-length')).toBe(String(big.length));
  });

  test('missing plugin: 404 with JSON error', async () => {
    const res = await handle('/api/v1/plugins/nosuchplugin/download');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ ok: false, reason: 'not found' });
  });

  test('path traversal: endpoint cannot reach artifacts outside plugins/', async () => {
    // file planted one level above dataDir must never be served
    await writeFile(join(testRoot, 'plugin.wasm'), WASM_BYTES);
    const dotdot = await handle('/api/v1/plugins/%2E%2E/download');
    expect(dotdot.status).toBe(404);

    const encodedSlashes = await handle('/api/v1/plugins/..%2F..%2Fdata/download');
    expect(encodedSlashes.status).toBe(404);
    expect(await encodedSlashes.json()).toEqual({ ok: false, reason: 'not found' });

    const sneaky = await handle('/api/v1/plugins/goodplugin%2F..%2F..%2Fsecret/download');
    expect(sneaky.status).toBe(404);
    expect(await sneaky.json()).toEqual({ ok: false, reason: 'not found' });

    const backslash = await handle('/api/v1/plugins/..%5C..%5Csecret/download');
    expect(backslash.status).toBe(404);
    expect(await backslash.json()).toEqual({ ok: false, reason: 'not found' });
  });
});
