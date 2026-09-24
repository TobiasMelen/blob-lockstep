import { EMPTY_INPUT, type Input, inputsEqual, packInputs, unpackInputs } from "../sim/input";
import { PLAYER_COUNT, Sim, type SimSnapshot, TICK_RATE } from "../sim/sim";

export const TICK_MS = 1000 / TICK_RATE;
const HASH_INTERVAL = 30;
const MAX_INPUTS_PER_PACKET = 120;
const PING_INTERVAL_MS = 500;

export type NetMessage =
  /** Redundant input stream: all unacked local inputs starting at tick `from`. */
  | { t: "in"; from: number; d: number[]; ack: number; tick: number }
  | { t: "hash"; tick: number; h: number }
  | { t: "ping"; ts: number }
  | { t: "pong"; ts: number };

export interface Transport {
  send(msg: NetMessage, reliable: boolean): void;
}

export type SessionOptions = {
  localPlayer: number;
  inputDelay: number;
  /** How many ticks past the last confirmed remote input we may simulate before stalling. */
  maxPrediction: number;
  transport: Transport;
  onDesync?: (tick: number, local: number, remote: number) => void;
  /** Called with the hash of every checkpoint tick once its state is final. */
  onFinalHash?: (tick: number, hash: number) => void;
};

export type SessionStats = {
  tick: number;
  confirmedTick: number;
  rollbacks: number;
  resimulatedTicks: number;
  lastRollbackDepth: number;
  maxRollbackDepth: number;
  stalls: number;
  rttMs: number;
  advantage: number;
  lastCheckedHashTick: number;
  desyncTick: number;
};

type Frame = { snapshot: SimSnapshot; hash?: number };

/**
 * Two-player delay-based lockstep with rollback.
 *
 * Local input sampled while simulating tick T is scheduled for tick T + inputDelay, so with
 * latency under the delay the remote input is usually already known and nothing rolls back.
 * When it isn't, the remote's last confirmed input is repeated as a prediction; once the
 * real input arrives and differs, state is restored to that tick and resimulated.
 */
export class RollbackSession {
  readonly sim: Sim;
  readonly localPlayer: number;
  readonly remotePlayer: number;
  readonly inputDelay: number;

  private readonly maxPrediction: number;
  private readonly transport: Transport;
  private readonly onDesync?: SessionOptions["onDesync"];
  private readonly onFinalHash?: SessionOptions["onFinalHash"];

  /** Next tick to simulate; the sim holds the state at the start of this tick. */
  private currentTick = 0;
  private readonly localInputs = new Map<number, Input>();
  private readonly remoteInputs = new Map<number, Input>();
  /** Highest tick for which every remote input 0..tick is known. */
  private remoteConfirmed: number;
  /** Highest tick of our inputs the remote has confirmed contiguously. */
  private remoteAck: number;
  private readonly usedRemote = new Map<number, Input>();
  private readonly frames = new Map<number, Frame>();
  private frameFloor = 0;
  private localFloor = 0;
  private pendingRollback: number | null = null;

  private readonly localHashes = new Map<number, number>();
  private readonly remoteHashes = new Map<number, number>();
  private nextHashTick = HASH_INTERVAL;

  private remoteTick = 0;
  private remoteTickAt = 0;
  private heardFromRemote = false;
  private lastPingAt = -Infinity;
  private rtt = 0;

  readonly stats: SessionStats;

  constructor(opts: SessionOptions) {
    this.sim = Sim.create();
    this.localPlayer = opts.localPlayer;
    this.remotePlayer = 1 - opts.localPlayer;
    this.inputDelay = opts.inputDelay;
    this.maxPrediction = opts.maxPrediction;
    this.transport = opts.transport;
    this.onDesync = opts.onDesync;
    this.onFinalHash = opts.onFinalHash;

    // Ticks inside the initial delay window have implicit empty input for both players.
    for (let t = 0; t < this.inputDelay; t++) {
      this.localInputs.set(t, EMPTY_INPUT);
      this.remoteInputs.set(t, EMPTY_INPUT);
    }
    this.remoteConfirmed = this.inputDelay - 1;
    this.remoteAck = this.inputDelay - 1;
    this.stats = {
      tick: 0,
      confirmedTick: this.remoteConfirmed,
      rollbacks: 0,
      resimulatedTicks: 0,
      lastRollbackDepth: 0,
      maxRollbackDepth: 0,
      stalls: 0,
      rttMs: 0,
      advantage: 0,
      lastCheckedHashTick: -1,
      desyncTick: -1,
    };
  }

