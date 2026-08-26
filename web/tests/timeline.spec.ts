import { expect, test } from "@playwright/test";
import {
  dayMarks,
  formatDay,
  formatHour,
  hoursFromNow,
  nearestIndex,
  relativeHour,
} from "../lib/timeline";

/**
 * The scrubber's clock. Every value here is in island time, and the tests are
 * written with UTC instants so a machine in another zone gets the same result
 * - which is the whole point of the module.
 */

const AUGUST = new Date("2026-08-26T06:00:00Z"); // 07:00 in Madeira, WEST
const JANUARY = new Date("2026-01-15T06:00:00Z"); // 06:00 in Madeira, WET

test("hours are shown in island time, summer and winter", () => {
  expect(formatHour(AUGUST, "en")).toBe("07:00");
  expect(formatHour(JANUARY, "en")).toBe("06:00");
});

test("the day label names the local morning, not the UTC one", () => {
  // 23:30 UTC on the 26th is already the 27th in Madeira in summer.
  expect(formatDay(new Date("2026-08-26T23:30:00Z"), "en")).toContain("27");
});

test("day marks fall where the island's calendar turns over", () => {
  const times: Date[] = [];
  for (let hour = 0; hour < 30; hour++) {
    times.push(new Date(Date.UTC(2026, 7, 26, 12 + hour)));
  }
  const marks = dayMarks(times, "en");
  expect(marks[0].index).toBe(0);
  // 12:00 UTC on the 26th is 13:00 local, so midnight local is eleven hours on.
  expect(marks[1].index).toBe(11);
  expect(marks[1].label).toContain("27");
});

test("the nearest hour is found, and an empty timeline says so", () => {
  const times = [
    new Date("2026-08-26T09:00:00Z"),
    new Date("2026-08-26T10:00:00Z"),
  ];
  expect(nearestIndex(times, new Date("2026-08-26T09:29:00Z"))).toBe(0);
  expect(nearestIndex(times, new Date("2026-08-26T09:31:00Z"))).toBe(1);
  expect(nearestIndex([], new Date())).toBe(-1);
});

test("offsets from now are signed: archive is negative", () => {
  const now = new Date("2026-08-26T09:00:00Z");
  expect(hoursFromNow(new Date("2026-08-26T14:00:00Z"), now)).toBe(5);
  expect(hoursFromNow(new Date("2026-08-25T09:00:00Z"), now)).toBe(-24);
});

test("the relative phrase is written in the page's language", () => {
  const now = new Date("2026-08-26T09:00:00Z");
  const later = new Date("2026-08-26T12:00:00Z");
  expect(relativeHour(later, "en", now)).toBe("in 3 hours");
  expect(relativeHour(later, "pt", now)).toContain("3 horas");
  expect(relativeHour(now, "en", now)).toBe("this hour");
});
