import RAPIER from "@dimforge/rapier2d-deterministic-compat";
import type { Input } from "./input";

export const PLAYER_COUNT = 2;
export const TICK_RATE = 60;
export const WORLD_W = 16;
export const WORLD_H = 9;

export const RIM_COUNT = 28;
/** cos/sin of 2π / RIM_COUNT. */
const ROT_COS = 0.9749279121818236;
const ROT_SIN = 0.2225209339563144;
const BLOB_RADIUS = 1.2;
export const RIM_BALL_RADIUS = 0.13;
const CORE_RADIUS = 0.35;
export const GRAB_RADIUS = 1.0;
// Rapier springs are acceleration-based: stiffness is (m/s²)/m regardless of mass, so
// "heavy" comes from soft, overdamped springs: the blob lags the hand and creeps back to
// round over ~1.5 s instead of snapping back.
const SPOKE_STIFFNESS = 80;
const SPOKE_DAMPING = 30;
const BEND_STIFFNESS = 30;
const BEND_DAMPING = 10;
const HAND_STIFFNESS = 100;
const HAND_DAMPING = 16;
/** The hand never leads the grabbed body by more than this, so flicks can't tear the ring. */
const MAX_REACH = 1.4;
const PRESSURE = 15;

const GROUP_WORLD = 0x0001;
const GROUP_RIM = 0x0002;
const groups = (membership: number, filter: number) => (membership << 16) | filter;

let physicsReady: Promise<void> | undefined;
export function initPhysics(): Promise<void> {
  physicsReady ??= RAPIER.init();
  return physicsReady;
}

export type PegShape = { kind: "circle"; x: number; y: number; r: number };
export type BoxShape = { kind: "box"; x: number; y: number; hw: number; hh: number; angle: number };
export type StaticShape = PegShape | BoxShape;

export const STATIC_SHAPES: readonly StaticShape[] = [
  { kind: "circle", x: 4, y: 3.2, r: 0.45 },
  { kind: "circle", x: 12, y: 3.2, r: 0.45 },
  { kind: "circle", x: 8, y: 1.6, r: 0.3 },
  { kind: "box", x: 3.2, y: 6.2, hw: 1.6, hh: 0.12, angle: -0.25 },
  { kind: "box", x: 12.8, y: 6.2, hw: 1.6, hh: 0.12, angle: 0.25 },
];

/** Game state that lives outside the physics world and must be rolled back with it. */
type Extra = {
  grabJoint: number[];
  grabBody: number[];
  prevDown: number[];
};

export type SimSnapshot = {
  world: Uint8Array;
  extra: Extra;
};

/**
 * Rapier handles are opaque f64s (index/generation bit-packed), so game state refers to
 * bodies by index into these arrays rather than by raw handle.
 */
type Layout = {
  rim: number[];
  core: number;
  hands: number[];
  /** Bodies a player can grab: rim then core. */
  grabbable: number[];
  restArea: number;
};

function copyExtra(e: Extra): Extra {
  return { grabJoint: e.grabJoint.slice(), grabBody: e.grabBody.slice(), prevDown: e.prevDown.slice() };
}

/**
 * Deterministic simulation: same sequence of `step(inputs)` calls yields bit-identical
 * state on every machine. All game-logic math outside Rapier sticks to IEEE-754 basic ops
 * (+ - * / sqrt), which are correctly rounded everywhere; no Math.sin/cos/random at runtime.
 */
export class Sim {
  world: RAPIER.World;
  readonly layout: Layout;
  private extra: Extra;

  private constructor(world: RAPIER.World, layout: Layout, extra: Extra) {
    this.world = world;
    this.layout = layout;
    this.extra = extra;
  }

  static create(): Sim {
    const world = new RAPIER.World({ x: 0, y: -9.81 });
    world.timestep = 1 / TICK_RATE;
    world.numSolverIterations = 16;

    const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const wall = (x: number, y: number, hw: number, hh: number) =>
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(hw, hh)
          .setTranslation(x, y)
          .setFriction(0.6)
          .setCollisionGroups(groups(GROUP_WORLD, 0xffff)),
        ground,
      );
    wall(WORLD_W / 2, -0.5, WORLD_W / 2 + 1, 0.5);
    wall(WORLD_W / 2, WORLD_H + 0.5, WORLD_W / 2 + 1, 0.5);
    wall(-0.5, WORLD_H / 2, 0.5, WORLD_H / 2 + 1);
    wall(WORLD_W + 0.5, WORLD_H / 2, 0.5, WORLD_H / 2 + 1);

