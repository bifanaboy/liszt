import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { Script } from "node:vm";

const root = new URL("../", import.meta.url);

test("Hatchable runtime folders contain no local TypeScript declarations", () => {
  for (const directory of ["api", "lib", "public"]) {
    const files = readdirSync(new URL(`${directory}/`, root), { recursive: true });
    assert.deepEqual(
      files.filter((file) => file.endsWith(".ts")),
      [],
      `${directory} must contain only Hatchable-compatible runtime files`,
    );
  }
});

test("dashboard startup parses without top-level await after imports are linked", () => {
  const source = readFileSync(new URL("public/app.js", root), "utf8").replace(
    /^import[\s\S]*?from "\.\/[^"]+";\n/gm,
    "",
  );
  assert.doesNotThrow(() => new Script(source, { filename: "public/app.js" }));
});
