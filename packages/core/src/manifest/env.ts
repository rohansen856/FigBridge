import type { EnvLookup } from './types.js';

/** Only variables with this prefix may be referenced from a manifest. */
export const ENV_NAME_PATTERN = /^FIGMA_[A-Z0-9_]{1,64}$/;

/**
 * Minimal dotenv reader: `KEY=value`, optional `export `, single/double quotes, `#` comments.
 * Only keys in `allowed` are kept; everything else in the file (which may hold unrelated
 * secrets) is discarded immediately. No interpolation or command expansion.
 */
export function parseDotenv(text: string, allowed: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !allowed.has(m[1]!)) continue;
    let value = m[2]!;
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2]!;
    else value = value.replace(/\s+#.*$/, '').trim();
    out.set(m[1]!, value);
  }
  return out;
}

/** Names of `${env:NAME}` placeholders used in manifest text, restricted to the allowed prefix. */
export function referencedEnvNames(manifestText: string): Set<string> {
  const names = new Set<string>();
  for (const m of manifestText.matchAll(/\$\{env:([A-Z0-9_]+)\}/g)) if (ENV_NAME_PATTERN.test(m[1]!)) names.add(m[1]!);
  return names;
}

/** Process environment first, then the workspace `.env` file; only allowlisted names resolve. */
export function createEnvLookup(
  allowed: ReadonlySet<string>,
  processEnv: Record<string, string | undefined>,
  dotenvText?: string,
): EnvLookup {
  const fromFile = dotenvText ? parseDotenv(dotenvText, allowed) : new Map<string, string>();
  return (name) => {
    if (!allowed.has(name) || !ENV_NAME_PATTERN.test(name)) return undefined;
    return processEnv[name] || fromFile.get(name) || undefined;
  };
}
