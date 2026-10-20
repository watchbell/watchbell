import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// R1 (5c): the same "@ext/registry" choice as next.config.ts and tsconfig.json.
const ext = existsSync(new URL("./src/private/registry.ts", import.meta.url)) ? "./src/private/registry.ts" : "./src/lib/extensions-none.ts";

export default defineConfig({
  resolve: {
    alias: {
      "@ext/registry": fileURLToPath(new URL(ext, import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
