import { expect, test } from "@playwright/test";
import {
  coverage,
  decodeSpotHours,
  hourIndexAt,
  loadSpotHours,
  spotHourAt,
  spotHoursUrl,
  type SpotHoursHeader,
} from "../lib/spotHours";
import { calimaSeverity, hourVerdict } from "../lib/conditions";

/**
 * The per-spot hourly series: its decoding, and the verdict drawn from it.
 *
 * The failure worth guarding is not a crash. It is the blob being read one
 * spot or one hour out of step, which produces a perfectly plausible number
 * under the wrong name - so the arithmetic is pinned here directly.
 */

const T0 = Date.UTC(2026, 7, 20, 0, 0);

function header(overrides: Partial<SpotHoursHeader> = {}): SpotHoursHeader {
  const base: SpotHoursHeader = {
    file: "spot-hours.bin",
    generated_at: "2026-08-27T12:00:00Z",
    t0: "2026-08-20T00:00:00Z",
    step_h: 1,
    count: 2,
    spots: ["arieiro", "ruivo"],
    series: [
      { name: "deck_base_m", scale: 20, offset: 0 },
      { name: "deck_top_m", scale: 20, offset: 0 },
      { name: "cloud_at_summit", scale: 0.005, offset: 0 },
      { name: "temperature_c", scale: 0.25, offset: -25 },
      { name: "wind_kmh", scale: 0.5, offset: 0 },
      { name: "aod", scale: 0.01, offset: 0 },
    ],
    missing: 255,
    bytes: 2 * 6 * 2,
    ...overrides,
  };
  return base;
}

/** Two spots, six series, two hours - written out so the layout is visible. */
function blob(): Uint8Array {
  return new Uint8Array([
    // arieiro
    30,
    31, // deck base: 600m, 620m
    70,
    71, // deck top: 1400m, 1420m
    180,
    10, // cloud at summit: 0.9, 0.05
    145,
    150, // temperature: 11.25C, 12.5C
    36,
    45, // wind: 18, 22.5
    15,
    80, // aod: 0.15 (clean), 0.80 (heavy calima)
    // ruivo
    255,
    255, // no deck base
    255,
    255, // no deck top
    4,
    255, // 0.02, then nothing
    140,
    255, // 10C, then nothing
    20,
    255, // 10km/h, then nothing
    255,
    255, // no dust reading at all
  ]);
}

test("a spot's own block is found by its position in the header", () => {
  const hours = decodeSpotHours(header(), blob());

  const arieiro = spotHourAt(hours, "arieiro", T0);
  expect(arieiro).toEqual({
    deckBaseM: 600,
    deckTopM: 1400,
    cloudAtSummit: 0.9,
    temperatureC: 11.25,
    windKmh: 18,
    aod: 0.15,
  });

  // The second spot, not a re-read of the first shifted by a series.
  expect(spotHourAt(hours, "ruivo", T0)?.temperatureC).toBe(10);
  expect(spotHourAt(hours, "ruivo", T0)?.deckTopM).toBeNull();
});

test("the second hour is the second hour", () => {
  const hours = decodeSpotHours(header(), blob());
  const later = spotHourAt(hours, "arieiro", T0 + 3600_000);
  expect(later?.deckTopM).toBe(1420);
  expect(later?.windKmh).toBe(22.5);
});

test("a hole is not a clear sky", () => {
  const hours = decodeSpotHours(header(), blob());
  const at = spotHourAt(hours, "ruivo", T0 + 3600_000);
  // Every series missing, and none of them read as zero - zero metres would be
  // a claim that the cloud is on the ground.
  expect(at).toEqual({
    deckBaseM: null,
    deckTopM: null,
    cloudAtSummit: null,
    temperatureC: null,
    windKmh: null,
    aod: null,
  });
});

test("outside the published span there is nothing, not the nearest edge", () => {
  const hours = decodeSpotHours(header(), blob());
  expect(hourIndexAt(hours, T0 - 3600_000)).toBeNull();
  expect(hourIndexAt(hours, T0 + 2 * 3600_000)).toBeNull();
  expect(spotHourAt(hours, "arieiro", T0 + 5 * 3600_000)).toBeNull();
  expect(spotHourAt(hours, "nowhere", T0)).toBeNull();
});

test("the covered span is reported from the header, not guessed", () => {
  const hours = decodeSpotHours(header(), blob());
  expect(coverage(hours)).toEqual({ fromMs: T0, toMs: T0 + 3600_000 });
});

