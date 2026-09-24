import { PipingSignaling } from "./signaling";

const HOST_ID = "host";
const ICE_GATHER_TIMEOUT_MS = 4000;
const ANSWER_TIMEOUT_MS = 10000;
const CONNECT_TIMEOUT_MS = 10000;
const JOIN_ATTEMPTS = 3;
const SILENCE_TIMEOUT_MS = 4000;

export const RTC_CONFIG: RTCConfiguration = {
  iceCandidatePoolSize: 4,
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    ...(import.meta.env.VITE_TURN_USERNAME && import.meta.env.VITE_TURN_CREDENTIAL
      ? [
          {
            urls: [
              "turn:global.relay.metered.ca:80",
              "turn:global.relay.metered.ca:80?transport=tcp",
              "turn:global.relay.metered.ca:443",
              "turns:global.relay.metered.ca:443?transport=tcp",
            ],
            username: import.meta.env.VITE_TURN_USERNAME,
            credential: import.meta.env.VITE_TURN_CREDENTIAL,
          },
        ]
      : []),
  ],
};

export type LinkConditions = { lagMs: number; loss: number };

/** A connected peer: one unreliable/unordered channel for inputs, one reliable for control. */
export class PeerLink {
  private readonly listeners = new Set<(msg: any) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  private lastHeard = performance.now();
  private readonly watchdog: ReturnType<typeof setInterval>;

  constructor(
    readonly pc: RTCPeerConnection,
    private readonly fast: RTCDataChannel,
    private readonly reliable: RTCDataChannel,
    private readonly conditions: LinkConditions,
  ) {
    const onMessage = (e: MessageEvent) => {
      this.lastHeard = performance.now();
      const msg = JSON.parse(e.data);
      this.listeners.forEach((cb) => cb(msg));
    };
    // A dead transport can sit in "disconnected" for 30 s+ before "failed", with channels
    // still reporting open. Peers talk every tick, so prolonged silence means it's gone.
    this.watchdog = setInterval(() => {
      if (performance.now() - this.lastHeard > SILENCE_TIMEOUT_MS) {
        console.warn(`No messages from peer for ${SILENCE_TIMEOUT_MS} ms, closing link`);
        this.close();
      }
    }, 500);
    fast.onmessage = onMessage;
    reliable.onmessage = onMessage;
    const onClose = () => this.handleClose();
    fast.onclose = onClose;
    reliable.onclose = onClose;
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") onClose();
    });
  }

  send(msg: unknown, reliable: boolean): void {
    const channel = reliable ? this.reliable : this.fast;
    const data = JSON.stringify(msg);
    const { lagMs, loss } = this.conditions;
    if (!reliable && loss > 0 && Math.random() < loss) return;
    const deliver = () => {
      if (channel.readyState === "open") channel.send(data);
    };
    if (lagMs > 0) setTimeout(deliver, lagMs);
    else deliver();
  }

  onMessage(cb: (msg: any) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onClose(cb: () => void): void {
    this.closeListeners.add(cb);
  }

  close(): void {
    this.handleClose();
    this.pc.close();
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    this.closeListeners.forEach((cb) => cb());
  }
}

function createPeer(conditions: LinkConditions) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  // Pre-negotiated channels exist on both sides without an ondatachannel round trip.
  const fast = pc.createDataChannel("inputs", { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
  const reliable = pc.createDataChannel("control", { negotiated: true, id: 1, ordered: true });
  const iceFailed = new Promise<never>((_, reject) => {
    pc.addEventListener("iceconnectionstatechange", () => {
      if (pc.iceConnectionState === "failed") {
        reject(new Error("Peer-to-peer connection failed (a TURN server may be needed on this network)"));
      }
    });
  });
  iceFailed.catch(() => {});
  const opened = Promise.race([
    Promise.all([fast, reliable].map(waitOpen)).then(() => new PeerLink(pc, fast, reliable, conditions)),
    iceFailed,
  ]);
  return { pc, opened };
}

function waitOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    channel.addEventListener("open", () => resolve(), { once: true });
    channel.addEventListener("close", () => reject(new Error("Data channel closed")), { once: true });
  });
}

/** Non-trickle ICE: wait until all candidates are in the local description (one signaling message each way). */
async function gatheredDescription(pc: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
  if (pc.iceGatheringState !== "complete") {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, ICE_GATHER_TIMEOUT_MS);
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  }
  return pc.localDescription!.toJSON();
}

export function randomId(length = 6): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export type Status = (text: string) => void;

