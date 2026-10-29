import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["workspaces/**", "node_modules/**", "dist/**"],
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
  },
});
