# SynBrane project context

## Overview
SynBrane is an experimental music tool pairing a lightweight browser UI with a Node.js backend. The browser now focuses on a streamlined two-panel layout: a **Chords** box for editing up to five loop chords (one at a time) using a circular note selector, and a **Synth Parameters** box for global playback controls and patch management. Chord edits are sent to the backend/audio engine for live playback or WAV renders. The top of the page carries a cyberpunk-style ASCII "SynBrane" banner above the subtitle.
The header includes a simple link to a dedicated About page (`/about.html`) with centered copy that walks through how SynBrane works across harmony and rhythm modes, looping, patching, and supported tunings.

The About link now sits beneath the subtitle, aligned to the right so it no longer overlaps the ASCII banner.

## Architecture
- **Frontend** (`public/`)
  - Plain HTML/CSS/JS served statically by Cloudflare Workers Static Assets after cutover, locally by the Node server or Wrangler. The existing Vercel site remains available until the owner completes cutover.
  - Chords panel: up to five chord tabs, with the visible count controlled by a "Chords in loop" selector. Each chord stores its own tuning, root, notes, and preset on a multi-octave spiral picker covering three visible octaves (0–2) for the current temperament rather than any circle-of-fifths ordering. The picker uses compact degree labels with a ° symbol (e.g., `7°`) that start at 1 for non-12-EDO tunings, spacing tuned for dense temperaments like 31-EDO, and temperament-specific color themes with subdued inactive bubbles and high-contrast highlighted selections. Preset chords are fetched per tuning from the backend (universal ratios plus temperament-specific sets) and applied by degree, and users can still toggle any point afterward. Root selectors track degree names per temperament. Interval and frequency readouts explain the chosen notes (cents/steps from root, Hz). A per-chord preview loop toggle stays in this panel while arpeggiation moved to global controls.
  - Synth Parameters panel: compact controls for mode (Harmony/Rhythm), tempo, rhythm multiplier, waveform, master volume, ADSR, filter settings, and loop chord count. The rhythm slider now ranges from roughly 0.1–1.0× (default ~0.3×) for subtle timing shifts instead of fast multipliers. A gentle detune control smooths polyphonic previews for dense temperaments. Patch Save/Load controls sit at the top of the panel for quick access, with master volume pinned ahead of the remaining synth sliders. The rendered loop audio player now sits directly beneath the Render Loop button in the chords panel for immediate access where the render is triggered.
  - Global arpeggiator: a switch-style toggle lives alongside the chord dropdowns so it is visible while setting tunings and presets. When flipped on it applies one pattern/rate to all chords, and the same settings drive both chord previews and loop playback/renders.
- Patch system: Save downloads a JSON file carrying global mode/tempo/rhythm/synth (including master volume)/preview/global arpeggiator plus per-chord tuning, root, preset id, notes, and the loop chord count. Load applies a JSON patch and updates the UI; rhythm multipliers are clamped to the current slider range when loading.
  - Loop playback/render: builds a loop-length-limited (1–5 chords) sequence (one bar per visible chord) with explicit tuning ids, full degree lists, per-event arpeggiator settings (both structured and pattern/rate flags), and derived frequencies. The resulting payload is reused verbatim by both the Web Audio loop preview path and `/api/render`, so previews and renders share identical timing, synth/rhythm settings, and 10-loop length.

- **Backend** (`server/`)
  - Minimal HTTP server exposing REST endpoints:
    - `GET /api/tunings` — returns available tunings (EDO presets + Scala discoveries) with ids, type, value, label, description, intervals, and base frequency metadata.
    - `GET /api/chords?tuningId=...` — returns chord options and root labels for the selected tuning. Universal presets map ratio/cents shapes into any temperament; temperament-specific presets cover 8/12/19/22/24/31-EDO (including Orwell-derived voicings folded into 31-EDO), and Scala tunings generate modal triads/tetrads, fifth stacks, and step-weave voicings. The endpoint prefers `tuningId` and still honors legacy `tuningType`/`tuningValue` query params. Degree-equivalent presets are deduplicated per temperament (keeping temperament-specific shapes first) so each tuning shows a unique set of chord options.
    - `POST /api/play` — triggers playback (single chord or a sequence) through the active audio engine, carrying synth settings when provided.
    - `POST /api/render` — renders a single chord or a multi-bar sequence to WAV with the requested synth/rhythm settings and returns the file URL, forwarding the fully normalized job (including loop counts and arpeggiator flags) straight to the audio layer.
    - Playback and render endpoints now share a common job normalizer (`buildJobFromBody`) so loop sequences, arpeggiator flags, and synth settings are expanded identically for live play and renders.
  - Serves static assets from `public/` and rendered files from `RENDER_OUTPUT_DIR`.
  - Tuning helpers live in `server/tuning/`.