export class RoomFullError extends Error {
  constructor() {
    super("This room already has two players.");
  }
}

/** Nobody answered the offer: the room's host is gone (e.g. a stale listener from a closed tab). */
export class HostSilentError extends Error {
  constructor() {
    super("The host did not answer.");
  }
}

export type HostOptions = {
  /** Whether a guest may connect now; otherwise offers are answered with "full". */
  accepting: () => boolean;
  onGuest: (link: PeerLink) => void;
  /** Another tab already hosts this room. Signaling has stopped; join it instead. */
  onTaken: () => void;
  onError: (err: Error) => void;
  status: Status;
};

/**
 * Host `room` until closed, handing each connected guest to `onGuest`. A newer offer
 * supersedes a pending attempt, so a guest that retries (or reloads) mid-handshake isn't
 * locked out. Listening continues while a game runs so extra visitors learn it's full
 * rather than mistaking the room for empty.
 */
export function hostRoom(room: string, conditions: LinkConditions, opts: HostOptions): { close(): void } {
  let pending: RTCPeerConnection | undefined;
  const signaling = new PipingSignaling(room, HOST_ID, {
    onFailed: () => opts.onError(new Error("Lost connection to the signaling service (ppng.io)")),
    onTaken: () => {
      pending?.close();
      opts.onTaken();
    },
  });

  signaling.addListener(async ({ from, data }) => {
    if (data?.type !== "offer" || typeof from !== "string") return;
    if (!opts.accepting()) {
      void signaling.send(from, { type: "full" });
      return;
    }
    pending?.close();
    opts.status("Friend found, connecting…");
    const { pc, opened } = createPeer(conditions);
    pending = pc;
    try {
      await pc.setRemoteDescription(data);
      await pc.setLocalDescription(await pc.createAnswer());
      await signaling.send(from, await gatheredDescription(pc));
      const link = await withTimeout(opened, CONNECT_TIMEOUT_MS, "Peer connection timed out");
      if (pending !== pc) return link.close();
      pending = undefined;
      opts.onGuest(link);
    } catch (err) {
      pc.close();
      if (pending !== pc) return;
      pending = undefined;
      console.warn("Guest connection failed, waiting for another attempt", err);
      opts.status("Connection attempt failed, still waiting…");
    }
  });
  return {
    close() {
      pending?.close();
      signaling.close();
    },
  };
}

/** Connect to the host of `room`, retrying the whole handshake a few times. */
export async function joinRoom(room: string, conditions: LinkConditions, status: Status): Promise<PeerLink> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await joinOnce(room, conditions, (text) =>
        status(attempt > 1 ? `${text} (attempt ${attempt}/${JOIN_ATTEMPTS})` : text),
      );
    } catch (err) {
      if (attempt >= JOIN_ATTEMPTS || err instanceof RoomFullError || err instanceof HostSilentError) throw err;
      console.warn(`Join attempt ${attempt} failed, retrying`, err);
    }
  }
}

async function joinOnce(room: string, conditions: LinkConditions, status: Status): Promise<PeerLink> {
  const myId = randomId(10);
  let failSignaling: (err: Error) => void = () => {};
  const signalingFailed = new Promise<never>((_, reject) => (failSignaling = reject));
  const signaling = new PipingSignaling(room, myId, {
    onFailed: () => failSignaling(new Error("Lost connection to the signaling service (ppng.io)")),
  });
  const { pc, opened } = createPeer(conditions);
  try {
    status("Gathering network candidates…");
    await pc.setLocalDescription(await pc.createOffer());
    const offer = await gatheredDescription(pc);

    const answer = new Promise<RTCSessionDescriptionInit>((resolve, reject) => {
      signaling.addListener(({ data }) => {
        if (data?.type === "answer") resolve(data);
        if (data?.type === "full") reject(new RoomFullError());
      });
    });
    status("Contacting host…");
    void signaling.send(HOST_ID, offer);
    const remote = await Promise.race([
      withTimeout(answer, ANSWER_TIMEOUT_MS, new HostSilentError()),
      signalingFailed,
    ]);
    await pc.setRemoteDescription(remote);
    status("Connecting peer-to-peer…");
    return await withTimeout(opened, CONNECT_TIMEOUT_MS, "Peer connection timed out (a TURN server may be needed on this network)");
  } catch (err) {
    pc.close();
    throw err;
  } finally {
    signaling.close();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, error: string | Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(typeof error === "string" ? new Error(error) : error), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
