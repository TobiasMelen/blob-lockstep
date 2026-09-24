import type { Input } from "../sim/input";
import { PLAYER_COUNT, RIM_COUNT, STATIC_SHAPES, type Sim, WORLD_H, WORLD_W } from "../sim/sim";
import { BlobGl, type BlobFrame, type View } from "./blobGl";

export const PLAYER_COLORS = ["#ff5fa2", "#4fd8ff"];

export type Cursor = { x: number; y: number; down: boolean; player: number; label: string };

/**
 * Three stacked layers inside `stage`: a static 2D canvas redrawn only on resize, a WebGL
 * canvas where the blob is an SDF, and HTML cursors moved with compositor-only transforms.
 */
export class Renderer {
  private readonly bg: HTMLCanvasElement;
  private readonly blob: BlobGl;
  private readonly cursorLayer: HTMLElement;
  private readonly cursorEls = new Map<string, HTMLElement>();
  private readonly rim: Float32Array;
  private view: View = { scale: 1, ox: 0, oy: 0, worldH: WORLD_H, dpr: 1 };

  constructor(private readonly stage: HTMLElement) {
    this.bg = stage.querySelector<HTMLCanvasElement>("canvas.bg")!;
    this.blob = new BlobGl(stage.querySelector<HTMLCanvasElement>("canvas.blob")!, PLAYER_COLORS);
    this.cursorLayer = stage.querySelector<HTMLElement>(".cursors")!;
    this.rim = new Float32Array(RIM_COUNT * 2);
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    const margin = 24;
    const scale = Math.min((w - margin * 2) / WORLD_W, (h - margin * 2) / WORLD_H);
    this.view = {
      scale,
      ox: (w - WORLD_W * scale) / 2,
      oy: (h - WORLD_H * scale) / 2,
      worldH: WORLD_H,
      dpr,
    };
    this.blob.resize(w, h, dpr);
    this.drawStatic(w, h, dpr);
  }

  /** Stage-relative CSS px to world metres. */
  toWorld(sx: number, sy: number): { x: number; y: number } {
    const { ox, oy, scale } = this.view;
    return { x: (sx - ox) / scale, y: WORLD_H - (sy - oy) / scale };
  }

  private sx(x: number) {
    return this.view.ox + x * this.view.scale;
  }
  private sy(y: number) {
    return this.view.oy + (WORLD_H - y) * this.view.scale;
  }

  private drawStatic(w: number, h: number, dpr: number): void {
    this.bg.width = Math.round(w * dpr);
    this.bg.height = Math.round(h * dpr);
    const ctx = this.bg.getContext("2d", { alpha: false })!;
    const { scale } = this.view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#12131a";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#1b1d27";
    ctx.fillRect(this.sx(0), this.sy(WORLD_H), WORLD_W * scale, WORLD_H * scale);
    ctx.strokeStyle = "#2c2f3d";
    ctx.lineWidth = 2;
    ctx.strokeRect(this.sx(0), this.sy(WORLD_H), WORLD_W * scale, WORLD_H * scale);

    ctx.fillStyle = "#3a3e52";
    for (const s of STATIC_SHAPES) {
      ctx.save();
      ctx.translate(this.sx(s.x), this.sy(s.y));
      if (s.kind === "circle") {
        ctx.beginPath();
        ctx.arc(0, 0, s.r * scale, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.rotate(-s.angle);
        ctx.fillRect(-s.hw * scale, -s.hh * scale, s.hw * 2 * scale, s.hh * 2 * scale);
      }
      ctx.restore();
    }
  }

  draw(sim: Sim, cursors: Cursor[]): void {
    const { rim: handles, core: coreHandle, hands } = sim.layout;
    const rim = this.rim;
    for (let i = 0; i < handles.length; i++) {
      const t = sim.world.getRigidBody(handles[i]).translation();
      rim[i * 2] = t.x;
      rim[i * 2 + 1] = t.y;
    }
    const core = sim.world.getRigidBody(coreHandle).translation();

    // Eyes follow the nearest cursor.
    let look = { x: 0, y: -1 };
    let best = Infinity;
    for (const c of cursors) {
      const dx = c.x - core.x;
      const dy = c.y - core.y;
      const d = Math.hypot(dx, dy);
      if (d < best && d > 1e-4) {
        best = d;
        look = { x: dx / d, y: dy / d };
      }
    }

    const tethers: BlobFrame["tethers"] = [];
    for (let p = 0; p < PLAYER_COUNT; p++) {
      const body = sim.grabbedBody(p);
      if (body === -1) {
        tethers.push(null);
        continue;
      }
      const h = sim.world.getRigidBody(hands[p]).translation();
      const b = sim.world.getRigidBody(body).translation();
      tethers.push({ hx: h.x, hy: h.y, bx: b.x, by: b.y });
    }

    this.blob.draw({ rim, core, look, tethers }, this.view);
    this.drawCursors(cursors);
  }

  private drawCursors(cursors: Cursor[]): void {
    const seen = new Set<string>();
    for (const c of cursors) {
      const key = `${c.player}`;
      seen.add(key);
      let el = this.cursorEls.get(key);
      if (!el) {
        el = document.createElement("div");
        el.className = "cursor";
        el.style.setProperty("--c", PLAYER_COLORS[c.player]);
        el.innerHTML = `<div class="ring"></div><div class="label"></div>`;
        this.cursorLayer.append(el);
        this.cursorEls.set(key, el);
      }
      const label = el.lastElementChild as HTMLElement;
      if (label.textContent !== c.label) label.textContent = c.label;
      el.classList.toggle("down", c.down);
      el.hidden = false;
      el.style.transform = `translate3d(${this.sx(c.x).toFixed(1)}px, ${this.sy(c.y).toFixed(1)}px, 0)`;
    }
    for (const [key, el] of this.cursorEls) if (!seen.has(key)) el.hidden = true;
  }
}

export function cursorFromInput(input: Input, player: number, label: string): Cursor {
  return { x: input.x / 1000, y: input.y / 1000, down: !!input.down, player, label };
}
