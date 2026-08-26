/**
 * The cloud deck, drawn as a volume at its true altitude.
 *
 * This is the one visual that states the product's actual claim: the summit is
 * above the cloud, and the cloud has a top at a specific height. A number can
 * assert that. Only a picture can show it.
 *
 * Why a custom WebGL layer rather than something declarative:
 *
 * - `fill-extrusion` is terrain-relative and has no base-alignment property in
 *   MapLibre, so an extrusion drapes itself over the mountains instead of
 *   forming a plane through them. That is the exact opposite of the point.
 * - `MercatorCoordinate.fromLngLat([lng, lat], altitudeMetres)` maps altitude
 *   straight onto z, which is the only way to put flat geometry at an absolute
 *   height.
 * - `renderingMode: "3d"` shares the map's depth buffer, so terrain occludes
 *   the cloud for free. Peaks piercing the deck is then geometrically true
 *   rather than an effect drawn to look true.
 *
 * Why slices rather than a raymarch. A raymarch would be the obvious way to
 * draw a volume, but it needs the scene depth to know where each ray stops,
 * and MapLibre hands custom layers no depth texture - only matrices (see
 * `CustomRenderMethodInput`). Rendering terrain depth a second time to get one
 * costs more than the alternative: slicing the volume into horizontal sheets
 * lets the hardware depth test do the occlusion, at true altitudes, in one
 * pass. The sheets all sample one 3D noise texture, so consecutive slices are
 * vertically coherent and read as a single body of cloud rather than a stack.
 */

import { MercatorCoordinate } from "maplibre-gl";
import { cameraState } from "./camera";
import { NOISE_SIZE, generateNoiseVolume } from "./noise3d";
import { selectSlabs, type ProfilePoint } from "./slabs";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";

/**
 * Vertical spacing between slices.
 *
 * The trade is straightforward: closer spacing looks more like a volume and
 * costs a full screen of shading per slice. 110m is about where the banding
 * stops being visible against a 1000m-deep deck.
 */
const SLICE_SPACING_M = 110;

/** Ceiling on slices, and therefore on overdraw. Lowered on small screens. */
const MAX_SLICES = 22;

/**
 * Extinction per metre at full density.
 *
 * Beer-Lambert, so a 1000m column of solid cloud transmits exp(-2.1) - about
 * 12%. Physically a real stratocumulus deck is far more opaque than that, but
 * a deck that blacks the island out is a picture of nothing: this is the point
 * where you can still read the terrain through a full overcast and still see
 * at a glance that it is a full overcast.
 */
const EXTINCTION_PER_M = 0.0021;

/** Horizontal distance over which the noise volume repeats. */
const CLOUD_SCALE_M = 34000;

/** Vertical distance over which it repeats. Shorter: cloud is layered. */
const CLOUD_VERTICAL_SCALE_M = 5200;

/** How far each shadow tap reaches towards the sun. */
const LIGHT_STEP_M = 420;

