# SynBrane

Experimental music workbench for exploring alternative tunings, browsing chords, and translating pitch information into rhythm. The app ships with a minimal browser UI backed by a Node.js API and a SuperCollider-ready boundary for audio rendering. A five-slot custom chord editor, expanded tempo/rhythm controls, and a groove-focused rhythm engine (four-on-the-floor kick/snare spine with hats and per-note tom/clap layers on slowed grids) are available out of the box.

## Architecture and cutover

Cloudflare Workers with Static Assets serves `public/` and proxies same-origin `/api/*` requests to the existing DigitalOcean backend at `http://147-182-251-148.sslip.io:3001`. `worker/index.mjs` is an ES module; the backend remains CommonJS and `npm start` still starts `server/index.js`. There is no frontend build step or synthesis inside the Worker. Browser Web Audio previews, tuning/chord controls, and patch save/load keep their existing implementation.

This prepares Cloudflare hosting; it does not perform cutover. Keep the existing Vercel deployment (`https://syn-brane.vercel.app`) and its `api/` handlers active until Cloudflare has passed the checks below and you decide to cut over. The temporary `sslip.io` backend hostname already maps to the droplet, so no owned domain or DNS changes are required to test the `workers.dev` site. The backend must still be reachable on port 3001.

## Cloudflare dashboard setup

Do this **after this PR has been reviewed and merged into `main` by the owner**, when ready to deploy. Connecting and selecting **Save and Deploy** actually deploys the site.

1. Open Cloudflare dashboard → **Workers & Pages** → **Create application**.
2. Next to **Import a repository**, choose **Get started**, connect/select GitHub, and select **aleph9909/SynBrane**. Use the Worker import flow, not a Pages project.
3. Configure the project with these exact settings:

   | Setting | Value |
   | --- | --- |
   | Worker/project name | `synbrane` |
   | Production branch | `main` |
   | Root directory | Repository root (`/`) |
   | Build command | Leave blank |
   | Deploy command | `npx wrangler deploy` |
   | Build environment variable | `NODE_VERSION=24` |

   There is no frontend build output directory to configure. `wrangler.jsonc` sets the assets directory to `./public`, binds it as `ASSETS`, and sets the module entry point to `worker/index.mjs`. The checked-in lockfile installs Wrangler; Node 22 or newer is required for this Wrangler version. The explicit Node 24 build setting meets that requirement without changing the backend runtime.
4. `BACKEND_BASE=http://147-182-251-148.sslip.io:3001` is already included as a **non-secret runtime variable** in `wrangler.jsonc`. No secret or additional dashboard variable is required for the first deployment. It must be an HTTP(S) origin, with no credentials, path prefix, query, or fragment. Cloudflare Worker subrequests require a hostname, not a numeric IP address. This `sslip.io` hostname resolves to `147.182.251.148` without domain registration or an account. It is a third-party DNS dependency and does not add TLS: the backend hop remains HTTP. If the droplet IP changes, update the embedded IP in the hostname. Local loopback-IP overrides remain valid for local Wrangler development. Change its checked-in value for a persistent backend change; a dashboard-only change may be overwritten on a later deployment.
5. Select **Save and Deploy**. Open the provided `https://synbrane.<account-subdomain>.workers.dev` URL. `workers_dev: true` explicitly enables this address. Do not add a custom domain or alter DNS until checks pass.
6. For an already-created Worker, use **Workers & Pages → synbrane → Settings → Builds → Connect** to attach this repository and enter the same settings. The dashboard Worker name must match `synbrane` in Wrangler. Future pushes to the production branch trigger deployment once this integration is connected.

