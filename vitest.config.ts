import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

const cleanroomAlias = [
  {
    find: /^@cleanroom\/([a-z0-9-]+)$/,
    replacement: `${resolve(rootDir, "packages")}/$1/src/index.ts`,
  },
];

export default defineConfig({
  resolve: {
    alias: cleanroomAlias,
  },
  test: {
    include: ["src/**/*.test.ts", "packages/*/src/**/*.test.ts", "fixtures/*/src/**/*.test.ts"],
  },
});
