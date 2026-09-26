const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

/**
 * Flat ESLint configuration.
 *
 * Formatting is delegated to Prettier — `eslint-config-prettier` must stay last
 * so it can switch off every stylistic rule that would fight the formatter.
 */
module.exports = [
  {
    ignores: ['node_modules/', 'coverage/', 'logs/', '.ai-ignored/', '.ai-tasks/'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': ['error', 'always'],
      'no-console': 'off',
      'no-await-in-loop': 'off',
      // Payouts are processed one at a time on purpose, so `for…of` with `await` is intended.
      'require-atomic-updates': 'off',
    },
  },
  {
    files: ['tests/**/*.js', 'jest.setup.js'],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
  },
  prettier,
];
