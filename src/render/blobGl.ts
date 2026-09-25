import { PLAYER_COUNT, RIM_BALL_RADIUS, RIM_COUNT } from "../sim/sim";

/** Catmull-Rom samples per rim link. */
const SUBDIVISIONS = 4;
const SKIN_POINTS = RIM_COUNT * SUBDIVISIONS;
/** Half-width of the outline's anti-aliased edges, device px. */
const AA_PX = 1.5;
/** Eyes (2 whites, 2 pupils) plus a line and a dot per player's tether. */
const MAX_SPRITES = 4 + PLAYER_COUNT * 2;

// The whole mesh is generated from gl_VertexID and the rim ball positions; there are no buffers.
const BLOB_VERTEX = /* glsl */ `#version 300 es
#define N ${RIM_COUNT}
#define SUB ${SUBDIVISIONS}
const float RIM_R = ${RIM_BALL_RADIUS.toFixed(4)};
const float AA_PX = ${AA_PX.toFixed(1)};

uniform vec2 uRim[N];
uniform vec2 uCenter;
uniform float uOrient;   // +1 if the rim runs counter-clockwise
uniform int uPass;       // 0: body fan, 1: outline ribbon
uniform float uOutline;  // outline width, world units
uniform vec2 uOffset;    // world position of device pixel (0,0)
uniform float uWorldPerPx;
uniform vec2 uViewport;

out vec2 vWorld;
out vec2 vShade;
out float vR;
out float vAcross; // outline ribbon: signed distance from the skin, world units

vec2 rim(int i) { return uRim[(i + N) % N]; }

// Catmull-Rom position and tangent in the span starting at ball i.
void curve(int i, float t, out vec2 p, out vec2 dp) {
  vec2 p0 = rim(i - 1), p1 = rim(i), p2 = rim(i + 1), p3 = rim(i + 2);
  vec2 b = p2 - p0;
  vec2 c = 2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3;
  vec2 d = 3.0 * p1 - p0 - 3.0 * p2 + p3;
  p = p1 + 0.5 * t * (b + t * (c + t * d));
  dp = 0.5 * (b + t * (2.0 * c + 3.0 * t * d));
}

vec2 outward(vec2 tangent) {
  return vec2(tangent.y, -tangent.x) * (uOrient / max(length(tangent), 1e-6));
}

// Skin point s: the curve through the ball centres pushed out by the ball radius. The shading
// normal comes from a chord one ball either side, so dents don't crease the dome.
void skin(int s, out vec2 pos, out vec2 normal, out vec2 shade) {
  int i = s / SUB;
  float t = float(s - i * SUB) / float(SUB);
  vec2 p, dp, a, b;
  curve(i, t, p, dp);
  normal = outward(dp);
  pos = p + normal * RIM_R;
  curve(i - 1, t, a, dp);
  curve(i + 1, t, b, dp);
  shade = outward(b - a);
}

void main() {
  vec2 world, normal, shade;
  vAcross = 0.0;
  if (uPass == 0) {
    int tri = gl_VertexID / 3;
    int corner = gl_VertexID - tri * 3;
    if (corner == 0) {
      world = uCenter;
      shade = vec2(0.0);
      vR = 0.0;
    } else {
      // Inset so the fill's aliased edge sits under the opaque part of the outline.
      skin(tri + corner - 1, world, normal, shade);
      world -= normal * AA_PX * uWorldPerPx;
      vR = 1.0;
    }
  } else {
    // Spans from inside the outline to just past the skin, so both edges get a soft fringe
    // and the fill's hard edge stays covered.
    skin(gl_VertexID >> 1, world, normal, shade);
    float aa = AA_PX * uWorldPerPx;
    vAcross = (gl_VertexID & 1) == 1 ? -uOutline - aa : aa;
    world += normal * vAcross;
    vR = 1.0;
  }
  vWorld = world;
  vShade = shade;
  gl_Position = vec4((world - uOffset) / (uWorldPerPx * uViewport) * 2.0 - 1.0, 0.0, 1.0);
}`;

const BLOB_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

const float AA_PX = ${AA_PX.toFixed(1)};

uniform int uPass;
uniform vec2 uCenter;
uniform float uOutline;
uniform float uWorldPerPx;
in vec2 vWorld;
in vec2 vShade;
in float vR;
in float vAcross;
out vec4 outColor;

const vec3 DEEP = vec3(0.07, 0.42, 0.22);
const vec3 BASE = vec3(0.30, 0.89, 0.54);
const vec3 LIGHT = vec3(0.78, 1.0, 0.86);
const vec3 OUTLINE = vec3(0.05, 0.36, 0.19);

