import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../index';

// no network, no real secrets — the key below is a throwaway test fixture, not
// a credential for anything
const TEST_KEY = 'pm-test-fixture-key';

const VALID_PUBLISH = {
  id: 'test-plugin',
  name: 'validname',
  version: '1.0.0',
  module: Buffer.from('fake-wasm-bytes-for-tests').toString('base64'),
};

const EXPECTED_401 = { ok: false, reason: 'unauthorized' };
const EXPECTED_401_RAW = JSON.stringify(EXPECTED_401);

async function makeServer(apiKey: string | undefined) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pm-auth-test-'));
  const app = createServer({ apiKey, dataDir, baseUrl: 'http://localhost' });
  return { app, dataDir };
}

function publishRequest(key?: string, body: unknown = VALID_PUBLISH) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key !== undefined) headers['x-api-key'] = key;
  return new Request('http://localhost/api/v1/plugins/publish', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('auth middleware', () => {
  let dataDir: string | undefined;

  afterEach(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  test('missing key -> 401 with exact structured body', async () => {
    const s = await makeServer(TEST_KEY);
    dataDir = s.dataDir;
    const res = await s.app.handle(publishRequest());
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    const text = await res.text();
    expect(text).toBe(EXPECTED_401_RAW);
    expect(JSON.parse(text)).toEqual(EXPECTED_401);
  });

  test('wrong key -> 401 with exact structured body', async () => {
    const s = await makeServer(TEST_KEY);
    dataDir = s.dataDir;
    const res = await s.app.handle(publishRequest('pm-test-fixture-wr0ng'));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    const text = await res.text();
    expect(text).toBe(EXPECTED_401_RAW);
  });

  test('wrong-length keys (short and long) -> 401 with exact structured body', async () => {
    const s = await makeServer(TEST_KEY);
    dataDir = s.dataDir;
    for (const wrong of ['x', TEST_KEY.slice(0, -1), TEST_KEY + '-extra-bytes']) {
      const res = await s.app.handle(publishRequest(wrong));
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).toBe(EXPECTED_401_RAW);
    }
  });

  test('correct key -> passes through to the publish handler', async () => {
    const s = await makeServer(TEST_KEY);
    dataDir = s.dataDir;
    const res = await s.app.handle(publishRequest(TEST_KEY));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });
});
