/**
 * The sky, drawn per pixel from the direction each pixel is looking.
 *
 * MapLibre's own `sky` is axisymmetric: one horizon colour, applied evenly all
 * the way round the compass. A real dawn is not like that at all - the light
 * is concentrated in one direction and the rest of the horizon is still night,
 * and a ring of orange around the whole view is precisely what reads as
 * painted rather than lit.
 *
 * So: a full-screen quad, a view ray per pixel, and colour as a function of
 * two angles - how high the ray looks, and how far it is from the sun. Its
 * `fog-*` settings are still MapLibre's, because those haze the terrain and
 * this layer never touches terrain.
 *
 * The quad is drawn at the far plane with the depth test on. That way it fills
 * only pixels nothing else has claimed, whether MapLibre happens to draw this
 * layer before or after the terrain mesh - which is not a detail the custom
 * layer API guarantees.
 */

import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import type { SkyPalette } from "./lighting";

export const SKY_LAYER_ID = "sky-dome";

const VERTEX_SOURCE = `#version 300 es
in vec2 a_position;
out vec2 v_ndc;

void main() {
  v_ndc = a_position;
  // z = 1: the far plane. Everything real is in front of it, so the depth test
  // does the masking and this never paints over terrain.
  gl_Position = vec4(a_position, 1.0, 1.0);
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 v_ndc;

uniform vec3 u_forward;
uniform vec3 u_right;
uniform vec3 u_up;
uniform float u_tan_half_fov;
uniform float u_aspect;
uniform vec3 u_sun;
uniform float u_sun_elevation;
uniform vec3 u_zenith;
uniform vec3 u_horizon;
uniform vec3 u_horizon_away;
uniform vec3 u_sun_colour;

out vec4 fragColor;

void main() {
  // The direction this pixel is looking, in east/north/up.
  vec3 ray = normalize(
    u_forward +
    u_right * (v_ndc.x * u_tan_half_fov * u_aspect) +
    u_up * (v_ndc.y * u_tan_half_fov)
  );

  float height = ray.z;

  // The horizon colour is itself directional. This is the whole difference
  // between a sunrise and a stripe: at 06:40 the eastern horizon is on fire
  // and the western horizon is still night, and a single horizon colour
  // applied all the way round the compass - which is what MapLibre's own sky
  // does - can only ever draw the second half of that.
  vec2 rayGround = normalize(ray.xy + vec2(1e-6));
  vec2 sunGround = normalize(u_sun.xy + vec2(1e-6));
  float toward = dot(rayGround, sunGround);
  vec3 horizon = mix(u_horizon_away, u_horizon, smoothstep(-0.35, 0.95, toward));

  // Vertical gradient. Weighted towards the horizon - the interesting half of
  // a dawn sky happens in the first fifteen degrees, and a linear ramp spends
  // most of itself on empty zenith.
  float up = clamp(height, 0.0, 1.0);
  vec3 colour = mix(horizon, u_zenith, pow(up, 0.42));

  // The glow, and the only reason this layer exists: it is centred on the sun
  // and falls off with angle, so the east is alight while the west is still
  // night. Two lobes - a tight one for the flare near the sun and a wide one
  // for the general brightening of that quarter of the sky.
  float toSun = max(dot(ray, u_sun), 0.0);
  float tight = pow(toSun, 900.0);
  float wide = pow(toSun, 6.0);
  // Fades out as the sun sinks: at -10 degrees there is no glow left to see.
  float twilight = smoothstep(-10.0, 2.0, u_sun_elevation);
  colour += u_sun_colour * (wide * 0.30 + tight * 1.6) * twilight;

  // The sun itself, half a degree across, once it is actually up. Softened at
  // the limb because a hard-edged disc on a 1-pixel boundary aliases badly.
  if (u_sun_elevation > -0.4) {
    float disc = smoothstep(0.99987, 0.99996, toSun);
    colour += u_sun_colour * disc * 6.0;
  }

  // Below the horizon line the ray is looking at ground the terrain mesh does
  // not reach - open ocean past the DEM's edge. Darkening into the horizon
  // colour is what makes that read as distance rather than as a hole.
  float below = smoothstep(0.0, -0.06, height);
  colour = mix(colour, horizon * 0.45, below);

  fragColor = vec4(colour, 1.0);
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
    throw new Error(`sky shader failed to compile: ${log}`);
  }
  return shader;
}

const RAD = Math.PI / 180;

export class SkyLayer implements CustomLayerInterface {
  readonly id = SKY_LAYER_ID;
  readonly type = "custom";
  readonly renderingMode = "3d";

  private map: MapLibreMap | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private positionLocation = -1;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private sun: [number, number, number] = [1, 0, 0];
  private sunElevation = 0;
  private palette: SkyPalette | null = null;
  private visible = true;

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;

    const program = gl.createProgram();
    if (!program) throw new Error("could not create sky program");
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`sky program failed to link: ${gl.getProgramInfoLog(program)}`);
    }

    this.program = program;
    this.positionLocation = gl.getAttribLocation(program, "a_position");
    for (const name of [
      "u_forward",
      "u_right",
      "u_up",
      "u_tan_half_fov",
      "u_aspect",
      "u_sun",
      "u_sun_elevation",
      "u_zenith",
      "u_horizon",
      "u_horizon_away",
      "u_sun_colour",
    ]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }

    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    // Two triangles covering clip space.
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW
    );
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    if (this.program) gl.deleteProgram(this.program);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    this.program = null;
    this.buffer = null;
    this.map = null;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.map?.triggerRepaint();
  }

  /** Sun vector in east/north/up, its elevation in degrees, and the palette. */
  setSun(
    vector: [number, number, number],
    elevationDegrees: number,
    palette: SkyPalette
  ): void {
    this.sun = vector;
    this.sunElevation = elevationDegrees;
    this.palette = palette;
    this.map?.triggerRepaint();
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const map = this.map;
    if (!this.visible || !this.program || !map || !this.palette) return;

    // Camera basis in east/north/up. MapLibre's pitch is measured from
    // straight down, so pitch 0 looks at the ground and 90 at the horizon.
    const bearing = map.getBearing() * RAD;
    const pitch = map.getPitch() * RAD;
    const sinBearing = Math.sin(bearing);
    const cosBearing = Math.cos(bearing);
    const sinPitch = Math.sin(pitch);
    const cosPitch = Math.cos(pitch);

    const forward: [number, number, number] = [
      sinBearing * sinPitch,
      cosBearing * sinPitch,
      -cosPitch,
    ];
    const up: [number, number, number] = [
      sinBearing * cosPitch,
      cosBearing * cosPitch,
      sinPitch,
    ];
    const right: [number, number, number] = [cosBearing, -sinBearing, 0];

    gl.useProgram(this.program);
    gl.uniform3f(this.uniforms.u_forward, ...forward);
    gl.uniform3f(this.uniforms.u_right, ...right);
    gl.uniform3f(this.uniforms.u_up, ...up);
    gl.uniform1f(this.uniforms.u_tan_half_fov, Math.tan(args.fov / 2));
    gl.uniform1f(
      this.uniforms.u_aspect,
      gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight)
    );
    gl.uniform3f(this.uniforms.u_sun, ...this.sun);
    gl.uniform1f(this.uniforms.u_sun_elevation, this.sunElevation);
    gl.uniform3f(this.uniforms.u_zenith, ...this.palette.zenith);
    gl.uniform3f(this.uniforms.u_horizon, ...this.palette.horizon);
    // The horizon on the far side of the sky: the night the sunrise has not
    // reached yet. Pulled towards the zenith colour rather than being a colour
    // of its own, so the two ends of the gradient always belong together.
    const away = this.palette.zenith;
    const warm = this.palette.horizon;
    gl.uniform3f(
      this.uniforms.u_horizon_away,
      away[0] + (warm[0] - away[0]) * 0.22,
      away[1] + (warm[1] - away[1]) * 0.26,
      away[2] + (warm[2] - away[2]) * 0.4
    );
    gl.uniform3f(this.uniforms.u_sun_colour, ...this.palette.sun);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.positionLocation);
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
  }
}
