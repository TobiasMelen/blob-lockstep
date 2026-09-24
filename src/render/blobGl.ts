import { PLAYER_COUNT, RIM_BALL_RADIUS, RIM_COUNT } from "../sim/sim";

/** Catmull-Rom samples per rim link; the radius table is ray-cast against this smooth curve. */
const CURVE_SUBDIVISIONS = 3;
const CURVE_POINTS = RIM_COUNT * CURVE_SUBDIVISIONS;
/** Directions in the polar radius table; a multiple of 4 so it packs into vec4 uniforms. */
const ANGLES = 128;
const TAU = Math.PI * 2;
const RAY_COS = Float32Array.from({ length: ANGLES }, (_, k) => Math.cos((k / ANGLES) * TAU));
const RAY_SIN = Float32Array.from({ length: ANGLES }, (_, k) => Math.sin((k / ANGLES) * TAU));

const VERTEX = /* glsl */ `#version 300 es
void main() {
  // Full-screen triangle, no buffers.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

#define K ${ANGLES}
#define P ${PLAYER_COUNT}
const float RIM_R = ${RIM_BALL_RADIUS.toFixed(4)};
const float TAU = 6.28318531;

// Rim curve radius from uCenter at K evenly spaced angles from +x, CCW: the exact table,
// then a blurred copy for shading normals so dents don't crease the whole body.
uniform vec4 uRadius[K / 2];
uniform vec2 uCenter;
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

float radiusSample(int table, int i) {
  i = (i + K) % K + table * K;
  return uRadius[i >> 2][i & 3];
}

// Rim radius R and dR/dtheta at angle theta, Catmull-Rom through the table so the slope
// (and with it the normal) is continuous.
vec2 radiusAt(int table, float theta) {
  float x = theta * (float(K) / TAU);
  float fi = floor(x);
  float t = x - fi;
  int i = int(fi);
  float p0 = radiusSample(table, i - 1);
  float p1 = radiusSample(table, i);
  float p2 = radiusSample(table, i + 1);
  float p3 = radiusSample(table, i + 2);
  float b = p2 - p0;
  float c = 2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3;
  float d = 3.0 * p1 - p0 - 3.0 * p2 + p3;
  float r = p1 + 0.5 * t * (b + t * (c + t * d));
  float dr = 0.5 * (b + t * (2.0 * c + 3.0 * t * d));
  return vec2(r, dr * (float(K) / TAU));
}

// Gradient of f = rho - R(theta) in world space.
vec2 radialGradient(vec2 er, float rho, float dr) {
  return er - (dr / max(rho, 0.2)) * vec2(-er.y, er.x);
}

// Distance to the rim curve treating the blob as star-shaped around uCenter: f = rho - R(theta).
// Dividing by |grad f| turns the radial gap into a close approximation of the true distance.
// Returns (distance, smoothed outward normal, smoothed R) — the smoothed parts drive shading only.
vec4 sdBlobCurve(vec2 p) {
  vec2 q = p - uCenter;
  float rho = length(q);
  vec2 er = rho > 1e-5 ? q / rho : vec2(1.0, 0.0);
  float theta = atan(q.y, q.x);
  vec2 rr = radiusAt(0, theta);
  vec2 rs = radiusAt(1, theta);
  float d = (rho - rr.x) / length(radialGradient(er, rho, rr.y));
  return vec4(d, normalize(radialGradient(er, rho, rs.y)), rs.x);
}

float coverage(float d, float aa) { return 1.0 - smoothstep(-aa, aa, d); }

// Gaussian shoulder plus a long exponential tail, like a wide blur of the silhouette.
float glowAlpha(float d) {
  float od = max(d, 0.0);
  return 0.2 * exp(-(od * od) / 0.35) + 0.08 * exp(-1.6 * od);
}

// Beyond this distance outside the skin only the glow is visible.
const float GLOW_ONLY = 0.1;

vec4 shadeBlob(vec2 p) {
  vec4 sd = sdBlobCurve(p);
  float d = sd.x - RIM_R;
  if (d > GLOW_ONLY) {
    float ga = glowAlpha(d);
    return vec4(GLOW * ga, ga);
  }
  vec2 g = sd.yz;
  float aa = uWorldPerPx;

  // r: 0 at the centre, 1 at the skin, whatever the current squish. Treat the body as a
  // sphere over that parameter so the shading gradient spans the whole blob.
  vec2 fromCenter = p - uCenter;
  float lc = length(fromCenter);
  float r = clamp(lc / (sd.w + RIM_R), 0.0, 1.0);
  vec2 dir = normalize(mix(fromCenter / max(lc, 1e-4), g, r * r));
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
  private readonly radii = new Float32Array(ANGLES * 2);

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
      "uRadius", "uCenter", "uCore", "uLook", "uBounds", "uWorldPerPx", "uWorldPerCss", "uOffset",
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
    const curve = catmullRomClosed(rim, this.curve);
    const center = centroid(curve);
    polarRadii(curve, center, this.radii);
    blurCircular(this.radii);
    gl.uniform4fv(this.u.uRadius, this.radii);
    gl.uniform2f(this.u.uCenter, center.x, center.y);
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

/** Area centroid of a closed polygon; the most star-friendly centre for a squished ring. */
function centroid(pts: Float32Array): { x: number; y: number } {
  const n = pts.length / 2;
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const x0 = pts[i * 2];
    const y0 = pts[i * 2 + 1];
    const x1 = pts[((i + 1) % n) * 2];
    const y1 = pts[((i + 1) % n) * 2 + 1];
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/**
 * Distance from `c` to the curve along each table direction. Where a ray crosses the curve
 * more than once (a fold), the farthest hit wins so the silhouette never gets holes.
 */
function polarRadii(pts: Float32Array, c: { x: number; y: number }, out: Float32Array): Float32Array {
  const n = pts.length / 2;
  let fallback = 0;
  for (let k = 0; k < ANGLES; k++) {
    const ux = RAY_COS[k];
    const uy = RAY_SIN[k];
    let best = -1;
    for (let i = 0; i < n; i++) {
      const ax = pts[i * 2] - c.x;
      const ay = pts[i * 2 + 1] - c.y;
      const ex = pts[((i + 1) % n) * 2] - c.x - ax;
      const ey = pts[((i + 1) % n) * 2 + 1] - c.y - ay;
      const denom = ux * ey - uy * ex;
      if (Math.abs(denom) < 1e-9) continue;
      const s = (ax * uy - ay * ux) / denom;
      if (s < 0 || s > 1) continue;
      const t = (ax * ey - ay * ex) / denom;
      if (t > best) best = t;
    }
    out[k] = best > 0 ? best : fallback;
    if (best > 0) fallback = best;
  }
  return out;
}

/** Gaussian over neighbouring angles, sigma in table samples; kernel spans ±3 sigma. */
const NORMAL_BLUR_SIGMA = 3;
const BLUR_KERNEL = (() => {
  const half = NORMAL_BLUR_SIGMA * 3;
  const w = Array.from({ length: half * 2 + 1 }, (_, i) => Math.exp(-((i - half) ** 2) / (2 * NORMAL_BLUR_SIGMA ** 2)));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / sum);
})();

/** Fills the second half of `table` with a circular blur of the first half. */
function blurCircular(table: Float32Array): void {
  const half = (BLUR_KERNEL.length - 1) / 2;
  for (let k = 0; k < ANGLES; k++) {
    let v = 0;
    for (let j = 0; j < BLUR_KERNEL.length; j++) v += BLUR_KERNEL[j] * table[(k + j - half + ANGLES) % ANGLES];
    table[ANGLES + k] = v;
  }
}

function hexToRgb(hex: string): number[] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
