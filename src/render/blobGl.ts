import { PLAYER_COUNT, RIM_BALL_RADIUS, RIM_COUNT } from "../sim/sim";

/** Catmull-Rom samples per rim link; the shader SDFs this smooth curve, not the raw polygon. */
const CURVE_SUBDIVISIONS = 3;
const CURVE_POINTS = RIM_COUNT * CURVE_SUBDIVISIONS;
const COARSE_POINTS = RIM_COUNT / 2;

const VERTEX = /* glsl */ `#version 300 es
void main() {
  // Full-screen triangle, no buffers.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

#define N ${CURVE_POINTS}
#define NC ${COARSE_POINTS}
#define P ${PLAYER_COUNT}
const float RIM_R = ${RIM_BALL_RADIUS.toFixed(4)};

uniform vec2 uRim[N];
uniform vec2 uCoarse[NC];
uniform vec2 uCore;
uniform vec2 uLook;
uniform vec4 uBounds;      // world-space AABB of blob + glow margin
uniform float uWorldPerPx; // world units per device pixel
uniform float uWorldPerCss;
uniform vec2 uOffset;      // world position of fragment (0,0)
uniform vec4 uTether[P];   // hand.xy, body.xy
uniform float uTetherOn[P];
uniform vec3 uTetherColor[P];

out vec4 outColor;

const vec3 DEEP = vec3(0.07, 0.42, 0.22);
const vec3 BASE = vec3(0.30, 0.89, 0.54);
const vec3 LIGHT = vec3(0.78, 1.0, 0.86);
const vec3 OUTLINE = vec3(0.05, 0.36, 0.19);
const vec3 GLOW = vec3(0.30, 0.89, 0.54);

// Premultiplied "top over bottom".
vec4 over(vec4 top, vec4 bottom) { return top + bottom * (1.0 - top.a); }

// Width over which neighbouring segments' directions blend into the shading normal.
const float NORMAL_SMOOTH = 0.08;

// Signed distance to the rim curve polygon (Inigo Quilez's sdPolygon) plus a smooth outward normal.
// The exact gradient jumps wherever the nearest segment changes (radial facets) and flips
// across the polygon line itself, so the normal is a soft-min weighted blend of each
// segment's outward edge normal. Assumes counter-clockwise rim order, as the sim builds it.
vec3 sdPolygon(vec2 p) {
  float d = 1e20;
  float s = 1.0;
  float m = 1e20;
  vec2 acc = vec2(0.0);
  for (int i = 0, j = N - 1; i < N; j = i, i++) {
    vec2 e = uRim[j] - uRim[i];
    vec2 w = p - uRim[i];
    vec2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    float bl = length(b);
    d = min(d, bl);
    vec2 dir = normalize(vec2(-e.y, e.x));
    // Online log-sum-exp so weights never underflow.
    if (bl < m) {
      acc = acc * exp((bl - m) / NORMAL_SMOOTH) + dir;
      m = bl;
    } else {
      acc += exp((m - bl) / NORMAL_SMOOTH) * dir;
    }
    bvec3 c = bvec3(p.y >= uRim[i].y, p.y < uRim[j].y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  vec2 grad = acc / max(length(acc), 1e-6);
  return vec3(s * d, grad);
}

float coverage(float d, float aa) { return 1.0 - smoothstep(-aa, aa, d); }

// Signed distance to a coarse polygon (every other rim point). Its chords sit only a few cm
// inside the fine curve, which is plenty for the glow far from the skin.
float sdCoarse(vec2 p) {
  float d = 1e20;
  float s = 1.0;
  for (int i = 0, j = NC - 1; i < NC; j = i, i++) {
    vec2 e = uCoarse[j] - uCoarse[i];
    vec2 w = p - uCoarse[i];
    vec2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= uCoarse[i].y, p.y < uCoarse[j].y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  return s * sqrt(d);
}

// Gaussian shoulder plus a long exponential tail, like a wide blur of the silhouette.
float glowAlpha(float d) {
  float od = max(d, 0.0);
  return 0.2 * exp(-(od * od) / 0.35) + 0.08 * exp(-1.6 * od);
}

// Beyond this coarse distance outside the skin only the glow is visible.
const float COARSE_BAND = 0.25;

vec4 shadeBlob(vec2 p) {
  float dc = sdCoarse(p) - RIM_R;
  if (dc > COARSE_BAND) {
    float ga = glowAlpha(dc);
    return vec4(GLOW * ga, ga);
  }
  vec3 sd = sdPolygon(p);
  float d = sd.x - RIM_R;
  vec2 g = sd.yz;
  float aa = uWorldPerPx;

  // r: 0 at the core, 1 at the skin, whatever the current squish. Treat the body as a
  // sphere over that parameter so the shading gradient spans the whole blob.
  vec2 fromCore = p - uCore;
  float lc = length(fromCore);
  float r = clamp(lc / max(lc - d, 1e-4), 0.0, 1.0);
  vec2 dir = normalize(mix(fromCore / max(lc, 1e-4), g, r * r));
  vec3 n = normalize(vec3(dir * r, sqrt(max(1.0 - r * r, 0.0)) + 0.08));
  vec3 L = normalize(vec3(-0.45, 0.6, 0.75));
  float diff = clamp(dot(n, L), 0.0, 1.0);
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 10.0);
  vec3 albedo = mix(BASE, LIGHT, 0.55 * (1.0 - smoothstep(0.0, 0.8, r)));
  vec3 col = albedo * (0.3 + 0.8 * diff);
  col = mix(col, DEEP, smoothstep(0.6, 1.0, r) * (1.0 - diff) * 0.8);
  col += 0.28 * spec;
  float edge = 1.0 - smoothstep(0.0, 3.0 * aa, abs(d + 0.012) - 0.012);
  col = mix(col, OUTLINE, edge);

  float a = coverage(d, aa);
  vec4 body = vec4(col * a, a);
  float glowA = glowAlpha(d) * (1.0 - a);
  vec4 result = over(body, vec4(GLOW * glowA, glowA));

  // Eyes ride on the core.
  for (int k = 0; k < 2; k++) {
    float side = k == 0 ? -1.0 : 1.0;
    vec2 e = uCore + vec2(side * 0.32, 0.2);
    float white = coverage(length(p - e) - 0.18, aa);
    float pupil = coverage(length(p - e - uLook * 0.08) - 0.09, aa);
    result = over(vec4(vec3(white), white), result);
    result = over(vec4(vec3(0.08, 0.09, 0.12) * pupil, pupil), result);
  }
  return result;
}

vec4 shadeTether(vec2 p, int i) {
  vec2 a = uTether[i].xy;
  vec2 b = uTether[i].zw;
  vec2 ab = b - a;
  float len = max(length(ab), 1e-5);
  float h = clamp(dot(p - a, ab) / (len * len), 0.0, 1.0);
  float d = length(p - a - ab * h);
  float css = uWorldPerCss;
  float dash = step(fract(h * len / (11.0 * css)), 0.55);
  float line = coverage(d - 1.5 * css, uWorldPerPx) * dash;
  float dot_ = coverage(length(p - b) - 5.0 * css, uWorldPerPx);
  float alpha = max(line, dot_);
  return vec4(uTetherColor[i] * alpha, alpha);
}

void main() {
  vec2 p = gl_FragCoord.xy * uWorldPerPx + uOffset;
  vec4 col = vec4(0.0);
  if (p.x >= uBounds.x && p.y >= uBounds.y && p.x <= uBounds.z && p.y <= uBounds.w) {
    col = shadeBlob(p);
  }
  for (int i = 0; i < P; i++) {
    if (uTetherOn[i] > 0.5) col = over(shadeTether(p, i), col);
  }
  outColor = col;
}`;

