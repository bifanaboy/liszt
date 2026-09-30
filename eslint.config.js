import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // public/ is a verbatim port of the codex dashboard (plain browser JS) and
    // deploy/ holds shell/systemd/YAML artefacts; neither is TypeScript.
    ignores: ["node_modules/**", "data/**", "public/**", "deploy/**"],
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
);
