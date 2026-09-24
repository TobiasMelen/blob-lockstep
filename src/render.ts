import type { Input } from "./sim/input";
import { PLAYER_COUNT, RIM_BALL_RADIUS, STATIC_SHAPES, type Sim, WORLD_H, WORLD_W } from "./sim/sim";

export const PLAYER_COLORS = ["#ff5fa2", "#4fd8ff"];

export type Cursor = { x: number; y: number; down: boolean; player: number; label: string };

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private scale = 1;
  private ox = 0;
  private oy = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const margin = 24;
    this.scale = Math.min((w - margin * 2) / WORLD_W, (h - margin * 2) / WORLD_H);
    this.ox = (w - WORLD_W * this.scale) / 2;
    this.oy = (h - WORLD_H * this.scale) / 2;
  }

  /** Screen (CSS px relative to canvas) to world metres. */
  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.ox) / this.scale, y: WORLD_H - (sy - this.oy) / this.scale };
  }

  private sx(x: number) {
    return this.ox + x * this.scale;
  }
  private sy(y: number) {
    return this.oy + (WORLD_H - y) * this.scale;
  }

  draw(sim: Sim, cursors: Cursor[]): void {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.fillStyle = "#12131a";
    ctx.fillRect(0, 0, w, h);

    // Arena
    ctx.fillStyle = "#1b1d27";
    ctx.fillRect(this.sx(0), this.sy(WORLD_H), WORLD_W * this.scale, WORLD_H * this.scale);
    ctx.strokeStyle = "#2c2f3d";
    ctx.lineWidth = 2;
    ctx.strokeRect(this.sx(0), this.sy(WORLD_H), WORLD_W * this.scale, WORLD_H * this.scale);

    ctx.fillStyle = "#3a3e52";
    for (const s of STATIC_SHAPES) {
      ctx.save();
      ctx.translate(this.sx(s.x), this.sy(s.y));
      if (s.kind === "circle") {
        ctx.beginPath();
        ctx.arc(0, 0, s.r * this.scale, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.rotate(-s.angle);
        ctx.fillRect(-s.hw * this.scale, -s.hh * this.scale, s.hw * 2 * this.scale, s.hh * 2 * this.scale);
      }
      ctx.restore();
    }

    this.drawBlob(sim, cursors);

    // Grab tethers from each player's hand to the body it holds.
    for (let p = 0; p < PLAYER_COUNT; p++) {
      const body = sim.grabbedBody(p);
      if (body < 0) continue;
      const hand = sim.world.getRigidBody(sim.layout.hands[p]).translation();
      const t = sim.world.getRigidBody(body).translation();
      ctx.strokeStyle = PLAYER_COLORS[p];
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(this.sx(hand.x), this.sy(hand.y));
      ctx.lineTo(this.sx(t.x), this.sy(t.y));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = PLAYER_COLORS[p];
      ctx.beginPath();
      ctx.arc(this.sx(t.x), this.sy(t.y), 5, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const c of cursors) this.drawCursor(c);
  }

  private drawBlob(sim: Sim, cursors: Cursor[]): void {
    const ctx = this.ctx;
    const core = sim.world.getRigidBody(sim.layout.core).translation();
    // Push each rim point outward by the ball radius so the skin wraps the colliders.
    const pts = sim.layout.rim.map((handle) => {
      const t = sim.world.getRigidBody(handle).translation();
      const dx = t.x - core.x;
      const dy = t.y - core.y;
      const len = Math.hypot(dx, dy) || 1;
      return {
        x: this.sx(t.x + (dx / len) * RIM_BALL_RADIUS),
        y: this.sy(t.y + (dy / len) * RIM_BALL_RADIUS),
      };
    });

    const n = pts.length;
    ctx.beginPath();
    const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    });
    const start = mid(pts[n - 1], pts[0]);
    ctx.moveTo(start.x, start.y);
    for (let i = 0; i < n; i++) {
      const m = mid(pts[i], pts[(i + 1) % n]);
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
    }
    ctx.closePath();

    const cx = this.sx(core.x);
    const cy = this.sy(core.y);
    const grad = ctx.createRadialGradient(cx - 0.4 * this.scale, cy - 0.5 * this.scale, 0.1 * this.scale, cx, cy, 1.6 * this.scale);
    grad.addColorStop(0, "#b8ffcf");
    grad.addColorStop(0.55, "#4de38a");
    grad.addColorStop(1, "#1f9e57");
    ctx.fillStyle = grad;
    ctx.shadowColor = "rgba(77, 227, 138, 0.35)";
    ctx.shadowBlur = 30;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#167a42";
    ctx.stroke();

    // Eyes follow the nearest cursor.
    let look = { x: cx, y: cy + 1 };
    let best = Infinity;
    for (const c of cursors) {
      const d = Math.hypot(this.sx(c.x) - cx, this.sy(c.y) - cy);
      if (d < best) {
        best = d;
        look = { x: this.sx(c.x), y: this.sy(c.y) };
      }
    }
    const lx = look.x - cx;
    const ly = look.y - cy;
    const ll = Math.hypot(lx, ly) || 1;
    const eyeR = 0.18 * this.scale;
    for (const side of [-1, 1]) {
      const ex = cx + side * 0.32 * this.scale;
      const ey = cy - 0.2 * this.scale;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#14161f";
      ctx.beginPath();
      ctx.arc(ex + (lx / ll) * eyeR * 0.45, ey + (ly / ll) * eyeR * 0.45, eyeR * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawCursor(c: Cursor): void {
    const ctx = this.ctx;
    const x = this.sx(c.x);
    const y = this.sy(c.y);
    ctx.strokeStyle = PLAYER_COLORS[c.player];
    ctx.fillStyle = PLAYER_COLORS[c.player];
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, c.down ? 7 : 11, 0, Math.PI * 2);
    if (c.down) ctx.fill();
    else ctx.stroke();
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillText(c.label, x + 14, y - 10);
  }
}

export function cursorFromInput(input: Input, player: number, label: string): Cursor {
  return { x: input.x / 1000, y: input.y / 1000, down: !!input.down, player, label };
}
