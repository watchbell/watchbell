import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
    // The docs tests parse and render every real page (twice for the exported layout); a busy machine needs more than
    // the default 5 s.
    testTimeout: 60_000,
  },
});
