/**
 * An opaque sea surface at 0m.
 *
 * Terrarium is a bathymetric DEM: it carries the sea floor as well as the
 * land. Madeira is a volcano rising 4km off the abyssal plain, so without this
 * the island sits in a bowl of brown submarine mountains, the horizon fills
 * with seabed ridges, and every artefact in the bathymetry shows up as a spike
 * in open water.
 *
 * Clamping the DEM itself would mean decoding and re-encoding every tile on
 * the main thread. A flat opaque plane at sea level costs one quad, hides
 * everything below zero by depth alone, and has the useful side effect of
 * making the ocean read as ocean at dawn rather than as dark satellite pixels.
 */

import { MercatorCoordinate } from "maplibre-gl";
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

const VERTEX_SOURCE = `#version 300 es
in vec2 a_mercator;
uniform mat4 u_matrix;
uniform float u_world_size;
uniform vec2 u_centre;
uniform float u_sea_level;
out vec2 v_offset;

void main() {
  // World pixels in x/y and metres in z - see CloudDeckLayer for why.
  gl_Position = u_matrix * vec4(a_mercator * u_world_size, u_sea_level, 1.0);
  v_offset = a_mercator - u_centre;
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 v_offset;
uniform vec3 u_near_colour;
uniform vec3 u_far_colour;
uniform vec3 u_dawn_colour;
uniform float u_extent;
out vec4 fragColor;

void main() {
  // Lighten with distance so the sea meets the sky instead of ending in a
  // hard band of flat colour.
  // Gentle: a steep ramp turns the far water into a bright sheet that reads as
  // a floating polygon rather than as distance.
  float distance = clamp(length(v_offset) / u_extent, 0.0, 1.0);
  distance = distance * distance * (3.0 - 2.0 * distance);
  vec3 water = mix(u_near_colour, u_far_colour, distance);

  // The sun comes up over open water to the east, and at this hour the sea in
  // that direction is the brightest thing in the frame. Without it the ocean
  // is a flat dark rectangle and the whole scene reads as a map rather than a
  // morning.
  vec2 direction = normalize(v_offset + vec2(1e-6));
  float sunward = smoothstep(0.1, 1.0, direction.x) * distance;
  fragColor = vec4(mix(water, u_dawn_colour, sunward * 0.55), 1.0);
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
  private centreLocation: WebGLUniformLocation | null = null;
  private seaLevelLocation: WebGLUniformLocation | null = null;
  private nearColourLocation: WebGLUniformLocation | null = null;
  private farColourLocation: WebGLUniformLocation | null = null;
  private dawnColourLocation: WebGLUniformLocation | null = null;
  private extentLocation: WebGLUniformLocation | null = null;
  private centre: [number, number] = [0, 0];
  private extent = 0;
  private readonly vertices = new Float32Array(12);

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
    this.centreLocation = gl.getUniformLocation(program, "u_centre");
    this.seaLevelLocation = gl.getUniformLocation(program, "u_sea_level");
    this.nearColourLocation = gl.getUniformLocation(program, "u_near_colour");
    this.farColourLocation = gl.getUniformLocation(program, "u_far_colour");
    this.dawnColourLocation = gl.getUniformLocation(program, "u_dawn_colour");
    this.extentLocation = gl.getUniformLocation(program, "u_extent");

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
    if (!this.program) return;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(
      this.matrixLocation,
      false,
      args.modelViewProjectionMatrix as Float32Array
    );
    const worldSize = 512 * Math.pow(2, this.map?.getZoom() ?? 0);
    this.updateGeometry(gl, args.farZ, worldSize);
    gl.uniform1f(this.worldSizeLocation, worldSize);
    gl.uniform2f(this.centreLocation, this.centre[0], this.centre[1]);
    gl.uniform1f(this.seaLevelLocation, SEA_LEVEL_M);
    gl.uniform3f(this.nearColourLocation, 0.04, 0.07, 0.12);
    // Meets the fog colour in style.ts, so the horizon is a transition rather
    // than a seam between two different surfaces.
    // Light enough to read as water under a lit sky. Too dark and the top
    // half of the frame is a black slab with an island pasted on it.
    gl.uniform3f(this.farColourLocation, 0.19, 0.22, 0.29);
    gl.uniform3f(this.dawnColourLocation, 0.62, 0.42, 0.3);
    gl.uniform1f(this.extentLocation, this.extent);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.mercatorLocation);
    gl.vertexAttribPointer(this.mercatorLocation, 2, gl.FLOAT, false, 8, 0);

    // Opaque and depth-writing, unlike the cloud deck: the whole point is to
    // occlude the sea floor behind it.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.0, 1.0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.enable(gl.BLEND);
  }
}
