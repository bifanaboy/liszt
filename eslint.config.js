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
    files: ["test/**/*.js"],
    languageOptions: {
      globals: {
        AbortSignal: "readonly",
        AbortController: "readonly",
        Buffer: "readonly",
        Headers: "readonly",
        Response: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        process: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
      },
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
    // Both files are ES modules - `<script type="module" src="/app.js">` in
    // index.html, and source-health.js is imported from app.js - so the parse
    // sourceType is pinned here rather than inherited from whatever a default
    // happens to be, which would silently turn into a classic script parse if
    // that ever changed. ecmaVersion is deliberately NOT pinned: freezing it
    // would make this gate reject syntax these files are later allowed to use,
    // which is the opposite of what it is for.
    files: ["public/**/*.js"],
    languageOptions: { sourceType: "module" },
    rules: { "no-undef": "off" },
  },
  {
    // Local operator diagnostics: scripts run by hand to check the live sources,
    // never imported by the app. Printing their result IS their output - unlike
    // the CLIs in src/cli, which write to stdout deliberately rather than
    // logging - so `no-console` is off here for the same reason it is off for
    // public/: these files report to a human, not to a log pipeline.
    files: ["src/cli/**/*.ts"],
    rules: { "no-console": "off" },
  },
);
