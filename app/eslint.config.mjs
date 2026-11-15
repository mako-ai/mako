import js from "@eslint/js";
import prettierRecommended from "eslint-plugin-prettier/recommended";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

// One way to call the API: the typed client in src/api (see
// .cursor/rules/18-frontend-state.mdc). The lists below are shared because a
// later flat-config block REPLACES a rule's options for the files it matches
// instead of merging them.

/** Deleted HTTP helpers that must not come back. */
const LEGACY_CLIENT_PATTERNS = [
  {
    group: ["**/lib/api-client", "**/lib/workspace-client"],
    message:
      "The legacy API clients are gone: stores call the typed client in src/api (`api`, or `unspecced` for routes the spec does not describe yet).",
  },
];

/**
 * Raw `fetch("/api/...")` skips the typed client's workspace header and 401
 * handling. The few genuine exceptions (response streams, keepalive beacons)
 * carry an inline `eslint-disable-next-line no-restricted-syntax -- <why>`.
 */
const RAW_API_FETCH_MESSAGE =
  "Call the API through the typed client (src/api) from a store action, not raw fetch. A stream/beacon that cannot use it needs an inline eslint-disable with the reason.";
const RAW_API_FETCH = [
  {
    selector:
      "CallExpression[callee.name='fetch'][arguments.0.type='Literal'][arguments.0.value=/^\\/api(\\/|$)/]",
    message: RAW_API_FETCH_MESSAGE,
  },
  {
    selector:
      "CallExpression[callee.name='fetch'][arguments.0.type='TemplateLiteral'][arguments.0.quasis.0.value.raw=/^\\/api(\\/|$)/]",
    message: RAW_API_FETCH_MESSAGE,
  },
];

const DIRECT_API_MESSAGE =
  "Components/pages/contexts/hooks must not call the API directly. Add a Zustand store action and read via a selector. See .cursor/rules/18-frontend-state.mdc.";

export default defineConfig([
  // Only TypeScript is linted (the old `--ext ts,tsx`).
  globalIgnores([
    "**/dist/",
    "**/*.{js,mjs,cjs}",
    "src/api/schema.d.ts", // generated from the OpenAPI spec
  ]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      react.configs.flat.recommended,
      react.configs.flat["jsx-runtime"],
      prettierRecommended,
    ],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    settings: {
      react: {
        // Explicit, not "detect": eslint-plugin-react 7.37's detection calls
        // context.getFilename(), which ESLint 10 removed.
        version: "19.3",
      },
    },
    rules: {
      // React rules
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "react/prop-types": "off", // We use TypeScript for prop validation

      // TypeScript rules
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "warn",

      // General rules
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-debugger": "error",
      "no-duplicate-imports": "error",
      "no-unused-expressions": "error",
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "smart"],
      curly: ["error", "multi-line"],

      // Downgrade some strict rules to warnings to ease development
      "@typescript-eslint/ban-ts-comment": "warn",
      "react/no-unescaped-entities": "warn",
      "react/display-name": "warn",
      "react-hooks/rules-of-hooks": "warn",
      "no-empty": "warn",

      "no-restricted-imports": ["error", { patterns: LEGACY_CLIENT_PATTERNS }],
      "no-restricted-syntax": ["error", ...RAW_API_FETCH],
    },
  },
  {
    // Frontend state rule (.cursor/rules/18-frontend-state.mdc): components,
    // pages, contexts and hooks never call the API directly — go through a
    // Zustand store action and read the result via a selector. Type-only
    // imports from the api module are fine; the clients are banned, and so is
    // `fetch` itself (a non-API fetch is an exception, disabled inline with
    // its reason). Tests may import the client to stub it.
    files: [
      "src/components/**/*.{ts,tsx}",
      "src/pages/**/*.{ts,tsx}",
      "src/contexts/**/*.{ts,tsx}",
      "src/hooks/**/*.{ts,tsx}",
    ],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...LEGACY_CLIENT_PATTERNS,
            {
              group: ["**/api", "**/api/index"],
              importNames: [
                "api",
                "unspecced",
                "unwrap",
                "unwrapBody",
                "bodyWithStatus",
                "createApiClient",
              ],
              message: DIRECT_API_MESSAGE,
            },
            {
              group: ["**/api/client", "**/api/unspecced"],
              message: DIRECT_API_MESSAGE,
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: DIRECT_API_MESSAGE },
      ],
    },
  },
]);
