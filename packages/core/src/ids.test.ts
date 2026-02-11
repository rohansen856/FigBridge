import { describe, expect, it } from 'vitest';
import { checkRefId, generateRefId, generateUniqueRefId, isRefId, REF_ID_ALPHABET } from './ids.js';

describe('ref IDs', () => {
  it('alphabet is Crockford Base32 without I L O U', () => {
    expect(REF_ID_ALPHABET).toHaveLength(32);
    expect(REF_ID_ALPHABET).not.toMatch(/[ILOU]/);
  });

  it('generated IDs are valid and well spread', () => {
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      const id = generateRefId();
      expect(isRefId(id)).toBe(true);
      seen.add(id);
      for (const c of id) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    expect(seen.size).toBe(2000);
    expect(counts.size).toBe(32); // every symbol appears in 24k draws
  });

  it('retries on collision with existing IDs', () => {
    const draws = [...'AAAAAAAAAAAA', ...'AAAAAAAAAAAA', ...'BBBBBBBBBBBB'].map((c) => REF_ID_ALPHABET.indexOf(c));
    let i = 0;
    const id = generateUniqueRefId(new Set(['AAAAAAAAAAAA']), () => draws[i++]!);
    expect(id).toBe('BBBBBBBBBBBB');
  });

  it('gives up after max attempts', () => {
    expect(() => generateUniqueRefId(new Set(["AAAAAAAAAAAA"]), () => 10, 3)).toThrow(/unique/);
  });

  it.each([
    ['F7KQ9M2X4P6D', 'valid'],
    ['f7kq9m2x4p6d', 'noncanonical-case'],
    ['F7KQ9M2X4P6', 'invalid'],
    ['F7KQ9M2X4P6DD', 'invalid'],
    ['F7KQ9M2X4P6U', 'invalid'],
    ['F7KQ9M2X4P-D', 'invalid'],
  ])('checkRefId(%s) → %s', (raw, kind) => {
    expect(checkRefId(raw).kind).toBe(kind);
  });

  it('suggests Crockford substitutes for I/L/O but never applies them', () => {
    expect(checkRefId('F7KQ9M2X4POL')).toEqual({ kind: 'invalid', reason: 'excluded-letter', suggestion: 'F7KQ9M2X4P01' });
    expect(checkRefId('F7KQ9M2X4PUU')).toEqual({ kind: 'invalid', reason: 'excluded-letter' });
  });
});

describe('numeric-looking IDs', () => {
  it('never generates IDs YAML would read as numbers', () => {
    const draws = [...'000000000000', ...'1234E5678901', ...'0000000000A0'].map((c) => REF_ID_ALPHABET.indexOf(c));
    let i = 0;
    expect(generateRefId(() => draws[i++]!)).toBe('0000000000A0');
  });
});
