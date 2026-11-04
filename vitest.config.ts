import { defineConfig } from "vitest/config";

// Test files share one database, so run them one after another.
export default defineConfig({
  test: { fileParallelism: false },
});
