import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/out/**', '**/node_modules/**', '**/marketplace/**', '**/claude-marketplace/**', 'spikes/**', 'fixtures/**', 'examples/**', '**/*.mjs'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-syntax': ['error', { selector: "CallExpression[callee.object.name='console'][callee.property.name='log']", message: 'Use stderr or the output channel; stdout is reserved for MCP.' }],
    },
  },
  { files: ['**/*.test.ts', '**/test/**', '**/test-utils/**'], rules: { 'no-restricted-syntax': 'off', '@typescript-eslint/no-explicit-any': 'off' } },
);
