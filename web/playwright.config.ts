import { defineConfig, devices } from "@playwright/test";

/**
 * Tests run against the static export, not the dev server: that is what
 * actually ships, and the MapLibre worker path only behaves correctly in a
 * real static build (see scripts/copy-maplibre-worker.mjs).
 *
 * Run `npm run build` first, or let webServer do it.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  // SwiftShader draws terrain, imagery and the deck at a few frames per
  // second, and each test waits for tiles as well. The default 30s is not a
  // meaningful budget here.
  timeout: 120_000,
  reporter: [["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: "http://localhost:3100",
    // Headless Chromium has no GPU, so WebGL falls back to SwiftShader. It is
    // slow and the output is not byte-identical to a real GPU - which is why
    // nothing here asserts pixel equality, only that the canvas drew something
    // and that no errors were logged.
    launchOptions: {
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npx serve out -l 3100",
    port: 3100,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
