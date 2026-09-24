/**
 * Signaling over ppng.io, a free public "piping server": a POST to a path is streamed to
 * whoever does a GET on the same path. Each peer long-polls its own path `<room>/<id>`
 * and others POST to it. Ported from acthung-webrtc's usePPNGSignaling.
 */
const PPNG_BASE = "https://ppng.io";
const NAMESPACE = "blob-lockstep-v1";

export type SignalMessage = { from: string; data: any };

export type SignalingEvents = {
  onFailed?: () => void;
  /** ppng.io allows one receiver per path: someone else is already listening on ours. */
  onTaken?: () => void;
};

export class PipingSignaling {
  private readonly abort = new AbortController();
  private readonly listeners = new Set<(msg: SignalMessage) => void>();
  private failures = 0;

  constructor(
    private readonly room: string,
    private readonly myId: string,
    private readonly events: SignalingEvents = {},
  ) {
    void this.poll();
  }

  private url(id: string): string {
    return `${PPNG_BASE}/${encodeURIComponent(`${NAMESPACE}/${this.room}/${id}`)}`;
  }

  async send(to: string, data: unknown): Promise<void> {
    // The POST only completes once the recipient's GET picks it up, so retry a few times
    // in case the recipient is between polls or the server drops us.
    for (let attempt = 0; attempt < 5 && !this.abort.signal.aborted; attempt++) {
      try {
        const res = await fetch(this.url(to), {
          method: "POST",
          body: JSON.stringify({ from: this.myId, data }),
          signal: this.abort.signal,
        });
        if (res.ok) return;
      } catch (err: any) {
        if (err?.name === "AbortError") return;
      }
      await sleep(1000);
    }
  }

  addListener(listener: (msg: SignalMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.abort.abort();
    this.listeners.clear();
  }

  private async poll(): Promise<void> {
    const url = this.url(this.myId);
    while (!this.abort.signal.aborted) {
      try {
        // no-store: Chrome's HTTP cache otherwise queues a same-URL GET behind another tab's pending one.
        const res = await fetch(url, { signal: this.abort.signal, cache: "no-store" });
        if (res.status === 400 && this.events.onTaken) {
          this.close();
          this.events.onTaken();
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.failures = 0;
        const text = await res.text();
        if (!text) continue;
        let msg: SignalMessage;
        try {
          msg = JSON.parse(text);
        } catch {
          continue;
        }
        this.listeners.forEach((cb) => cb(msg));
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        if (++this.failures > 5) {
          this.events.onFailed?.();
          return;
        }
        await sleep(1000);
      }
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
