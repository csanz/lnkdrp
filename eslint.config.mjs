import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsdoc from "eslint-plugin-jsdoc";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Repo-specific ignores:
    // - `public/` contains vendored/minified assets (pdf.js, animation bundles) that are not lintable.
    // - `db/migration/` and `scripts/` contain one-off maintenance code where strict TS/ESLint rules (e.g. no-explicit-any)
    //   are often intentionally relaxed.
    "public/**",
    "db/migration/**",
    "scripts/**",
    "tmp/**",
  ]),
  {
    plugins: {
      jsdoc,
    },
    rules: {
      // This repo intentionally uses `any` in a few integration-heavy places (NextAuth session augmentation,
      // Next.js route handler glue, and UI plumbing). Keep it visible, but don't fail CI on it.
      "@typescript-eslint/no-explicit-any": "warn",
      // Too strict for common UI patterns like "close drawer on navigation".
      "react-hooks/set-state-in-effect": "off",
      // Exported API should be self-documenting.
      // - This is intentionally a warning-only guardrail to avoid blocking development.
      "jsdoc/require-jsdoc": [
        "warn",
        {
          contexts: [
            // Named exports.
            "ExportNamedDeclaration > FunctionDeclaration",
            "ExportNamedDeclaration > ClassDeclaration",
            // e.g. `export const Foo = () => {}`
            "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression",
            // e.g. `export const foo = function () {}`
            "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > FunctionExpression",
            // Default exports.
            "ExportDefaultDeclaration > FunctionDeclaration",
            "ExportDefaultDeclaration > ClassDeclaration",
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