  get tick(): number {
    return this.currentTick;
  }

  /** Whether `advance` would currently stall waiting for remote input. */
  get stalled(): boolean {
    return this.currentTick - this.remoteConfirmed > this.maxPrediction;
  }

  /**
   * Try to simulate one tick with `localInput` scheduled `inputDelay` ticks ahead.
   * Returns false if stalled on remote input (the input is dropped; sample again next time).
   */
  advance(localInput: Input, nowMs: number): boolean {
    this.flushRollback();
    if (this.stalled) {
      this.stats.stalls++;
      this.sendInputs();
      this.maybePing(nowMs);
      return false;
    }
    this.localInputs.set(this.currentTick + this.inputDelay, localInput);
    this.simulateTick(this.currentTick);
    this.currentTick++;
    this.sendInputs();
    this.maybePing(nowMs);
    this.finalize();
    this.stats.tick = this.currentTick;
    return true;
  }

  receive(msg: NetMessage, nowMs: number): void {
    switch (msg.t) {
      case "in": {
        this.remoteAck = Math.max(this.remoteAck, msg.ack);
        this.heardFromRemote = true;
        if (msg.tick >= this.remoteTick) {
          this.remoteTick = msg.tick;
          this.remoteTickAt = nowMs;
        }
        const inputs = unpackInputs(msg.d);
        for (let i = 0; i < inputs.length; i++) {
          const t = msg.from + i;
          if (t <= this.remoteConfirmed || this.remoteInputs.has(t)) continue;
          this.remoteInputs.set(t, inputs[i]);
          const used = this.usedRemote.get(t);
          if (t < this.currentTick && (!used || !inputsEqual(used, inputs[i]))) {
            this.pendingRollback = Math.min(this.pendingRollback ?? t, t);
          }
        }
        while (this.remoteInputs.has(this.remoteConfirmed + 1)) this.remoteConfirmed++;
        this.stats.confirmedTick = this.remoteConfirmed;
        break;
      }
      case "hash": {
        this.remoteHashes.set(msg.tick, msg.h);
        this.compareHash(msg.tick);
        break;
      }
      case "ping":
        this.transport.send({ t: "pong", ts: msg.ts }, false);
        break;
      case "pong": {
        const sample = nowMs - msg.ts;
        this.rtt = this.rtt === 0 ? sample : this.rtt * 0.8 + sample * 0.2;
        this.stats.rttMs = this.rtt;
        break;
      }
    }
  }

  /**
   * Estimated ticks we are ahead of the remote. Positive means we should slow down so
   * the remote's inputs arrive in time instead of being predicted.
   */
  advantage(nowMs: number): number {
    if (!this.heardFromRemote) return 0;
    const remoteNow = this.remoteTick + (nowMs - this.remoteTickAt + this.rtt / 2) / TICK_MS;
    const adv = this.currentTick - remoteNow;
    this.stats.advantage = adv;
    return adv;
  }

  /** Latest remote input known (confirmed or not), used to draw the remote cursor. */
  latestRemoteInput(): Input {
    for (let t = this.currentTick + this.inputDelay; t >= this.remoteConfirmed; t--) {
      const input = this.remoteInputs.get(t);
      if (input) return input;
    }
    return EMPTY_INPUT;
  }

