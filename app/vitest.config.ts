import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solid()],
  resolve: {
    conditions: ["development", "browser"],
  },
  test: {
    environment: "happy-dom",
    environmentOptions: {
      happyDOM: {
        width: 390,
        height: 844,
        url: "http://localhost/",
      },
    },
    globals: true,
    include: ["app/**/*.test.{ts,tsx}"],
  },
});
