import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
}

// plate: this is exported for the tests but the strict grammar is internal
export const PLUGIN_ID_RE = /^[a-z0-9_-]{1,64}$/;
export const ID_RE = PLUGIN_ID_RE;

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
  size: number;
  sha256: string;
}

export interface PublishPluginInfo {
  id: string;
  name: string;
  version: string;
  publishedAt: string;
  size: number;
}

export interface PublishError {
  code: string;
  message: string;
  details?: Record<string, string>;
}

export type PublishResult =
  | { ok: true; plugin: PublishPluginInfo }
  | { ok: false; error: PublishError };

/**
 * Raw upload shape. Every field is `unknown` on purpose: the route hands us
 * whatever JSON the client sent and the validator narrows. Nothing here is
 * trusted until validate() has had its way with it.
 */
export interface PublishInput {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  module?: unknown;
  signature?: unknown;
}

export const DEFAULT_MAX_MODULE_BYTES = 8 * 1024 * 1024;
// id and version both become path segments, so cap version as well
const MAX_VERSION_LENGTH = 64;
const MAX_NAME_LENGTH = 128;
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_PUBLIC_KEY_BYTES = 32;

const NAME_RE = /^[a-z0-9][a-z0-9.-]{0,127}$/;
// strict semver 2.0.0 without build metadata: major.minor.patch and an
// optional dot-separated pre-release (numeric identifiers may not have
// leading zeros). kept deliberately small, no dependency needed
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isStrictBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && BASE64_RE.test(value);
}

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[] | null;
}

function parseSemver(value: string): SemverParts | null {
  const match = SEMVER_RE.exec(value);
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split('.') : null,
  };
}

// semver precedence: release > prerelease; numeric ids < alphanumeric ids
function compareSemver(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      // exact for arbitrarily long numeric identifiers: compare digit-count
      // first (no leading zeros by semver rules), then lexicographically
      if (x.length !== y.length) return x.length - y.length;
      if (x !== y) return x < y ? -1 : 1;
      continue;
    }
    if (xNum) return -1;
    if (yNum) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function compareVersionStrings(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa && pb) return compareSemver(pa, pb);
  if (pa) return 1;
  if (pb) return -1;
  return a.localeCompare(b);
}

interface StoredManifest extends PluginSummary {
  publishedAt: string;
  size: number;
  sha256: string;
  signature?: { verified: boolean };
}

export class PluginRegistry {
  private readonly dataDir: string;
  private readonly maxModuleBytes: number;

  constructor(dataDir: string, opts?: { maxModuleBytes?: number }) {
    this.dataDir = dataDir;
    this.maxModuleBytes = opts?.maxModuleBytes ?? DEFAULT_MAX_MODULE_BYTES;
  }

