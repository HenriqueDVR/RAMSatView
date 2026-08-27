import { expect, test, type Page } from "@playwright/test";
import {
  fixtureConditions,
  fixtureGridBytes,
  fixtureGridHeader,
  fixtureSpotHoursBytes,
  fixtureSpotHoursHeader,
} from "./fixture";

/**
 * The readouts following the scrubber, end to end.
 *
 * This is the contradiction the hourly series exists to close. Before it, the
 * volume, the heatmap, the observed field and the sun all moved with the hour
 * while the panel beside them kept showing the day summary - so at 04:00 the
 * map drew a deck under the summit and the sentence next to it said something
 * else. The whole pitch of this product is that the picture and the number
 * agree, and they did not.
 */

test.use({ timezoneId: "Atlantic/Madeira", locale: "en-GB" });

async function serve(page: Page, { withHours = true } = {}) {
  const grid = fixtureGridHeader();
  const hours = fixtureSpotHoursHeader(grid);
  await page.route("**/conditions.json", (route) =>
    route.fulfill({
      json: {
        ...fixtureConditions(),
        cloud_grid: grid,
        spot_hours: withHours ? hours : null,
      },
    }),
  );
  await page.route("**/cloud-grid.bin", (route) =>
    route.fulfill({
      contentType: "application/octet-stream",
      body: Buffer.from(fixtureGridBytes(grid)),
    }),
  );
  await page.route("**/spot-hours.bin", (route) =>
    route.fulfill({
      contentType: "application/octet-stream",
      body: Buffer.from(fixtureSpotHoursBytes(hours)),
    }),
  );
  return { grid, hours };
}

async function openArieiro(page: Page) {
  await page.goto("/en");
  await page.waitForSelector(".scrubber input[type=range]", {
    timeout: 30_000,
  });
  await page.locator('.map-pin[aria-label^="Pico do Arieiro"]').click();
  await page.waitForSelector("#spot-pico-arieiro");
}

/** Drive the slider the way a thumb does, and read what the panel now says. */
async function atHour(page: Page, index: number) {
  await page.locator(".scrubber input[type=range]").fill(String(index));
  // The readout is React state off an input event; give it a frame to land.
  await expect(page.locator(".scrubber-hour")).toBeVisible();
  return {
    verdict: await page.locator("#spot-pico-arieiro .verdict").textContent(),
    facts: await page.locator("#spot-pico-arieiro .facts").innerText(),
    row: await page.locator("#row-pico-arieiro .spot-sub").textContent(),
  };
}

test("the numbers beside the map move with the hour the map is drawing", async ({
  page,
}) => {
  await serve(page);
  await openArieiro(page);

  const last = Number(
    await page.locator(".scrubber input[type=range]").getAttribute("max"),
  );

  const early = await atHour(page, 0);
  const late = await atHour(page, last);

  // The fixture walks the deck down through the summits, so the verdict has to
  // change end to end. A stuck panel gives the same sentence twice.
  expect(early.verdict).not.toBe(late.verdict);
  expect(early.verdict).toContain("Summit inside the cloud");
  expect(late.verdict).toContain("Above the cloud sea");

  // And the scalars move with it rather than staying on the day summary.
  expect(early.facts).not.toBe(late.facts);
});

test("the list row agrees with the panel, hour by hour", async ({ page }) => {
  await serve(page);
  await openArieiro(page);
  const last = Number(
    await page.locator(".scrubber input[type=range]").getAttribute("max"),
  );

  for (const index of [0, last]) {
    const { verdict, row } = await atHour(page, index);
    // Two places on screen showing the same spot at the same hour. They read
    // from one function for exactly this reason.
    expect(row?.trim()).toBe(verdict?.trim());
  }
});

test("the callout on the pin says what the panel says", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "no callout on a phone");
  await serve(page);
  await openArieiro(page);
  const last = Number(
    await page.locator(".scrubber input[type=range]").getAttribute("max"),
  );

  for (const index of [0, last]) {
    const { verdict } = await atHour(page, index);
    await expect(page.locator(".callout-sub")).toHaveText(verdict!.trim());
  }
});

test("without the series the panel falls back to the day, not to nothing", async ({
  page,
}) => {
  // The blob is allowed to be missing - it is fetched separately and fails on
  // its own. What must not happen is a blank readout or a thrown render.
  await serve(page, { withHours: false });
  await openArieiro(page);

  await expect(page.locator("#spot-pico-arieiro .verdict")).toBeVisible();
  await expect(page.locator("#spot-pico-arieiro .facts")).toContainText("°C");

  const before = await atHour(page, 0);
  const after = await atHour(
    page,
    Number(
      await page.locator(".scrubber input[type=range]").getAttribute("max"),
    ),
  );
  // Unchanged, because the day summary is all there is - and that is the
  // honest answer rather than a number invented per hour.
  expect(before.verdict).toBe(after.verdict);
});
