import { expect, test, type Page } from "@playwright/test";
import { fixtureConditions } from "./fixture";
// From exposure.ts, not lighting.ts: importing lighting.ts here would pull
// maplibre-gl into node through style.ts and the whole file fails to load.
import { highlightGain, imageryPaint } from "../lib/map/exposure";

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

test("the horizon band is painted the same colour the sky hazes into", async ({
  page,
}) => {
  await page.goto("/en/");
  await page.waitForSelector(".map canvas", { timeout: 30_000 });
  await page.waitForTimeout(6_000);

  const sky = (await page.evaluate(
    () =>
      (
        window as unknown as {
          __satappMap: { getSky: () => Record<string, unknown> };
        }
      ).__satappMap.getSky()
  )) as Record<string, unknown>;

  // MapLibre runs its own sky pass over the custom one and paints a flat band
  // across the horizon. Whatever colour that band is, it meets the custom sky
  // at a straight edge - so it has to be the colour the custom sky hazes
  // towards, which is the fog colour. Set to anything else it is a stripe, and
  // that stripe is the thing that read as a line drawn across the view.
  expect(sky["horizon-color"]).toBe(sky["fog-color"]);
  // One colour at the horizon, not a second blended into it.
  expect(sky["horizon-fog-blend"]).toBe(1);
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

test("the imagery is exposed down as the real light comes up", () => {
  // Sentinel-2 is a midday composite: the noon light is already in the pixels,
  // and adding a noon light on top is what made the ground look lacquered.
  const dawn = imageryPaint(0);
  const noon = imageryPaint(1);
  expect(noon.brightnessMax).toBeLessThan(dawn.brightnessMax);
  expect(noon.saturation).toBeLessThan(dawn.saturation);
  expect(noon.contrast).toBeLessThan(dawn.contrast);
  // Never so dark that the island disappears into its own shadow.
  expect(noon.brightnessMax).toBeGreaterThan(0.6);

  // Same rule for the key light: warm and strong at dawn, restrained at noon,
  // where a white highlight reads as a reflection off rock.
  expect(highlightGain(1)).toBeLessThan(highlightGain(0));
  expect(highlightGain(1)).toBeGreaterThan(0.25);
});

test("the exposure is clamped rather than extrapolated", () => {
  // daylight() can only return 0..1, but nothing stops a caller passing
  // something else, and an unclamped ramp would make deep night *brighter*
  // than dawn and midday darker than the imagery can survive.
  expect(imageryPaint(-3)).toEqual(imageryPaint(0));
  expect(imageryPaint(4)).toEqual(imageryPaint(1));
  expect(highlightGain(-3)).toBe(highlightGain(0));
});
