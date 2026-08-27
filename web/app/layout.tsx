import type { Metadata } from "next";
// MapLibre first, ours second: both stylesheets style .maplibregl-ctrl-* with
// single-class selectors, so the later import wins every tie. Loading theirs
// last is what made the zoom control keep its white pill no matter what
// globals.css said about it.
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Madeira Conditions",
  description:
    "Sea-of-clouds and sunrise forecasts for Madeira's peaks, and sea conditions for its beaches.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Only the root layout may carry <html>, and it sits above the [locale]
  // segment, so it cannot know which language the page below it is in. The
  // default here is corrected per page by scripts/set-html-lang.mjs after the
  // export - see that file. This comment used to claim the route segment did
  // it, which nothing did.
  return (
    <html lang="pt">
      <body>{children}</body>
    </html>
  );
}