void main() {
  if (uPass == 1) {
    float aa = AA_PX * uWorldPerPx;
    float a = (1.0 - smoothstep(-aa, aa, vAcross)) * smoothstep(-uOutline - aa, -uOutline + aa, vAcross);
    outColor = vec4(OUTLINE * a, a);
    return;
  }
  // r: 0 at the centre, 1 at the skin, whatever the current squish. Treat the body as a dome
  // over that parameter, turning from the radial direction inside to the skin normal at the edge.
  float r = clamp(vR, 0.0, 1.0);
  vec2 fromCenter = vWorld - uCenter;
  float lc = length(fromCenter);
  vec2 radial = lc > 1e-4 ? fromCenter / lc : vec2(0.0, 1.0);
  float ls = length(vShade);
  vec2 edge = ls > 1e-4 ? vShade / ls : radial;
  vec2 dir = normalize(mix(radial, edge, r * r) + 1e-5);
  vec3 n = normalize(vec3(dir * r, sqrt(max(1.0 - r * r, 0.0)) + 0.08));
  vec3 L = normalize(vec3(-0.45, 0.6, 0.75));
  float diff = clamp(dot(n, L), 0.0, 1.0);
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 10.0);
  vec3 albedo = mix(BASE, LIGHT, 0.55 * (1.0 - smoothstep(0.0, 0.8, r)));
  vec3 col = albedo * (0.3 + 0.8 * diff);
  col = mix(col, DEEP, smoothstep(0.6, 1.0, r) * (1.0 - diff) * 0.8);
  col += 0.28 * spec;
  outColor = vec4(col, 1.0);
}`;

// Capsules from a to b (a == b for discs), optionally dashed; one instanced quad each.
const SPRITE_VERTEX = /* glsl */ `#version 300 es
#define S ${MAX_SPRITES}
uniform vec4 uSeg[S];    // a.xy, b.xy
uniform vec2 uStyle[S];  // radius, dash period (0 = solid)
uniform vec3 uColor[S];
uniform vec2 uOffset;
uniform float uWorldPerPx;
uniform vec2 uViewport;

out vec2 vWorld;
flat out vec4 vSeg;
flat out vec2 vStyle;
flat out vec3 vColor;

