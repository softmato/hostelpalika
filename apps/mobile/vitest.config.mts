import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

/**
 * Node-only tests for pure logic — route resolution, URL derivation, formatting.
 *
 * There is deliberately no React Native preset here. Rendering RN components
 * under vitest needs a heavy shim layer that tends to test the shim rather than
 * the app; component behaviour is verified on a device instead. What *is* worth
 * testing in isolation is the logic that decides things, and that logic is kept
 * free of RN imports so it can be.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(root, "./src"),
      /*
       * The platform's date rules, resolved to the same file the server
       * imports and Metro bundles — see `metro.config.js` for why the alias
       * points at the `calendar` directory rather than at `@hostel/shared`.
       * Aliasing it here too is what keeps these tests testing the shipped
       * conversion instead of a stand-in for it.
       */
      "@hostel/calendar": resolve(root, "../../packages/shared/src/calendar"),
      /*
       * The meal-window rule the cook portal's buttons and the server's
       * announce guard both read. `cook.test.ts` locks the lock/unlock times
       * against the shipped parser rather than a stand-in for it.
       */
      "@hostel/food": resolve(root, "../../packages/shared/src/food"),
      /*
       * The night boundary the prompt cron, the warden board and this app all
       * key an answer under. One file, or "tonight" means three things.
       */
      "@hostel/night": resolve(root, "../../packages/shared/src/night"),
      "@hostel/brand": resolve(root, "../../packages/shared/src/brand"),
      "@hostel/expenses": resolve(root, "../../packages/shared/src/expenses"),
      "@hostel/constants": resolve(root, "../../packages/shared/src/constants"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
