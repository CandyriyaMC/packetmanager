// smoke tests for the pm CLI. the registry itself is not contacted — the
// "server" in these tests is a bun-local mock on an ephemeral localhost port.
import { describe, expect, test, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PM = fileURLToPath(new URL('./pm', import.meta.url));
const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort cleanup, whatever
    }
  }
});

// spawn the CLI as a subprocess, exactly how an operator would call it
async function runPm(
  args: string[],
  envOverride: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string; output: string; exitCode: number }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...envOverride })) {
    if (v !== undefined) env[k] = v;
  }
  const proc = Bun.spawn([process.execPath, PM, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, output: `${stdout}\n${stderr}`, exitCode };
}

describe('pm CLI', () => {
  test('pm --help lists all six subcommands', async () => {
    for (const invocation of [['--help'], ['help']]) {
      const res = await runPm(invocation);
      expect(res.exitCode).toBe(0);
      for (const name of ['list', 'get', 'download', 'publish', 'health', 'help']) {
        expect(res.output).toContain(name);
      }
    }
  });

  test('pm list against an unreachable server exits 1 and says "unreachable"', async () => {
    // port 1 on localhost is never a live service, so the connect is refused
    const res = await runPm(['--base-url', 'http://127.0.0.1:1', 'list']);
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain('unreachable');
  });

  test('pm download of a missing plugin prints the server\'s HTTP 404', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/v1/plugins/nope/download') {
          return new Response(JSON.stringify({ ok: false, reason: 'not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const outPath = join(makeTmpDir(), 'nope.plugin');
      const res = await runPm([
        '--base-url',
        `http://127.0.0.1:${server.port}`,
        'download',
        'nope',
        '--out',
        outPath,
      ]);
      expect(res.output).toContain('HTTP 404');
      expect(res.exitCode).toBe(3);
    } finally {
      server.stop(true);
    }
  });

  test('pm publish without $PM_API_KEY exits non-zero', async () => {
    const wasmPath = join(makeTmpDir(), 'demo.wasm');
    writeFileSync(wasmPath, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    const res = await runPm(['publish', 'demo', wasmPath], { PM_API_KEY: undefined });
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain('PM_API_KEY');
  });
});
