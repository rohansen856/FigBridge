import { describe, expect, it } from 'vitest';
import { createEnvLookup, parseDotenv, referencedEnvNames } from './env.js';

describe('dotenv', () => {
  const text = [
    '# comment',
    'FIGMA_FILE_URL="https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/x"',
    "export FIGMA_OTHER='b'",
    'FIGMA_ACCESS_TOKEN="figd_secret_value_123"',
    'DATABASE_PASSWORD=hunter2',
    'FIGMA_PLAIN=c # trailing comment',
  ].join('\n');

  it('keeps only allowlisted keys and strips quotes', () => {
    const m = parseDotenv(text, new Set(['FIGMA_FILE_URL', 'FIGMA_OTHER', 'FIGMA_PLAIN']));
    expect([...m.entries()]).toEqual([
      ['FIGMA_FILE_URL', 'https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/x'],
      ['FIGMA_OTHER', 'b'],
      ['FIGMA_PLAIN', 'c'],
    ]);
  });

  it('lookup prefers process env and refuses non-allowlisted names', () => {
    const lookup = createEnvLookup(new Set(['FIGMA_FILE_URL']), { FIGMA_FILE_URL: 'from-process', HOME: '/root' }, text);
    expect(lookup('FIGMA_FILE_URL')).toBe('from-process');
    expect(lookup('HOME')).toBeUndefined();
    expect(lookup('FIGMA_ACCESS_TOKEN')).toBeUndefined();
  });

  it('finds referenced placeholder names', () => {
    expect([...referencedEnvNames('url: "${env:FIGMA_FILE_URL}"\nx: ${env:HOME}')]).toEqual(['FIGMA_FILE_URL']);
  });
});
