import { defineConfig, devices } from "@playwright/test";

/**
 * Tests run against the static export, not the dev server: that is what
 * actually ships, and the MapLibre worker path only behaves correctly in a
 * real static build (see scripts/copy-maplibre-worker.mjs).
 *
 * Run `npm run build` first, or let webServer do it.
 */
/**
 * Which specs need a rendered map, and which are pure functions.
 *
 * The split exists because they cost three orders of magnitude apart. A map
 * spec software-renders terrain, imagery and a cloud volume through
 * SwiftShader on the CPU, at a few frames a second; the logic specs never open
 * a page at all and the whole set of them finishes in seconds. Running the
 * lot on every save meant a quarter of an hour and a pinned CPU to check a
 * function that takes bytes and returns a colour.
 *
 * Listed rather than inferred from a directory, and guarded: tests/suite.spec.ts
 * fails if a spec file appears in neither list, so a new one cannot silently
 * end up in no project and never run.
 */
export const LOGIC_SPECS = [
  "cloudGrid.spec.ts",
  "conditions.spec.ts",
  "dem.spec.ts",
  "observedCloud.spec.ts",
  "spotHours.spec.ts",
  "suite.spec.ts",
  "sun.spec.ts",
  "timeline.spec.ts",
];

export const MAP_SPECS = [
  "callout.spec.ts",
  "hours.spec.ts",
  "layers.spec.ts",
  "lighting.spec.ts",
  "map.spec.ts",
  "renders.spec.ts",
  "scrubber.spec.ts",
  "visual.spec.ts",
];

/** Anchored at the end, so `map.spec.ts` cannot also match `heatmap.spec.ts`. */
const match = (names: string[]) =>
  names.map((name) => new RegExp(`[\\/]${name.replaceAll(".", "[.]")}$`));

export default defineConfig({
  testDir: "./tests",
  // Markup and layout snapshots do not vary by OS, so the default per-platform
  // directories would only fork the same files between a dev machine and CI.
  snapshotPathTemplate: "{testDir}/__snapshots__/{testFileName}/{arg}{ext}",
  fullyParallel: false,
  // One worker, deliberately. Two SwiftShader maps rendering side by side on
  // one CPU is enough to push tile loading past the timeout, which shows up as
  // a flake rather than as the slow machine it actually is.
  workers: 1,
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
        // CI runners give a container a 64MB /dev/shm by default, and a
        // software-rendered map is well past that. Chromium does not report
        // this as an error - the renderer simply dies, and the test that was
        // driving it fails with "session closed" after burning its whole
        // timeout.
        "--disable-dev-shm-usage",
      ],
    },
  },
  projects: [
    // No page, no browser: Playwright only launches Chromium for a test that
    // asks for the `page` fixture, and none of these do.
    {
      name: "logic",
      testMatch: match(LOGIC_SPECS),
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "desktop",
      testMatch: match(MAP_SPECS),
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      testMatch: match(MAP_SPECS),
      use: {
        ...devices["Pixel 7"],
        // Pixel 7 ships a device scale factor of 3, which asks SwiftShader for
        // nine times the pixels of the same page at 1 - roughly 1236x2745 of
        // software-rendered terrain, cloud volume and satellite raster. On a CI
        // runner that was enough to take the renderer down mid-suite. Nothing
        // here asserts pixels, only markup, geometry and the map's own state,
        // so the density buys the suite nothing and costs it the browser.
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: {
    // --yes, because a bare `npx serve` on a machine that has never
    // installed it stops at an interactive prompt and the whole suite
    // sits there until the webServer timeout.
    command: "npx --yes serve out -l 3100",
    port: 3100,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
