import type { Input } from "../sim/input";
import { type RollbackSession, TICK_MS } from "./rollback";

const MAX_TICKS_PER_UPDATE = 8;
/** Fraction of tick length to stretch/shrink per tick of advantage. */
const SYNC_GAIN = 0.04;
const MAX_ADJUST = 0.25;
/** Estimation noise (frame phase, jitter) is ~±0.5 tick; don't chase it. */
const DEADBAND = 0.75;

/** Fixed-timestep driver that slows down when ahead of the remote and speeds up when behind. */
export class TickPacer {
  private acc = 0;

  update(session: RollbackSession, dtMs: number, nowMs: number, sample: () => Input): number {
    this.acc += Math.min(dtMs, 250);
    // Time already accumulated counts as progress we're about to make.
    const adv = session.advantage(nowMs) + this.acc / TICK_MS;
    session.stats.advantage = adv;
    const outside = Math.abs(adv) <= DEADBAND ? 0 : adv - Math.sign(adv) * DEADBAND;
    const adjust = Math.max(-MAX_ADJUST, Math.min(MAX_ADJUST, outside * SYNC_GAIN));
    const interval = TICK_MS * (1 + adjust);
    let ticks = 0;
    while (this.acc >= interval && ticks < MAX_TICKS_PER_UPDATE) {
      if (!session.advance(sample(), nowMs)) {
        this.acc = Math.min(this.acc, interval);
        break;
      }
      this.acc -= interval;
      ticks++;
    }
    if (ticks === MAX_TICKS_PER_UPDATE) this.acc = Math.min(this.acc, interval);
    // Apply any rollback triggered by inputs received since the last tick before rendering.
    session.flushRollback();
    return ticks;
  }
}