const VERTEX_SOURCE = `#version 300 es
in vec2 a_mercator;
in float a_altitude;
in float a_altitude_m;
in float a_coverage;
in float a_level;
uniform mat4 u_matrix;
uniform float u_world_size;
uniform vec2 u_centre;
out float v_coverage;
out float v_level;
out float v_altitude_m;
out vec2 v_world;
out vec2 v_mercator;

void main() {
  // World pixels in x and y, metres in z: the matrix MapLibre hands a custom
  // layer is the transform's _viewProjMatrix, not the 0..1 mercator matrix the
  // v4 docs still describe. Getting this wrong is silent - the geometry
  // projects to a point behind the far plane and simply never appears.
  gl_Position = u_matrix * vec4(a_mercator * u_world_size, a_altitude, 1.0);
  v_coverage = a_coverage;
  v_level = a_level;
  v_altitude_m = a_altitude_m;
  // Relative to the island rather than to the antimeridian: absolute mercator
  // values are ~0.45 and the fine detail vanishes into float precision.
  v_world = a_mercator - u_centre;
  // Absolute, for the forecast field: that lookup is in the grid's own frame,
  // not relative to whatever the camera is centred on.
  v_mercator = a_mercator;
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
precision highp sampler3D;

in float v_coverage;
in float v_level;
in float v_altitude_m;
in vec2 v_world;
in vec2 v_mercator;

uniform sampler3D u_noise;
// The forecast volume: cloud fraction per cell, cols x rows x altitudes for
// the hour being shown. u_field_mix is 0 when there is none, and the coverage
// then comes from the per-spot profile the slices were built from.
uniform sampler3D u_field;
uniform float u_field_mix;
uniform vec2 u_field_origin;
uniform vec2 u_field_span;
uniform vec2 u_field_altitude;
uniform vec3 u_field_dims;
uniform float u_time;
uniform vec2 u_extent;
uniform float u_metres_per_mercator;
uniform float u_slice_m;
uniform vec3 u_sun;
uniform vec3 u_sun_colour;
uniform vec3 u_sky_colour;

out vec4 fragColor;

const float EXTINCTION_PER_M = ${EXTINCTION_PER_M};
const float CLOUD_SCALE_M = ${CLOUD_SCALE_M}.0;
const float CLOUD_VERTICAL_SCALE_M = ${CLOUD_VERTICAL_SCALE_M}.0;
const float LIGHT_STEP_M = ${LIGHT_STEP_M}.0;

/** Sample point in the noise volume for a position in metres. */
vec3 volumePoint(vec2 metres, float altitude) {
  return vec3(metres / CLOUD_SCALE_M, altitude / CLOUD_VERTICAL_SCALE_M);
}

/**
 * Cloud density at a point, 0..1.
 *
 * Coverage sets the threshold the shape band has to clear, so a 30% hour
 * leaves scattered clumps and a 95% hour closes over. The detail band only
 * erodes what the shape band already allowed - adding it instead would give
 * the cloud two competing silhouettes and read as noise.
 */
float density(vec3 point, float coverage, float erosion) {
  float shape = texture(u_noise, point).r;
  // A fixed-width ramp above the threshold rather than a division by coverage.
  // Dividing spreads the transition over the whole remaining range, so a 90%
  // hour came out as a single flat value everywhere and the cloud lost its
  // shape exactly when there was most of it to look at. A narrow ramp keeps an
  // edge at every coverage - the edge just has less to enclose.
  float threshold = 1.0 - coverage;
  float body = smoothstep(threshold, threshold + 0.26, shape);
  if (body <= 0.0) return 0.0;
  float detail = texture(u_noise, point * 3.1 + vec3(0.37, 0.11, 0.53)).g;
  return body * mix(1.0, detail * 1.35, erosion);
}

/**
 * Coverage at this fragment: from the forecast volume where there is one.
 *
 * The grid's samples sit on the *edges* of the box, not in the middles of its
 * cells, so the lookup is offset by half a texel - without that the whole
 * field is dragged half a cell north-west, which on a 10x8 grid over Madeira
 * is about four kilometres.
 */
float coverageHere() {
  if (u_field_mix <= 0.0) return v_coverage;
  vec3 fraction = vec3(
    (v_mercator - u_field_origin) / u_field_span,
    (v_altitude_m - u_field_altitude.x) / u_field_altitude.y
  );
  vec3 texel = (clamp(fraction, 0.0, 1.0) * (u_field_dims - 1.0) + 0.5) /
    u_field_dims;
  return mix(v_coverage, texture(u_field, texel).r, u_field_mix);
}

void main() {
  // Metres from the island centre. Wind drift is applied to the sample point
  // rather than to the geometry: the slices stay put and the weather moves
  // through them.
  vec2 metres = v_world * u_metres_per_mercator;
  // Shear - the top of a deck runs ahead of its base - is the cheapest cue
  // that this is a body of air and not a model of one.
  float shear = 1.0 + 0.5 * v_level;
  vec2 drift = vec2(u_time * 5.5, u_time * 2.0) * shear;
  vec3 point = volumePoint(metres + drift, v_altitude_m);

  // Where one noise cell no longer covers a pixel the detail band is pure
  // aliasing, so it fades out with distance and the cloud goes smooth.
  vec2 footprint = fwidth(point.xy);
  float erosion = 0.7 * (1.0 - smoothstep(0.02, 0.09, footprint.x + footprint.y));

  // Radial, not rectangular. A box fade puts a straight edge across open water
  // wherever the deck's bounds fall inside the frame, which reads as a sheet
  // of something lying on the sea.
  float reach = length(v_world / u_extent);
  float edge = 1.0 - smoothstep(0.62, 1.0, reach);
  if (edge <= 0.0) discard;

  float coverage = coverageHere();
  float d = density(point, coverage, erosion) * edge;
  // Thin haze from twenty slices at once is what turns a cloud into a fog
  // filter over the whole frame. Below this a slice contributes nothing worth
  // the fill rate.
  if (d <= 0.05) discard;

  // Self-shadowing: march a short way towards the sun and see how much cloud
  // is in the way. Three taps is enough to give the tops relief and keep the
  // undersides dark, which is the difference between a volume and a stack of
  // translucent sheets.
  float shadow = 0.0;
  for (int step = 1; step <= 3; step++) {
    vec3 towards = point + u_sun * (LIGHT_STEP_M * float(step)) /
      vec3(CLOUD_SCALE_M, CLOUD_SCALE_M, CLOUD_VERTICAL_SCALE_M);
    shadow += density(towards, coverage, 0.0);
  }
  float sunlight = exp(-shadow * LIGHT_STEP_M * EXTINCTION_PER_M * 1.6);

  // Beer-Lambert through this slice's thickness, so a deeper deck is more
  // opaque than a shallow one without anything having to say so.
  float alpha = 1.0 - exp(-d * u_slice_m * EXTINCTION_PER_M);

  // Ambient from the sky above, direct light from the low sun, and a powder
  // term so thin edges glow the way backlit cloud does at sunrise.
  float powder = 1.0 - exp(-d * 4.0);
  // Weighted towards the direct term. Ambient-dominated cloud is grey soup;
  // what makes a deck read at sunrise is bright tops against dark undersides,
  // which is the sunlight term doing the work and the sky only filling in.
  vec3 colour = u_sky_colour * (0.30 + 0.42 * v_level);
  colour += u_sun_colour * sunlight * (0.30 + 0.70 * powder) * (0.45 + 0.75 * v_level);

  fragColor = vec4(colour * alpha, alpha); // premultiplied, as MapLibre expects
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
    throw new Error(`cloud deck shader failed to compile: ${log}`);
  }
  return shader;
}

export type { ProfilePoint };

export type CloudDeckOptions = {
  /** Lng/lat box the deck covers: [west, south, east, north]. */
  bounds: [number, number, number, number];
  /**
   * Terrain exaggeration in force on the map.
   *
   * Not cosmetic. The terrain mesh is drawn at elevation x exaggeration, so a
   * deck drawn at its true altitude would sit too low against an exaggerated
   * summit and the picture would contradict the number it is illustrating.
   */
  exaggeration: number;
  /** False under prefers-reduced-motion: the deck is then still. */
  animate: boolean;
  /** Overdraw budget. Lower on phones, where fill rate is the constraint. */
  maxSlices?: number;
};

/** Until told otherwise: low, and in the east, which is the default framing. */
const DEFAULT_SUN: [number, number, number] = [0.94, -0.12, 0.32];

type Slice = { altitude: number; coverage: number; level: number };

/**
 * One hour of the forecast volume, in the frame the shader samples it in.
 *
 * Mercator rather than lng/lat: the fragment already has a mercator position
 * and converting back to latitude per pixel costs an exp() and a log() for a
 * lookup into a ten-cell-wide texture.
 */
export type FieldFrame = {
  origin: [number, number];
  span: [number, number];
  altitudeBaseM: number;
  altitudeSpanM: number;
  cols: number;
  rows: number;
  levels: number;
  /** cols x rows x levels bytes, x fastest - as texImage3D wants it. */
  values: Uint8Array;
};

/**
 * Turn one hour of a decoded cloud grid into a frame the layer can upload.
 *
 * The blob is already laid out [altitude][row][col] within an hour, and row 0
 * is the north edge, which is also the low-mercator-y edge - so the bytes go
 * to the GPU untouched and only the box they cover has to be described.
 */
export function fieldFrame(
  bbox: [number, number, number, number],
  altitudesM: number[],
  cols: number,
  rows: number,
  values: Uint8Array
): FieldFrame | null {
  if (altitudesM.length < 2 || values.length !== cols * rows * altitudesM.length) {
    return null;
  }
  const [west, south, east, north] = bbox;
  const nw = MercatorCoordinate.fromLngLat([west, north]);
  const se = MercatorCoordinate.fromLngLat([east, south]);
  return {
    origin: [nw.x, nw.y],
    span: [se.x - nw.x, se.y - nw.y],
    altitudeBaseM: altitudesM[0],
    altitudeSpanM: altitudesM[altitudesM.length - 1] - altitudesM[0],
    cols,
    rows,
    levels: altitudesM.length,
    values,
  };
}

export class CloudDeckLayer implements CustomLayerInterface {
  readonly id = "cloud-deck";
  readonly type = "custom";
  readonly renderingMode = "3d";

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private indices: WebGLBuffer | null = null;
  private noise: WebGLTexture | null = null;
  private field: WebGLTexture | null = null;
  private fieldFrame: FieldFrame | null = null;
  private mercatorLocation = -1;
  private altitudeLocation = -1;
  private altitudeMetresLocation = -1;
  private coverageLocation = -1;
  private levelLocation = -1;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private drawn: Slice[] = [];
  private sliceSpacing = SLICE_SPACING_M;
  private profile: ProfilePoint[] = [];
  private started = performance.now();
  private visible = true;
  /**
   * Direction to the sun in the volume's own frame: x east, y *south* (the
   * mercator convention), z up. Replaced by the real solar position as soon
   * as the map knows what time it is showing.
   */
  private sun: [number, number, number] = DEFAULT_SUN;
  private sunElevation = 5;

  constructor(private options: CloudDeckOptions) {}

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;

    const program = gl.createProgram();
    if (!program) throw new Error("could not create cloud deck program");
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(
        `cloud deck program failed to link: ${gl.getProgramInfoLog(program)}`
      );
    }

    this.program = program;
    this.mercatorLocation = gl.getAttribLocation(program, "a_mercator");
    this.altitudeLocation = gl.getAttribLocation(program, "a_altitude");
    this.altitudeMetresLocation = gl.getAttribLocation(program, "a_altitude_m");
    this.coverageLocation = gl.getAttribLocation(program, "a_coverage");
    this.levelLocation = gl.getAttribLocation(program, "a_level");
    for (const name of [
      "u_matrix",
      "u_time",
      "u_world_size",
      "u_centre",
      "u_extent",
      "u_metres_per_mercator",
      "u_slice_m",
      "u_sun",
      "u_sun_colour",
      "u_sky_colour",
      "u_noise",
      "u_field",
      "u_field_mix",
      "u_field_origin",
      "u_field_span",
      "u_field_altitude",
      "u_field_dims",
    ]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }

    this.noise = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.noise);
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RGBA8,
      NOISE_SIZE,
      NOISE_SIZE,
      NOISE_SIZE,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      generateNoiseVolume()
    );
    // REPEAT on all three axes is what makes the tileable generation worth
    // doing: the volume is sampled far outside 0..1 in every direction.
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);

    // A 1x1x1 clear cell until a forecast volume arrives. A sampler with no
    // texture bound is undefined behaviour, and on some drivers it is black
    // cloud rather than nothing.
    this.field = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.field);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(
      gl.TEXTURE_3D, 0, gl.R8, 1, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE,
      new Uint8Array([0])
    );
    for (const axis of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) {
      gl.texParameteri(gl.TEXTURE_3D, axis, gl.CLAMP_TO_EDGE);
    }
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (this.fieldFrame) this.uploadField(this.fieldFrame);

    this.buffer = gl.createBuffer();
    this.indices = gl.createBuffer();
    this.upload();
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    if (this.program) gl.deleteProgram(this.program);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.indices) gl.deleteBuffer(this.indices);
    if (this.noise) gl.deleteTexture(this.noise);
    if (this.field) gl.deleteTexture(this.field);
    this.program = null;
    this.buffer = null;
    this.indices = null;
    this.noise = null;
    this.field = null;
    this.gl = null;
    this.map = null;
  }

  /** How many slices the last upload produced. Read by the e2e suite. */
  get slabCount(): number {
    return this.drawn.length;
  }

  /** Swap in another day or another viewpoint's profile. */
  setProfile(profile: ProfilePoint[]): void {
    this.profile = profile;
    this.upload();
    this.map?.triggerRepaint();
  }

  /**
   * Swap in the hour of forecast volume being shown, or null to fall back to
   * the profile the slices were built from.
   *
   * Cheap by design: the scrubber calls this on every step, and one hour of
   * the grid is a few hundred kilobytes of texture upload, not a rebuild of
   * the geometry.
   */
  setField(frame: FieldFrame | null): void {
    this.fieldFrame = frame;
    if (frame) this.uploadField(frame);
    this.map?.triggerRepaint();
  }

  private uploadField(frame: FieldFrame): void {
    const gl = this.gl;
    if (!gl || !this.field) return;
    gl.bindTexture(gl.TEXTURE_3D, this.field);
    // Rows are ten bytes wide, so the default four-byte row alignment would
    // shear the field diagonally - the classic non-power-of-two upload bug.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.R8,
      frame.cols,
      frame.rows,
      frame.levels,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      frame.values
    );
  }

  /**
   * Hide without removing.
   *
   * MapLibre's `visibility` layout property does not reach custom layers, and
   * removing this one would throw away the noise texture and the buffers - a
   * visible stall every time the toggle is flipped.
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.map?.triggerRepaint();
  }

  /** Takes the map-frame vector from lib/sun: east, north, up. */
  setSun(vector: [number, number, number], elevationDegrees: number): void {
    const [east, north, up] = vector;
    this.sun = [east, -north, up];
    this.sunElevation = elevationDegrees;
    this.map?.triggerRepaint();
  }

  setAnimate(animate: boolean): void {
    this.options = { ...this.options, animate };
    this.map?.triggerRepaint();
  }

  /**
   * Resample the forecast profile onto evenly spaced slices.
   *
   * The profile arrives at whatever altitudes the pressure levels landed on,
   * which is neither even nor fine enough to slice a volume with. Interpolating
   * onto a regular ladder keeps every slice the same thickness, which is what
   * lets one extinction constant describe all of them.
   */
  private buildSlices(): Slice[] {
    // Step 0: keep every sample above the haze threshold rather than thinning
    // to one every 200m. The ladder below decides the spacing now.
    const drawable = selectSlabs(this.profile, 0);
    if (drawable.length === 0) return [];

    const base = drawable[0][0];
    const top = drawable[drawable.length - 1][0];
    const depth = Math.max(top - base, SLICE_SPACING_M);
    const budget = this.options.maxSlices ?? MAX_SLICES;
    const count = Math.min(
      budget,
      Math.max(3, Math.round(depth / SLICE_SPACING_M) + 1)
    );
    this.sliceSpacing = depth / Math.max(count - 1, 1);

    const sorted = [...this.profile].sort((a, b) => a[0] - b[0]);
    const slices: Slice[] = [];
    for (let index = 0; index < count; index++) {
      const altitude = base + (depth * index) / Math.max(count - 1, 1);
      slices.push({
        altitude,
        coverage: coverageAt(sorted, altitude),
        level: count > 1 ? index / (count - 1) : 1,
      });
    }
    return slices;
  }

  private upload(): void {
    const gl = this.gl;
    if (!gl || !this.buffer || !this.indices) return;

    const [west, south, east, north] = this.options.bounds;
    const slices = this.buildSlices();
    const vertices: number[] = [];
    const elements: number[] = [];

    slices.forEach(({ altitude, coverage, level }, slice) => {
      const height = altitude * this.options.exaggeration;
      for (const [lng, lat] of [
        [west, north],
        [east, north],
        [east, south],
        [west, south],
      ]) {
        const point = MercatorCoordinate.fromLngLat([lng, lat]);
        vertices.push(point.x, point.y, height, altitude, coverage, level);
      }
      const first = slice * 4;
      elements.push(first, first + 1, first + 2, first, first + 2, first + 3);
    });

    this.drawn = slices;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices);
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      new Uint16Array(elements),
      gl.STATIC_DRAW
    );
  }

  /**
   * True when the camera is under the deck, in which case the slices have to
   * be drawn top down rather than bottom up.
   *
   * Translucent geometry only composites correctly back to front, and which
   * end is the back depends on which side of the deck the eye is on. Standing
   * under an overcast looking up is exactly the case this product exists for,
   * so it is not a corner worth cutting.
   */
  private drawTopDown(): boolean {
    const map = this.map;
    if (!map || this.drawn.length === 0) return false;
    const camera = cameraState(map);
    if (!camera) return false;
    const middle =
      (this.drawn[0].altitude + this.drawn[this.drawn.length - 1].altitude) / 2;
    return camera.altitude < middle * this.options.exaggeration;
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    if (!this.visible || !this.program || this.drawn.length === 0) return;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(
      this.uniforms.u_matrix,
      false,
      args.modelViewProjectionMatrix as Float32Array
    );
    gl.uniform1f(
      this.uniforms.u_time,
      this.options.animate ? (performance.now() - this.started) / 1000 : 0
    );

    // worldSize as MapLibre defines it: the 512px tile grid at the current
    // zoom. Read from the public API rather than reaching into transform.
    const zoom = this.map?.getZoom() ?? 0;
    gl.uniform1f(this.uniforms.u_world_size, 512 * Math.pow(2, zoom));

    const [west, south, east, north] = this.options.bounds;
    const nw = MercatorCoordinate.fromLngLat([west, north]);
    const se = MercatorCoordinate.fromLngLat([east, south]);
    const centre = MercatorCoordinate.fromLngLat([
      (west + east) / 2,
      (south + north) / 2,
    ]);
    gl.uniform2f(this.uniforms.u_centre, (nw.x + se.x) / 2, (nw.y + se.y) / 2);
    gl.uniform2f(
      this.uniforms.u_extent,
      Math.abs(se.x - nw.x) / 2,
      Math.abs(se.y - nw.y) / 2
    );
    // One mercator unit in metres at this latitude. Without it the noise is
    // sampled in mercator units and cloud cells silently change size with
    // latitude.
    gl.uniform1f(
      this.uniforms.u_metres_per_mercator,
      1 / centre.meterInMercatorCoordinateUnits()
    );
    gl.uniform1f(this.uniforms.u_slice_m, this.sliceSpacing);
    gl.uniform3f(this.uniforms.u_sun, ...this.sun);
    // Direct light warms and reddens as the sun approaches the horizon - the
    // same reason a sunrise is orange - and goes out below it, leaving only
    // the sky term. Interpolated rather than switched so scrubbing through
    // dawn is continuous.
    // Reaches full strength as the sun touches the horizon rather than well
    // after it: the lit tops of a deck at sunrise are the brightest thing in
    // the frame, and ramping this to noon instead made dawn look like dusk.
    const daylight = Math.min(1, Math.max(0, (this.sunElevation + 7) / 8));
    const horizon = 1 - Math.min(1, Math.max(0, this.sunElevation / 18));
    const strength = daylight * 1.35;
    gl.uniform3f(
      this.uniforms.u_sun_colour,
      strength,
      strength * (0.95 - 0.2 * horizon),
      strength * (0.9 - 0.36 * horizon)
    );
    // Sky fill: the blue the cloud's shadowed side picks up from above. Dim
    // and cold at night, brighter and neutral once the sun is properly up.
    const ambient = 0.22 + 0.5 * daylight;
    gl.uniform3f(
      this.uniforms.u_sky_colour,
      ambient * 0.62,
      ambient * 0.78,
      ambient
    );

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.noise);
    gl.uniform1i(this.uniforms.u_noise, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.field);
    gl.uniform1i(this.uniforms.u_field, 1);
    const frame = this.fieldFrame;
    gl.uniform1f(this.uniforms.u_field_mix, frame ? 1 : 0);
    if (frame) {
      gl.uniform2f(this.uniforms.u_field_origin, frame.origin[0], frame.origin[1]);
      gl.uniform2f(this.uniforms.u_field_span, frame.span[0], frame.span[1]);
      gl.uniform2f(
        this.uniforms.u_field_altitude,
        frame.altitudeBaseM,
        frame.altitudeSpanM
      );
      gl.uniform3f(
        this.uniforms.u_field_dims,
        frame.cols,
        frame.rows,
        frame.levels
      );
    }
    gl.activeTexture(gl.TEXTURE0);

    // Six floats per vertex: mercator xy, drawn height, true altitude,
    // coverage, level.
    const stride = 24;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.mercatorLocation);
    gl.vertexAttribPointer(this.mercatorLocation, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.altitudeLocation);
    gl.vertexAttribPointer(this.altitudeLocation, 1, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(this.altitudeMetresLocation);
    gl.vertexAttribPointer(this.altitudeMetresLocation, 1, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(this.coverageLocation);
    gl.vertexAttribPointer(this.coverageLocation, 1, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(this.levelLocation);
    gl.vertexAttribPointer(this.levelLocation, 1, gl.FLOAT, false, stride, 20);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices);

    // Test against the depth buffer so terrain occludes the cloud, but do not
    // write to it: the slices are translucent and must blend with each other
    // rather than the nearest one hiding the rest.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);

    // One draw per slice, ordered back to front. Twenty-odd draw calls is
    // nothing next to the fill cost, and it is the only way to get the order
    // right from both above and below the deck.
    const topDown = this.drawTopDown();
    for (let index = 0; index < this.drawn.length; index++) {
      const slice = topDown ? this.drawn.length - 1 - index : index;
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, slice * 6 * 2);
    }

    gl.depthMask(true);

    if (this.options.animate) this.map?.triggerRepaint();
  }
}

/** Linear interpolation of the forecast profile at one altitude. */
export function coverageAt(sorted: ProfilePoint[], altitude: number): number {
  if (sorted.length === 0) return 0;
  if (altitude <= sorted[0][0]) return sorted[0][1];
  const last = sorted[sorted.length - 1];
  if (altitude >= last[0]) return last[1];
  for (let index = 1; index < sorted.length; index++) {
    const [high, highValue] = sorted[index];
    if (high < altitude) continue;
    const [low, lowValue] = sorted[index - 1];
    const span = high - low;
    if (span <= 0) return highValue;
    return lowValue + ((highValue - lowValue) * (altitude - low)) / span;
  }
  return last[1];
}
