/**
 * Basemap and terrain sources, and the one licence decision that constrains
 * the whole project.
 *
 * EOX publishes Sentinel-2 cloudless as one layer per year. The yearly layers
 * from 2017 on are CC BY-NC-SA - free for this, unusable the day anyone wants
 * to charge for it. The unsuffixed `s2cloudless_3857` alias is the original
 * 2016 mosaic and is plain CC BY 4.0.
 *
 * Both identifiers are verified against
 * https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml - the abstracts
 * there carry the licence per layer, so this is not folklore.
 *
 * Open-Meteo's free tier is already non-commercial, so the stack is coherently
 * non-commercial end to end today. Flipping IMAGERY_LICENCE to "commercial"
 * swaps the imagery and its attribution in one place, which is the whole
 * reason this file exists.
 */

import type {
  RasterDEMSourceSpecification,
  RasterSourceSpecification,
} from "maplibre-gl";
import { CLEAN_DEM_PROTOCOL } from "./demProtocol";

export type ImageryLicence = "non-commercial" | "commercial";

export const IMAGERY_LICENCE: ImageryLicence = "non-commercial";

const EOX_LAYER: Record<ImageryLicence, string> = {
  "non-commercial": "s2cloudless-2025_3857",
  commercial: "s2cloudless_3857", // the 2016 mosaic, CC BY 4.0
};

const EOX_ATTRIBUTION: Record<ImageryLicence, string> = {
  "non-commercial":
    '<a href="https://s2maps.eu">Sentinel-2 cloudless 2025</a> by ' +
    '<a href="https://eox.at">EOX IT Services GmbH</a> ' +
    "(Contains modified Copernicus Sentinel data 2025) " +
    '<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/">CC BY-NC-SA 4.0</a>',
  commercial:
    '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by ' +
    '<a href="https://eox.at">EOX IT Services GmbH</a> ' +
    "(Contains modified Copernicus Sentinel data 2016) " +
    '<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>',
};

const TERRAIN_ATTRIBUTION =
  '<a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a> ' +
  "(Mapzen Terrarium, ODbL)";

/**
 * Sentinel-2 is 10m/px, which runs out around zoom 14. Capping there stops the
 * map requesting tiles that carry no more information, and matters more than
 * it sounds: this is opened on mobile data on a mountain road at 5am.
 */
const SATELLITE_MAX_ZOOM = 14;

export const SATELLITE_SOURCE_ID = "satellite";
export const DEM_SOURCE_ID = "terrain-dem";

export function satelliteSource(
  licence: ImageryLicence = IMAGERY_LICENCE
): RasterSourceSpecification {
  return {
    type: "raster",
    tiles: [
      `https://tiles.maps.eox.at/wmts/1.0.0/${EOX_LAYER[licence]}/default/g/{z}/{y}/{x}.jpg`,
    ],
    tileSize: 256,
    maxzoom: SATELLITE_MAX_ZOOM,
    attribution: EOX_ATTRIBUTION[licence],
  };
}

/**
 * Terrarium DEM: open data, no API key, and stable for years - but with no
 * SLA behind it. The map must survive this 404ing, so nothing except the
 * terrain itself may depend on it (see Map.tsx's error handler).
 */
export function demSource(): RasterDEMSourceSpecification {
  return {
    type: "raster-dem",
    tiles: [
      `${CLEAN_DEM_PROTOCOL}://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png`,
    ],
    encoding: "terrarium",
    tileSize: 256,
    maxzoom: 14,
    attribution: TERRAIN_ATTRIBUTION,
  };
}

/**
 * Archipelago bounds: the box the *data* covers.
 *
 * The cloud volume is gridded over exactly this, and the deck's quads span it,
 * so it is a statement about the forecast and not about the camera.
 */
export const BOUNDS: [number, number, number, number] = [
  -17.5, 32.3, -16.2, 33.2,
];

/**
 * How far the camera may roam, which is a much bigger box than the data.
 *
 * These used to be the same value, and it made the map feel boxed in: MapLibre
 * fits `maxBounds` inside the viewport, so a box the size of the archipelago
 * also imposed a floor on zooming out - the islands could never be seen with
 * any ocean around them, and panning stopped a few kilometres offshore. The
 * cloud stops at BOUNDS either way; what this buys is context and a way to
 * back off and look at the whole thing.
 */
export const VIEW_BOUNDS: [number, number, number, number] = [
  -21.0, 29.6, -12.7, 36.0,
];

/** Centred on the central massif rather than the island's centroid. */
export const CENTRE: [number, number] = [-16.92, 32.75];
