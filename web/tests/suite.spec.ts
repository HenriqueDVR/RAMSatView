import { expect, test } from "@playwright/test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { LOGIC_SPECS, MAP_SPECS } from "../playwright.config";

/**
 * The suite checking its own bookkeeping.
 *
 * The projects are split by cost - a map spec renders terrain through
 * SwiftShader and takes minutes, a logic spec takes milliseconds - and the
 * split is a pair of hand-written lists. That is fine right up until someone
 * adds a spec file and forgets to list it, at which point the file belongs to
 * no project and never runs again. Nothing else would notice: the suite would
 * stay green, with one fewer test in it.
 */

test("every spec file belongs to exactly one project", () => {
  const files = readdirSync(join(__dirname))
    .filter((name) => name.endsWith(".spec.ts"))
    .sort();

  const listed = [...LOGIC_SPECS, ...MAP_SPECS];
  const unassigned = files.filter((name) => !listed.includes(name));
  expect(
    unassigned,
    "add these to LOGIC_SPECS or MAP_SPECS in playwright.config.ts",
  ).toEqual([]);

  const both = LOGIC_SPECS.filter((name) => MAP_SPECS.includes(name));
  expect(both, "a spec cannot be in both lists").toEqual([]);

  // And nothing listed that no longer exists, which would read as coverage
  // that is not there.
  const missing = listed.filter((name) => !files.includes(name));
  expect(missing, "listed but not present").toEqual([]);
});

test("no logic spec quietly opens a page", async () => {
  // The one way a logic spec becomes a slow one without anybody noticing.
  const { readFileSync } = await import("node:fs");
  // Itself excluded: this file names the call it is looking for, so scanning
  // its own source finds it and reports the guard as the offender. It caught
  // that on its first run.
  const offenders = LOGIC_SPECS.filter((name) => {
    if (name === "suite.spec.ts") return false;
    const source = readFileSync(join(__dirname, name), "utf8");
    return source.includes("page.goto(");
  });
  expect(offenders, "these navigate, so they belong in MAP_SPECS").toEqual([]);
});
