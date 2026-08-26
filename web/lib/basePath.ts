/**
 * Where the site is mounted.
 *
 * Empty in development and in the e2e suite, which serve from the root, and
 * "/RAMSatView" on GitHub Pages, which serves every project site from a
 * subdirectory. Next rewrites its own bundle URLs from `basePath`, but not
 * plain `href`s, `fetch` paths or a Web Worker URL - those are the three
 * things here, and each of them is a blank page rather than a broken image
 * when it is wrong.
 */

export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** Prefix an absolute site path with the base the site is mounted at. */
export function withBase(path: string): string {
  return `${BASE_PATH}${path}`;
}
