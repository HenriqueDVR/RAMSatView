import { expect, test, type Page } from "@playwright/test";
import { fixtureConditions } from "./fixture";

/**
 * The callout anchored to the selected pin, and the marker structure that
 * holds it there.
 *
 * The structure is the part worth guarding. A MapLibre marker is positioned by
 * writing `transform` on its element every frame, so anything else that wants
 * that property on the same element silently wins or loses against the map -
 * and the failure is invisible in a screenshot taken while the camera is
 * still.
 */

test.use({ timezoneId: "Atlantic/Madeira", locale: "en-GB" });

test.beforeEach(async ({ page }) => {
  await page.route("**/conditions.json", (route) =>
    route.fulfill({ json: fixtureConditions() }),
  );
});

/** The pin, not the sidebar row - both are buttons carrying the spot's name. */
const pinFor = (page: Page, name: string) =>
  page.locator(`.map-pin[aria-label^="${name}"]`);

async function openOnRuivo(page: Page) {
  await page.goto("/en");
  await page.waitForSelector(".map-pin", { timeout: 30_000 });
  await pinFor(page, "Pico Ruivo").click();
  await expect(page.locator(".callout")).toBeVisible({ timeout: 30_000 });
}

/**
 * Wait for the selected pin's own scale to stop moving.
 *
 * `.map-pin.selected` reaches its scale through `transition: transform`, so a
 * read taken in the same tick as the click sees the identity matrix and the
 * grown pin looks like it never grew. Settle before measuring the scale - not
 * before measuring position, which several tests read mid-movement on purpose.
 */
async function settleSelectedPin(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const pin = document.querySelector(".map-pin.selected") as HTMLElement;
        if (!pin) {
          resolve();
          return;
        }
        const grown = new DOMMatrixReadOnly(getComputedStyle(pin).transform).a;
        if (grown > 1) {
          resolve();
          return;
        }
        const done = () => {
          pin.removeEventListener("transitionend", done);
          clearTimeout(timer);
          resolve();
        };
        // The transition may already have ended - or never have started, if
        // the class landed while the tab was throttled - so cap the wait.
        const timer = setTimeout(done, 1000);
        pin.addEventListener("transitionend", done);
      }),
  );
}

/**
 * Where the map has put the pin and the callout, in one read.
 *
 * The anchors are measured rather than the rendered boxes. A selected pin
 * animates its own scale, so its box is still moving for a moment after the
 * click and a rect comparison would be timing the transition instead of the
 * thing under test. The anchors carry only MapLibre's positioning, which is
 * exactly what has to agree.
 */
async function geometry(page: Page) {
  return page.evaluate(() => {
    const pin = document.querySelector(".map-pin.selected") as HTMLElement;
    const callout = document.querySelector(".callout") as HTMLElement;
    const pinBox = pin.getBoundingClientRect();
    const calloutBox = callout.getBoundingClientRect();

    // MapLibre writes `translate(-50%, …) translate(Xpx, Ypx) rotate…`, so the
    // pixel pair is the one carrying the map position.
    const anchorAt = (element: HTMLElement) => {
      const found = element.style.transform.match(
        /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/,
      );
      return found
        ? { x: Number(found[1]), y: Number(found[2]) }
        : { x: NaN, y: NaN };
    };

    return {
      offsetX: Math.round(
        calloutBox.left +
          calloutBox.width / 2 -
          (pinBox.left + pinBox.width / 2),
      ),
      pinAnchor: anchorAt(pin.parentElement as HTMLElement),
      calloutAnchor: anchorAt(callout.parentElement as HTMLElement),
      pinTransform: getComputedStyle(pin).transform,
      anchorTransform: (pin.parentElement as HTMLElement).style.transform,
    };
  });
}

