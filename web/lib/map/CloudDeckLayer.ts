/**
 * The cloud deck, drawn as translucent quads at their true altitude.
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
 *   these quads for free. Peaks piercing the deck is then geometrically true
 *   rather than an effect drawn to look true.
 */

import { MercatorCoordinate } from "maplibre-gl";
import { MAX_SLAB_OPACITY, selectSlabs, type ProfilePoint } from "./slabs";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";

const VERTEX_SOURCE = `#version 300 es
in vec2 a_mercator;
in float a_altitude;
in float a_alpha;
uniform mat4 u_matrix;
uniform float u_world_size;
uniform vec2 u_centre;
out float v_alpha;
out vec2 v_world;

void main() {
  gl_Position = u_matrix * vec4(a_mercator * u_world_size, a_altitude, 1.0);
  v_alpha = a_alpha;
  // Relative to the island, not to the antimeridian: absolute mercator values
  // are ~0.45, and the noise hash multiplies its input by 43758 before sin(),
  // which at that magnitude loses all precision and returns a constant.
  v_world = a_mercator - u_centre;
}`;

// Value-noise fbm, three octaves. A flat slab of uniform alpha reads as a
// sheet of plastic; real stratocumulus is lumpy and has holes, and the holes
// are what make the terrain underneath legible.
const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in float v_alpha;
in vec2 v_world;
uniform float u_time;
uniform vec2 u_extent;
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

float fbm(vec2 p) {
  float total = 0.0;
  float amplitude = 0.5;
  for (int octave = 0; octave < 3; octave++) {
    total += amplitude * noise(p);
    p *= 2.0;
    amplitude *= 0.5;
  }
  return total;
}

void main() {
  // Mercator units span 0..1 across the whole world, so Madeira occupies about
  // 0.004 of it. Scaling up is what turns that into cloud-sized features.
  // ~4km cells. Finer than this and the pattern is smaller than a few pixels
  // when the whole island is in frame, where five stacked slabs at different
  // parallax turn it into crawling static rather than cloud.
  vec2 p = v_world * 9000.0 + vec2(u_time * 0.00006, u_time * 0.00004);
  float n = fbm(p);

  // Zoomed out, one noise cell covers less than a pixel and the deck turns
  // into crawling static. Where the pattern can no longer be resolved, fade it
  // towards its own mean so the deck reads as smooth overcast instead.
  float footprint = fwidth(p.x) + fwidth(p.y);
  n = mix(n, 0.45, smoothstep(0.25, 0.9, footprint));
  // The deck is a local weather feature, not a global one. Without this fade
  // the quads run to the horizon and, seen almost edge-on from a summit, turn
  // the whole frame to milk. It must be computed per fragment: the quad's four
  // corners all sit exactly on the boundary, so a vertex-interpolated fade is
  // zero everywhere.
  vec2 offset = abs(v_world) / u_extent;
  float edge = 1.0 - smoothstep(0.55, 1.0, max(offset.x, offset.y));
  float alpha = v_alpha * edge * smoothstep(0.22, 0.80, n);
  if (alpha <= 0.004) discard;

  // Cool in the body, warm where it thins - the deck catches the sunrise from
  // the east before anything below it does.
  vec3 colour = mix(vec3(0.66, 0.72, 0.84), vec3(1.0, 0.93, 0.84), n);
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
};

