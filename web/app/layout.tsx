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
  // lang is set per-locale by the route segment; html here carries the default.
  return (
    <html lang="pt">
      <body>{children}</body>
    </html>
  );
}
