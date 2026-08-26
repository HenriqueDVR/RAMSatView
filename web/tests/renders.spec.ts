import { expect, test } from "@playwright/test";
import { fixtureConditions } from "./fixture";

/**
 * Re-render budget.
 *
 * React Scan's URL mode is gone and its npm build does not import cleanly
 * under the Next bundler, so the storm it was meant to catch is measured here
 * instead - and more directly. What actually costs anything in this app is not
 * a React render but its side effect: the marker layer tears down eight DOM
 * nodes, eight listeners and eight MapLibre Markers whenever its effect reruns.
 *
 * Selecting a spot changes a class name. It must not rebuild the layer.
 */

test.beforeEach(() => {
  test.skip(test.info().project.name !== "desktop", "desktop project only");
});

test("selecting a spot restyles the pins instead of rebuilding them", async ({
  page,
}) => {
  await page.route("**/conditions.json", (route) =>
    route.fulfill({ json: fixtureConditions() })
  );
  await page.goto("/en");
  await page.waitForSelector(".map .map-pin");
  await page.waitForTimeout(2_000);

  await page.evaluate(() => {
    const counter = { added: 0 };
    (window as unknown as { __pinChurn: typeof counter }).__pinChurn = counter;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.matches(".map-pin") || node.querySelector(".map-pin"))
          ) {
            counter.added += 1;
          }
        }
      }
    });
    observer.observe(document.querySelector(".map")!, {
      childList: true,
      subtree: true,
    });
  });

  for (const id of ["pico-arieiro", "pico-ruivo", "pico-arieiro"]) {
    await page.locator(`#spot-${id} .card-select`).click();
    await page.waitForTimeout(500);
  }

  const churn = await page.evaluate(
    () => (window as unknown as { __pinChurn: { added: number } }).__pinChurn.added
  );
  expect(churn).toBe(0);
  await expect(page.locator(".map .map-pin.selected")).toHaveCount(1);
});

test("switching tabs rebuilds the pins exactly once", async ({ page }) => {
  await page.route("**/conditions.json", (route) =>
    route.fulfill({ json: fixtureConditions() })
  );
  await page.goto("/en");
  await page.waitForSelector(".map .map-pin");
  await page.waitForTimeout(2_000);

  // The spot list genuinely changes here, so the layer has to be rebuilt - but
  // once, for the one beach in the fixture, not once per render.
  await page.evaluate(() => {
    const counter = { added: 0 };
    (window as unknown as { __pinChurn: typeof counter }).__pinChurn = counter;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.matches(".map-pin") || node.querySelector(".map-pin"))
          ) {
            counter.added += 1;
          }
        }
      }
    }).observe(document.querySelector(".map")!, { childList: true, subtree: true });
  });

  await page.getByRole("tab", { name: "Beaches" }).click();
  await page.waitForTimeout(1_000);

  const churn = await page.evaluate(
    () => (window as unknown as { __pinChurn: { added: number } }).__pinChurn.added
  );
  expect(churn).toBe(1);
  await expect(page.locator(".map .map-pin")).toHaveCount(1);
});
