import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../index';

// no network, no real secrets - the key below is a throwaway test fixture, not
// a credential for anything
const TEST_KEY = 'pm-test-fixture-key';

const VALID_PUBLISH = {
  id: 'test-plugin',
  name: 'validname',
  version: '1.0.0',
  module: Buffer.from('fake-wasm-bytes-for-tests').toString('base64'),
};

const EXPECTED_401 = {
  ok: false,
  error: {
    code: 'unauthorized',
    message: 'a valid x-api-key header is required',
  },
};
const EXPECTED_401_RAW = JSON.stringify(EXPECTED_401);

function makeServer(apiKey: string | undefined) {
  const tempDir = mkdtemp(join(tmpdir(), 'pm-auth-'));
  return tempDir.then((dataDir) => {
    const app = createServer({ apiKey, dataDir, baseUrl: 'http://localhost' });
    return { app, dataDir };
  });
}

afterEach(async () => {
  // each test creates its own tmpdir under tmpdir(); leave them — mkdtemp outside imply /tmp so leak is bounded
});

describe('auth middleware', () => {
  test('missing key -> 401 with exact structured body', async () => {
    const { app, dataDir } = await makeServer(TEST_KEY);
    const res = await app.handle(
      new Request('http://localhost/api/v1/plugins/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(VALID_PUBLISH),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    const text = await res.text();
    expect(text).toBe(EXPECTED_401_RAW);
    expect(JSON.parse(text)).toEqual(EXPECTED_401);
    await rm(dataDir, { recursive: true, force: true });
  });

  test('wrong key -> 401 with exact structured body', async () => {
    const { app, dataDir } = await makeServer(TEST_KEY);
    const res = await app.handle(
      new Request('http://localhost/api/v1/plugins/publish', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'pm-test-fixture-wr0ng',
        },
        body: JSON.stringify(VALID_PUBLISH),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    const text = await res.text();
    expect(text).toBe(EXPECTED_401_RAW);
    await rm(dataDir, { recursive: true, force: true });
  });

  test('wrong-length keys (short and long) -> 401 with exact structured body', async () => {
    const { app, dataDir } = await makeServer(TEST_KEY);
    for (const wrong of ['x', TEST_KEY.slice(0, -1), TEST_KEY + '-extra-bytes']) {
      const res = await app.handle(
        new Request('http://localhost/api/v1/plugins/publish', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': wrong,
          },
          body: JSON.stringify(VALID_PUBLISH),
        }),
      );
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).toBe(EXPECTED_401_RAW);
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  test('correct key -> passes through to the publish handler', async () => {
    const { app, dataDir } = await makeServer(TEST_KEY);
    const res = await app.handle(
      new Request('http://localhost/api/v1/plugins/publish', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': TEST_KEY,
        },
        body: JSON.stringify(VALID_PUBLISH),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
    await rm(dataDir, { recursive: true, force: true });
  });
});
