import { defineConfig } from "vitest/config";

// The pure logic runs in plain Node — no DOM needed. `setupFiles` installs the Foundry globals
// (game/CONFIG/Hooks/foundry/fromUuid) before any test's imports resolve.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.mjs"],
    setupFiles: ["test/helpers/foundry-shims.mjs"]
  }
});
