/**
 * The sea: a water surface at 0m that thickens with distance.
 *
 * Near the camera it is mostly transparent, so what you see is the actual
 * Sentinel-2 water - surf on the north coast, the shelf around Porto Santo,
 * the colour change over the reefs. That imagery is the most convincing thing
 * on the map and hiding it behind a painted plane was a waste of it.
 *
 * Far from the camera it closes to opaque, because out there the imagery has
 * nothing left to say: it is 10m pixels of open ocean seen almost edge-on,
 * and it ends at the DEM's edge rather than at a horizon. The painted water
 * carries the dawn light, the glitter path and the meeting with the sky.
 *
 * The plane also still hides the sea floor. Terrarium's bathymetry is clamped
 * flat by demFilter, so there is no relief down there to show - but the
 * clamped floor is drawn with ocean imagery on it, and that is exactly what
 * shows through the transparent near field.
 */

import { MercatorCoordinate } from "maplibre-gl";
import { cameraState } from "./camera";
import { CENTRE } from "./sources";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";

/**
 * The plane is rebuilt every frame to just inside the far clipping plane.
 *
 * A single huge quad does not work: everything past farZ is clipped away, so
 * the sea stopped a few tens of kilometres out and the gap between its far
 * edge and the true horizon filled with sky - which reads as the ocean simply
 * ending. Sizing it from the frustum means it always reaches the horizon,
 * whatever the pitch and zoom.
 */
const MAX_EXTENT_MERCATOR = 0.4;

/**
 * The DEM reads close to zero all along the coast, so the plane and the
 * imagery draped on the terrain end up coplanar and flicker against each other
 * as the camera moves. Dropping the plane a little and biasing its depth
 * settles it: below the shoreline, still above any real bathymetry.
 */
const SEA_LEVEL_M = -2;

/**
 * Where the water stops being a filter over the imagery and starts being
 * paint, expressed as multiples of the camera's height above the sea.
 *
 * Tied to camera height rather than fixed in metres so it behaves the same at
 * every zoom: standing off the island at 12km up, the imagery survives out to
 * ~15km and the paint takes over by ~60km; dropped to 2km over a beach, the
 * same ratios keep the water under the camera transparent and still close the
 * horizon.
 */
const OPEN_WATER_ALTITUDES = 1.2;
const CLOSED_WATER_ALTITUDES = 5;

/**
 * Opacity of the water directly under the camera.
 *
 * Not zero: raw Sentinel-2 ocean is a flat near-black that carries none of the
 * dawn light, and the point of the plane is that the sea reads as water at
 * this hour. A third of a wash keeps the surf and the shelf visible through
 * it and still tints them.
 */
const MIN_OPACITY = 0.34;

