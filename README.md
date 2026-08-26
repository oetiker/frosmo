# frosmo

Tabletop games played through a mirror clipped over a tablet's front camera —
an Osmo base and reflector, or anything else that folds the camera's view down
onto the table.

Put things on the table; the games react to them. No account, no server, no
network: the camera never leaves the device.

```
        ┌───────────┐
        │  ▟ mirror │ ← clipped over the front camera
        │  ┌─────┐  │
        │  │ iPad│  │
        │  └─────┘  │
        └───────────┘
   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
     ▣   ●   ▲      ← the play area, as the mirror sees it
```

## What it can see

Four detectors, each computed only when a game asks for it:

| Detector | Finds | Used by |
|---|---|---|
| **occupancy** | anything opaque on the table | Silhouette, Bounce |
| **ink** | pen strokes on light paper | Bounce |
| **tokens** | coloured pieces, sorted into eight colours | Colour Rush |
| **tiles** | printed letters and digits | Spell It |

## The games

- **Silhouette** — a shape appears; fill it with tangram pieces, blocks, coins,
  biscuits. Scored on how much of the outline you cover and how much you spill
  outside it. Nothing has to be identified, so this is the one to try first.
- **Bounce** — balls fall from the top and have to reach a lit cup. Everything
  the camera sees is solid: build a run out of blocks, a pencil case, or lines
  drawn on paper.
- **Colour Rush** — the screen asks for a set of colours; supply exactly those,
  against a clock.
- **Spell It** — a picture appears; spell it with letter tiles laid in a row.

## Getting it onto an iPad

**https://oetiker.github.io/frosmo/** — open it on the iPad and use **Share ›
Add to Home Screen**. After that it runs fullscreen, and offline: the service
worker precaches the whole app on first visit, so the tablet on the kitchen
table needs no network and no server at all.

Every push to `main` republishes it, via `.github/workflows/pages.yml`. That
needs Pages switched on once, in **Settings › Pages › Build and deployment ›
Source › GitHub Actions** — a workflow cannot enable it for you.

`npm run build` produces a fully static `dist/` with relative asset paths, so
it serves correctly from a sub-path like `/frosmo/`, or from any other static
host you point at it.

For development, note that `getUserMedia` needs a secure context, and iPadOS
gives no localhost exemption to another machine on the LAN — `npm run dev --host`
over `http://192.168.…` **will not** get you a camera. Tunnel instead:
`cloudflared tunnel --url http://localhost:5173` (or ngrok) alongside
`npm run dev`, and open the HTTPS URL it prints. Live reload, real camera.

Camera access works in home-screen web apps from iOS 14.3 onward. On older
versions, run it in Safari rather than installed.

To debug on the device, connect it to a Mac and use Safari's Develop menu; the
**Vision lab** screen in the app shows every pipeline stage and its cost in
milliseconds, which is usually faster than the inspector.

## Setting up the board

Once, per rig:

1. Clip the mirror over the camera so it looks at the table.
2. Pick the **camera**, if the device has more than one. A reflector clipped
   over the front camera wants that one; a tablet propped face-down on a stand
   wants the back one; a laptop with a mirror on a book wants whichever webcam
   points at the table.
3. Drag the four handles onto the corners of the play area.
4. Check the preview looks like your table, the right way round. **Rotate** and
   **Mirror** fix the orientation — a reflector reverses handedness and a bare
   camera does not.
5. Clear the table and save; the app learns what empty looks like.

The choice of camera is remembered, and the calibration remembers which camera
made it. Four corners only mean anything in the frame they were marked in, so
if you later play with a different camera the game says so and sends you back
here, rather than reacting to the wrong part of the world.

There is no list of supported tablets and no model of the mirror. Those four
corners are the entire rig model, which is why this works with hardware nobody
tested it against.

## Making pieces

**Print tiles** in the app produces letter tiles and colour tokens on plain
paper. The tiles are set in the same typeface the recogniser's templates are
rendered in, so tiles printed from the app are the best case for recognition;
Osmo's own tiles, Scrabble tiles and handwriting degrade from there. Glue the
sheet to card — floppy paper curls and casts shadows the camera reads as marks.

## Development

```sh
npm install
npm run dev          # http://localhost:5173 — camera works on localhost
npm test             # 118 unit tests, no browser needed
npm run typecheck
npm run build        # static dist/, plus a service worker built from it
```

Two more tools, both worth knowing about:

```sh
npx vite-node tools/bench.ts     # per-stage cost of the pipeline, no browser
npm run smoke                    # drive the real app in Chromium (see below)
```

`npm run smoke` renders a synthetic mirror view — a trapezoidal play area with
coloured pieces and a drawn line on it — feeds it to Chromium as a fake camera,
and drives the actual app: calibration, the vision lab, each game. It checks
the pipeline finds the pieces, reads their colours, rectifies the trapezoid, and
stores dragged corners in frame coordinates, then leaves screenshots in
`.smoke/`. It has caught three bugs no unit test would have. It serves the build from a
sub-path, as GitHub Pages does, and checks that the manifest, the icons and the
service worker all resolve there — an absolute base would pass at the root and
then 404 on the real deployment.

Set `CHROMIUM_PATH` if Playwright's bundled browser is not the one installed.

## Layout

```
src/vision/     camera, homography, calibration, rectification, the detectors
src/engine/     ball physics, field sampling, polygon rasterisation
src/games/      one file per game, plus the contract they implement
src/app/        shell and screens: home, calibrate, play, lab, print, about
tools/          icon generation, service worker generation, bench, smoke test
```

## Licence

[MIT](LICENSE).
