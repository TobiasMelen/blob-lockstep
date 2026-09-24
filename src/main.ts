import "./style.css";
import { EMPTY_INPUT, type Input } from "./sim/input";
import { initPhysics, PLAYER_COUNT, Sim, TICK_RATE, WORLD_H, WORLD_W } from "./sim/sim";
import { type NetMessage, RollbackSession, TICK_MS } from "./net/rollback";
import { TickPacer } from "./net/pacer";
import {
  HostSilentError,
  hostRoom,
  joinRoom,
  type LinkConditions,
  type PeerLink,
  randomId,
  RoomFullError,
} from "./net/peer";
import { receiveWelcome, sendWelcome } from "./net/welcome";
import { cursorFromInput, Renderer } from "./render/renderer";

const params = new URLSearchParams(location.search);
const INPUT_DELAY = clampInt(params.get("delay"), 3, 0, 15);
const MAX_PREDICTION = clampInt(params.get("maxPrediction"), 12, 1, 60);
/** Debug: artificial one-way lag (ms) and packet loss on outgoing messages. */
const CONDITIONS: LinkConditions = {
  lagMs: clampInt(params.get("lag"), 0, 0, 2000),
  loss: Math.min(0.9, Math.max(0, Number(params.get("loss")) || 0)),
};
/** How long a would-be host waits for ppng.io to report that the room already has one. */
const TAKEN_GRACE_MS = 1500;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $("stage");
const bar = $("bar");
const statusEl = $("status");
const hud = $("hud");
const toast = $("toast");
const renderer = new Renderer(stage);

const pointer = { x: WORLD_W / 2, y: WORLD_H / 2, down: false, inside: false };
const eventToWorld = (e: PointerEvent) => {
  const rect = stage.getBoundingClientRect();
  return renderer.toWorld(e.clientX - rect.left, e.clientY - rect.top);
};
stage.addEventListener("pointermove", (e) => {
  Object.assign(pointer, eventToWorld(e), { inside: true });
});
stage.addEventListener("pointerdown", (e) => {
  Object.assign(pointer, eventToWorld(e), { down: true, inside: true });
  if (stage.hasPointerCapture?.(e.pointerId) === false) {
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already-released pointers can't be captured.
    }
  }
});
const release = () => (pointer.down = false);
stage.addEventListener("pointerup", release);
stage.addEventListener("pointercancel", release);
stage.addEventListener("pointerleave", () => (pointer.inside = false));
window.addEventListener("blur", release);

function sampleInput(): Input {
  const q = (v: number, max: number) => Math.round(Math.min(max, Math.max(0, v)) * 1000);
  return { x: q(pointer.x, WORLD_W), y: q(pointer.y, WORLD_H), down: pointer.down ? 1 : 0 };
}

function setStatus(text: string, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", error);
}