    for (const s of STATIC_SHAPES) {
      const desc =
        s.kind === "circle"
          ? RAPIER.ColliderDesc.ball(s.r).setTranslation(s.x, s.y)
          : RAPIER.ColliderDesc.cuboid(s.hw, s.hh).setTranslation(s.x, s.y).setRotation(s.angle);
      world.createCollider(
        desc.setFriction(0.5).setCollisionGroups(groups(GROUP_WORLD, 0xffff)),
        ground,
      );
    }

    // Soft-body ring: rim balls chained with revolute joints, sprung to a core body.
    // Math.cos/sin are not guaranteed bit-identical across JS engines, so the ring is
    // built by repeated rotation with a literal constant using only basic arithmetic.
    const cx = WORLD_W / 2;
    const cy = WORLD_H * 0.6;
    const points: { x: number; y: number }[] = [];
    let ux = 1;
    let uy = 0;
    for (let i = 0; i < RIM_COUNT; i++) {
      points.push({ x: Math.fround(cx + ux * BLOB_RADIUS), y: Math.fround(cy + uy * BLOB_RADIUS) });
      const nx = ux * ROT_COS - uy * ROT_SIN;
      uy = ux * ROT_SIN + uy * ROT_COS;
      ux = nx;
    }

    const bodyDesc = () =>
      RAPIER.RigidBodyDesc.dynamic().setCanSleep(false).setLinearDamping(0.05).setAngularDamping(0.5);

    const core = world.createRigidBody(bodyDesc().setTranslation(cx, cy));
    world.createCollider(
      RAPIER.ColliderDesc.ball(CORE_RADIUS).setDensity(1).setCollisionGroups(0),
      core,
    );

    const rim = points.map((p) => {
      const body = world.createRigidBody(bodyDesc().setTranslation(p.x, p.y).setCcdEnabled(true));
      world.createCollider(
        RAPIER.ColliderDesc.ball(RIM_BALL_RADIUS)
          .setDensity(1.5)
          .setFriction(0.8)
          .setRestitution(0.1)
          .setCollisionGroups(groups(GROUP_RIM, GROUP_WORLD | GROUP_RIM)),
        body,
      );
      return body;
    });

    for (let i = 0; i < RIM_COUNT; i++) {
      const a = rim[i];
      const b = rim[(i + 1) % RIM_COUNT];
      const pa = points[i];
      const pb = points[(i + 1) % RIM_COUNT];
      const mx = (pa.x + pb.x) / 2;
      const my = (pa.y + pb.y) / 2;
      const joint = world.createImpulseJoint(
        RAPIER.JointData.revolute({ x: mx - pa.x, y: my - pa.y }, { x: mx - pb.x, y: my - pb.y }),
        a,
        b,
        true,
      );
      joint.setContactsEnabled(false);

      const spoke = world.createImpulseJoint(
        RAPIER.JointData.spring(BLOB_RADIUS, SPOKE_STIFFNESS, SPOKE_DAMPING, { x: 0, y: 0 }, { x: 0, y: 0 }),
        core,
        a,
        true,
      );
      spoke.setContactsEnabled(false);

      // Bending resistance: skip-one springs stop the chain folding over itself.
      const pc = points[(i + 2) % RIM_COUNT];
      const bendRest = Math.sqrt((pc.x - pa.x) * (pc.x - pa.x) + (pc.y - pa.y) * (pc.y - pa.y));
      const bend = world.createImpulseJoint(
        RAPIER.JointData.spring(bendRest, BEND_STIFFNESS, BEND_DAMPING, { x: 0, y: 0 }, { x: 0, y: 0 }),
        a,
        rim[(i + 2) % RIM_COUNT],
        true,
      );
      bend.setContactsEnabled(false);
    }

