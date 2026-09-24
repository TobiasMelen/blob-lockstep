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

1. On computer A, click **Create room** and send the link to computer B.
2. B opens the link. The peers connect and the simulation starts.
3. Click and drag anywhere near the blob to grab it. Both players can pull at once.

Opening the room link in a second tab on the same machine works too.

**Try solo** runs the physics locally without networking.

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
  After connecting, signaling is closed.
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
- **Desync detection**: every 30 ticks, once a tick's state is final, both peers exchange an
  FNV hash of all body state and grab state. The HUD shows `in sync ✓` or `DESYNC`.

## Deploy

`.github/workflows/pages.yml` tests, builds and deploys `dist/` to GitHub Pages when you push to
`main` or `master`. Enable Pages with "GitHub Actions" as the source. To use TURN, add the
optional `VITE_TURN_*` repository secrets.

## Limitations

- With no TURN configured, peers behind symmetric NATs or strict corporate firewalls can't
  connect. Same LAN or typical home networks work.
- Exactly two players.
- ppng.io is a free public service with no uptime guarantee.