test.describe("desktop", () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== "desktop", "desktop project only");
  });

  test("the selected pin carries its own headline", async ({ page }) => {
    await openOnRuivo(page);
    const callout = page.locator(".callout");

    // Which spot, what score, and the sentence that decides the morning.
    await expect(callout).toContainText("Pico Ruivo");
    await expect(callout).toContainText("Above the cloud sea");
    await expect(callout.locator(".callout-score")).toHaveText("35");

    // One at a time. Eight of these at the default camera would cover each
    // other and the pins under them.
    await expect(callout).toHaveCount(1);
  });

  test("nothing is selected, nothing is called out", async ({ page }) => {
    await page.goto("/en");
    await page.waitForSelector(".map-pin", { timeout: 30_000 });
    await expect(page.locator(".callout")).toHaveCount(0);
  });

  test("the callout does not take the pin's clicks", async ({ page }) => {
    await openOnRuivo(page);
    // It sits directly over the pin it describes. A box that swallowed clicks
    // would make that spot harder to select than the seven it is not.
    await expect(page.locator(".callout")).toHaveCSS("pointer-events", "none");
  });

  test("the map moves the wrapper and the pin only scales itself", async ({
    page,
  }) => {
    await openOnRuivo(page);
    await settleSelectedPin(page);
    const { pinTransform, anchorTransform } = await geometry(page);

    // The wrapper carries MapLibre's positioning.
    expect(anchorTransform).toContain("translate");

    // The pin carries nothing but its own scale. This is the regression: with
    // both on one element the inline transform won, the selected scale never
    // applied at all, and `transition: transform` animated the *positioning* -
    // so every pin slid along behind its own coordinate for the length of
    // every pan.
    const matrix = pinTransform.match(/matrix\(([^)]+)\)/);
    expect(matrix, `expected a matrix, got ${pinTransform}`).not.toBeNull();
    const [scaleX, , , scaleY, translateX, translateY] = matrix![1]
      .split(",")
      .map((value) => Number(value.trim()));
    expect(translateX).toBe(0);
    expect(translateY).toBe(0);
    expect(scaleX).toBeGreaterThan(1);
    expect(scaleY).toBeGreaterThan(1);
  });

  test("the callout stays on the pin through a camera move", async ({
    page,
  }) => {
    await openOnRuivo(page);
    const before = await geometry(page);
    expect(before.offsetX).toBe(0);

    // Read with no settling time at all, deliberately. The bug this covers was
    // only ever visible mid-movement: wait a second and the pin caught up.
    await page.evaluate(() =>
      (
        window as unknown as {
          __satappMap: { jumpTo: (options: Record<string, unknown>) => void };
        }
      ).__satappMap.jumpTo({
        center: [-16.95, 32.72],
        bearing: 200,
        pitch: 60,
        zoom: 12.4,
      }),
    );

    const after = await geometry(page);
    expect(after.offsetX).toBe(0);

    // The camera actually moved.
    expect(after.pinAnchor).not.toEqual(before.pinAnchor);

    // And the two anchors still agree, exactly: same column, and the callout
    // the marker's offset above. Before the fix the pin's anchor was correct
    // and the pin itself was somewhere else entirely, easing towards it.
    // To the pixel, not to the float: MapLibre positions each marker on its own
    // and samples the terrain under it separately, so the two land a few
    // hundredths of a pixel apart. The bug this covers was worth 130.
    for (const at of [before, after]) {
      expect(at.calloutAnchor.x).toBeCloseTo(at.pinAnchor.x, 0);
      expect(at.pinAnchor.y - at.calloutAnchor.y).toBeCloseTo(24, 0);
    }
  });
});

test("a phone gets the sheet instead of a callout", async ({ page }) => {
  test.skip(test.info().project.name !== "mobile", "phone layout only");
  await page.goto("/en");
  await page.waitForSelector(".map-pin", { timeout: 30_000 });
  await pinFor(page, "Pico Ruivo").click();

  // The sheet says the same three facts, somewhere that cannot end up
  // underneath itself.
  await expect(page.locator(".sidebar")).toHaveAttribute(
    "data-sheet",
    "open",
    { timeout: 30_000 },
  );
  await expect(page.locator(".sheet-summary")).toContainText("Pico Ruivo");
  await expect(page.locator(".callout")).toBeHidden();
});
