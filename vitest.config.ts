import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    globals: true,
    // connector/*.test.mjs runs on node:test (plain Node), not in workerd.
    exclude: [...configDefaults.exclude, "connector/**"],
  },
});
