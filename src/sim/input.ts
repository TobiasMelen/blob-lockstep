/**
 * Per-player, per-tick input. Coordinates are integer millimetres in world space so
 * both peers feed bit-identical values into the simulation regardless of screen size.
 */
export type Input = {
  x: number;
  y: number;
  down: 0 | 1;
};

export const EMPTY_INPUT: Input = Object.freeze({ x: 0, y: 0, down: 0 });

export function inputsEqual(a: Input, b: Input): boolean {
  return a.x === b.x && a.y === b.y && a.down === b.down;
}

export function packInputs(inputs: readonly Input[]): number[] {
  const out = new Array<number>(inputs.length * 3);
  for (let i = 0; i < inputs.length; i++) {
    out[i * 3] = inputs[i].x;
    out[i * 3 + 1] = inputs[i].y;
    out[i * 3 + 2] = inputs[i].down;
  }
  return out;
}

export function unpackInputs(packed: readonly number[]): Input[] {
  const out: Input[] = [];
  for (let i = 0; i + 2 < packed.length; i += 3) {
    out.push({
      x: packed[i] | 0,
      y: packed[i + 1] | 0,
      down: packed[i + 2] ? 1 : 0,
    });
  }
  return out;
}
