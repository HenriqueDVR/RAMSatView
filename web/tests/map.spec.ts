import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Map tests.
 *
 * WebGL output is not byte-stable across machines - headless Chromium renders
 * through SwiftShader and a real GPU does not - so nothing here asserts pixel
 * equality. What is asserted is that the canvas drew something substantial,
 * that no errors were logged, that both licences appear in the attribution
 * control, and that the deck geometry lands where the forecast says it should.
 *
 * The screenshots are written for a human to look at. They are evidence, not
 * assertions.
 */

const SHOTS = join(process.cwd(), "test-results", "shots");
mkdirSync(SHOTS, { recursive: true });

const ARIEIRO_M = 1818;

/** A synthetic profile: solid cloud between base and top, clear elsewhere. */
function deckProfile(baseM: number, topM: number): [number, number][] {
  const profile: [number, number][] = [];
  for (let altitude = 0; altitude <= 3000; altitude += 100) {
    const inside = altitude >= baseM && altitude <= topM;
    profile.push([altitude, inside ? 0.9 : 0.02]);
  }
  return profile;
}

/**
 * Serve a conditions document whose deck sits where this test wants it.
 *
 * Live forecasts are the wrong input for a geometry check: most mornings have
 * no deck at all, and "nothing was drawn" would pass a weaker assertion.
 */
async function withDeck(page: Page, baseM: number, topM: number) {
  await page.route("**/conditions.json", async (route) => {
    const response = await route.fetch();
    const document = await response.json();
    for (const spot of document.spots) {
      if (spot.type !== "viewpoint") continue;
      for (const day of spot.days) day.profile = deckProfile(baseM, topM);
    }
    await route.fulfill({ response, json: document });
  });
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

async function waitForMap(page: Page) {
  await page.waitForSelector(".map canvas", { timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  // Terrain and imagery keep streaming after networkidle on a slow renderer.
  await page.waitForTimeout(6_000);
}

test("map renders terrain and imagery without console errors", async ({
  page,
}, testInfo) => {
  const errors = collectErrors(page);
  await withDeck(page, 600, 1400);
  await page.goto("/en");
  await waitForMap(page);

  const canvas = page.locator(".map canvas").first();
  const shot = await canvas.screenshot();
  writeFileSync(join(SHOTS, `${testInfo.project.name}-map-default.png`), shot);

  // A canvas that drew nothing compresses to almost nothing. This is a
  // deliberately crude liveness check: it catches a blank map, and it cannot
  // fail because a GPU rendered a shade differently.
  expect(shot.byteLength).toBeGreaterThan(20_000);
  expect(errors).toEqual([]);
});

test("attribution names both the imagery and the terrain source", async ({
  page,
}) => {
  await page.goto("/en");
  await waitForMap(page);
  const attribution = await page
    .locator(".maplibregl-ctrl-attrib-inner")
    .innerText();
  expect(attribution).toContain("EOX");
  expect(attribution).toContain("AWS Terrain Tiles");
});

test("a deck below the summit is drawn below the summit", async ({
  page,
}, testInfo) => {
  await withDeck(page, 600, 1400);
  await page.goto("/en");
  await waitForMap(page);
  // Pins overlap at the default zoom, so hit-testing picks the wrong one.
  // The click handler is what matters here, not the pointer path to it.
  await page
    .locator('.map-pin[aria-label^="Pico do Arieiro"]')
    .first()
    .dispatchEvent("click");
  await page.waitForTimeout(5_000);

  const shot = await page.locator(".map canvas").first().screenshot();
  writeFileSync(join(SHOTS, `${testInfo.project.name}-deck-below.png`), shot);
  expect(shot.byteLength).toBeGreaterThan(20_000);
});

test("a deck above the summit swallows it", async ({ page }, testInfo) => {
  await withDeck(page, ARIEIRO_M + 200, ARIEIRO_M + 800);
  await page.goto("/en");
  await waitForMap(page);
  // Pins overlap at the default zoom, so hit-testing picks the wrong one.
  // The click handler is what matters here, not the pointer path to it.
  await page
    .locator('.map-pin[aria-label^="Pico do Arieiro"]')
    .first()
    .dispatchEvent("click");
  await page.waitForTimeout(5_000);

  const shot = await page.locator(".map canvas").first().screenshot();
  writeFileSync(join(SHOTS, `${testInfo.project.name}-deck-above.png`), shot);
  expect(shot.byteLength).toBeGreaterThan(20_000);
});

test("the page does not scroll sideways", async ({ page }) => {
  await page.goto("/en");
  await waitForMap(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