const VERTEX_SOURCE = `#version 300 es
in vec2 a_mercator;
uniform mat4 u_matrix;
uniform float u_world_size;
uniform float u_sea_level;
out vec2 v_mercator;

void main() {
  // World pixels in x/y and metres in z - see CloudDeckLayer for why.
  gl_Position = u_matrix * vec4(a_mercator * u_world_size, u_sea_level, 1.0);
  v_mercator = a_mercator;
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 v_mercator;
uniform vec2 u_camera;
uniform vec2 u_anchor;
uniform vec2 u_sun;
uniform float u_sun_elevation;
uniform float u_camera_altitude;
uniform float u_metres_per_mercator;
uniform float u_open_water_m;
uniform float u_closed_water_m;
uniform float u_min_opacity;
uniform vec3 u_near_colour;
uniform vec3 u_far_colour;
uniform vec3 u_dawn_colour;
uniform float u_time;
out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

/**
 * Noise that fades to its own mean once a cell is smaller than a pixel.
 *
 * Without this the water crawls. Every pattern on this plane is sampled at a
 * scale that is fine near the camera and far below one pixel per cell towards
 * the horizon, and undersampled noise does not look like distant texture - it
 * looks like static, and it changes every frame as the camera moves.
 */
float bandLimited(vec2 p, float mean) {
  float footprint = fwidth(p.x) + fwidth(p.y);
  return mix(noise(p), mean, smoothstep(0.35, 1.4, footprint));
}

void main() {
  // Metres from a fixed point on the earth, NOT from the map centre.
  //
  // The map centre moves with the camera every frame, so sampling the swell
  // and the glitter from it dragged the whole pattern along underneath the
  // view: the sea slid as you panned, which is what read as flicker. Anchored
  // here, the water stays where the water is and the camera moves over it.
  vec2 world = (v_mercator - u_anchor) * u_metres_per_mercator;

  // How far this patch of water is from the eye, in metres. Distance from the
  // map centre would be the easy thing to use and the wrong one: at a 70
  // degree pitch the centre of the screen is nowhere near the centre of what
  // the camera can see, and the fade would sit in the wrong place the moment
  // anyone tilted.
  vec2 delta = (v_mercator - u_camera) * u_metres_per_mercator;
  float range = length(vec3(delta, u_camera_altitude));

  // Lighten with distance so the sea meets the sky instead of ending in a
  // hard band of flat colour. Gentle: a steep ramp turns the far water into a
  // bright sheet that reads as a floating polygon rather than as distance.
  float far = smoothstep(0.0, u_closed_water_m * 1.6, range);
  far = far * far * (3.0 - 2.0 * far);
  vec3 water = mix(u_near_colour, u_far_colour, far);

  // Water towards the sun is the brightest thing in the frame at this hour,
  // and it is only bright in that direction. u_sun is the sun's horizontal
  // bearing in this same frame, so the highlight moves round the compass with
  // the real sun instead of always sitting in the east.
  vec2 towards = normalize(delta + vec2(1e-6));
  float sunward = smoothstep(0.1, 1.0, dot(towards, u_sun)) * far;
  // A sun below the horizon lights nothing directly; the glow fades out over
  // the last few degrees of twilight rather than switching off.
  float daylight = smoothstep(-6.0, 2.0, u_sun_elevation);
  vec3 colour = mix(water, u_dawn_colour, sunward * 0.55 * (0.35 + 0.65 * daylight));

  // Broad swell, deliberately near-invisible: it exists so the water close to
  // the camera is not a single flat value, which is what made the near field
  // read as a hole in the scene rather than as sea.
  vec2 swellPoint = world / vec2(900.0, 2600.0) + vec2(u_time * 0.02, 0.0);
  colour *= 0.93 + 0.15 * bandLimited(swellPoint, 0.5);

  // Glitter path. A low sun over water does not produce a smooth gradient, it
  // produces a shivering road of broken highlights narrowing towards the
  // observer - and that single cue is most of what separates "water" from
  // "grey polygon". Anisotropic on purpose: stretched across the swell,
  // chopped along it.
  vec2 ripplePoint = world / vec2(26.0, 90.0) + vec2(u_time * 0.9, u_time * 0.3);
  float glint =
    bandLimited(ripplePoint, 0.5) * 0.6 +
    bandLimited(ripplePoint * 2.7 + 11.0, 0.5) * 0.4;
  // Only where the sun actually is: a narrow lobe about the sunward axis.
  float lobe = pow(smoothstep(0.45, 1.0, dot(towards, u_sun)), 3.0);
  // Nothing glitters underfoot: the specular lobe is a grazing-angle effect,
  // so it belongs in the distance, not on the water at the camera's feet.
  glint = smoothstep(0.62, 0.95, glint) * lobe * far * daylight;
  colour += vec3(1.0, 0.82, 0.62) * glint * 0.5;

  float opacity = mix(
    u_min_opacity,
    1.0,
    smoothstep(u_open_water_m, u_closed_water_m, range)
  );

  fragColor = vec4(colour * opacity, opacity); // premultiplied, as MapLibre expects
}`;

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("could not create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`sea shader failed to compile: ${log}`);
  }
  return shader;
}

export const SEA_LAYER_ID = "sea";

export class SeaLayer implements CustomLayerInterface {
  readonly id = SEA_LAYER_ID;
  readonly type = "custom";
  readonly renderingMode = "3d";

