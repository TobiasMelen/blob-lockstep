import type { Input } from "../src/sim/input";
import { WORLD_H, WORLD_W } from "../src/sim/sim";

export function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Scripted "player": wanders around, periodically grabbing and dragging. */
export function inputScript(seed: number) {
  const rand = lcg(seed);
  let x = WORLD_W / 2;
  let y = WORLD_H / 2;
  let down: 0 | 1 = 0;
  let vx = 0;
  let vy = 0;
  return (): Input => {
    if (rand() < 0.03) down = down ? 0 : 1;
    if (rand() < 0.1) {
      vx = (rand() - 0.5) * 0.4;
      vy = (rand() - 0.5) * 0.4;
    }
    x = Math.min(WORLD_W, Math.max(0, x + vx));
    y = Math.min(WORLD_H, Math.max(0, y + vy));
    return { x: Math.round(x * 1000), y: Math.round(y * 1000), down };
  };
}