test("a blob that does not match its header is refused before it is read", () => {
  expect(() => decodeSpotHours(header(), new Uint8Array(4))).toThrow(
    /4 bytes, expected 24/,
  );
  expect(() => decodeSpotHours(header({ bytes: 999 }), blob())).toThrow(
    /declares 999 bytes/,
  );
});

test("series are matched by name, so an added channel cannot shift the rest", () => {
  // The ingest may publish a sixth series before this side knows about it.
  // Reading by position would then return the wrong channel silently.
  const reordered = header({
    series: [
      { name: "wind_kmh", scale: 0.5, offset: 0 },
      { name: "deck_base_m", scale: 20, offset: 0 },
      { name: "deck_top_m", scale: 20, offset: 0 },
      { name: "cloud_at_summit", scale: 0.005, offset: 0 },
      { name: "temperature_c", scale: 0.25, offset: -25 },
      { name: "aod", scale: 0.01, offset: 0 },
    ],
  });
  const hours = decodeSpotHours(reordered, blob());
  // First block is now wind, so wind reads what deck_base held before.
  expect(spotHourAt(hours, "arieiro", T0)?.windKmh).toBe(15);
});

test("the blob is fetched from beside the document", async () => {
  let asked = "";
  const fetchImpl = (async (url: string) => {
    asked = url;
    return {
      ok: true,
      arrayBuffer: async () => blob().buffer,
    };
  }) as unknown as typeof fetch;

  await loadSpotHours(
    header(),
    "https://example.com/data/conditions.json",
    fetchImpl,
  );
  expect(asked).toBe("https://example.com/data/spot-hours.bin");
  expect(
    spotHoursUrl(header(), "https://example.com/data/conditions.json"),
  ).toBe("https://example.com/data/spot-hours.bin");
});

// --- the verdict the panel and the pin both read --------------------------

test("cloud at the summit means you are inside it, whatever the deck says", () => {
  expect(hourVerdict({ cloudAtSummit: 0.9, deckTopM: 400 }, 1818)).toBe(
    "inside",
  );
});

test("a deck below the summit is a deck you stand above", () => {
  expect(hourVerdict({ cloudAtSummit: 0.05, deckTopM: 1400 }, 1818)).toBe(
    "above",
  );
});

test("a deck level with the summit is not a view", () => {
  expect(hourVerdict({ cloudAtSummit: 0.05, deckTopM: 1810 }, 1818)).toBe(
    "none",
  );
});

test("an hour that measured nothing defers to the day rather than inventing", () => {
  expect(hourVerdict({ cloudAtSummit: null, deckTopM: null }, 1818)).toBeNull();
});

test("dust rides the same series as everything else", () => {
  const hours = decodeSpotHours(header(), blob());
  // Clean maritime air at the first hour, a heavy calima at the second: the
  // vertical profile is identical across both and sees neither.
  expect(spotHourAt(hours, "arieiro", T0)?.aod).toBeCloseTo(0.15, 5);
  expect(spotHourAt(hours, "arieiro", T0 + 3600_000)?.aod).toBeCloseTo(0.8, 5);
  expect(calimaSeverity(0.15)).toBe("none");
  expect(calimaSeverity(0.8)).toBe("heavy");
  // Unmeasured is not clean.
  expect(calimaSeverity(null)).toBe("none");
  expect(spotHourAt(hours, "ruivo", T0)?.aod).toBeNull();
});

test("at Fanal the same sky gets the opposite words", () => {
  // The laurel forest in mist is what people drive there for. Calling that
  // "summit inside the cloud" told them to stay home on the one morning worth
  // going, which the README has listed as a known limitation since day one.
  const misty = { cloudAtSummit: 0.9, deckTopM: null };
  expect(hourVerdict(misty, 1150)).toBe("inside");
  expect(hourVerdict(misty, 1150, true)).toBe("fog");

  const clear = { cloudAtSummit: 0.02, deckTopM: 800 };
  expect(hourVerdict(clear, 1150)).toBe("above");
  expect(hourVerdict(clear, 1150, true)).toBe("no_fog");
});

test("a fog spot with nothing measured still defers rather than guessing", () => {
  // A deck top alone says nothing about whether there is mist in the trees.
  expect(
    hourVerdict({ cloudAtSummit: null, deckTopM: 900 }, 1150, true),
  ).toBeNull();
});