  private map: MapLibreMap | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private mercatorLocation = -1;
  private matrixLocation: WebGLUniformLocation | null = null;
  private worldSizeLocation: WebGLUniformLocation | null = null;
  private anchorLocation: WebGLUniformLocation | null = null;
  private sunLocation: WebGLUniformLocation | null = null;
  private sunElevationLocation: WebGLUniformLocation | null = null;
  private seaLevelLocation: WebGLUniformLocation | null = null;
  private nearColourLocation: WebGLUniformLocation | null = null;
  private farColourLocation: WebGLUniformLocation | null = null;
  private dawnColourLocation: WebGLUniformLocation | null = null;
  private timeLocation: WebGLUniformLocation | null = null;
  private cameraLocation: WebGLUniformLocation | null = null;
  private cameraAltitudeLocation: WebGLUniformLocation | null = null;
  private metresLocation: WebGLUniformLocation | null = null;
  private openWaterLocation: WebGLUniformLocation | null = null;
  private closedWaterLocation: WebGLUniformLocation | null = null;
  private minOpacityLocation: WebGLUniformLocation | null = null;
  private centre: [number, number] = [0, 0];
  private extent = 0;
  /** Horizontal sun bearing in mercator space; east until told otherwise. */
  private sun: [number, number] = [1, 0];
  private sunElevation = 0;
  private readonly vertices = new Float32Array(12);
  private readonly started = performance.now();

  /**
   * The glitter only moves while something else is already repainting. The sea
   * never asks for a frame of its own: the cloud deck is animating anyway when
   * motion is wanted, and under prefers-reduced-motion u_time is pinned to 0
   * so the water is still rather than merely slow.
   */
  constructor(private animate = true) {}

  private visible = true;

  /** Hide without removing - see CloudDeckLayer.setVisible. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.map?.triggerRepaint();
  }

  /**
   * Point the highlight and the glitter at the real sun.
   *
   * Takes the map-frame vector from lib/sun (east, north, up) and stores the
   * horizontal part in mercator space, where northing runs the other way.
   */
  setSun(vector: [number, number, number], elevationDegrees: number): void {
    const [east, north] = vector;
    const length = Math.hypot(east, north) || 1;
    this.sun = [east / length, -north / length];
    this.sunElevation = elevationDegrees;
    this.map?.triggerRepaint();
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;

    const program = gl.createProgram();
    if (!program) throw new Error("could not create sea program");
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(
        `sea program failed to link: ${gl.getProgramInfoLog(program)}`
      );
    }

    this.program = program;
    this.mercatorLocation = gl.getAttribLocation(program, "a_mercator");
    this.matrixLocation = gl.getUniformLocation(program, "u_matrix");
    this.worldSizeLocation = gl.getUniformLocation(program, "u_world_size");
    this.anchorLocation = gl.getUniformLocation(program, "u_anchor");
    this.sunLocation = gl.getUniformLocation(program, "u_sun");
    this.sunElevationLocation = gl.getUniformLocation(program, "u_sun_elevation");
    this.seaLevelLocation = gl.getUniformLocation(program, "u_sea_level");
    this.nearColourLocation = gl.getUniformLocation(program, "u_near_colour");
    this.farColourLocation = gl.getUniformLocation(program, "u_far_colour");
    this.dawnColourLocation = gl.getUniformLocation(program, "u_dawn_colour");
    this.timeLocation = gl.getUniformLocation(program, "u_time");
    this.cameraLocation = gl.getUniformLocation(program, "u_camera");
    this.cameraAltitudeLocation = gl.getUniformLocation(program, "u_camera_altitude");
    this.metresLocation = gl.getUniformLocation(program, "u_metres_per_mercator");
    this.openWaterLocation = gl.getUniformLocation(program, "u_open_water_m");
    this.closedWaterLocation = gl.getUniformLocation(program, "u_closed_water_m");
    this.minOpacityLocation = gl.getUniformLocation(program, "u_min_opacity");

