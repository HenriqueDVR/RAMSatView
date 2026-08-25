/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: the whole site is HTML/JS on a CDN. Forecast data is
  // fetched client-side from R2 at runtime, so new conditions do not require
  // a rebuild and traffic never reaches an origin server.
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  reactStrictMode: true,
};

export default nextConfig;