void main() {
  vec4 seg = uSeg[gl_InstanceID];
  vec2 style = uStyle[gl_InstanceID];
  vec2 ab = seg.zw - seg.xy;
  float len = length(ab);
  vec2 u = len > 1e-6 ? ab / len : vec2(1.0, 0.0);
  vec2 v = vec2(-u.y, u.x);
  float pad = style.x + 2.0 * uWorldPerPx;
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vWorld = (seg.xy + seg.zw) * 0.5 + u * corner.x * (len * 0.5 + pad) + v * corner.y * pad;
  vSeg = seg;
  vStyle = style;
  vColor = uColor[gl_InstanceID];
  gl_Position = vec4((vWorld - uOffset) / (uWorldPerPx * uViewport) * 2.0 - 1.0, 0.0, 1.0);
}`;

const SPRITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform float uWorldPerPx;
in vec2 vWorld;
flat in vec4 vSeg;
flat in vec2 vStyle;
flat in vec3 vColor;
out vec4 outColor;

void main() {
  vec2 pa = vWorld - vSeg.xy;
  vec2 ab = vSeg.zw - vSeg.xy;
  float len2 = dot(ab, ab);
  float h = len2 > 1e-12 ? clamp(dot(pa, ab) / len2, 0.0, 1.0) : 0.0;
  float d = length(pa - ab * h) - vStyle.x;
  float alpha = 1.0 - smoothstep(-uWorldPerPx, uWorldPerPx, d);
  if (vStyle.y > 0.0) alpha *= step(fract(h * sqrt(len2) / vStyle.y), 0.55);
  outColor = vec4(vColor * alpha, alpha);
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

type Program = { program: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

/**
 * Draws the blob as a mesh the vertex shader builds from the rim balls: a triangle fan filled
 * through a nonzero-winding stencil (so folds that cross themselves still fill correctly), an
 * outline ribbon, then the eyes and grab tethers as instanced capsules.
 */
export class BlobGl {
  private gl: WebGL2RenderingContext;
  private blob!: Program;
  private sprite!: Program;
  private readonly tetherColors: number[][];
  private readonly seg = new Float32Array(MAX_SPRITES * 4);
  private readonly style = new Float32Array(MAX_SPRITES * 2);
  private readonly color = new Float32Array(MAX_SPRITES * 3);

  constructor(
    private readonly canvas: HTMLCanvasElement,
    playerColors: readonly string[],
  ) {
    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: true,
      antialias: false,
      stencil: true,
      desynchronized: true,
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;
    this.tetherColors = playerColors.map(hexToRgb);
    this.init();
    canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
    canvas.addEventListener("webglcontextrestored", () => this.init());
  }

  private init(): void {
    const gl = this.gl;
    this.blob = link(gl, BLOB_VERTEX, BLOB_FRAGMENT, [
      "uRim", "uCenter", "uOrient", "uPass", "uOutline", "uOffset", "uWorldPerPx", "uViewport",
    ]);
    this.sprite = link(gl, SPRITE_VERTEX, SPRITE_FRAGMENT, [
      "uSeg", "uStyle", "uColor", "uOffset", "uWorldPerPx", "uViewport",
    ]);
    gl.bindVertexArray(gl.createVertexArray());
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
  }

  draw(frame: BlobFrame, view: View): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    const { rim } = frame;
    const worldPerCss = 1 / view.scale;
    const worldPerPx = worldPerCss / view.dpr;
    const { width, height } = this.canvas;
    const cssH = height / view.dpr;
    // Device pixel (0,0) is bottom-left; world y points up like GL.
    const ox = -view.ox * worldPerCss;
    const oy = view.worldH - (cssH - view.oy) * worldPerCss;

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    const { u } = this.blob;
    const { x: cx, y: cy, area } = centroid(rim);
    gl.useProgram(this.blob.program);
    gl.uniform2fv(u.uRim, rim);
    gl.uniform2f(u.uCenter, cx, cy);
    gl.uniform1f(u.uOrient, area >= 0 ? 1 : -1);
    gl.uniform1f(u.uOutline, Math.max(0.02 + worldPerCss, 3.5 * AA_PX * worldPerPx));
    gl.uniform2f(u.uOffset, ox, oy);
    gl.uniform1f(u.uWorldPerPx, worldPerPx);
    gl.uniform2f(u.uViewport, width, height);

    // Nonzero winding: count fan coverage in the stencil, then shade where it's non-zero,
    // zeroing as we go so overlapping fan triangles shade each pixel once.
    gl.enable(gl.STENCIL_TEST);
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
    gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP);
    gl.uniform1i(u.uPass, 0);
    gl.drawArrays(gl.TRIANGLES, 0, SKIN_POINTS * 3);
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);
    gl.drawArrays(gl.TRIANGLES, 0, SKIN_POINTS * 3);
    gl.disable(gl.STENCIL_TEST);

    gl.enable(gl.BLEND);
    gl.uniform1i(u.uPass, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, (SKIN_POINTS + 1) * 2);

    const count = this.fillSprites(frame, worldPerCss);
    const s = this.sprite.u;
    gl.useProgram(this.sprite.program);
    gl.uniform4fv(s.uSeg, this.seg);
    gl.uniform2fv(s.uStyle, this.style);
    gl.uniform3fv(s.uColor, this.color);
    gl.uniform2f(s.uOffset, ox, oy);
    gl.uniform1f(s.uWorldPerPx, worldPerPx);
    gl.uniform2f(s.uViewport, width, height);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.disable(gl.BLEND);
  }

  /** Eyes riding on the core, then each grab tether as a dashed line and a dot. */
  private fillSprites(frame: BlobFrame, css: number): number {
    let n = 0;
    const add = (ax: number, ay: number, bx: number, by: number, radius: number, dash: number, rgb: number[]) => {
      this.seg.set([ax, ay, bx, by], n * 4);
      this.style.set([radius, dash], n * 2);
      this.color.set(rgb, n * 3);
      n++;
    };
    const { core, look } = frame;
    for (const side of [-1, 1]) {
      const ex = core.x + side * 0.32;
      const ey = core.y + 0.2;
      add(ex, ey, ex, ey, 0.18, 0, [1, 1, 1]);
    }
    for (const side of [-1, 1]) {
      const px = core.x + side * 0.32 + look.x * 0.08;
      const py = core.y + 0.2 + look.y * 0.08;
      add(px, py, px, py, 0.09, 0, [0.08, 0.09, 0.12]);
    }
    frame.tethers.forEach((t, i) => {
      if (!t) return;
      add(t.hx, t.hy, t.bx, t.by, 1.5 * css, 11 * css, this.tetherColors[i]);
      add(t.bx, t.by, t.bx, t.by, 5 * css, 0, this.tetherColors[i]);
    });
    return n;
  }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string, names: string[]): Program {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
    return s;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link error");
  return { program, u: Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)])) };
}

/** Area centroid of the rim polygon, and its signed area (positive when counter-clockwise). */
function centroid(pts: Float32Array): { x: number; y: number; area: number } {
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
  return { x: cx / (3 * a), y: cy / (3 * a), area: a / 2 };
}

function hexToRgb(hex: string): number[] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