  /** Latest version of every plugin, one entry per id, sorted by id. */
  async listPublished(): Promise<PluginSummary[]> {
    const manifests = await this.scanManifests();
    const latest = new Map<string, StoredManifest>();
    for (const manifest of manifests) {
      const current = latest.get(manifest.id);
      if (!current || compareVersionStrings(manifest.version, current.version) > 0) {
        latest.set(manifest.id, manifest);
      }
    }
    return [...latest.values()]
      .map(({ id, name, version }) => ({ id, name, version }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async getDetail(id: string): Promise<PluginDetail | null> {
    if (!ID_RE.test(id)) return null;
    const manifests = await this.scanManifests(id);
    const latest = latestOf(manifests);
    if (!latest) return null;
    return {
      id: latest.id,
      name: latest.name,
      version: latest.version,
      publishedAt: latest.publishedAt,
      size: latest.size,
      sha256: latest.sha256,
    };
  }

  async getCore(id: string): Promise<{ id: string; name: string; version: string } | null> {
    const detail = await this.getDetail(id);
    return detail ? { id: detail.id, name: detail.name, version: detail.version } : null;
  }

  /**
   * Locate and classify the latest-published-plugin artifact. Returns null
   * when there's nothing published (invalid id, escaping path, missing dir).
   *
   * Content-Type precedence: manifest.json `contentType` if it's on the allowlist,
   * otherwise magic-byte sniff of the 4-byte wasm magic, otherwise
   * application/octet-stream.
   */
  async resolveArtifact(id: string): Promise<ResolvedArtifact | null> {
    const manifests = await this.scanManifests(id);
    const latest = latestOf(manifests);
    if (!latest) return null;
    const artifactPath = this.pluginPath(latest.id, latest.version);
    let sizeBytes: number;
    try {
      const st = await stat(artifactPath);
      if (!st.isFile()) return null;
      sizeBytes = st.size;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw err;
    }
    const manifestContentType = await this.manifestContentType(latest.id, latest.version);
    const contentType =
      manifestContentType ?? (await sniffContentType(artifactPath));
    return { path: artifactPath, sizeBytes, contentType };
  }

  /** contentType from manifest.json if string on the allowlist, else null */
  private async manifestContentType(id: string, version: string): Promise<string | null> {
    try {
      const raw = await readFile(this.manifestPath(id, version), 'utf8');
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
        console.warn(
          `download: ignoring unreadable manifest for plugin id=${id}@${version}:`,
          err,
        );
      }
      return null;
    }
  }

  private manifestPath(id: string, version: string): string {
    return join(this.dataDir, 'plugins', id, version, 'manifest.json');
  }

  /**
   * Validate and store a new plugin version.
   *
   * Publish-once per version: re-publishing the same id+version is rejected
   * with duplicate_version (409). Published artifacts are content-addressed
   * by the sha256 in the manifest, so letting a version be silently
   * overwritten would break everyone who already downloaded it.
   */
  async publish(input: PublishInput): Promise<PublishResult> {
    const validated = await this.validate(input);
    if (!validated.ok) return validated;
    const { id, name, version, moduleBytes, signature } = validated.value;

    const pluginsRoot = resolve(this.dataDir, 'plugins');
    // belt and braces: id/version are regex-clean by now, but never trust a
    // path segment to stay a path segment after it travels through promises
    const versionDir = resolve(pluginsRoot, id, version);
    if (versionDir !== join(pluginsRoot, id, version) || !versionDir.startsWith(pluginsRoot + sep)) {
      return fail('invalid_id', 'id/version resolve outside the plugins directory');
    }

    await mkdir(join(pluginsRoot, id), { recursive: true });

    // claim the version slot atomically: plain mkdir fails with EEXIST if
    // someone got there first (or a previous botched publish left it behind)
    try {
      await mkdir(versionDir, { recursive: false });
    } catch (err) {
      if (isNodeError(err) && err.code === 'EEXIST') {
        return fail('duplicate_version', `plugin ${id}@${version} is already published`, { id, version });
      }
      console.error(`publish: failed to create version directory: ${String(err)}`);
      return fail('internal', 'failed to prepare storage for the plugin');
    }

    const sha256 = createHash('sha256').update(moduleBytes).digest('hex');
    const publishedAt = new Date().toISOString();
    const signatureVerified = signature !== undefined;

    try {
      await this.writeFileAtomic(join(versionDir, 'plugin.plugin'), moduleBytes);
      if (signature) {
        await this.writeFileAtomic(join(versionDir, 'sig'), signature);
      }
      const manifest: StoredManifest = {
        id,
        name,
        version,
        publishedAt,
        size: moduleBytes.length,
        sha256,
        ...(signatureVerified ? { signature: { verified: true } } : {}),
      };
      await this.writeFileAtomic(join(versionDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    } catch (err) {
      // we claimed the slot, so we own cleaning it up — don't leave a
      // half-written version behind that would 409 every retry forever
      console.error(`publish: write failed for ${id}@${version}: ${String(err)}`);
      await rm(versionDir, { recursive: true, force: true }).catch(() => {});
      return fail('internal', 'failed to store the plugin');
    }

    // log the hash, never the payload
    console.log(
      `publish: ${id}@${version} bytes=${moduleBytes.length} sha256=${sha256} signed=${signatureVerified ? 'yes' : 'no'}`,
    );

    return { ok: true, plugin: { id, name, version, publishedAt, size: moduleBytes.length } };
  }

  // --- validation ---------------------------------------------------------

  private async validate(input: PublishInput): Promise<
    | { ok: true; value: { id: string; name: string; version: string; moduleBytes: Buffer; signature?: Buffer } }
    | { ok: false; error: PublishError }
  > {
    const id = asString(input.id);
    if (id === null || !ID_RE.test(id)) {
      return fail('invalid_id', 'id must match ^[a-z0-9_-]{1,64}$');
    }

    const name = asString(input.name);
    if (name === null || name.length > MAX_NAME_LENGTH || !NAME_RE.test(name)) {
      return fail('invalid_name', 'name must match ^[a-z0-9][a-z0-9.-]{0,127}$');
    }

    const version = asString(input.version);
    if (version === null || version.length > MAX_VERSION_LENGTH || !SEMVER_RE.test(version)) {
      return fail('invalid_version', 'version must be semver major.minor.patch with optional pre-release');
    }

    const moduleB64 = asString(input.module);
    if (moduleB64 === null || moduleB64.length === 0) {
      return fail('missing_module', 'module is required: base64-encoded bytes of the .plugin bundle');
    }
    // check the encoded size before decoding so a giant string is rejected cheaply
    if (moduleB64.length > Math.ceil(this.maxModuleBytes / 3) * 4 + 4) {
      return fail('module_too_large', `module exceeds the ${this.maxModuleBytes}-byte limit`);
    }
    if (!isStrictBase64(moduleB64)) {
      return fail('invalid_module', 'module must be valid base64');
    }
    const moduleBytes = Buffer.from(moduleB64, 'base64');
    if (moduleBytes.length === 0) {
      return fail('missing_module', 'module decodes to zero bytes');
    }
    if (moduleBytes.length > this.maxModuleBytes) {
      return fail('module_too_large', `module exceeds the ${this.maxModuleBytes}-byte limit`);
    }

    // ed25519 is checked, not assumed: 64 raw signature bytes when present
    let signature: Buffer | undefined;
    if (input.signature !== undefined) {
      const sigB64 = asString(input.signature);
      if (sigB64 === null || !isStrictBase64(sigB64)) {
        return fail('invalid_signature', 'signature must be valid base64 when provided');
      }
      signature = Buffer.from(sigB64, 'base64');
      if (signature.length !== ED25519_SIGNATURE_BYTES) {
        return fail('invalid_signature', `ed25519 signature must decode to ${ED25519_SIGNATURE_BYTES} bytes`);
      }
      const keyError = await this.verifySignature(id, moduleBytes, signature);
      if (keyError) return keyError;
    }

    return { ok: true, value: { id, name, version, moduleBytes, signature } };
  }

  /**
   * Fail closed: a signature is only accepted when the operator installed a
   * trusted publisher key at <dataDir>/publishers/<id>.pub (base64 of the raw
   * 32-byte ed25519 public key). No key on file or a bad signature means the
   * upload is rejected — accepting unverifiable signatures would be theatre.
   *
   * When no signature is provided at all we still accept the publish for now
   * and log it, because the publisher-key enrollment flow does not exist
   * yet. TODO(#1): make signatures mandatory once enrollment lands; until
   * then anyone holding PM_API_KEY can publish under any id.
   */
  private async verifySignature(id: string, moduleBytes: Buffer, signature: Buffer): Promise<{ ok: false; error: PublishError } | null> {
    const keyPath = join(this.dataDir, 'publishers', `${id}.pub`);
    let raw: string;
    try {
      raw = await readFile(keyPath, 'utf8');
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return fail(
          'untrusted_publisher',
          `no trusted publisher key on file for id "${id}" (expected publishers/${id}.pub); refusing to accept an unverifiable signature`,
          { id },
        );
      }
      console.error(`publish: could not read publisher key ${keyPath}: ${String(err)}`);
      return fail('internal', 'failed to read the publisher key');
    }
    const trimmed = raw.trim();
    if (!isStrictBase64(trimmed)) {
      return fail('invalid_publisher_key', `publisher key file publishers/${id}.pub is not strict base64`);
    }
    const keyBytes = Buffer.from(trimmed, 'base64');
    if (keyBytes.length !== ED25519_PUBLIC_KEY_BYTES) {
      return fail('invalid_publisher_key', `publisher key file publishers/${id}.pub must decode to ${ED25519_PUBLIC_KEY_BYTES} bytes`);
    }
    // jwk wants base64url — normalize whatever strict-base64 the file holds
    const base64url = trimmed.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    let keyObject;
    try {
      keyObject = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: base64url }, format: 'jwk' });
    } catch {
      return fail('invalid_publisher_key', `publisher key file publishers/${id}.pub is not a valid ed25519 public key`);
    }
    if (!verify(null, moduleBytes, keyObject, signature)) {
      return fail('invalid_signature', 'signature does not verify against the trusted publisher key', { id });
    }
    return null;
  }

