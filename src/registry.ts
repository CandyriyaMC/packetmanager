import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
}

/** ids: lowercase slug only. note: '..' passes this, so it's necessary but not sufficient */
export const PLUGIN_ID_RE = /^[a-z0-9_.-]{1,64}$/;

const ARTIFACT_NAME = 'plugin.wasm';

/**
 * Resolve the artifact path for a plugin id. The regex gate alone is not a
 * path-traversal fix ('..' is all dots), so we resolve to an absolute path
 * and verify it stays inside dataDir. Returns null when the id is invalid
 * or the resolved path escapes the root.
 */
export function resolveArtifactPath(dataDir: string, id: string): string | null {
  if (!PLUGIN_ID_RE.test(id)) return null;
  const root = resolve(dataDir);
  const artifact = resolve(root, id, ARTIFACT_NAME);
  const rel = relative(root, artifact);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return artifact;
}

// only these are allowed from a manifest; anything else falls through to sniffing
const ALLOWED_CONTENT_TYPES = new Set(['application/wasm', 'application/octet-stream']);

export interface ResolvedArtifact {
  path: string;
  sizeBytes: number;
  contentType: string;
}

/** sniff the 4-byte wasm magic \0asm, else octet-stream */
async function sniffContentType(filePath: string): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    const isWasm =
      bytesRead === 4 && head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d;
    return isWasm ? 'application/wasm' : 'application/octet-stream';
  } finally {
    await handle.close();
  }
}

export interface PluginDetail extends PluginSummary {
  publishedAt: string;
  module: string;
}

export interface PublishFinding {
  ok: boolean;
  findings: string[];
}

export class PluginRegistry {
  constructor(private readonly dataDir: string) {}

  async listPublished(): Promise<PluginSummary[]> {
    await this.ensureRoot();
    const entries = await readdir(this.dataDir, { withFileTypes: true });
    const out: PluginSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const detail = await this.readDetail(entry.name);
        if (detail) out.push({ id: detail.id, name: detail.name, version: detail.version });
      } catch {
        // skip unreadable plugin directories
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async getDetail(id: string): Promise<PluginDetail | null> {
    const detail = await this.readDetail(id);
    return detail;
  }

  async getCore(id: string): Promise<{ id: string; name: string; version: string } | null> {
    const detail = await this.readDetail(id);
    return detail ? { id: detail.id, name: detail.name, version: detail.version } : null;
  }

  /**
   * Locate and classify the plugin artifact. Returns null when the plugin is
   * missing (invalid id, escaping path, or absent file) — caller maps that to
   * 404. Content-Type comes from the manifest when it declares an allowlisted
   * value, otherwise from magic bytes.
   */
  async resolveArtifact(id: string): Promise<ResolvedArtifact | null> {
    const artifactPath = resolveArtifactPath(this.dataDir, id);
    if (!artifactPath) return null;
    let sizeBytes: number;
    try {
      const st = await stat(artifactPath);
      if (!st.isFile()) return null;
      sizeBytes = st.size;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw err; // real IO error — caller turns this into a 500
    }
    // id is validated at this point, so logging it raw is safe
    const fromManifest = await this.manifestContentType(id);
    const contentType = fromManifest ?? (await sniffContentType(artifactPath));
    return { path: artifactPath, sizeBytes, contentType };
  }

  /** contentType from manifest.json if it is a string on the allowlist */
  private async manifestContentType(id: string): Promise<string | null> {
    try {
      const raw = await readFile(join(this.dataDir, id, 'manifest.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const ct = (parsed as Record<string, unknown> | null)?.contentType;
      if (typeof ct === 'string') {
        const lower = ct.toLowerCase();
        if (ALLOWED_CONTENT_TYPES.has(lower)) return lower;
      }
      return null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(`download: ignoring unreadable manifest for plugin id=${id}:`, err);
      }
      return null;
    }
  }

  /**
   * Validate and store a new plugin. Idempotency is not guaranteed yet:
   * re-publishing the same version currently just overwrites in place.
   */
  async publish(input: {
    id: string;
    name: string;
    version: string;
    module: string;
  }): Promise<PublishFinding> {
    const findings: string[] = [];
    if (!/^[a-z0-9_-]{1,64}$/.test(input.id)) findings.push('invalid id');
    if (!/^[a-z0-9][a-z0-9.-]{0,127}$/i.test(input.name)) findings.push('invalid name');
    if (!/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/i.test(input.version)) findings.push('invalid semver');
    if (!input.module) findings.push('module bytes required');
    if (findings.length > 0) return { ok: false, findings };

    await this.ensureRoot();
    const dir = join(this.dataDir, input.id);
    await mkdir(dir, { recursive: true });
    const wasmBuffer = Buffer.from(input.module, 'base64');
    await writeFile(this.manifestPath(input.id), wasmBuffer);
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify(
        {
          id: input.id,
          name: input.name,
          version: input.version,
          publishedAt: new Date().toISOString(),
          module: input.module,
        } satisfies PluginDetail,
        null,
        2,
      ),
    );
    return { ok: true, findings: [] };
  }

  private async readDetail(id: string): Promise<PluginDetail | null> {
    try {
      const raw = await readFile(join(this.dataDir, id, 'manifest.json'), 'utf8');
      return JSON.parse(raw) as PluginDetail;
    } catch {
      return null;
    }
  }

  private manifestPath(id: string): string {
    return join(this.dataDir, id, 'plugin.wasm');
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
  }

  /** internal hook used by tests */
  static async freshTempDir(): Promise<string> {
    return join('/tmp', 'pm-test-' + randomUUID());
  }
}