    const hands: number[] = [];
    for (let p = 0; p < PLAYER_COUNT; p++) {
      hands.push(
        world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(cx, cy)).handle,
      );
    }

    const layout: Layout = {
      rim: rim.map((b) => b.handle),
      core: core.handle,
      hands,
      grabbable: [...rim.map((b) => b.handle), core.handle],
      restArea: 0,
    };
    const sim = new Sim(world, layout, {
      grabJoint: new Array(PLAYER_COUNT).fill(-1),
      grabBody: new Array(PLAYER_COUNT).fill(-1),
      prevDown: new Array(PLAYER_COUNT).fill(0),
    });
    layout.restArea = sim.rimArea();
    return sim;
  }

  /** Advance exactly one tick. `inputs[p]` is player p's input for this tick. */
  step(inputs: readonly Input[]): void {
    const world = this.world;
    const { hands, rim } = this.layout;
    const e = this.extra;

    for (let p = 0; p < PLAYER_COUNT; p++) {
      const input = inputs[p];
      let tx = input.x / 1000;
      let ty = input.y / 1000;
      const hand = world.getRigidBody(hands[p]);

      if (input.down && !e.prevDown[p]) {
        const target = this.pick(tx, ty);
        if (target >= 0) {
          const joint = world.createImpulseJoint(
            RAPIER.JointData.spring(0, HAND_STIFFNESS, HAND_DAMPING, { x: 0, y: 0 }, { x: 0, y: 0 }),
            hand,
            world.getRigidBody(this.layout.grabbable[target]),
            true,
          );
          joint.setContactsEnabled(false);
          e.grabJoint[p] = joint.handle;
          e.grabBody[p] = target;
        }
      } else if (!input.down && e.grabJoint[p] !== -1) {
        world.removeImpulseJoint(world.getImpulseJoint(e.grabJoint[p]), true);
        e.grabJoint[p] = -1;
        e.grabBody[p] = -1;
      }
      e.prevDown[p] = input.down;

      if (e.grabBody[p] >= 0) {
        const b = world.getRigidBody(this.layout.grabbable[e.grabBody[p]]).translation();
        const dx = tx - b.x;
        const dy = ty - b.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > MAX_REACH) {
          tx = b.x + (dx / len) * MAX_REACH;
          ty = b.y + (dy / len) * MAX_REACH;
        }
      }
      hand.setNextKinematicTranslation({ x: tx, y: ty });
    }

    this.applyPressure(rim);
    world.step();
  }

  /** Index into `layout.grabbable` of the nearest body within reach; ties resolve to the lowest index. */
  private pick(x: number, y: number): number {
    const { grabbable } = this.layout;
    let best = -1;
    let bestD = GRAB_RADIUS * GRAB_RADIUS;
    for (let i = 0; i < grabbable.length; i++) {
      const t = this.world.getRigidBody(grabbable[i]).translation();
      const dx = t.x - x;
      const dy = t.y - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private rimArea(): number {
    const rim = this.layout.rim;
    let area = 0;
    let prev = this.world.getRigidBody(rim[rim.length - 1]).translation();
    for (const h of rim) {
      const cur = this.world.getRigidBody(h).translation();
      area += prev.x * cur.y - cur.x * prev.y;
      prev = cur;
    }
    return area / 2;
  }

  /** Gas pressure: push rim outward along edge normals proportional to lost area. */
  private applyPressure(rim: number[]): void {
    const n = rim.length;
    const pos = rim.map((h) => this.world.getRigidBody(h).translation());
    let area = 0;
    for (let i = 0; i < n; i++) {
      const a = pos[i];
      const b = pos[(i + 1) % n];
      area += a.x * b.y - b.x * a.y;
    }
    area /= 2;
    const deficit = Math.min(0.6, (this.layout.restArea - area) / this.layout.restArea);
    if (deficit <= 0) return;
    const dt = this.world.timestep;
    const magnitude = PRESSURE * deficit * dt;
    for (let i = 0; i < n; i++) {
      const prev = pos[(i + n - 1) % n];
      const next = pos[(i + 1) % n];
      // Outward normal of the chord prev->next for a counter-clockwise polygon.
      const nx = next.y - prev.y;
      const ny = prev.x - next.x;
      this.world.getRigidBody(rim[i]).applyImpulse({ x: nx * magnitude, y: ny * magnitude }, true);
    }
  }

  save(): SimSnapshot {
    return { world: this.world.takeSnapshot(), extra: copyExtra(this.extra) };
  }

  load(snapshot: SimSnapshot): void {
    const next = RAPIER.World.restoreSnapshot(snapshot.world);
    this.world.free();
    this.world = next;
    this.extra = copyExtra(snapshot.extra);
  }

  /** FNV-1a over the raw f32 bits of every dynamic body plus grab state. */
  hash(): number {
    const buf = new DataView(new ArrayBuffer(4));
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      buf.setFloat32(0, v);
      const bits = buf.getUint32(0);
      for (let s = 0; s < 32; s += 8) {
        h ^= (bits >>> s) & 0xff;
        h = Math.imul(h, 0x01000193);
      }
    };
    const { rim, core, hands } = this.layout;
    for (const handle of [...rim, core, ...hands]) {
      const b = this.world.getRigidBody(handle);
      const t = b.translation();
      const v = b.linvel();
      mix(t.x);
      mix(t.y);
      mix(b.rotation());
      mix(v.x);
      mix(v.y);
      mix(b.angvel());
    }
    for (let p = 0; p < PLAYER_COUNT; p++) {
      mix(this.extra.grabBody[p]);
      mix(this.extra.prevDown[p]);
    }
    return h >>> 0;
  }

  /** Rigid-body handle held by `player`, or -1. */
  grabbedBody(player: number): number {
    const index = this.extra.grabBody[player];
    return index < 0 ? -1 : this.layout.grabbable[index];
  }

  dispose(): void {
    this.world.free();
  }
}
