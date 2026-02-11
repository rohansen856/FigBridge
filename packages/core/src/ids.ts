import { randomInt } from 'node:crypto';

/** Crockford Base32 alphabet (no I, L, O, U). */
export const REF_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const REF_ID_LENGTH = 12;
export const REF_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{12}$/;

export type RefId = string & { readonly __brand: 'RefId' };

export function isRefId(value: string): value is RefId {
  return REF_ID_PATTERN.test(value);
}

export type RefIdCheck =
  | { kind: 'valid'; id: RefId }
  /** Valid once upper-cased; the canonical form must be stored upper-case. */
  | { kind: 'noncanonical-case'; id: RefId }
  | { kind: 'invalid'; reason: 'length' | 'excluded-letter' | 'character'; suggestion?: string };

const CROCKFORD_SUBSTITUTES: Record<string, string> = { I: '1', L: '1', O: '0' };

/**
 * Classifies a raw 12-char token. Never silently remaps I/L/O/U: those produce an
 * `invalid` result, with a suggestion when a Crockford substitute exists.
 */
export function checkRefId(raw: string): RefIdCheck {
  if (raw.length !== REF_ID_LENGTH) return { kind: 'invalid', reason: 'length' };
  if (isRefId(raw)) return { kind: 'valid', id: raw };
  const upper = raw.toUpperCase();
  if (!/^[0-9A-Z]+$/.test(upper)) return { kind: 'invalid', reason: 'character' };
  if (isRefId(upper)) return { kind: 'noncanonical-case', id: upper as RefId };
  const substituted = [...upper].map((c) => CROCKFORD_SUBSTITUTES[c] ?? c).join('');
  return {
    kind: 'invalid',
    reason: 'excluded-letter',
    ...(isRefId(substituted) ? { suggestion: substituted } : {}),
  };
}

export type RandomIndex = (exclusiveMax: number) => number;

/**
 * True if YAML 1.2 (and most other parsers) could read the ID as a number, e.g. `000000000000`
 * or `1234E5678901`. The loader copes with these, but generated IDs avoid them so manifests
 * stay unambiguous in every tool.
 */
export function isNumericLooking(id: string): boolean {
  return !/[A-DF-Z]/.test(id);
}

/**
 * Generates one ID from a CSPRNG; each character is an unbiased draw from 32 symbols.
 * Numeric-looking draws (probability ≈ 2.7e-6) are redrawn.
 */
export function generateRefId(random: RandomIndex = randomInt): RefId {
  for (;;) {
    let out = '';
    for (let i = 0; i < REF_ID_LENGTH; i++) out += REF_ID_ALPHABET[random(REF_ID_ALPHABET.length)];
    if (!isNumericLooking(out)) return out as RefId;
  }
}

/**
 * Generates an ID not present in `taken` (manifest refs, retired IDs and every raw ID
 * seen in source). Throws after `maxAttempts` collisions, which only a broken RNG causes.
 */
export function generateUniqueRefId(
  taken: ReadonlySet<string>,
  random: RandomIndex = randomInt,
  maxAttempts = 16,
): RefId {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const id = generateRefId(random);
    if (!taken.has(id)) return id;
  }
  throw new Error(`Could not generate a unique reference ID after ${maxAttempts} attempts`);
}
