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
 * Far wider than the archipelago: this has to meet the horizon, not the edge
 * of the bounds, or its far edge shows up as a straight line in open water.
 */
const SEA_MARGIN_DEG = 12;

const VERTEX_SOURCE = `#version 300 es
in vec2 a_mercator;
uniform mat4 u_matrix;
uniform float u_world_size;
uniform vec2 u_centre;
out vec2 v_offset;

void main() {
  // World pixels in x/y and metres in z - see CloudDeckLayer for why.
  gl_Position = u_matrix * vec4(a_mercator * u_world_size, 0.0, 1.0);
  v_offset = a_mercator - u_centre;
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 v_offset;
uniform vec3 u_near_colour;
uniform vec3 u_far_colour;
out vec4 fragColor;

void main() {
  // Lighten with distance so the sea meets the sky instead of ending in a
  // hard band of flat colour.
  // Gentle: a steep ramp turns the far water into a bright sheet that reads as
  // a floating polygon rather than as distance.
  float distance = clamp(length(v_offset) * 12.0, 0.0, 1.0);
  fragColor = vec4(mix(u_near_colour, u_far_colour, distance), 1.0);
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
  private nearColourLocation: WebGLUniformLocation | null = null;
  private farColourLocation: WebGLUniformLocation | null = null;
  private centre: [number, number] = [0, 0];

  constructor(private centreLngLat: [number, number]) {}

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
    this.nearColourLocation = gl.getUniformLocation(program, "u_near_colour");
    this.farColourLocation = gl.getUniformLocation(program, "u_far_colour");

    const [lng, lat] = this.centreLngLat;
    const west = lng - SEA_MARGIN_DEG;
    const east = lng + SEA_MARGIN_DEG;
    // Mercator y is unbounded near the poles; this stays well inside it.
    const north = Math.min(80, lat + SEA_MARGIN_DEG);
    const south = Math.max(-80, lat - SEA_MARGIN_DEG);

    const corners: [number, number][] = [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ];
    const vertices: number[] = [];
    for (const index of [0, 1, 2, 0, 2, 3]) {
      const point = MercatorCoordinate.fromLngLat(corners[index]);
      vertices.push(point.x, point.y);
    }

    const centrePoint = MercatorCoordinate.fromLngLat(this.centreLngLat);
    this.centre = [centrePoint.x, centrePoint.y];

    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    if (this.program) gl.deleteProgram(this.program);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    this.program = null;
    this.buffer = null;
    this.map = null;
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    if (!this.program) return;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(
      this.matrixLocation,
      false,
      args.modelViewProjectionMatrix as Float32Array
    );
    gl.uniform1f(
      this.worldSizeLocation,
      512 * Math.pow(2, this.map?.getZoom() ?? 0)
    );
    gl.uniform2f(this.centreLocation, this.centre[0], this.centre[1]);
    gl.uniform3f(this.nearColourLocation, 0.031, 0.063, 0.11);
    // Meets the fog colour in style.ts, so the horizon is a transition rather
    // than a seam between two different surfaces.
    gl.uniform3f(this.farColourLocation, 0.07, 0.1, 0.16);

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

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.enable(gl.BLEND);
  }
}
