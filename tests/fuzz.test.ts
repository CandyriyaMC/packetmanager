// Property-style fuzz coverage for the publish API contract.
// The registry treats every client-supplied field as hostile; these tests
// hammer the validators with adversarial shapes and assert the server never
// answers with 200 or 500 — only structured 4xx / 401 responses.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/index';

const API_KEY = 'fuzz-api-key-0123456789abcdef';

const cleanup: string[] = [];

async function setup(opts?: { apiKey?: string | undefined; maxModuleBytes?: number }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pm-fuzz-test-'));
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

// bundle bytes are generated dynamically: wasm magic + version + a seed-derived
// payload. do not write inline wasm fixtures.
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function wasmLikeBytes(seed: string): Buffer {
  let h = 2166136261 >>> 0; // fnv-1a, only used to spread seeds across payloads
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const payload = Buffer.alloc(24);
  for (let i = 0; i < payload.length; i++) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    h >>>= 0;
    payload[i] = h & 0xff;
  }
  return Buffer.concat([WASM_MAGIC, payload]);
}

function bundleBase64(seed: string): string {
  return wasmLikeBytes(seed).toString('base64');
}

function goodBody(overrides?: Record<string, unknown>) {
  return {
    id: 'demo_plugin',
    name: 'demo-plugin.example',
    version: '1.2.3',
    module: bundleBase64('fuzz-seed'),
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

describe('fuzz: id validation', () => {
  // regex-gate bypasses: dots, slashes, percent escapes, control chars, bidi
  // overrides, unicode, empty string, boundary and over-boundary lengths
  test.each([
    '...',
    '../',
    '..\\',
    'x%..',
    '!&()',
    '🔥',
    'dëmo',
    'a\u0000b',
    'a\u007fb',
    '',
    'a'.repeat(65),
    'b'.repeat(4096),
  ])('rejects id %j with invalid_id', async (id) => {
    const { app } = await setup();
    const res = await publish(app, { apiKey: API_KEY, body: goodBody({ id }) });
    expect(res.status).toBe(400);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('invalid_id');
  });

  test('rejects non-string ids (number, object, array) with invalid_id', async () => {
    // note: test.each spreads array rows, so object/array inputs are checked in a loop
    for (const id of [123, { id: 'x' }, ['x']] as const) {
      const { app } = await setup();
      const res = await publish(app, { apiKey: API_KEY, body: goodBody({ id }) });
      expect(res.status).toBe(400);
      const json = await jsonOf(res);
      expect(json.error.code).toBe('invalid_id');
    }
  });
});

describe('fuzz: version validation', () => {
  test.each([
    '1',
    '1.0',
    '1.0.0-',
    '1.0.0+build',
    '1.0.x',
    '01.0.0',
    'release',
    'latest',
  ])('rejects version %j with invalid_version', async (version) => {
    const { app } = await setup();
    const res = await publish(app, { apiKey: API_KEY, body: goodBody({ version }) });
    expect(res.status).toBe(400);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('invalid_version');
  });
});

describe('fuzz: name validation', () => {
  test.each([
    'Demo', // uppercase
    '.leading', // leading dot
    'has space', // embedded whitespace
    'demo\u0001plugin', // control char
    'x'.repeat(129), // one past the 128 cap
  ])('rejects name %j with invalid_name', async (name) => {
    const { app } = await setup();
    const res = await publish(app, { apiKey: API_KEY, body: goodBody({ name }) });
    expect(res.status).toBe(400);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('invalid_name');
  });
});

describe('fuzz: module validation', () => {
  test.each([
    '!!!not-base64!!!', // not in the base64 alphabet at all
    'AAAA====', // padding in the wrong place
    'AB=C', // misplaced single pad
    '   ', // whitespace only
  ])('rejects module %j with invalid_module', async (module) => {
    const { app } = await setup();
    const res = await publish(app, { apiKey: API_KEY, body: goodBody({ module }) });
    expect(res.status).toBe(400);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('invalid_module');
  });

  test('rejects a ~256KB base64 module cheaply, whichever gate trips first', async () => {
    const big = Buffer.alloc(192 * 1024, 0x61).toString('base64');
    // a tiny configured cap must trip the encoded-size gate before any decode
    const small = await setup({ maxModuleBytes: 16 });
    const resSmall = await publish(small.app, { apiKey: API_KEY, body: goodBody({ module: big }) });
    expect(resSmall.status).toBe(400);
    expect((await jsonOf(resSmall)).error.code).toBe('module_too_large');
    // with the default cap the same size is fine to decode, so use a string of
    // invalid base64 at the same size to hit the strict-base64 gate instead
    const def = await setup();
    const resBig = await publish(def.app, {
      apiKey: API_KEY,
      body: goodBody({ module: '!'.repeat(256 * 1024) }),
    });
    expect(resBig.status).toBe(400);
    expect((await jsonOf(resBig)).error.code).toBe('invalid_module');
  });

  test('rejects an empty module (zero bytes after decode) with missing_module', async () => {
    const { app } = await setup();
    // non-empty strict base64 cannot decode to zero bytes, so the empty
    // string is the only path to this branch
    const res = await publish(app, { apiKey: API_KEY, body: goodBody({ module: '' }) });
    expect(res.status).toBe(400);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('missing_module');
  });
});

describe('fuzz: signature validation', () => {
  test.each([
    '!!!sig!!!', // not base64
    Buffer.alloc(32).toString('base64'), // too few bytes for ed25519 (64)
    Buffer.alloc(65).toString('base64'), // one byte too many
  ])('rejects signature %j with invalid_signature', async (signature) => {
    const { app } = await setup();
    const res = await publish(app, { apiKey: API_KEY, body: goodBody({ signature }) });
    expect(res.status).toBe(400);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('invalid_signature');
  });

  test('rejects a well-formed 64-byte signature when no publisher key is on file', async () => {
    const { app } = await setup();
    // fail closed: unverifiable signature must never be accepted
    const res = await publish(app, {
      apiKey: API_KEY,
      body: goodBody({ signature: Buffer.alloc(64).toString('base64') }),
    });
    expect(res.status).toBe(400);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('untrusted_publisher');
  });
});

describe('fuzz: auth ordering', () => {
  test('no x-api-key returns 401 even when the body is a fuzz body', async () => {
    const { app } = await setup();
    const res = await publish(app, { apiKey: null, body: goodBody({ id: '../' }) });
    expect(res.status).toBe(401);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('unauthorized');
  });

  test('no x-api-key returns 401 even on a non-JSON content type', async () => {
    const { app } = await setup();
    const res = await publish(app, { apiKey: null, contentType: 'application/octet-stream', rawBody: 'rawbytes' });
    expect(res.status).toBe(401);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('unauthorized');
  });

  test('wrong x-api-key returns 401 even for an otherwise valid publish body', async () => {
    const { app } = await setup();
    const res = await publish(app, { apiKey: 'definitely-not-the-key', body: goodBody({ version: '1' }) });
    expect(res.status).toBe(401);
    const json = await jsonOf(res);
    expect(json.error.code).toBe('unauthorized');
  });
});