Cloudflare references: [Worker hostname requirement](https://developers.cloudflare.com/workers/platform/known-issues/#fetch-to-ip-addresses), [temporary hostname service](https://sslip.io/), [Git-connected Workers setup](https://developers.cloudflare.com/workers/ci-cd/builds/), [static assets binding](https://developers.cloudflare.com/workers/static-assets/binding/), [Worker-first API routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/).

## Local development

Use Node 22+ (Node 24 recommended) for Wrangler and tests.

```bash
npm ci
```

To run the backend alone, copy `.env.example` to `.env` if overrides are needed, then run `npm run dev` and open `http://localhost:3001`. SuperCollider is optional, not required; Node DSP is the default. `npm start` and `npm run dev` retain their existing backend behavior.

For the full Cloudflare path with a local backend, run in two terminals:

```bash
# Terminal 1: existing backend
npm run dev

# Terminal 2: local Worker + static assets, with a local-only backend override
npm run dev:worker -- --var BACKEND_BASE:http://127.0.0.1:3001
```

Open `http://localhost:8787`. Leave `window.SYNBRANE_API_BASE` unset: requests must stay relative to the Worker origin. Without `--var`, `npm run dev:worker` uses the configured DigitalOcean backend, so its APIs depend on that droplet being reachable. Local overrides can also be placed in ignored `.dev.vars` as `BACKEND_BASE="http://127.0.0.1:3001"`; they are not deployed. Backend `.env` settings and Worker `.dev.vars` are separate.

## Validation commands

```bash
npm run test:worker              # Focused mocked-upstream tests; no live service
npm run test:worker:integration  # Real local workerd runtime + local Node DSP backend
npm run check:worker             # Wrangler deploy --dry-run; does not deploy
```

The integration test launches temporary local processes on ports 13001 and 18787, compares homepage/About/CSS/JS bytes, checks tuning/chord APIs and API 404/405 behavior, and renders harmony and rhythm WAVs through the Worker. It explicitly disables SuperCollider, stores renders in a temporary directory, and cleans up. Override `TEST_BACKEND_PORT` / `TEST_WORKER_PORT` if those ports are occupied.

`npm run deploy:worker` is a separate, **real deployment** command; use it only when deliberately deploying. Dashboard deployments use `npx wrangler deploy` as shown above.

## Post-deployment checks before cutover

- Open the homepage and About link; confirm styles and JavaScript load. About may redirect from `/about.html` to its extensionless canonical asset URL.
- Check `/api/tunings` and `/api/chords?tuningId=edo%3A31` return JSON; confirm changing tunings and chord presets works in the UI.
- Play a chord and loop using browser previews. Check tuning/root selection, arpeggiation, synth settings, and patch save/load. These remain browser-side features; audible playback still needs a browser/user interaction.
- Render a short harmony loop and a rhythm loop. Confirm the render JSON contains `/api/render-file?path=...`, the audio player fetches WAV bytes from the same HTTPS origin, and playback/download works without mixed-content requests.
- Confirm unknown `/api/...` routes return JSON 404, unsupported methods return 405 with `Allow`, and `/api/render-file?path=https://example.com/a.wav` returns 400.
- Range requests are forwarded along with `If-Range` and cache validators. The current repository backend ignores Range and returns a full 200 WAV; the Worker also preserves 206, 304, and 416 responses if an upstream supports them. Do not assume seeking/range support has been added to the droplet.
- Keep Vercel available until these live checks succeed. Synthesis still depends on DigitalOcean availability. Only browser-to-Cloudflare traffic is HTTPS; the configured Worker-to-backend hop remains the existing HTTP connection.

### Migration validation record (2026-10-06)

Mocked-upstream tests and the real local Worker/Node DSP integration passed, as did Wrangler's deployment dry run. Live requests to both DigitalOcean tuning/chord endpoints returned **502 from the execution environment's network proxy**, reporting `[Errno 111] Connection refused`; no application response was obtained. This does not establish the droplet's operational status from Cloudflare. Subsequently, the owner confirmed Node listens on `0.0.0.0:3001`, the local tuning endpoint returns HTTP 200, and the public tuning endpoint loads after allowing TCP 3001 through UFW. The owner also confirmed the tuning endpoint loads through `147-182-251-148.sslip.io`. These owner-reported checks establish backend reachability from their browser; live Cloudflare-to-DigitalOcean API/render checks and audible browser/patch checks remain for post-deployment verification. SuperCollider enablement on DigitalOcean has not been verified.

## Documentation

See `PROJECT_CONTEXT.md` for API contracts, security boundaries, configuration, and audio behavior.
