import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // node_modules and data are not ours; deploy/ was deleted in PR #3 and is
    // gone from the tree, so it needed no entry to stay out.
    ignores: ["node_modules/**", "data/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "error",
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
    },
  },
  {
    // Browser globals are not defined in Node, so `no-undef` fires 13 times on
    // correct code in these two files. Turning it off buys a parse: ESLint
    // reports a syntax error here regardless of which rules are enabled, and
    // that is the failure this gate exists to catch - `app.js` is the sole
    // <script> tag in index.html and `source-health.js` is imported from it, so
    // a parse error in either serves a dead dashboard. Spelling the globals out
    // by hand instead would reimplement the `globals` package in a form that
    // goes stale.
    //
    // What it costs is wider than the browser globals: `no-undef` cannot tell
    // them apart, so this also silences undeclared *local* identifiers - a
    // renamed or typo'd helper, a binding deleted at the call site. `globals`
    // is one devDependency and one config line, which is the alternative if
    // that blind spot ever earns the dependency. Both files currently resolve.
    files: ["public/**/*.js"],
    rules: { "no-undef": "off" },
  },
);
