module.exports = {
  root: true,
  env: {
    browser: true,
    es2020: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:prettier/recommended',
  ],
  ignorePatterns: [
    'dist',
    '.eslintrc.cjs',
    'node_modules',
    'src/api/schema.d.ts', // generated from the OpenAPI spec
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: ['./tsconfig.json', './tsconfig.node.json'],
    tsconfigRootDir: __dirname,
  },
  plugins: ['react-refresh', '@typescript-eslint', 'react'],
  settings: {
    react: {
      version: 'detect',
    },
  },
  rules: {
    // React rules
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
    'react/prop-types': 'off', // We use TypeScript for prop validation
    
    // TypeScript rules
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-non-null-assertion': 'warn',
    
    // General rules
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'no-debugger': 'error',
    'no-duplicate-imports': 'error',
    'no-unused-expressions': 'error',
    'prefer-const': 'error',
    'no-var': 'error',
    'eqeqeq': ['error', 'smart'],
    'curly': ['error', 'multi-line'],
    
    // Downgrade some strict rules to warnings to ease development
    '@typescript-eslint/ban-ts-comment': 'warn',
    'react/no-unescaped-entities': 'warn',
    'react/display-name': 'warn',
    'react-hooks/rules-of-hooks': 'warn',
    'no-empty': 'warn',
  },
  overrides: [
    {
      // Frontend state rule (.cursor/rules/18-frontend-state.mdc): components
      // and pages never call the API directly — go through a Zustand store
      // action and read the result via a selector. Type-only imports from the
      // api module are fine; only the `api` client is banned. Hooks are the
      // data-access seam and are exempt for now (but should also route through
      // stores — do not add new direct calls there).
      files: ['src/components/**/*.{ts,tsx}', 'src/pages/**/*.{ts,tsx}'],
      excludedFiles: ['**/hooks/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/api', '**/api/index'],
                importNames: ['api', 'unwrapBody', 'createApiClient'],
                message:
                  'Components/pages must not call the API directly. Add a Zustand store action and read via a selector. See .cursor/rules/18-frontend-state.mdc.',
              },
            ],
          },
        ],
      },
    },
  ],
};