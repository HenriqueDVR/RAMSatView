import js from "@eslint/js";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Flat config. The point of it is `recommended-latest`, which in
 * eslint-plugin-react-hooks 7 carries the compiler-powered rules as well as
 * the two classic ones: Map.tsx holds refs and effects around an imperative
 * WebGL library, which is exactly where hook bugs hide and exactly what those
 * rules see.
 *
 * No type-aware linting: it needs a full program per run and none of the rules
 * enabled here ask for types.
 */
export default [
  {
    ignores: [
      ".next/**",
      "out/**",
      "node_modules/**",
      "test-results/**",
      "public/**",
      "next-env.d.ts",
    ],
  },
  js.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  {
    files: ["**/*.{ts,tsx,mjs}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // TypeScript already reports these, and its version understands types,
      // overloads and declaration merging. Leaving the ESLint copies on just
      // duplicates the error or contradicts it.
      "no-unused-vars": "off",
      "no-undef": "off",
      "no-redeclare": "off",
    },
  },
];
