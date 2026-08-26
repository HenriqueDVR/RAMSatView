// GitHub Pages serves a project site from /<repo>/, so every absolute URL the
// bundle emits has to carry that prefix. Empty locally and in the e2e suite,
// which both serve from the root.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath,
  assetPrefix: basePath || undefined,
  // Static export: the whole site is HTML/JS on a CDN. The forecast is fetched
  // client-side from a JSON file published alongside it, so the page shell is
  // cacheable forever and traffic never reaches an origin server.
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  reactStrictMode: true,
};

export default nextConfig;
