'use strict';

module.exports = {
  env: {
    node: true,
    es2022: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
  },
  rules: {
    // Errors
    'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-undef': 'error',
    'no-console': 'off',

    // Style
    'eqeqeq': ['error', 'always'],
    'curly': ['error', 'all'],
    'prefer-const': 'error',
    'no-var': 'error',

    // Node
    'handle-callback-err': 'error',
  },
};
