import type { Input } from "../sim/input";
import type { SimSnapshot } from "../sim/sim";
import type { PeerLink } from "./peer";

/** Some browsers cap data channel messages at 64 KiB; stay well below. */
const CHUNK_CHARS = 16_000;
const WELCOME_TIMEOUT_MS = 10_000;

/** Everything a guest needs to join a running game in lockstep. */
export type Welcome = {
  tick: number;
  /** Player slot the guest takes. */
  player: number;
  delay: number;
  maxPrediction: number;
  /** Each player's input for the delay window starting at `tick`. */
  inputs: Input[];
  snapshot: SimSnapshot;
};

type Header = Omit<Welcome, "snapshot"> & { t: "welcome"; extra: SimSnapshot["extra"]; chunks: number };
type Chunk = { t: "welcome-chunk"; i: number; data: string };

export function sendWelcome(link: PeerLink, welcome: Welcome): void {
  const { snapshot, ...rest } = welcome;
  const data = toBase64(snapshot.world);
  const chunks = Math.ceil(data.length / CHUNK_CHARS);
  const header: Header = { t: "welcome", ...rest, extra: snapshot.extra, chunks };
  link.send(header, true);
  for (let i = 0; i < chunks; i++) {
    const chunk: Chunk = { t: "welcome-chunk", i, data: data.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) };
    link.send(chunk, true);
  }
}

export function receiveWelcome(link: PeerLink): Promise<Welcome> {
  return new Promise((resolve, reject) => {
    let header: Header | undefined;
    const parts: string[] = [];
    const timer = setTimeout(() => finish(new Error("Timed out receiving the game state")), WELCOME_TIMEOUT_MS);
    const off = link.onMessage((msg: Header | Chunk) => {
      if (msg.t === "welcome") header = msg;
      else if (msg.t === "welcome-chunk") parts[msg.i] = msg.data;
      else return;
      if (header && parts.filter((p) => p !== undefined).length === header.chunks) finish();
    });
    link.onClose(() => finish(new Error("Disconnected while receiving the game state")));

    function finish(err?: Error) {
      clearTimeout(timer);
      off();
      if (err) return reject(err);
      const { t, extra, chunks, ...rest } = header!;
      resolve({ ...rest, snapshot: { world: fromBase64(parts.join("")), extra } });
    }
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
