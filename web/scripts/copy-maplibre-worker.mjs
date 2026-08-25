/**
 * Copy MapLibre's worker into public/ so it can be served as a real file.
 *
 * MapLibre 6 ships its worker as a separate ES module and spawns it with
 * `new Worker(new URL("./maplibre-gl-worker.mjs", import.meta.url), { type: "module" })`.
 * Webpack cannot rewrite that URL inside an already-bundled dependency, so it
 * bakes in the build machine's absolute path - the browser then requests a
 * nonexistent file, the static host answers with index.html, and the map dies
 * with "non-JavaScript MIME type" and no tiles. MapLibre 4 inlined the worker
 * as a blob and had none of this.
 *
 * So the two files are copied verbatim and pointed at with setWorkerUrl().
 * They are siblings on purpose: the worker imports ./maplibre-gl-shared.mjs.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "..", "node_modules", "maplibre-gl", "dist");
const to = join(here, "..", "public", "maplibre");

const FILES = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

mkdirSync(to, { recursive: true });
for (const file of FILES) {
  copyFileSync(join(from, file), join(to, file));
}
console.log(`copied ${FILES.length} maplibre worker files to public/maplibre`);
