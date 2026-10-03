import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Listed before "@dispatchmail/core": the first alias that matches wins, and that one matches this path too.
      "@dispatchmail/core/env": fileURLToPath(new URL("./packages/core/src/env.ts", import.meta.url)),
      "@dispatchmail/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@dispatchmail/db": fileURLToPath(new URL("./packages/db/src/index.ts", import.meta.url)),
      "@dispatchmail/provider-fake": fileURLToPath(new URL("./packages/provider-fake/src/index.ts", import.meta.url)),
      "@dispatchmail/provider-ses": fileURLToPath(new URL("./packages/provider-ses/src/index.ts", import.meta.url)),
      "@dispatchmail/sdk": fileURLToPath(new URL("./packages/sdk/src/index.ts", import.meta.url)),
      "@dispatchmail/storage": fileURLToPath(new URL("./packages/storage/src/index.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    setupFiles: ["./scripts/test-setup.ts"],
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "examples/**/*.test.ts"],
    fileParallelism: false,
    slowTestThreshold: 0
  }
});
