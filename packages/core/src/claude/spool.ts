import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { MAX_EVENT_BYTES, parseEvent, type ClaudeEvent } from './events.js';

export const SPOOL_MAX_FILES = 200;
export const SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_FILE = /^\d{13}-[0-9a-f-]{36}\.json$/;

/** Per-user state directory (outside any repository). */
export function stateDir(env: Record<string, string | undefined> = process.env): string {
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'figbridge');
    case 'win32':
      return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'figbridge');
    default:
      return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'figbridge');
  }
}

/**
 * Spool directory for one project, keyed by the real path of the directory that holds the
 * manifest. The hook (Claude Code side) and the extension compute the same path independently.
 */
export async function spoolDirFor(manifestDir: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  let real = await realpath(manifestDir);
  if (platform() === 'win32' || platform() === 'darwin') real = real.toLowerCase();
  const key = createHash('sha256').update(real).digest('hex').slice(0, 16);
  return join(stateDir(env), 'spool', key);
}

/** Creates the spool directory (0700) and refuses symlinked components we create. */
export async function ensureSpoolDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('FigBridge spool directory is not a plain directory.');
}

/** Atomically writes one event (temp file + rename), then prunes old files. */
export async function writeEvent(dir: string, event: ClaudeEvent): Promise<string> {
  const body = JSON.stringify(event);
  if (Buffer.byteLength(body) > MAX_EVENT_BYTES) throw new Error('event too large');
  await ensureSpoolDir(dir);
  const name = `${Date.now().toString().padStart(13, '0')}-${event.eventId}.json`;
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  await writeFile(tmp, body, { mode: 0o600, flag: 'wx' });
  await rename(tmp, join(dir, name));
  await prune(dir);
  return name;
}

export async function prune(dir: string, now = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => EVENT_FILE.test(n)).sort();
  } catch {
    return;
  }
  const expired = names.filter((n) => now - Number(n.slice(0, 13)) > SPOOL_MAX_AGE_MS);
  const overflow = names.length - expired.length - SPOOL_MAX_FILES;
  const victims = [...expired, ...names.filter((n) => !expired.includes(n)).slice(0, Math.max(0, overflow))];
  await Promise.all(victims.map((n) => rm(join(dir, n), { force: true })));
}

export interface SpoolReadResult {
  events: Array<{ name: string; event: ClaudeEvent }>;
  /** Files that failed validation (already deleted). */
  rejected: number;
}

/** Reads, validates and deletes pending event files, oldest first. */
export async function drainSpool(dir: string): Promise<SpoolReadResult> {
  const out: SpoolReadResult = { events: [], rejected: 0 };
  let names: string[];
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) return out;
    names = (await readdir(dir)).filter((n) => EVENT_FILE.test(n)).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > MAX_EVENT_BYTES) {
        out.rejected++;
      } else {
        const event = parseEvent(await readFile(path, 'utf8'));
        if (event) out.events.push({ name, event });
        else out.rejected++;
      }
    } catch {
      out.rejected++;
    }
    await rm(path, { force: true });
  }
  return out;
}

export async function spoolExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
