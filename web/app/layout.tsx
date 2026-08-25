import type { Metadata } from "next";
import "./globals.css";
import "maplibre-gl/dist/maplibre-gl.css";

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
