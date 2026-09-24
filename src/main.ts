import "./style.css";
import { EMPTY_INPUT, type Input } from "./sim/input";
import { initPhysics, Sim, TICK_RATE, WORLD_H, WORLD_W } from "./sim/sim";
import { type NetMessage, RollbackSession } from "./net/rollback";
import { TickPacer } from "./net/pacer";
import { hostRoom, joinRoom, type LinkConditions, type PeerLink, randomId } from "./net/peer";
import { cursorFromInput, Renderer } from "./render/renderer";

const params = new URLSearchParams(location.search);
const INPUT_DELAY = clampInt(params.get("delay"), 3, 0, 15);
const MAX_PREDICTION = clampInt(params.get("maxPrediction"), 12, 1, 60);
/** Debug: artificial one-way lag (ms) and packet loss on outgoing messages. */
const CONDITIONS: LinkConditions = {
  lagMs: clampInt(params.get("lag"), 0, 0, 2000),
  loss: Math.min(0.9, Math.max(0, Number(params.get("loss")) || 0)),
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $("stage");
const lobby = $("lobby");
const lobbyActions = $("lobby-actions");
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

function exposeDebug(state: object) {
  if (import.meta.env.DEV) Object.assign(window, { __blob: { state, renderer, pointer } });
}

function clampInt(raw: string | null, fallback: number, min: number, max: number) {
  const n = raw == null ? NaN : parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// ---------------------------------------------------------------- networked play

type StartMessage = { t: "start"; delay: number; maxPrediction: number };

function startSession(link: PeerLink, localPlayer: number, delay: number, maxPrediction: number) {
  lobby.hidden = true;
  hud.hidden = false;

  const session = new RollbackSession({
    localPlayer,
    inputDelay: delay,
    maxPrediction,
    transport: { send: (msg, reliable) => link.send(msg, reliable) },
    onDesync: (tick, local, remote) => {
      console.error(`Desync at tick ${tick}: local ${local.toString(16)} remote ${remote.toString(16)}`);
      showToast(`Desync detected at tick ${tick}. Simulation diverged.`);
    },
  });
  exposeDebug({ session, get sim() { return session.sim; } });
  link.onMessage((msg: NetMessage | { t: string }) => {
    if (msg.t === "in" || msg.t === "hash" || msg.t === "ping" || msg.t === "pong") {
      session.receive(msg as NetMessage, performance.now());
    }
  });

  let running = true;
  link.onClose(() => {
    running = false;
    showToast("The other player disconnected. Reload to start a new room.");
  });
  window.addEventListener("beforeunload", () => link.close());

  const pacer = new TickPacer();
  const labels = localPlayer === 0 ? ["you (host)", "friend"] : ["friend", "you"];
  let last = performance.now();
  let lastHud = 0;
  const frame = (now: number) => {
    if (running) pacer.update(session, now - last, now, sampleInput);
    last = now;

    const local: Input = { ...sampleInput() };
    const cursors = [
      cursorFromInput(session.latestRemoteInput(), session.remotePlayer, labels[session.remotePlayer]),
      ...(pointer.inside ? [cursorFromInput(local, localPlayer, labels[localPlayer])] : []),
    ];
    renderer.draw(session.sim, cursors);

    if (now - lastHud > 200) {
      lastHud = now;
      renderHud(session);
    }
    requestAnimationFrame(frame);
  };
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
    `player      ${session.localPlayer === 0 ? "host" : "guest"}`,
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

async function host() {
  const room = randomId();
  const url = new URL(location.href);
  url.hash = room;
  const shareLink = $<HTMLInputElement>("share-link");
  shareLink.value = url.toString();
  $("share").hidden = false;
  lobbyActions.hidden = true;
  $("copy").onclick = async () => {
    await navigator.clipboard.writeText(shareLink.value);
    $("copy").textContent = "Copied!";
  };
  try {
    const link = await hostRoom(room, CONDITIONS, setStatus);
    const start: StartMessage = { t: "start", delay: INPUT_DELAY, maxPrediction: MAX_PREDICTION };
    link.send(start, true);
    startSession(link, 0, INPUT_DELAY, MAX_PREDICTION);
  } catch (err: any) {
    setStatus(err?.message ?? String(err), true);
  }
}

async function join(room: string) {
  lobbyActions.hidden = true;
  try {
    const link = await joinRoom(room, CONDITIONS, setStatus);
    setStatus("Connected, waiting for host to start…");
    const start = await new Promise<StartMessage>((resolve) => {
      const off = link.onMessage((msg) => {
        if (msg?.t === "start") {
          off();
          resolve(msg);
        }
      });
    });
    startSession(link, 1, start.delay, start.maxPrediction);
  } catch (err: any) {
    setStatus(err?.message ?? String(err), true);
    lobbyActions.hidden = false;
    $("retry").hidden = false;
    $("create").classList.add("secondary");
  }
}

// ---------------------------------------------------------------- solo play

function solo() {
  lobby.hidden = true;
  const sim = Sim.create();
  exposeDebug({ sim });
  const tickMs = 1000 / TICK_RATE;
  let acc = 0;
  let last = performance.now();
  const frame = (now: number) => {
    acc += Math.min(now - last, 250);
    last = now;
    while (acc >= tickMs) {
      sim.step([sampleInput(), EMPTY_INPUT]);
      acc -= tickMs;
    }
    renderer.draw(sim, pointer.inside ? [cursorFromInput(sampleInput(), 0, "you")] : []);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- boot

async function boot() {
  setStatus("Loading physics…");
  await initPhysics();
  setStatus("");
  const room = location.hash.slice(1);
  $("create").onclick = () => {
    history.replaceState(null, "", location.pathname + location.search);
    void host();
  };
  $("retry").onclick = () => location.reload();
  $("solo").onclick = solo;
  if (room) void join(room);
  else if (params.has("solo")) solo();

  // Idle background so the lobby isn't empty.
  const preview = Sim.create();
  const idle = () => {
    if (lobby.hidden) return preview.dispose();
    preview.step([EMPTY_INPUT, EMPTY_INPUT]);
    renderer.draw(preview, []);
    requestAnimationFrame(idle);
  };
  requestAnimationFrame(idle);
}

void boot();