- **Audio engines** (`server/audio/`)
  - `supercolliderClient.js` — writes small SuperCollider scripts and executes them via `sclang`. Provides `playRealtime` and `renderToFile` using SynthDefs for harmony and overtone-rich rhythm mapping.
  - `engine.js` — Node DSP fallback synthesizing harmony voices with selectable waveforms, ADSR envelopes, optional resonant low-pass filter, and arpeggiated rendering based on per-event pattern/rate fields. Rhythm voices lock a four-on-the-floor kick with snares on beats 2 and 4, add steady hats, and map chord notes onto toms/claps/percussion on 4–16 step grids. Harmony rendering honors detune cents per voice and arpeggiator timing to mirror the browser. Supports single-chord renders and multi-event sequences.
  - `index.js` — selects SuperCollider when `SUPER_COLLIDER_ENABLED=true`; otherwise uses the Node path and falls back automatically on errors.

## Audio behavior
- **Harmony mode (Node DSP)**: oscillator waveforms (sine/saw/square), ADSR envelope, optional resonant low-pass filter, and loudness normalized around -4 dBFS. Arpeggio patterns are active and honor the global arpeggiator settings (enable/pattern/rate) from the UI.
- **Rhythm mode (Node DSP)**: drum kit voices with overtone partials but no added saturation so renders mirror the cleaner Web Audio preview. A kick + snare backbone anchors beats 1/3 and 2/4, hats ride across 4–16 step grids, and chord tones map onto toms/claps/extra percussion with density shaped by the rhythm-speed slider (0.1–1.0×). Partial stacks are now band-limited per hit to avoid aliasing, and rendered rhythms run through a gentle low-pass to keep cymbals bright without brittle foldover.
- **Browser preview** mirrors these designs using in-browser Web Audio for chord/loop previews without relying on backend playback. The preview path supports globally arpeggiated or looped chords with per-note detune for smoother stacks and ensures arpeggiated previews cycle through every highlighted note before finishing.

## Deployment model
- **Cloudflare target:** `wrangler.jsonc` names Worker `synbrane`, loads the module `worker/index.mjs`, uses compatibility date `2026-10-06`, explicitly enables `workers.dev`, and serves `./public` through `ASSETS`. `/api` and `/api/*` run the Worker first; ordinary files keep normal static asset routing. There is no SPA fallback or frontend build step. Unknown API routes return JSON 404; other missing files return a static 404.
- **Backend:** the existing DigitalOcean origin is `http://147-182-251-148.sslip.io:3001`. Node/audio synthesis remains there. The Worker runtime variable `BACKEND_BASE` includes this non-secret initial value in Wrangler for the first dashboard deployment. Only HTTP(S) origins are accepted, without credentials, path prefixes, query strings, or fragments. Cloudflare Worker subrequests must use a hostname instead of a numeric IP. The temporary third-party `sslip.io` hostname maps to `147.182.251.148` without buying a domain or creating DNS records; it does not provide TLS. Update the hostname if the droplet IP changes. Loopback-IP overrides are for local Wrangler development only.
- **Browser:** the empty `API_BASE` default keeps all browser API requests and rendered audio on the current HTTPS origin. Web Audio preview, tuning/chord behavior, patches, and synth code are unchanged. Do not set `window.SYNBRANE_API_BASE` for Cloudflare deployment.
- **Cutover:** existing Vercel hosting at `https://syn-brane.vercel.app` and the legacy `api/` handlers remain intact. Cloudflare does not execute those handlers. Do not disconnect Vercel or change DNS before the owner validates Cloudflare and decides to cut over.
- The Worker proxies the API/audio transfer only; it never runs synthesis. Browser-to-Worker traffic is HTTPS while the configured server-to-server hop remains HTTP. Droplet availability is still required for tuning/chord APIs and WAV rendering.

### Worker API contract

| Route | Method | Behavior |
| --- | --- | --- |
| `/api/tunings` | GET | Forward to backend, including query string |
| `/api/chords` | GET | Forward query unchanged, including `tuningId` and legacy parameters |
| `/api/play` | POST | Stream the original request body to backend |
| `/api/render` | POST | Stream body; validate successful JSON `file` and rewrite to `/api/render-file?path=...` |
| `/api/render-file?path=...` | GET | Stream the permitted backend `/renders/` WAV with its status and audio/cache headers |

