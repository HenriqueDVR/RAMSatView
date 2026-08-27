import { expect, test, type Page } from "@playwright/test";
import {
  fixtureConditions,
  fixtureGridBytes,
  fixtureGridHeader,
} from "./fixture";
import { nearestIndex } from "../lib/timeline";

/**
 * The time control, end to end.
 *
 * What matters here is not the pixels - the deck's appearance is covered by
 * the visual suite - but that the volume is fetched, accepted, and that moving
 * the slider moves the hour the map is drawing without throwing. A silently
 * stuck scrubber looks exactly like a calm forecast.
 */

async function serve(page: Page, { truncated = false } = {}) {
  const header = fixtureGridHeader();
  await page.route("**/conditions.json", (route) =>
    route.fulfill({ json: { ...fixtureConditions(), cloud_grid: header } })
  );
  const bytes = fixtureGridBytes(header);
  await page.route("**/cloud-grid.bin", (route) =>
    route.fulfill({
      contentType: "application/octet-stream",
      body: Buffer.from(truncated ? bytes.subarray(0, bytes.length - 1) : bytes),
    })
  );
  return header;
}

async function waitForMap(page: Page) {
  await page.waitForSelector(".map canvas", { timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(4_000);
}

test("the scrubber appears once the volume has loaded", async ({ page }) => {
  const header = await serve(page);
  await page.goto("/en/");

  const slider = page.getByRole("slider", { name: "Hour shown" });
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute("max", String(header.times.length - 1));
  // Every day in the volume is labelled on the track.
  await expect(page.locator(".scrubber-mark-label").first()).toBeVisible();
});

test("moving the slider moves the hour the map is drawing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await serve(page);
  await page.goto("/en/");
  await waitForMap(page);

  const slider = page.getByRole("slider", { name: "Hour shown" });
  const before = await page.locator(".scrubber-hour").innerText();
  await slider.focus();
  await slider.press("ArrowRight");
  await slider.press("ArrowRight");

  await expect(page.locator(".scrubber-hour")).not.toHaveText(before);
  expect(errors).toEqual([]);
});

test("the now button returns to the current hour and then disables itself", async ({
  page,
}) => {
  const header = await serve(page);
  await page.goto("/en/");

  const now = page.getByRole("button", { name: "Now" });
  const slider = page.getByRole("slider", { name: "Hour shown" });
  await slider.focus();
  await slider.press("ArrowLeft");
  await expect(now).toBeEnabled();

  await now.click();
  // Computed, not hardcoded: the fixture's hours are pinned to the top of the
  // hour, so which of them is nearest to "now" depends on which half of the
  // hour the suite happens to run in.
  const expected = nearestIndex(
    header.times.map((time) => new Date(time))
  );
  await expect(slider).toHaveValue(String(expected));
  await expect(now).toBeDisabled();
});

test("a truncated volume is refused and the page carries on without it", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await serve(page, { truncated: true });
  await page.goto("/en/");
  await waitForMap(page);

  // No control, because there is no trustworthy volume behind it - but the
  // map, the sidebar and the scores are all still there.
  await expect(page.locator(".scrubber")).toHaveCount(0);
  await expect(page.locator(".map canvas")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Pico do Arieiro/ }).first()
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("the heatmap and the volumetric cloud are alternatives", async ({
  page,
}) => {
  // Served with a volume: with no grid published there is no cloud top to
  // colour, and the switch deliberately does nothing.
  await serve(page);
  await page.goto("/en/");
  await waitForMap(page);
  await page.getByRole("button", { name: /layers/i }).click();

  const cloud = page.getByRole("checkbox", { name: "Cloud", exact: true });
  const heatmap = page.getByRole("checkbox", { name: "Cloud-top altitude" });
  await expect(cloud).toBeChecked();
  await expect(heatmap).not.toBeChecked();

  // They are the same field drawn two ways, so switching one on has to switch
  // the other off - on screen together they only obscure each other.
  await heatmap.check();
  await expect(cloud).not.toBeChecked();
  await expect(
    page.locator(".legend"),
    "the legend appears with the layer it explains"
  ).toBeVisible();
  await expect(
    page.evaluate(
      () =>
        (
          window as unknown as {
            __satappMap: { getLayer(id: string): unknown };
          }
        ).__satappMap.getLayer("cloud-top") !== undefined
    )
  ).resolves.toBe(true);

  await cloud.check();
  await expect(heatmap).not.toBeChecked();
  await expect(page.locator(".legend")).toHaveCount(0);
});
