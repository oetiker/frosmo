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
| **tiles** | printed letters and digits, read by a small CNN | Spell It |

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
**Vision lab** screen in the app is usually faster than the inspector. It shows
every pipeline stage, its cost in milliseconds, the exposure correction the
camera made it apply, and live controls for the detection thresholds — the
numbers that decide whether the board works can only be judged under a real
mirror in a real room.

`npm run replay <diagnostic.json>` plays a captured file back through the
current detectors, in a real browser, and reports what they make of it — the
only way to work on this code without the rig in front of you. Captures contain
a photograph of the room, so they are gitignored rather than committed.

**Capture diagnostic** in that screen packages one moment of the real rig — the
full-resolution camera frame, the rectified board, the learned reference, the
current masks and every setting that produced them — into a single file you can
share off the device. That file is enough to reproduce a detector's behaviour
exactly, and to turn "the tokens don't work" into a fixture with a failing
test.

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
paper. The tiles are set in the typeface the recogniser was trained on, so tiles
printed from the app are the best case for recognition; Osmo's own tiles,
Scrabble tiles and handwriting degrade from there. Glue the sheet to card —
floppy paper curls and casts shadows the camera reads as marks.

## Reading letters

The letters are read by a small convolutional net that ships inside the bundle:
24×24 input, two convolution-and-pool stages, one fully connected layer, 36
outputs. Weights are quantised to int8, which is why the whole recogniser is
about 60 KB of the download and needs no fetch at play time.

It is trained offline, on this machine, from the glyphs rendered by the browser
itself — every sample is one of those glyphs pushed through the degradations a
tablet camera actually applies: perspective, rotation, blur, uneven fill,
contrast collapse, sensor noise, and a neighbouring tile intruding at the
border. That is the whole training set; there is no corpus to download.

```sh
npm run glyphs:render   # Chromium renders the 36 glyphs → .glyphs/base.json
npm run glyphs:train    # trains, checks gradients, writes src/vision/glyph-model.json
```

Two things do most of the work at play time. A game says which characters can
possibly appear — Spell It only ever wants letters — and that restriction is
applied to the scores *before* the winner is picked, not as a filter afterwards,
so `D` can never lose to `0`. And each glyph is read once and then cached
against its position, because a tile that has not moved cannot have changed
its mind; only a handful of new glyphs are put through the net per frame, which
is what keeps it inside the frame budget.

## Development

```sh
npm install
npm run dev          # http://localhost:5173 — camera works on localhost
npm test             # 175 unit tests, no browser needed
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
tools/          icons, service worker, glyph rendering and training, bench, smoke
```

## Licence

[MIT](LICENSE).
