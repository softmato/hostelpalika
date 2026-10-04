import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
      "@hostel/db": path.resolve(dirname, "../../packages/db/src"),
      "@hostel/shared": path.resolve(dirname, "../../packages/shared/src"),
      "@hostel/constants": path.resolve(dirname, "../../packages/shared/src/constants"),
      // See the stub for why. The real package is a build-time tripwire that
      // throws on import, and Vitest is not a build.
      "server-only": path.resolve(dirname, "test/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
