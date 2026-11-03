import js from "@eslint/js";
import prettierRecommended from "eslint-plugin-prettier/recommended";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

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
    },
  },
  {
    // Frontend state rule (.cursor/rules/18-frontend-state.mdc): components
    // and pages never call the API directly — go through a Zustand store
    // action and read the result via a selector. Type-only imports from the
    // api module are fine; only the `api` client is banned. Hooks are the
    // data-access seam and are exempt for now (but should also route through
    // stores — do not add new direct calls there).
    files: ["src/components/**/*.{ts,tsx}", "src/pages/**/*.{ts,tsx}"],
    ignores: ["**/hooks/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/api", "**/api/index"],
              importNames: ["api", "unwrapBody", "createApiClient"],
              message:
                "Components/pages must not call the API directly. Add a Zustand store action and read via a selector. See .cursor/rules/18-frontend-state.mdc.",
            },
          ],
        },
      ],
    },
  },
]);