    this.buffer = gl.createBuffer();
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    if (this.program) gl.deleteProgram(this.program);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    this.program = null;
    this.buffer = null;
    this.map = null;
  }

  /** Centre on the camera and reach as far as the frustum allows. */
  private updateGeometry(gl: WebGL2RenderingContext, farZ: number, worldSize: number): void {
    const map = this.map;
    if (!map) return;
    const centre = MercatorCoordinate.fromLngLat(map.getCenter());
    // farZ is in the same world pixels as the vertex positions.
    const extent = Math.min(MAX_EXTENT_MERCATOR, farZ / worldSize);
    this.centre = [centre.x, centre.y];
    this.extent = extent;

    const west = centre.x - extent;
    const east = centre.x + extent;
    const north = centre.y - extent;
    const south = centre.y + extent;
    this.vertices.set([
      west, north, east, north, east, south,
      west, north, east, south, west, south,
    ]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertices, gl.DYNAMIC_DRAW);
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    if (!this.visible || !this.program) return;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(
      this.matrixLocation,
      false,
      args.modelViewProjectionMatrix as Float32Array
    );
    const worldSize = 512 * Math.pow(2, this.map?.getZoom() ?? 0);
    this.updateGeometry(gl, args.farZ, worldSize);
    gl.uniform1f(this.worldSizeLocation, worldSize);
    const anchor = MercatorCoordinate.fromLngLat(CENTRE);
    gl.uniform2f(this.anchorLocation, anchor.x, anchor.y);
    // The sun's horizontal bearing in mercator, where y grows *south* - hence
    // the flipped northing. Elevation goes across separately so the water can
    // stop reflecting a sun that has not risen.
    gl.uniform2f(this.sunLocation, this.sun[0], this.sun[1]);
    gl.uniform1f(this.sunElevationLocation, this.sunElevation);
    gl.uniform1f(this.seaLevelLocation, SEA_LEVEL_M);
    gl.uniform3f(this.nearColourLocation, 0.055, 0.085, 0.14);
    // Meets the fog colour in style.ts, so the horizon is a transition rather
    // than a seam between two different surfaces.
    // Light enough to read as water under a lit sky. Too dark and the top
    // half of the frame is a black slab with an island pasted on it.
    gl.uniform3f(this.farColourLocation, 0.165, 0.208, 0.313);
    gl.uniform3f(this.dawnColourLocation, 0.62, 0.42, 0.3);

    // Camera-relative fade. Without a camera - the internals this reads are
    // not public API - the water falls back to fully opaque, which is exactly
    // how it behaved before it learned to fade.
    const camera = this.map ? cameraState(this.map) : null;
    const centre = MercatorCoordinate.fromLngLat(
      camera?.lngLat ?? this.map?.getCenter() ?? { lng: 0, lat: 0 }
    );
    const altitude = Math.max(camera?.altitude ?? 0, 1);
    gl.uniform2f(this.cameraLocation, centre.x, centre.y);
    gl.uniform1f(this.cameraAltitudeLocation, altitude);
    gl.uniform1f(
      this.metresLocation,
      1 / centre.meterInMercatorCoordinateUnits()
    );
    gl.uniform1f(this.openWaterLocation, altitude * OPEN_WATER_ALTITUDES);
    gl.uniform1f(this.closedWaterLocation, altitude * CLOSED_WATER_ALTITUDES);
    gl.uniform1f(this.minOpacityLocation, camera ? MIN_OPACITY : 1);
    gl.uniform1f(
      this.timeLocation,
      this.animate ? (performance.now() - this.started) / 1000 : 0
    );

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.mercatorLocation);
    gl.vertexAttribPointer(this.mercatorLocation, 2, gl.FLOAT, false, 8, 0);

    // Blended now rather than opaque, so the imagery underneath shows through
    // the near field. Depth is still written: the plane has to stop the cloud
    // slices below it from being drawn over the water, and it is the only
    // thing at sea level that can.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.enable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    // The imagery is draped on a DEM clamped flat just below sea level, so the
    // two surfaces are close enough to fight for the depth test. The offset
    // settles it in the plane's favour.
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.0, 1.0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.disable(gl.POLYGON_OFFSET_FILL);
  }
}