  flushRollback(): void {
    if (this.pendingRollback === null) return;
    const from = this.pendingRollback;
    this.pendingRollback = null;
    const frame = this.frames.get(from);
    if (!frame) throw new Error(`Missing snapshot for rollback to tick ${from}`);
    this.sim.load(frame.snapshot);
    for (let t = from; t < this.currentTick; t++) this.simulateTick(t);
    const depth = this.currentTick - from;
    this.stats.rollbacks++;
    this.stats.resimulatedTicks += depth;
    this.stats.lastRollbackDepth = depth;
    this.stats.maxRollbackDepth = Math.max(this.stats.maxRollbackDepth, depth);
  }

  dispose(): void {
    this.sim.dispose();
  }

  private simulateTick(t: number): void {
    const frame: Frame = { snapshot: this.sim.save() };
    if (t % HASH_INTERVAL === 0) frame.hash = this.sim.hash();
    this.frames.set(t, frame);

    const local = this.localInputs.get(t);
    if (!local) throw new Error(`Missing local input for tick ${t}`);
    const remote = this.remoteInputs.get(t) ?? this.remoteInputs.get(this.remoteConfirmed) ?? EMPTY_INPUT;
    this.usedRemote.set(t, remote);

    const inputs = new Array<Input>(PLAYER_COUNT);
    inputs[this.localPlayer] = local;
    inputs[this.remotePlayer] = remote;
    this.sim.step(inputs);
  }

  private sendInputs(): void {
    const from = this.remoteAck + 1;
    const to = Math.min(this.currentTick + this.inputDelay - 1, from + MAX_INPUTS_PER_PACKET - 1);
    const inputs: Input[] = [];
    for (let t = from; t <= to; t++) {
      const input = this.localInputs.get(t);
      if (!input) break;
      inputs.push(input);
    }
    this.transport.send(
      { t: "in", from, d: packInputs(inputs), ack: this.remoteConfirmed, tick: this.currentTick },
      false,
    );
  }

  private maybePing(nowMs: number): void {
    if (nowMs - this.lastPingAt < PING_INTERVAL_MS) return;
    this.lastPingAt = nowMs;
    this.transport.send({ t: "ping", ts: nowMs }, false);
  }

  /** Publish hashes for ticks whose state can no longer change, and prune history. */
  private finalize(): void {
    // State at the start of tick t is final once every input for ticks < t is confirmed.
    // Frames only exist for already simulated ticks, hence the cap below currentTick.
    const finalTick = Math.min(this.remoteConfirmed + 1, this.currentTick - 1);
    while (this.nextHashTick <= finalTick) {
      const frame = this.frames.get(this.nextHashTick);
      if (frame?.hash !== undefined) {
        this.localHashes.set(this.nextHashTick, frame.hash);
        this.onFinalHash?.(this.nextHashTick, frame.hash);
        this.transport.send({ t: "hash", tick: this.nextHashTick, h: frame.hash }, true);
        this.compareHash(this.nextHashTick);
      }
      this.nextHashTick += HASH_INTERVAL;
    }

    // Rollback can only target unconfirmed ticks, so older snapshots are dead.
    for (; this.frameFloor < finalTick; this.frameFloor++) {
      this.frames.delete(this.frameFloor);
      this.usedRemote.delete(this.frameFloor);
      this.remoteInputs.delete(this.frameFloor - 1);
    }
    // Local inputs are needed until simulated past for good and acked by the remote.
    const localKeep = Math.min(finalTick, this.remoteAck + 1);
    for (; this.localFloor < localKeep; this.localFloor++) this.localInputs.delete(this.localFloor);
  }

  private compareHash(tick: number): void {
    const local = this.localHashes.get(tick);
    const remote = this.remoteHashes.get(tick);
    if (local === undefined || remote === undefined) return;
    this.localHashes.delete(tick);
    this.remoteHashes.delete(tick);
    this.stats.lastCheckedHashTick = Math.max(this.stats.lastCheckedHashTick, tick);
    if (local !== remote && this.stats.desyncTick < 0) {
      this.stats.desyncTick = tick;
      this.onDesync?.(tick, local, remote);
    }
  }
}