export class CloudDeckLayer implements CustomLayerInterface {
  readonly id = "cloud-deck";
  readonly type = "custom";
  readonly renderingMode = "3d";

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private indices: WebGLBuffer | null = null;
  private mercatorLocation = -1;
  private altitudeLocation = -1;
  private alphaLocation = -1;
  private matrixLocation: WebGLUniformLocation | null = null;
  private timeLocation: WebGLUniformLocation | null = null;
  private worldSizeLocation: WebGLUniformLocation | null = null;
  private centreLocation: WebGLUniformLocation | null = null;
  private extentLocation: WebGLUniformLocation | null = null;
  private indexCount = 0;
  private profile: ProfilePoint[] = [];
  private started = performance.now();

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
    this.alphaLocation = gl.getAttribLocation(program, "a_alpha");
    this.matrixLocation = gl.getUniformLocation(program, "u_matrix");
    this.timeLocation = gl.getUniformLocation(program, "u_time");
    this.worldSizeLocation = gl.getUniformLocation(program, "u_world_size");
    this.centreLocation = gl.getUniformLocation(program, "u_centre");
    this.extentLocation = gl.getUniformLocation(program, "u_extent");
    this.buffer = gl.createBuffer();
    this.indices = gl.createBuffer();
    this.upload();
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    if (this.program) gl.deleteProgram(this.program);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.indices) gl.deleteBuffer(this.indices);
    this.program = null;
    this.buffer = null;
    this.indices = null;
    this.gl = null;
    this.map = null;
  }

  /** How many slabs the last upload produced. Read by the e2e suite. */
  get slabCount(): number {
    return this.indexCount / 6;
  }

  /** Swap in another day or another viewpoint's profile. */
  setProfile(profile: ProfilePoint[]): void {
    this.profile = profile;
    this.upload();
    this.map?.triggerRepaint();
  }

  setAnimate(animate: boolean): void {
    this.options = { ...this.options, animate };
    this.map?.triggerRepaint();
  }

  private upload(): void {
    const gl = this.gl;
    if (!gl || !this.buffer || !this.indices) return;

    const [west, south, east, north] = this.options.bounds;
    const slabs = selectSlabs(this.profile);
    const vertices: number[] = [];
    const elements: number[] = [];

    slabs.forEach(([altitude, fraction], slab) => {
      const height = altitude * this.options.exaggeration;
      const alpha = Math.min(MAX_SLAB_OPACITY, fraction * MAX_SLAB_OPACITY);
      for (const [lng, lat] of [
        [west, north],
        [east, north],
        [east, south],
        [west, south],
      ]) {
        const point = MercatorCoordinate.fromLngLat([lng, lat]);
        vertices.push(point.x, point.y, height, alpha);
      }
      const base = slab * 4;
      elements.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });

    this.indexCount = elements.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices);
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      new Uint16Array(elements),
      gl.STATIC_DRAW
    );
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    if (!this.program || !this.indexCount) return;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(
      this.matrixLocation,
      false,
      args.modelViewProjectionMatrix as Float32Array
    );
    gl.uniform1f(
      this.timeLocation,
      this.options.animate ? (performance.now() - this.started) / 1000 : 0
    );
    // worldSize as MapLibre defines it: the 512px tile grid at the current
    // zoom. Read from the public API rather than reaching into transform.
    const zoom = this.map?.getZoom() ?? 0;
    gl.uniform1f(this.worldSizeLocation, 512 * Math.pow(2, zoom));

    const [west, south, east, north] = this.options.bounds;
    const nw = MercatorCoordinate.fromLngLat([west, north]);
    const se = MercatorCoordinate.fromLngLat([east, south]);
    gl.uniform2f(this.centreLocation, (nw.x + se.x) / 2, (nw.y + se.y) / 2);
    gl.uniform2f(
      this.extentLocation,
      Math.abs(se.x - nw.x) / 2,
      Math.abs(se.y - nw.y) / 2
    );

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.mercatorLocation);
    gl.vertexAttribPointer(this.mercatorLocation, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.altitudeLocation);
    gl.vertexAttribPointer(this.altitudeLocation, 1, gl.FLOAT, false, 16, 8);
    gl.enableVertexAttribArray(this.alphaLocation);
    gl.vertexAttribPointer(this.alphaLocation, 1, gl.FLOAT, false, 16, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices);

    // Test against the depth buffer so terrain occludes the deck, but do not
    // write to it: the slabs are translucent and must blend with each other
    // rather than the nearest one hiding the rest.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);

    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);

    gl.depthMask(true);

    if (this.options.animate) this.map?.triggerRepaint();
  }
}
