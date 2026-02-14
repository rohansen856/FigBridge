import { readFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';
import { glob } from 'tinyglobby';
import type { Diagnostic } from './diagnostics.js';
import { ReferenceIndex } from './index/reference-index.js';
import { createEnvLookup, referencedEnvNames } from './manifest/env.js';
import { loadManifest } from './manifest/load.js';
import { MANIFEST_FILENAME, type ManifestLoadResult, type ScanSettings } from './manifest/types.js';
import { Scanner } from './scanner/scanner.js';

/** Files larger than this are skipped (minified bundles, generated code). */
export const MAX_SOURCE_BYTES = 1024 * 1024;

/** Walks up from `start` to the nearest directory containing the manifest. */
export function findManifestRoot(start: string, stopAt?: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, MANIFEST_FILENAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir || (stopAt && dir === resolve(stopAt))) return undefined;
    dir = parent;
  }
}

/** Reads the manifest plus `.env` (only the variables the manifest references). */
export async function loadManifestFromDisk(
  root: string,
  processEnv: Record<string, string | undefined> = process.env,
): Promise<ManifestLoadResult> {
  const path = join(root, MANIFEST_FILENAME);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return {
      state: 'invalid',
      diagnostics: [{ code: 'CONFIG_NOT_FOUND', severity: 'error', message: `No ${MANIFEST_FILENAME} in ${root}.`, file: MANIFEST_FILENAME }],
    };
  }
  const names = referencedEnvNames(text);
  let dotenv: string | undefined;
  if (names.size) dotenv = await readFile(join(root, '.env'), 'utf8').catch(() => undefined);
  return loadManifest(text, MANIFEST_FILENAME, createEnvLookup(names, processEnv, dotenv));
}

export function createPathFilter(scan: ScanSettings): (relPath: string) => boolean {
  const include = picomatch(scan.include, { dot: false });
  const exclude = picomatch(scan.exclude, { dot: true });
  return (p) => include(p) && !exclude(p);
}

export interface WorkspaceScanResult {
  index: ReferenceIndex;
  manifest: ManifestLoadResult;
  skipped: string[];
}

/**
 * Scans a workspace from disk. Never follows symlinks out of `root` and never reads files that
 * the manifest's include/exclude globs don't select.
 */
export async function scanWorkspace(
  root: string,
  scanner: Scanner,
  options: { signal?: AbortSignal; env?: Record<string, string | undefined> } = {},
): Promise<WorkspaceScanResult> {
  const { signal } = options;
  const index = new ReferenceIndex();
  const manifest = await loadManifestFromDisk(root, options.env);
  const duplicateMappings = manifest.diagnostics.filter((d: Diagnostic) => d.code === 'DUPLICATE_MAPPING').length;
  index.setManifest(manifest.manifest, duplicateMappings);
  const skipped: string[] = [];
  if (!manifest.manifest) {
    index.scanState = 'failed';
    return { index, manifest, skipped };
  }
  const realRoot = await realpath(root);
  const filter = createPathFilter(manifest.manifest.scan);
  const files = await glob(manifest.manifest.scan.include, {
    cwd: root,
    ignore: manifest.manifest.scan.exclude,
    followSymbolicLinks: false,
    onlyFiles: true,
    dot: false,
  });
  let partial = false;
  for (const rel of files.sort()) {
    if (signal?.aborted) {
      partial = true;
      break;
    }
    const relPath = rel.split(sep).join('/');
    if (!filter(relPath)) continue;
    const abs = join(root, rel);
    try {
      const real = await realpath(abs);
      if (!isInside(realRoot, real)) {
        skipped.push(relPath);
        continue;
      }
      const info = await stat(real);
      if (info.size > MAX_SOURCE_BYTES) {
        skipped.push(relPath);
        continue;
      }
      const text = await readFile(real, 'utf8');
      index.setFile(scanner.scan({ relPath, text }));
    } catch {
      skipped.push(relPath);
      partial = true;
    }
  }
  index.scanState = partial ? 'partial' : 'complete';
  return { index, manifest, skipped };
}

export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}
