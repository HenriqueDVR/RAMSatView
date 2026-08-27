/**
 * Stamp each exported page with the language it is actually written in.
 *
 * The root layout renders `<html lang="pt">` and cannot do better: in the App
 * Router only the root layout may carry the `<html>` element, and the root
 * layout sits above the `[locale]` segment, so nothing there knows which
 * language the page below it is in. The comment beside it claimed the route
 * segment set the language per locale. Nothing did, and both exported pages
 * declared themselves Portuguese - so a screen reader read the English site
 * aloud with Portuguese pronunciation, and search engines were told the same.
 *
 * The export writes one HTML file per locale, so the honest fix is to correct
 * them after the fact rather than to restructure the routes around an
 * attribute. Runs as a postbuild step, next to the worker copy, and fails the
 * build if it finds a page it cannot place - a silently skipped page would put
 * the bug straight back.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "out");
const LOCALES = ["en", "pt"];

function pagesIn(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...pagesIn(path));
    else if (entry.endsWith(".html")) found.push(path);
  }
  return found;
}

function localeOf(path) {
  const relative = path.slice(OUT.length + 1).split(/[\\/]/);
  return LOCALES.includes(relative[0]) ? relative[0] : null;
}

let stamped = 0;
for (const page of pagesIn(OUT)) {
  const locale = localeOf(page);
  // The root redirect and the 404 belong to no locale and keep the default.
  if (locale === null) continue;

  const html = readFileSync(page, "utf8");
  const updated = html.replace(/<html([^>]*)\slang="[^"]*"/, `<html$1 lang="${locale}"`);
  if (updated === html && !html.includes(`lang="${locale}"`)) {
    throw new Error(`no lang attribute to set in ${page}`);
  }
  writeFileSync(page, updated);
  stamped += 1;
}

if (stamped === 0) {
  throw new Error(`no localised pages found under ${OUT}`);
}
console.log(`set html lang on ${stamped} page(s)`);
