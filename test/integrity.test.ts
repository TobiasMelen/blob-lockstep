import { beforeAll, describe, expect, it } from "vitest";
import type { Input } from "../src/sim/input";
import { initPhysics, Sim, WORLD_H, WORLD_W } from "../src/sim/sim";
import { lcg } from "./helpers";

function measure(sim: Sim) {
  const core = sim.world.getRigidBody(sim.layout.core).translation();
  const pts = sim.layout.rim.map((h) => sim.world.getRigidBody(h).translation());
  let area = 0;
  let maxDist = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
    maxDist = Math.max(maxDist, Math.hypot(a.x - core.x, a.y - core.y));
  }
  // Core inside polygon (winding test).
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > core.y !== b.y > core.y && core.x < ((b.x - a.x) * (core.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return { area: area / 2, maxDist, inside };
}

/** Grab the blob and yank it around as fast as a mouse realistically can. */
function violentScript(seed: number, sim: Sim) {
  const rand = lcg(seed);
  let target = { x: WORLD_W / 2, y: WORLD_H / 2 };
  let holding = false;
  let t = 0;
  return (): Input => {
    t++;
    if (!holding && t % 90 === 0) {
      const body = sim.layout.rim[Math.floor(rand() * sim.layout.rim.length)];
      const p = sim.world.getRigidBody(body).translation();
      target = { x: p.x, y: p.y };
      holding = true;
    } else if (holding && t % 90 === 60) {
      holding = false;
    } else if (holding) {
      target.x = Math.min(WORLD_W, Math.max(0, target.x + (rand() - 0.5) * 1.6));
      target.y = Math.min(WORLD_H, Math.max(0, target.y + (rand() - 0.5) * 1.6));
    }
    const down = holding ? 1 : 0;
    return { x: Math.round(target.x * 1000), y: Math.round(target.y * 1000), down };
  };
}

const at = (x: number, y: number): Input => ({ x: Math.round(x * 1000), y: Math.round(y * 1000), down: 1 });
const idle: Input = { x: 0, y: 0, down: 0 };

describe("Blob integrity", () => {
  beforeAll(() => initPhysics());

  // Folding the blob flat (core yanked out through the rim, or top pulled through the bottom)
  // used to leave it stuck as a banana at ~20% of its area.
  for (const fold of ["core out", "top through bottom"] as const) {
    it(`reinflates after being folded flat (${fold})`, () => {
      const sim = Sim.create();
      for (let t = 0; t < 180; t++) sim.step([idle, idle]);
      const rest = measure(sim).area;
      const pos = (h: number) => sim.world.getRigidBody(h).translation();
      const { rim, core } = sim.layout;
      const top = rim.reduce((b, h) => (pos(h).y > pos(b).y ? h : b));
      const bottom = rim.reduce((b, h) => (pos(h).y < pos(b).y ? h : b));
      let folded = Infinity;
      for (let t = 0; t < 120; t++) {
        // Each hand keeps reaching past its body, so the pull never lets up.
        const k = Math.min(1, t / 20);
        const pa = fold === "core out" ? pos(core) : pos(top);
        const pb = pos(bottom);
        const a = fold === "core out" ? at(pa.x - 4 * k, pa.y) : at(pa.x, pa.y - 4 * k);
        const b = fold === "core out" ? idle : at(pb.x, pb.y + 4 * k);
        sim.step([a, b]);
        folded = Math.min(folded, measure(sim).area / rest);
      }
      for (let t = 0; t < 120; t++) sim.step([idle, idle]);
      const recovered = measure(sim).area / rest;
      sim.dispose();
      expect(folded).toBeLessThan(0.7);
      expect(recovered).toBeGreaterThan(0.9);
    });
  }

  for (const seed of [1, 2, 3]) {
    it(`survives violent two-player dragging (seed ${seed})`, () => {
      const sim = Sim.create();
      const rest = measure(sim);
      const a = violentScript(seed, sim);
      const b = violentScript(seed + 100, sim);
      let worstArea = Infinity;
      let worstDist = 0;
      let outside = 0;
      for (let t = 0; t < 60 * 30; t++) {
        sim.step([a(), b()]);
        const m = measure(sim);
        worstArea = Math.min(worstArea, m.area / rest.area);
        worstDist = Math.max(worstDist, m.maxDist);
        if (!m.inside) outside++;
      }
      // Let it settle and check it recovers its shape.
      for (let t = 0; t < 180; t++) sim.step([{ x: 0, y: 0, down: 0 }, { x: 0, y: 0, down: 0 }]);
      const settled = measure(sim);
      sim.dispose();
      expect(outside).toBe(0);
      expect(worstArea).toBeGreaterThan(0.3);
      expect(worstDist).toBeLessThan(2.6);
      expect(settled.area / rest.area).toBeGreaterThan(0.8);
    });
  }
});
