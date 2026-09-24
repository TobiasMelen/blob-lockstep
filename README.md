# Blob Lockstep

Two desktops connect peer-to-peer and drag the same jelly blob around. There's no backend. The
physics is deterministic and runs as a lockstep simulation with input delay and rollback.

## Run

```sh
npm install
npm run dev      # http://localhost:5173
npm test         # determinism, rollback-over-lossy-network and blob integrity tests
npm run build    # static site in dist/
```

1. Open the site on computer A. It creates a room, puts its id in the URL (`#abc123`) and you
   can start playing right away.
2. Send that URL to computer B. B looks for someone in the room first (no game runs meanwhile),
   then connects, receives the current game state and joins mid-game. If the room turns out to
   be empty, B starts a fresh game and waits there instead.
3. Click and drag anywhere near the blob to grab it. Both players can pull at once.

Whoever is in the room holds the game. If one player leaves or refreshes, the other keeps
playing and takes over hosting, and the returning player rejoins their game. A third visitor is
told the room is full. Opening the room link in a second tab on the same machine works too.

`?solo` runs the physics locally without networking.

### Debug URL parameters

| Param | Default | Meaning |
| --- | --- | --- |
| `delay` | `3` | Input delay in ticks (60 Hz). The host's value is used for both peers. |
| `maxPrediction` | `12` | Max ticks to run ahead of confirmed remote input before stalling. |
| `lag` | `0` | Artificial one-way latency (ms) added to outgoing messages. |
| `loss` | `0` | Artificial packet loss (0–0.9) on the unreliable input channel. |

For example, `?lag=80&loss=0.1` on both sides forces frequent rollbacks. The HUD shows ping,
rollbacks, stalls and the result of the periodic state-hash comparison.

## How it works

- **Signaling** (`src/net/signaling.ts`) is ported from acthung-webrtc. It uses the free
  [ppng.io](https://ppng.io) piping server: each peer long-polls `blob-lockstep-v1/<room>/<id>`
  and the other side POSTs to it. The ICE is non-trickle, so there's one offer and one answer.
  The host listens on `<room>/host` for as long as it's in the room. ppng.io allows one
  receiver per path, so a newcomer first tries to listen there too: an immediate `400` means
  someone already holds the room and it joins them, otherwise it becomes the host.
- **Joining mid-game** (`src/net/welcome.ts`): the host sends the Rapier world snapshot, the
  tick number and both players' inputs for the next `delay` ticks over the reliable channel,
  then both sides start a rollback session from that tick. The host restores the same snapshot
  on its side, so both continue from identically deserialized state.
- **WebRTC** (`src/net/peer.ts`) uses two pre-negotiated data channels. The unordered channel has
  no retransmits and carries inputs. The reliable channel carries control messages and state
  hashes. STUN is Google's. TURN (metered.ca) is used if `VITE_TURN_USERNAME` and
  `VITE_TURN_CREDENTIAL` are set, the same as in achtung.
- **Physics** (`src/sim/sim.ts`) uses `@dimforge/rapier2d-deterministic`, which gives
  cross-platform bit-identical results. The blob is a soft ring: 28 balls chained by revolute
  joints, sprung to a core, with skip-one bending springs and area pressure. Game logic outside
  Rapier only uses IEEE basic ops (`+ - * / sqrt`). No `Math.sin/cos/random` runs at runtime.
  Inputs are integer millimetres.
- **Netcode** (`src/net/rollback.ts`): local input sampled at tick `T` is applied at `T + delay`.
  Every tick, each peer sends all of its inputs the other side hasn't acknowledged, so losing a
  packet costs nothing. Missing remote input is predicted by repeating the last confirmed input.
  When the real input differs, the session restores the Rapier snapshot for that tick and
  resimulates. It stalls rather than predicting more than `maxPrediction` ticks ahead.
- **Time sync** (`src/net/pacer.ts`) is a fixed-timestep loop that stretches or shrinks the tick
  length based on the estimated frame advantage over the peer.
- **Rendering** (`src/render/`) uses three stacked layers:
  - A 2D canvas for the arena, redrawn only on resize.
  - A WebGL2 canvas where a single fragment pass draws the blob as a signed distance field.
    Each frame the CPU ray-casts a smoothed rim curve into a table of 128 radii around the
    blob's centroid, so per pixel the distance is a circle's `length(p) - R(angle)` with a
    cubic lookup, corrected by the radius slope. The glow, outline, anti-aliasing and dome
    lighting all come from that distance. Shading normals use a blurred copy of the table so
    dents don't crease the body. The eyes and grab tethers are also SDFs.
  - HTML cursors and labels, moved with `translate3d` so they're compositor-only.
- **Desync detection**: every 30 ticks, once a tick's state is final, both peers exchange an
  FNV hash of all body state and grab state. The HUD shows `in sync ✓` or `DESYNC`.

## Deploy

`.github/workflows/pages.yml` builds and deploys `dist/` to GitHub Pages on every push to
`master`. Pages must use "GitHub Actions" as its source. It doesn't run the tests or pass TURN
credentials; add `npm test` or `VITE_TURN_*` env vars to the build step if you need them.

## Limitations

- With no TURN configured, peers behind symmetric NATs or strict corporate firewalls can't
  connect. Same LAN or typical home networks work.
- Exactly two players.
- A link that goes silent for 4 s is treated as a disconnect. The game carries on and the guest
  rejoins automatically. That also happens if a player's tab is hidden for that long, because
  browsers pause `requestAnimationFrame` there and the simulation stops.
- WebKit (Safari) data channels between two pages on the same Mac stop delivering after a few
  seconds, even in a minimal test with no game code. The silence timeout turns that into a
  short reconnect instead of a permanent stall.
- ppng.io is a free public service with no uptime guarantee.