export type BlobFrame = {
  rim: Float32Array; // x0,y0,x1,y1,... world
  core: { x: number; y: number };
  look: { x: number; y: number };
  tethers: ({ hx: number; hy: number; bx: number; by: number } | null)[];
};

export type View = {
  /** CSS px per world metre. */
  scale: number;
  ox: number;
  oy: number;
  worldH: number;
  dpr: number;
};

const GLOW_MARGIN = 2.2;

/** Draws the blob and grab tethers as signed distance fields in a single fragment pass. */
export class BlobGl {
  private gl: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private u!: Record<string, WebGLUniformLocation | null>;
  private readonly tetherColors: Float32Array;
  private readonly curve = new Float32Array(CURVE_POINTS * 2);
  private readonly coarse = new Float32Array(COARSE_POINTS * 2);

  constructor(
    private readonly canvas: HTMLCanvasElement,
    playerColors: readonly string[],
  ) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, desynchronized: true });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;
    this.tetherColors = new Float32Array(playerColors.flatMap(hexToRgb));
    this.init();
    canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
    canvas.addEventListener("webglcontextrestored", () => this.init());
  }

  private init(): void {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link error");
    this.program = program;
    const names = [
      "uRim", "uCoarse", "uCore", "uLook", "uBounds", "uWorldPerPx", "uWorldPerCss", "uOffset",
      "uTether", "uTetherOn", "uTetherColor",
    ];
    this.u = Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)]));
    gl.bindVertexArray(gl.createVertexArray());
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
  }

  draw(frame: BlobFrame, view: View): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    const { rim } = frame;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < rim.length; i += 2) {
      minX = Math.min(minX, rim[i]);
      maxX = Math.max(maxX, rim[i]);
      minY = Math.min(minY, rim[i + 1]);
      maxY = Math.max(maxY, rim[i + 1]);
    }
    const m = RIM_BALL_RADIUS + GLOW_MARGIN;

    const worldPerCss = 1 / view.scale;
    const worldPerPx = worldPerCss / view.dpr;
    const cssH = this.canvas.height / view.dpr;
    const tethers = new Float32Array(PLAYER_COUNT * 4);
    const on = new Float32Array(PLAYER_COUNT);
    frame.tethers.forEach((t, i) => {
      if (!t) return;
      tethers.set([t.hx, t.hy, t.bx, t.by], i * 4);
      on[i] = 1;
    });

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.uniform2fv(this.u.uRim, catmullRomClosed(rim, this.curve));
    for (let i = 0; i < COARSE_POINTS; i++) {
      this.coarse[i * 2] = rim[i * 4];
      this.coarse[i * 2 + 1] = rim[i * 4 + 1];
    }
    gl.uniform2fv(this.u.uCoarse, this.coarse);
    gl.uniform2f(this.u.uCore, frame.core.x, frame.core.y);
    gl.uniform2f(this.u.uLook, frame.look.x, frame.look.y);
    gl.uniform4f(this.u.uBounds, minX - m, minY - m, maxX + m, maxY + m);
    gl.uniform1f(this.u.uWorldPerPx, worldPerPx);
    gl.uniform1f(this.u.uWorldPerCss, worldPerCss);
    // Fragment (0,0) is the bottom-left device pixel; world y points up like GL.
    gl.uniform2f(this.u.uOffset, -view.ox * worldPerCss, view.worldH - (cssH - view.oy) * worldPerCss);
    gl.uniform4fv(this.u.uTether, tethers);
    gl.uniform1fv(this.u.uTetherOn, on);
    gl.uniform3fv(this.u.uTetherColor, this.tetherColors);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

/** Uniform Catmull-Rom through a closed loop of points, CURVE_SUBDIVISIONS samples per span. */
function catmullRomClosed(pts: Float32Array, out: Float32Array): Float32Array {
  const n = pts.length / 2;
  let o = 0;
  for (let i = 0; i < n; i++) {
    const i0 = ((i + n - 1) % n) * 2;
    const i1 = i * 2;
    const i2 = ((i + 1) % n) * 2;
    const i3 = ((i + 2) % n) * 2;
    for (let s = 0; s < CURVE_SUBDIVISIONS; s++) {
      const t = s / CURVE_SUBDIVISIONS;
      const t2 = t * t;
      const t3 = t2 * t;
      for (let k = 0; k < 2; k++) {
        const p0 = pts[i0 + k];
        const p1 = pts[i1 + k];
        const p2 = pts[i2 + k];
        const p3 = pts[i3 + k];
        out[o + k] =
          0.5 *
          (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3);
      }
      o += 2;
    }
  }
  return out;
}

function hexToRgb(hex: string): number[] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