  // --- storage helpers ----------------------------------------------------

  private pluginPath(id: string, version: string): string {
    return join(this.dataDir, 'plugins', id, version, 'plugin.plugin');
  }

  private async writeFileAtomic(finalPath: string, data: Buffer | string): Promise<void> {
    const tmp = `${finalPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, finalPath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  private async scanManifests(id?: string): Promise<StoredManifest[]> {
    const root = join(this.dataDir, 'plugins');
    let ids: string[];
    if (id !== undefined) {
      if (!ID_RE.test(id)) return [];
      ids = [id];
    } else {
      try {
        ids = (await readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') return [];
        throw err;
      }
    }
    const out: StoredManifest[] = [];
    for (const scopeId of ids) {
      const versionsDir = join(root, scopeId);
      let versionEntries;
      try {
        versionEntries = await readdir(versionsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of versionEntries) {
        if (!entry.isDirectory()) continue;
        try {
          const raw = await readFile(join(versionsDir, entry.name, 'manifest.json'), 'utf8');
          const parsed = JSON.parse(raw) as StoredManifest;
          if (typeof parsed.id !== 'string' || typeof parsed.version !== 'string') continue;
          out.push(parsed);
        } catch {
          // skip unreadable or half-written versions
          console.warn(`scan: skipping ${scopeId}/${entry.name} (unreadable manifest)`);
        }
      }
    }
    return out;
  }
}

function latestOf<T extends { version: string; publishedAt: string }>(manifests: T[]): T | null {
  let best: T | null = null;
  for (const manifest of manifests) {
    if (!best) {
      best = manifest;
      continue;
    }
    const byVersion = compareVersionStrings(manifest.version, best.version);
    if (byVersion > 0 || (byVersion === 0 && manifest.publishedAt > best.publishedAt)) {
      best = manifest;
    }
  }
  return best;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function fail(code: string, message: string, details?: Record<string, string>): { ok: false; error: PublishError } {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
