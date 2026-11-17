import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
          }),
        ],
        test: {
          name: "workers",
          globals: true,
          // connector/*.test.mjs runs on node:test (plain Node), not in workerd.
          // hermes.test.ts needs a real node:http server, which workerd cannot reach.
          exclude: [
            ...configDefaults.exclude,
            "connector/**",
            "tests/hermes.test.ts",
          ],
        },
      },
      {
        test: {
          name: "node",
          globals: true,
          environment: "node",
          include: ["tests/hermes.test.ts"],
        },
      },
    ],
  },
});