Unsupported methods return JSON 405 with `Allow`; unknown API routes return JSON 404. Unreachable upstreams return a clear JSON 502. Ordinary upstream error statuses and bodies pass through. Invalid successful render responses or rejected redirects return JSON 502 rather than exposing unsafe file URLs.

Render paths must be a single flat `/renders/<filename>.wav` path matching the existing engines' output. Filename characters are ASCII letters, digits, hyphen, underscore, and dot, with an alphanumeric/hyphen/underscore first character and no `..`. Absolute and protocol-relative URLs (even the configured origin), subdirectories, backslashes, whitespace, query/fragment suffixes, malformed encoding, leftover percent escapes, and traversal are rejected. The query is decoded exactly once; missing/duplicate `path` parameters are rejected. Backend-returned paths must satisfy the same contract. All upstream redirects are rejected with 502, including same-origin redirects, so no redirect can escape the allowed destination.

WAVs pass through as `ReadableStream` bodies without text conversion or whole-file buffering. Range/If-Range and conditional cache headers are forwarded; content type/length/disposition/range, accept-ranges, encoding, validators, cache policy, and retry-after are preserved where supplied. Stale entity metadata is removed when render JSON is rewritten. Browser cookies and authorization are not forwarded. The repository backend currently returns full 200 WAVs rather than implementing Range; the Worker preserves 206/304/416 when supported upstream, without inventing range support.

### Exact Cloudflare setup

After the owner reviews and merges this migration, follow **Workers & Pages → Create application → Import a repository → Get started → GitHub → aleph9909/SynBrane**. Configure:

| Setting | Value |
| --- | --- |
| Worker name | `synbrane` |
| Root directory | Repository root (`/`) |
| Production branch | `main` |
| Build command | Leave blank |
| Deploy command | `npx wrangler deploy` |
| Build environment | `NODE_VERSION=24` |
| Runtime variable (already in Wrangler) | `BACKEND_BASE=http://147-182-251-148.sslip.io:3001` |

