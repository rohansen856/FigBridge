import { readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { glob } from 'tinyglobby';
import {
  createPathFilter,
  isInside,
  loadManifestFromDisk,
  MANIFEST_FILENAME,
  MAX_SOURCE_BYTES,
  ReferenceIndex,
  Scanner,
  type ManifestLoadResult,
} from '@figbridge/core';

/**
 * Keeps a ReferenceIndex in sync with the files on disk. Each refresh re-globs the manifest's
 * include patterns and re-scans only files whose mtime or size changed, so repeated tool calls
 * stay cheap. Only manifest-selected files inside the root are ever read.
 */
export class DiskIndexer {
  readonly index = new ReferenceIndex();
  manifest: ManifestLoadResult | undefined;
  private manifestStamp = '';
  private readonly stamps = new Map<string, string>();
  private realRoot: string | undefined;
  private refreshing: Promise<void> | undefined;
  private lastRefresh = 0;

  constructor(
    readonly root: string,
    private readonly scanner: Scanner,
    private readonly minIntervalMs = 1000,
  ) {}

  refresh(): Promise<void> {
    if (Date.now() - this.lastRefresh < this.minIntervalMs && this.manifest) return Promise.resolve();
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
      this.lastRefresh = Date.now();
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    this.realRoot ??= await realpath(this.root);
    const manifestStamp = await stampOf(join(this.root, MANIFEST_FILENAME)).catch(() => 'missing');
    const envStamp = await stampOf(join(this.root, '.env')).catch(() => 'missing');
    if (`${manifestStamp}|${envStamp}` !== this.manifestStamp || !this.manifest) {
      this.manifestStamp = `${manifestStamp}|${envStamp}`;
      const prevScan = JSON.stringify(this.manifest?.manifest?.scan);
      this.manifest = await loadManifestFromDisk(this.root);
      if (this.manifest.manifest) {
        this.index.setManifest(this.manifest.manifest, this.manifest.diagnostics.filter((d) => d.code === 'DUPLICATE_MAPPING').length);
        if (prevScan !== JSON.stringify(this.manifest.manifest.scan)) {
          this.index.clearFiles();
          this.stamps.clear();
        }
      } else if (!this.index.getManifest()) {
        this.index.scanState = 'failed';
        return;
      }
    }
    const m = this.index.getManifest();
    if (!m) return;
    const filter = createPathFilter(m.scan);
    const files = (await glob(m.scan.include, { cwd: this.root, ignore: m.scan.exclude, followSymbolicLinks: false, onlyFiles: true })).map((f) => f.split(sep).join('/'));
    const present = new Set<string>();
    let partial = false;
    for (const relPath of files) {
      if (!filter(relPath)) continue;
      present.add(relPath);
      const abs = join(this.root, relPath);
      try {
        const stamp = await stampOf(abs);
        if (this.stamps.get(relPath) === stamp) continue;
        this.stamps.set(relPath, stamp);
        const real = await realpath(abs);
        const info = await stat(real);
        if (!isInside(this.realRoot, real) || info.size > MAX_SOURCE_BYTES) {
          this.index.removeFile(relPath);
          continue;
        }
        this.index.setFile(this.scanner.scan({ relPath, text: await readFile(real, 'utf8') }));
      } catch {
        partial = true;
      }
    }
    for (const relPath of [...this.stamps.keys()])
      if (!present.has(relPath)) {
        this.stamps.delete(relPath);
        this.index.removeFile(relPath);
      }
    this.index.scanState = partial ? 'partial' : 'complete';
  }
}

async function stampOf(path: string): Promise<string> {
  const s = await stat(path);
  return `${s.mtimeMs}:${s.size}`;
}
