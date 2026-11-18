import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
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

  /** Read the raw .wasm bytes of a published plugin. */
  async readManifest(id: string): Promise<Buffer | null> {
    try {
      return await readFile(this.manifestPath(id));
    } catch {
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