No output directory, framework build, or secret is required. Wrangler reads `./public` directly. Select **Save and Deploy** only when ready to deploy, then use the supplied `workers.dev` URL. For an existing Worker use **Settings → Builds → Connect** and the same configuration. Keep runtime configuration in Wrangler to avoid dashboard/source drift. See [Cloudflare's Git setup](https://developers.cloudflare.com/workers/ci-cd/builds/) and [Worker-first routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/).

### Local and live verification

Use Node 22+ for the pinned Wrangler dependency (Node 24 recommended), then `npm ci`. Start the backend with `npm run dev`; in another terminal run `npm run dev:worker -- --var BACKEND_BASE:http://127.0.0.1:3001` and open `http://localhost:8787`. Alternatively put the local backend override in ignored `.dev.vars`. The backend's `.env` and the Worker's `.dev.vars` are separate. Without an override, Wrangler targets DigitalOcean.

Run `npm run test:worker` for mocked route/security/streaming tests, `npm run test:worker:integration` for real workerd/static-assets and local Node DSP renders, and `npm run check:worker` for deployment dry run only. Integration uses temporary WAV storage, disables SuperCollider, and cleans up its local processes. Default test ports 13001/18787 can be changed with `TEST_BACKEND_PORT`/`TEST_WORKER_PORT`.

Before cutover, verify homepage, About, CSS/JS, tuning/chord changes, browser chord/loop previews, arpeggiation, patch save/load, and both harmony/rhythm server renders on the deployed Worker. Check JSON render URLs stay same-origin and lead to playable WAVs, API 404/405 behavior, rejected unsafe paths, and the upstream's actual range behavior. The complete dashboard steps and post-deployment checklist are in `README.md`.

On 2026-10-06 the mocked tests, real local Worker + Node DSP render integration, and Wrangler dry run passed. Live tuning/chord requests to the configured droplet yielded network-proxy 502 errors reporting connection refused; they did not yield backend application responses. The owner subsequently confirmed a Node listener on `0.0.0.0:3001`, local HTTP 200 for `/api/tunings`, and browser access to the public tuning endpoint after allowing TCP 3001 through UFW. The owner also confirmed browser access to `/api/tunings` through `147-182-251-148.sslip.io`. Cloudflare-to-DigitalOcean connectivity/rendering and audible browser/patch checks remain live verification items. SuperCollider is optional and its enablement on the droplet is **unverified**.

## Temperaments
- EDO tunings include 8, 10, 12, 13, 15, 16, 17, 19, 20, 22, 24, 26, 27, and 31 with temperament-specific chord presets sourced from the backend; Scala tunings come from the `scales` directory. Interval mapping in the UI uses cents approximations to highlight equivalent functions across temperaments and redraws the circle with the proper number of divisions. Each temperament paints the spiral with its own color theme, and the UI no longer exposes 32-EDO.
- 31-EDO now carries richer temperaments derived from Orwell-9 and Mothra-6 shapes (nonets, hexads, neutral dominants, blues stacks, and extended 11ths) alongside the existing meantone sets, so Orwell flavors live inside the 31-EDO option instead of a standalone 9-EDO entry.

## UI controls
  - Chords panel: configurable tab count (1–5) based on the loop length selector, active chord label, per-chord tuning select, root selector, chord preset dropdown (major/minor/dim/aug/sus/add chords), loop toggle, a quick action row directly beneath the chord dropdowns with Clear, Play chord, and Copy to next chord buttons, loop Play/Stop/Render controls just above the spiral note selector with toggleable degrees, interval/frequency readouts, and a global arpeggiator switch with pattern/rate selects that apply to all chords, previews, and loops. Root dropdowns use zero-based degree labels (e.g., Degree 0) for non-12-EDO temperaments to match the spiral numbering, and chord preset labels keep zero-based degrees for those tunings while 12-EDO presets omit numeric degree hints (note names only in the dropdown).
  - Synth Parameters: master volume leads the panel, followed by mode (harmony/rhythm), tempo (30–300 BPM), rhythm multiplier (~0.1–1.0), waveform, attack/decay/sustain/release, detune, cutoff/resonance, loop length selector, and patch Save/Load.
- Patch JSON shape (v1):
```
{
  "version": 1,
  "loopChordCount": 4,
  "global": {
      "mode": "harmony",
      "tempo": 120,
      "rhythmMultiplier": 0.3,
    "synth": { "waveform": "saw", "envelope": { ... }, "filter": { ... }, "detuneCents": 3, "volume": 1 },
    "arpeggiator": { "enabled": false, "pattern": "up", "rate": "1/8" },
    "preview": { "arpeggiate": false, "arpRateMs": 180, "loop": false }
  },
  "chords": [
    { "tuningId": "edo:12", "root": 0, "preset": "major-triad", "notes": [0,4,7], "arp": {"enabled": false, "pattern": "up", "rate": "1/8"} },
    { ... }
  ]
}
```
Chord-level `arp` objects remain in saved patches for backward compatibility, but playback favors the global arpeggiator when present.
- Loop playback uses the chord circles as the single source of truth; no explore palette or bar-level editors remain.

## Configuration
- Worker: `BACKEND_BASE` is configured in `wrangler.jsonc`; `ASSETS` is the static assets binding. Worker settings do not change the backend configuration below.
- Backend-only local use requires no environment variables; all defaults are hard-coded for development and adjustable via the UI.
- Frontend API base: all browser fetches go through a global `API_BASE` constant defined in `public/main.js`, which defaults to an empty string so requests use the same-origin hosting proxy routes (Cloudflare after cutover, Vercel before cutover). A `window.SYNBRANE_API_BASE` override is available for local development if you need to target a different backend directly.
- Optional environment variables remain supported for overrides:
  - `PORT` (default `3001`)
  - `HOST` (default `0.0.0.0`)
  - `BASE_FREQUENCY` (default `440`)
  - `SCALES_DIR` (default `<repo>/scales`)
  - `RENDER_OUTPUT_DIR` (default `<repo>/renders`)
  - `RENDER_SAMPLE_RATE` (minimum `44100`)
  - `SUPER_COLLIDER_ENABLED` (default `false`)
  - `SUPER_COLLIDER_SCLANG_PATH` (default `sclang`)

## Scripts
- `npm run dev` — Start the backend in development mode.
- `npm start` — Start the backend with default environment.
- `npm run dev:worker` — Run the local Cloudflare Worker and assets; use a local backend override when desired.
- `npm run deploy:worker` — Actually deploy Worker and assets (explicit deployment only).
- `npm run test:worker` — Run focused mocked-upstream tests.
- `npm run test:worker:integration` — Run the real local Worker/backend/static/WAV smoke checks.
- `npm run check:worker` — Validate/bundle with `wrangler deploy --dry-run`, without deployment.
