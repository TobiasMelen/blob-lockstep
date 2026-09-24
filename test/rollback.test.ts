import { beforeAll, describe, expect, it } from "vitest";
import { EMPTY_INPUT, type Input } from "../src/sim/input";
import { initPhysics, Sim } from "../src/sim/sim";
import { type NetMessage, RollbackSession } from "../src/net/rollback";
import { TickPacer } from "../src/net/pacer";
import { inputScript, lcg } from "./helpers";

type LinkOptions = { latencyMs: number; jitterMs: number; loss: number };

type Peer = {
  session: RollbackSession;
  pacer: TickPacer;
  script: () => Input;
  /** Input actually scheduled per tick, the ground truth for the reference sim. */
  scheduled: Map<number, Input>;
  finalHashes: Map<number, number>;
  clockSkew: number;
};

function runMatch(link: LinkOptions, inputDelay: number, durationMs: number, seed: number) {
  const rand = lcg(seed);
  const queue: { at: number; to: number; msg: NetMessage }[] = [];
  let now = 0;
  const lastReliableAt = [0, 0];

  const makeTransport = (from: number) => ({
    send(msg: NetMessage, reliable: boolean) {
      const to = 1 - from;
      if (!reliable && rand() < link.loss) return;
      let at = now + link.latencyMs + rand() * link.jitterMs;
      if (reliable) {
        at = Math.max(at, lastReliableAt[to]);
        lastReliableAt[to] = at;
      }
      queue.push({ at, to, msg: JSON.parse(JSON.stringify(msg)) });
    },
  });

  const peers: Peer[] = [0, 1].map((p) => {
    const finalHashes = new Map<number, number>();
    return {
      session: new RollbackSession({
        localPlayer: p,
        inputDelay,
        maxPrediction: 12,
        transport: makeTransport(p),
        onFinalHash: (t, h) => finalHashes.set(t, h),
      }),
      pacer: new TickPacer(),
      script: inputScript(100 + p),
      scheduled: new Map(),
      finalHashes,
      clockSkew: p === 0 ? 1 : 1.002,
    };
  });

  // Guest starts late by one-way latency, like receiving the host's start message.
  const startAt = [0, link.latencyMs];
  const lastUpdate = [0, link.latencyMs];
  const frameMs = 1000 / 60;
  const nextFrame = [0, link.latencyMs];

  for (now = 0; now < durationMs; now += 1) {
    queue.sort((a, b) => a.at - b.at);
    while (queue.length && queue[0].at <= now) {
      const { to, msg } = queue.shift()!;
      if (now >= startAt[to]) peers[to].session.receive(msg, now);
    }
    peers.forEach((peer, p) => {
      if (now < nextFrame[p]) return;
      // Render frames with a little jitter, like rAF under load.
      nextFrame[p] = now + frameMs * (0.8 + rand() * 0.6);
      const dt = (now - lastUpdate[p]) * peer.clockSkew;
      lastUpdate[p] = now;
      const s = peer.session;
      peer.pacer.update(s, dt, now, () => {
        const input = peer.script();
        peer.scheduled.set(s.tick + s.inputDelay, input);
        return input;
      });
    });
  }
  return peers;
}

function referenceHashes(peers: Peer[], inputDelay: number, upTo: number) {
  const sim = Sim.create();
  const hashes = new Map<number, number>();
  for (let t = 0; t <= upTo; t++) {
    if (t % 30 === 0) hashes.set(t, sim.hash());
    if (t === upTo) break;
    sim.step(
      peers.map((p) => (t < inputDelay ? EMPTY_INPUT : p.scheduled.get(t)!)),
    );
  }
  sim.dispose();
  return hashes;
}

function check(peers: Peer[], inputDelay: number) {  const [a, b] = peers;
  expect(a.session.stats.desyncTick).toBe(-1);
  expect(b.session.stats.desyncTick).toBe(-1);
  const common = [...a.finalHashes.keys()].filter((t) => b.finalHashes.has(t));
  expect(common.length).toBeGreaterThan(20);
  const last = Math.max(...common);
  const ref = referenceHashes(peers, inputDelay, last);
  for (const t of common) {
    expect(a.finalHashes.get(t)).toBe(b.finalHashes.get(t));
    expect(a.finalHashes.get(t)).toBe(ref.get(t));
  }
  return { a: a.session.stats, b: b.session.stats, checked: common.length };
}

describe("RollbackSession", () => {
  beforeAll(() => initPhysics());

  it("low latency within input delay: no rollbacks needed", () => {
    const peers = runMatch({ latencyMs: 15, jitterMs: 5, loss: 0 }, 3, 15_000, 1);
    const r = check(peers, 3);
    expect(r.a.tick).toBeGreaterThan(800);
    expect(r.a.maxRollbackDepth + r.b.maxRollbackDepth).toBeLessThanOrEqual(4);
  });

  it("latency above input delay with loss: rolls back and stays in sync", () => {
    const peers = runMatch({ latencyMs: 90, jitterMs: 40, loss: 0.15 }, 3, 20_000, 2);
    const r = check(peers, 3);
    expect(r.a.rollbacks + r.b.rollbacks).toBeGreaterThan(50);
    expect(r.a.tick).toBeGreaterThan(1000);
    // Pacer keeps both peers close in tick count.
    expect(Math.abs(r.a.tick - r.b.tick)).toBeLessThan(20);
  });

  it("very bad link stalls instead of diverging", () => {
    const peers = runMatch({ latencyMs: 250, jitterMs: 150, loss: 0.3 }, 3, 15_000, 3);
    const r = check(peers, 3);
    expect(r.a.stalls + r.b.stalls).toBeGreaterThan(0);
  });
});