function showToast(text: string) {
  toast.textContent = text;
  toast.hidden = false;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number) {
  const n = raw == null ? NaN : parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// ---------------------------------------------------------------- game state

/** Nobody else connected: the other player's slot gets empty input. */
type LocalGame = {
  kind: "local";
  sim: Sim;
  player: number;
  tick: number;
  acc: number;
  /** Our input for the last simulated tick, carried into a session when a guest joins. */
  last: Input;
};
type NetGame = { kind: "net"; session: RollbackSession; pacer: TickPacer; link: PeerLink };

/** Null until we know whether to start a game or join one already running in the room. */
let game: LocalGame | NetGame | null = null;
let room = "";
let hosting: { close(): void } | null = null;

function playLocal(sim: Sim, player: number, tick: number) {
  game = { kind: "local", sim, player, tick, acc: 0, last: EMPTY_INPUT };
  hud.hidden = true;
}

function stepLocal(g: LocalGame, dtMs: number) {
  g.acc += Math.min(dtMs, 250);
  while (g.acc >= TICK_MS) {
    const input = sampleInput();
    const inputs = new Array<Input>(PLAYER_COUNT).fill(EMPTY_INPUT);
    inputs[g.player] = input;
    g.sim.step(inputs);
    g.tick++;
    g.last = input;
    g.acc -= TICK_MS;
  }
}

function startNet(link: PeerLink, localPlayer: number, delay: number, maxPrediction: number, resume: { sim: Sim; tick: number; inputs: Input[] }) {
  const session = new RollbackSession({
    localPlayer,
    inputDelay: delay,
    maxPrediction,
    resume,
    transport: { send: (msg, reliable) => link.send(msg, reliable) },
    onDesync: (tick, local, remote) => {
      console.error(`Desync at tick ${tick}: local ${local.toString(16)} remote ${remote.toString(16)}`);
      showToast(`Desync detected at tick ${tick}. Simulation diverged.`);
    },
  });
  const g: NetGame = { kind: "net", session, pacer: new TickPacer(), link };
  game = g;
  bar.hidden = true;
  hud.hidden = false;
  toast.hidden = true;
  link.onMessage((msg: NetMessage | { t: string }) => {
    if (game !== g) return;
    if (msg.t === "in" || msg.t === "hash" || msg.t === "ping" || msg.t === "pong") {
      session.receive(msg as NetMessage, performance.now());
    }
  });
  link.onClose(() => {
    if (game !== g) return;
    // Keep playing from where we are; whoever stays in the room carries the game on.
    playLocal(session.sim, session.localPlayer, session.tick);
    showInvite("Your friend left. Waiting for someone to join…");
    if (!hosting) becomeHost();
  });
}

// ---------------------------------------------------------------- room

function showInvite(text = "Waiting for a friend to open the link…") {
  const shareLink = $<HTMLInputElement>("share-link");
  shareLink.value = location.href;
  $("share").hidden = false;
  $("retry").hidden = true;
  bar.hidden = false;
  setStatus(text);
}

/** Take the room with whatever game we have. If someone else already holds it, join them instead. */
function becomeHost() {
  hosting = hostRoom(room, CONDITIONS, {
    accepting: () => game?.kind !== "net",
    onGuest: welcomeGuest,
    onTaken: () => {
      hosting = null;
      void joinGame();
    },
    onError: (err) => setStatus(err.message, true),
    status: (text) => setStatus(text),
  });
}

function welcomeGuest(link: PeerLink) {
  // A guest can arrive while we're still checking the room; nobody else holds it, so start fresh.
  if (!game) playLocal(Sim.create(), 0, 0);
  const g = game!;
  if (g.kind !== "local") return link.close();
  // Restore our own snapshot too so both sides continue from identical deserialized state.
  const snapshot = g.sim.save();
  g.sim.load(snapshot);
  const inputs = new Array<Input>(PLAYER_COUNT).fill(EMPTY_INPUT);
  inputs[g.player] = g.last;
  const guest = 1 - g.player;
  sendWelcome(link, { tick: g.tick, player: guest, delay: INPUT_DELAY, maxPrediction: MAX_PREDICTION, inputs, snapshot });
  startNet(link, g.player, INPUT_DELAY, MAX_PREDICTION, { sim: g.sim, tick: g.tick, inputs });
}

async function joinGame() {
  $("share").hidden = true;
  $("retry").hidden = true;
  bar.hidden = false;
  try {
    const link = await joinRoom(room, CONDITIONS, (text) => setStatus(text));
    setStatus("Connected, receiving the game…");
    const welcome = await receiveWelcome(link);
    const sim = Sim.create();
    sim.load(welcome.snapshot);
    const previous = game;
    startNet(link, welcome.player, welcome.delay, welcome.maxPrediction, {
      sim,
      tick: welcome.tick,
      inputs: welcome.inputs,
    });
    if (previous?.kind === "local") previous.sim.dispose();
  } catch (err: any) {
    if (err instanceof HostSilentError) {
      // A listener was registered but nobody answered (e.g. left over from a closed tab).
      takeRoom();
      return;
    }
    setStatus(err?.message ?? String(err), true);
    if (!(err instanceof RoomFullError) && game?.kind === "local") {
      // We have a game of our own; stay available in case the other side comes back.
      becomeHost();
      return;
    }
    $("retry").hidden = false;
  }
}

/** Host the room with our current game, starting a fresh one if we have none. */
function takeRoom() {
  if (!game) playLocal(Sim.create(), 0, 0);
  showInvite();
  if (!hosting) becomeHost();
}

// ---------------------------------------------------------------- frame loop

let last = performance.now();
let lastHud = 0;
function frame(now: number) {
  const dt = now - last;
  last = now;
  const g = game;
  if (!g) {
    // Still looking for a friend: arena only.
  } else if (g.kind === "local") {
    stepLocal(g, dt);
    renderer.draw(g.sim, pointer.inside ? [cursorFromInput(sampleInput(), g.player, "you")] : []);
  } else {
    const { session, pacer } = g;
    pacer.update(session, dt, now, sampleInput);
    const cursors = [
      cursorFromInput(session.latestRemoteInput(), session.remotePlayer, "friend"),
      ...(pointer.inside ? [cursorFromInput(sampleInput(), session.localPlayer, "you")] : []),
    ];
    renderer.draw(session.sim, cursors);
    if (now - lastHud > 200) {
      lastHud = now;
      renderHud(session);
    }
  }
  requestAnimationFrame(frame);
}

function renderHud(session: RollbackSession) {
  const s = session.stats;
  const sync =
    s.desyncTick >= 0
      ? `<span class="bad">DESYNC @${s.desyncTick}</span>`
      : s.lastCheckedHashTick >= 0
        ? `<span class="ok">in sync ✓</span> @${s.lastCheckedHashTick}`
        : "checking…";
  const lines = [
    `player      ${session.localPlayer + 1} (${hosting ? "host" : "guest"})`,
    `tick        ${s.tick}  (confirmed ${s.confirmedTick})`,
    `ping        ${s.rttMs.toFixed(0)} ms`,
    `input delay ${session.inputDelay} ticks (${((session.inputDelay * 1000) / TICK_RATE).toFixed(0)} ms)`,
    `advantage   ${s.advantage.toFixed(2)} ticks`,
    `rollbacks   ${s.rollbacks}  last ${s.lastRollbackDepth}  max ${s.maxRollbackDepth}`,
    `stalls      ${s.stalls}`,
    `sync        ${sync}`,
  ];
  if (CONDITIONS.lagMs || CONDITIONS.loss) {
    lines.push(`sim link    +${CONDITIONS.lagMs} ms, ${(CONDITIONS.loss * 100).toFixed(0)}% loss`);
  }
  hud.innerHTML = lines.join("\n");
}

// ---------------------------------------------------------------- boot

async function boot() {
  setStatus("Loading physics…");
  await initPhysics();
  requestAnimationFrame(frame);
  if (import.meta.env.DEV) Object.assign(window, { __blob: { get game() { return game; }, renderer, pointer } });

  $("retry").onclick = () => location.reload();
  $("copy").onclick = async () => {
    await navigator.clipboard.writeText($<HTMLInputElement>("share-link").value);
    $("copy").textContent = "Copied!";
    setTimeout(() => ($("copy").textContent = "Copy link"), 1500);
  };
  window.addEventListener("hashchange", () => location.reload());
  window.addEventListener("beforeunload", () => {
    hosting?.close();
    if (game?.kind === "net") game.link.close();
  });

  if (params.has("solo")) {
    bar.hidden = true;
    playLocal(Sim.create(), 0, 0);
    return;
  }

  room = location.hash.slice(1);
  if (!room) {
    // A brand-new room can't have anyone in it yet.
    room = randomId();
    history.replaceState(null, "", `#${room}`);
    takeRoom();
    return;
  }

  // Try to take the room; ppng.io rejects a second listener at once if someone already holds
  // it, in which case onTaken switches to joining. No game runs until we know which.
  setStatus("Looking for your friend…");
  becomeHost();
  await new Promise((resolve) => setTimeout(resolve, TAKEN_GRACE_MS));
  if (hosting && !game) takeRoom();
}

void boot();
