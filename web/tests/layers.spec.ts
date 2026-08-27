import { expect, test, type Page } from "@playwright/test";
import { fixtureConditions } from "./fixture";

/**
 * The layer switches, end to end.
 *
 * These assert on the map's own state rather than on pixels: whether the
 * imagery is hidden and whether terrain is attached are the things the panel
 * actually promises, and they are readable without a screenshot.
 */

// The frozen document, so these do not depend on today's weather having a
// deck in it.
test.beforeEach(async ({ page }) => {
  await page.route("**/conditions.json", (route) =>
    route.fulfill({ json: fixtureConditions() }),
  );
});

async function waitForMap(page: Page) {
  await page.waitForSelector(".map canvas", { timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  // Terrain and imagery keep streaming after networkidle on a slow renderer.
  await page.waitForTimeout(6_000);
}

async function openPanel(page: Page) {
  await page.getByRole("button", { name: /layers/i }).click();
}

/**
 * How long a toggle is given to reach the map.
 *
 * Playwright's default for `expect.poll` is five seconds, which is a fine
 * budget for a machine with a GPU and is not one here: the switch flips React
 * state immediately, but the map only applies it once the style is loaded, and
 * under SwiftShader with the whole suite queued behind it that can take
 * considerably longer than five seconds. Failing at five was a false negative
 * - the test passed on its own every time and only fell over inside the full
 * run.
 */
const APPLIED_TIMEOUT = { timeout: 30_000 };

test("the panel starts closed and opens on demand", async ({ page }) => {
  await page.goto("/en/");
  const list = page.locator(".layer-list");
  await expect(list).toBeHidden();
  await openPanel(page);
  await expect(list).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Satellite" })).toBeChecked();
});

test("turning the satellite off hides the imagery", async ({ page }) => {
  await page.goto("/en/");
  await waitForMap(page);
  await openPanel(page);
  await page.getByRole("checkbox", { name: "Satellite" }).uncheck();

  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          (
            window as unknown as {
              __satappMap: {
                getLayoutProperty: (id: string, key: string) => unknown;
              };
            }
          ).__satappMap.getLayoutProperty("satellite", "visibility"),
        ),
      APPLIED_TIMEOUT,
    )
    .toBe("none");

  // The terrain's attribution stays: the DEM is still in use with the imagery
  // off. EOX's is not asserted either way - MapLibre recomputes the control on
  // its own schedule after a visibility change, so whether the line has gone
  // yet is a race, and attributing imagery that is not currently drawn breaks
  // no licence in the direction that matters.
  await expect(page.locator(".maplibregl-ctrl-attrib-inner")).toContainText(
    "AWS Terrain Tiles",
  );
});

test("turning 3D terrain off detaches the terrain", async ({ page }) => {
  await page.goto("/en/");
  await waitForMap(page);
  await openPanel(page);
  await page.getByRole("checkbox", { name: "3D terrain" }).uncheck();

  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __satappMap: { getTerrain: () => unknown };
              }
            ).__satappMap.getTerrain() === null,
        ),
      APPLIED_TIMEOUT,
    )
    .toBe(true);
});

test("the toggles leave no console errors behind", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/en/");
  await waitForMap(page);
  await openPanel(page);
  // Exact: "Cloud" is a prefix of "Cloud-top altitude", and a substring match
  // now resolves to two checkboxes.
  for (const name of ["Cloud", "Satellite", "3D terrain"]) {
    await page.getByRole("checkbox", { name, exact: true }).uncheck();
  }
  for (const name of ["Cloud", "Satellite", "3D terrain"]) {
    await page.getByRole("checkbox", { name, exact: true }).check();
  }
  await page.waitForTimeout(2_000);
  expect(errors).toEqual([]);
});
