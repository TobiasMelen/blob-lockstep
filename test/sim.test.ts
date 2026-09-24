import { beforeAll, describe, expect, it } from "vitest";
import type { Input } from "../src/sim/input";
import { initPhysics, Sim } from "../src/sim/sim";
import { inputScript } from "./helpers";

function recordInputs(ticks: number): Input[][] {
  const a = inputScript(1);
  const b = inputScript(2);
  return Array.from({ length: ticks }, () => [a(), b()]);
}

describe("Sim determinism", () => {
  beforeAll(() => initPhysics());

  it("two independent sims produce identical hashes", () => {
    const inputs = recordInputs(900);
    const s1 = Sim.create();
    const s2 = Sim.create();
    for (const tick of inputs) {
      s1.step(tick);
      s2.step(tick);
      expect(s2.hash()).toBe(s1.hash());
    }
    s1.dispose();
    s2.dispose();
  });

  it("save/load every tick matches straight simulation", () => {
    const inputs = recordInputs(900);
    const straight = Sim.create();
    const reloaded = Sim.create();
    for (const tick of inputs) {
      straight.step(tick);
      reloaded.load(reloaded.save());
      reloaded.step(tick);
      expect(reloaded.hash()).toBe(straight.hash());
    }
    straight.dispose();
    reloaded.dispose();
  });

  it("rewinding and resimulating reproduces the same state", () => {
    const inputs = recordInputs(600);
    const sim = Sim.create();
    const hashes: number[] = [];
    const snaps = new Map<number, ReturnType<Sim["save"]>>();
    inputs.forEach((tick, t) => {
      snaps.set(t, sim.save());
      sim.step(tick);
      hashes.push(sim.hash());
    });
    for (const from of [0, 137, 300, 555]) {
      sim.load(snaps.get(from)!);
      for (let t = from; t < inputs.length; t++) sim.step(inputs[t]);
      expect(sim.hash()).toBe(hashes[hashes.length - 1]);
    }
    sim.dispose();
  });

  it("blob actually moves when grabbed", () => {
    const sim = Sim.create();
    const core = () => sim.world.getRigidBody(sim.layout.core).translation();
    for (let t = 0; t < 120; t++) sim.step([{ x: 0, y: 0, down: 0 }, { x: 0, y: 0, down: 0 }]);
    const rest = { ...core() };
    const grabAt = { x: Math.round(rest.x * 1000), y: Math.round(rest.y * 1000) };
    for (let t = 0; t < 120; t++) {
      sim.step([{ ...grabAt, y: grabAt.y + t * 30, down: 1 }, { x: 0, y: 0, down: 0 }]);
    }
    expect(sim.grabbedBody(0)).toBeGreaterThanOrEqual(0);
    expect(core().y).toBeGreaterThan(rest.y + 1.5);
    sim.dispose();
  });
});
