import { expect, test, type Page } from "@playwright/test";
import { fixtureConditions } from "./fixture";

/**
 * Regression snapshots.
 *
 * These are DOM snapshots, not pixels. WebGL output is not byte-stable across
 * machines - headless Chromium renders through SwiftShader and a real GPU does
 * not - so the map is checked the only way that means anything off a GPU: the
 * canvas drew something, and nothing was logged as an error. Everything else
 * is markup, which is stable, diffable and says why it changed.
 *
 * All of it runs against the frozen document in ./fixture.ts. Snapshotting the
 * live forecast would rewrite these files on every ingest.
 */

// Sunrise is formatted in the browser's zone, so the zone has to be pinned or
// the snapshot depends on where the machine is.
test.use({ timezoneId: "Atlantic/Madeira", locale: "en-GB" });

async function withFixture(page: Page) {
  await page.route("**/conditions.json", (route) =>
    route.fulfill({ json: fixtureConditions() }),
  );
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

/** outerHTML, one tag per line, so a diff points at the element that moved. */
async function markup(page: Page, selector: string): Promise<string> {
  const html = await page
    .locator(selector)
    .first()
    .evaluate((node) => node.outerHTML);
  return html.replace(/></g, ">\n<").trim() + "\n";
}

test.describe("structure", () => {
  // Markup does not vary by device; running these in the mobile project too
  // would only fork a second copy of every snapshot file.
  test.beforeEach(() => {
    test.skip(test.info().project.name !== "desktop", "desktop project only");
  });

  test("viewpoint detail", async ({ page }) => {
    await withFixture(page);
    await page.goto("/en");
    // The sidebar shows one spot at a time now, so the snapshot has to say
    // which - the list order is the score order and that moves with the data.
    await page.locator("#row-pico-arieiro").click();
    await page.waitForSelector("#spot-pico-arieiro");
    expect(await markup(page, "#spot-pico-arieiro")).toMatchSnapshot(
      "viewpoint-detail.html",
    );
  });

  test("beach detail", async ({ page }) => {
    await withFixture(page);
    await page.goto("/en");
    // Beaches are a separate tab; the viewpoint list is what loads first.
    await page.getByRole("tab", { name: "Beaches" }).click();
    await page.locator("#row-porto-santo-beach").click();
    await page.waitForSelector("#spot-porto-santo-beach");
    expect(await markup(page, "#spot-porto-santo-beach")).toMatchSnapshot(
      "beach-detail.html",
    );
  });

  test("official warning banner", async ({ page }) => {
    await withFixture(page);
    await page.goto("/en");
    await page.waitForSelector(".statusbar .official");
    expect(await markup(page, ".statusbar .official")).toMatchSnapshot(
      "official-warning.html",
    );
  });
});

test("map at the default camera draws and logs nothing", async ({
  page,
}, testInfo) => {
  const errors = collectErrors(page);
  await withFixture(page);
  await page.goto("/en");
  await page.waitForSelector(".map canvas", { timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(6_000);

  const camera = await page.evaluate(() => {
    const map = (
      window as unknown as {
        __satappMap?: {
          getZoom(): number;
          getPitch(): number;
          getBearing(): number;
          getTerrain(): unknown;
        };
      }
    ).__satappMap;
    if (!map) return null;
    return {
      zoom: Number(map.getZoom().toFixed(2)),
      pitch: Number(map.getPitch().toFixed(1)),
      bearing: Number(map.getBearing().toFixed(1)),
      terrain: map.getTerrain() !== null,
    };
  });
  // The pitched opening shot is the whole reason the terrain reads as terrain
  // on first paint. A camera reset to flat overhead is a real regression and
  // is invisible in every other assertion here.
  expect(camera).toEqual({ zoom: 10.6, pitch: 70, bearing: 72, terrain: true });

  const shot = await page.locator(".map canvas").first().screenshot();
  await testInfo.attach(`${testInfo.project.name}-map-default.png`, {
    body: shot,
    contentType: "image/png",
  });
  expect(shot.byteLength).toBeGreaterThan(20_000);
  expect(errors).toEqual([]);
});

test("375px lays out in one column with nothing off-screen", async ({
  page,
}) => {
  await withFixture(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/en");
  // The sheet opens collapsed, so the list is not on screen until it is asked
  // for: peek -> detail -> full, one tap each.
  const handle = page.locator(".sheet-handle");
  await handle.click();
  await handle.click();
  await page.locator("#row-pico-arieiro").click();
  await page.waitForSelector("#spot-pico-arieiro");

  const boxes = (selectors: string[]) =>
    page.evaluate((list) => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          overflowsRight:
            Math.round(rect.right) > document.documentElement.clientWidth,
        };
      };
      return {
        viewport: document.documentElement.clientWidth,
        documentOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        boxes: Object.fromEntries(list.map((s) => [s, box(s)])),
      };
    }, selectors);

  const viewpoint = await boxes([
    ".map",
    "#spot-pico-arieiro",
    "#spot-pico-arieiro .profile",
    "#spot-pico-arieiro .dial",
    "#spot-pico-arieiro .detail-readout",
  ]);
  // Collapse before switching lists, the way a thumb would: the open sheet is
  // most of the screen and the tabs are above it.
  await handle.click();
  await page.getByRole("tab", { name: "Beaches" }).click();
  await handle.click();
  await handle.click();
  await page.locator("#row-porto-santo-beach").click();
  await page.waitForSelector("#spot-porto-santo-beach");
  const beach = await boxes(["#spot-porto-santo-beach", ".sidebar"]);

  for (const measured of [viewpoint, beach]) {
    expect(measured.documentOverflow).toBeLessThanOrEqual(0);
    for (const [selector, value] of Object.entries(measured.boxes)) {
      expect(value, `${selector} is missing`).not.toBeNull();
      expect(
        value!.overflowsRight,
        `${selector} extends past the viewport`,
      ).toBe(false);
    }
  }
  // The dial and the profile share a row inside the detail panel, by design. What
  // must hold at 375px is that the row fits: a profile wider than the readout
  // is how that row breaks, and it clips the chart rather than wrapping.
  const readout = viewpoint.boxes["#spot-pico-arieiro .detail-readout"]!;
  const profile = viewpoint.boxes["#spot-pico-arieiro .profile"]!;
  const dial = viewpoint.boxes["#spot-pico-arieiro .dial"]!;
  expect(profile.width).toBeGreaterThan(0);
  expect(profile.width + dial.width).toBeLessThanOrEqual(readout.width);
  // One column: the beach detail starts where the viewpoint detail does.
  expect(beach.boxes["#spot-porto-santo-beach"]!.left).toBe(
    viewpoint.boxes["#spot-pico-arieiro"]!.left,
  );

  const layout = { viewpoint, beach };
  expect(JSON.stringify(layout, null, 2)).toMatchSnapshot("mobile-375.json");
});

test("the phone keeps the map and brings the numbers up over it", async ({
  page,
}) => {
  test.skip(test.info().project.name !== "mobile", "phone layout only");
  await withFixture(page);
  await page.goto("/en");

  const sheet = page.locator(".sidebar");
  // Thirty seconds, not Playwright's five: the sheet's state is React's, and
  // it is set the instant the tap lands, but on a CI runner rendering the map
  // through SwiftShader the tap itself can be a long way behind the call that
  // sent it. Five seconds failed there while passing every time locally, which
  // is a budget problem wearing a bug's clothes.
  const atState = (value: string) =>
    expect(sheet).toHaveAttribute("data-sheet", value, { timeout: 30_000 });

  // The map is the page: it fills the viewport rather than sitting in a band
  // at the top of a document that scrolls. This is the regression that matters
  // - everything else here is the sheet built on top of it.
  const map = await page.locator(".map").boundingBox();
  const viewport = page.viewportSize()!;
  expect(map!.width).toBe(viewport.width);
  expect(Math.round(map!.height)).toBe(viewport.height);

  await atState("peek");
  await expect(page.locator(".spot-list")).toBeHidden();

  // Tapping a pin asks about that spot, and the sheet answers with it rather
  // than with the ranking.
  //
  // By name, and only once the pins are up: the marker layer rebuilds its
  // elements when the map finishes loading, and a click racing that rebuild
  // lands on a button that has already been replaced.
  await page.waitForSelector(".map-pin");
  await page.getByRole("button", { name: /Pico Ruivo/ }).click();
  await atState("detail");
  await expect(page.locator(".spot-detail h3")).toHaveText("Pico Ruivo");
  await expect(page.locator(".spot-list")).toBeHidden();

  // And the list is one tap further on.
  await page.locator(".sheet-handle").click();
  await atState("full");
  await expect(page.locator(".spot-list")).toBeVisible();

  // Nothing about any of this scrolls the page out from under the map.
  const overflow = await page.evaluate(() => ({
    x:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
    y:
      document.documentElement.scrollHeight -
      document.documentElement.clientHeight,
  }));
  expect(overflow).toEqual({ x: 0, y: 0 });
});
