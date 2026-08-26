import { expect, test, type Page } from "@playwright/test";
import { fixtureConditions } from "./fixture";

/**
 * The scene is lit by the real sun.
 *
 * Not a screenshot test - WebGL output is not stable enough for that off a
 * GPU. What is asserted is the thing that would actually break: that the map's
 * lights are aimed from the solar position for the hour being displayed,
 * rather than from a constant someone typed in once.
 */

test.beforeEach(async ({ page }) => {
  await page.route("**/conditions.json", (route) =>
    route.fulfill({ json: fixtureConditions() })
  );
});

async function paint(page: Page, layer: string, property: string) {
  return page.evaluate(
    ({ layer: id, property: name }) =>
      (
        window as unknown as {
          __satappMap: {
            getPaintProperty: (layer: string, property: string) => unknown;
          };
        }
      ).__satappMap.getPaintProperty(id, name),
    { layer, property }
  );
}

test("both hillshades are aimed from the sunrise sun", async ({ page }) => {
  await page.goto("/en/");
  await page.waitForSelector(".map canvas", { timeout: 30_000 });
  await page.waitForTimeout(6_000);

  // The document is lit for its own sunrise, so the key light comes from the
  // east: somewhere between north-east and south-east depending on the season.
  const key = (await paint(page, "hillshade", "hillshade-illumination-direction")) as number;
  expect(key).toBeGreaterThan(45);
  expect(key).toBeLessThan(135);

  // The fill is skylight from the other side. If these two ever coincide the
  // scene has one light again and every away-facing slope is a silhouette.
  const fill = (await paint(
    page,
    "hillshade-fill",
    "hillshade-illumination-direction"
  )) as number;
  const between = (((fill - key) % 360) + 360) % 360;
  expect(Math.abs(between - 180)).toBeLessThan(1);
});

test("the key light sits low at sunrise", async ({ page }) => {
  await page.goto("/en/");
  await page.waitForSelector(".map canvas", { timeout: 30_000 });
  await page.waitForTimeout(6_000);

  const altitude = (await paint(
    page,
    "hillshade",
    "hillshade-illumination-altitude"
  )) as number;
  // Floored at 6 degrees: a hillshade lit from exactly the horizon has no
  // gradient to work with and renders the terrain flat black.
  expect(altitude).toBeGreaterThanOrEqual(6);
  expect(altitude).toBeLessThan(25);
});
