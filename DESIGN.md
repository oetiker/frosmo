# frosmo — table games through a mirror

*Design notes, 2026-08-26*

frosmo turns a mirror clipped over a tablet's front camera into a game input.
Pieces on the table in front of the device become the controls: shapes to cover
an outline, obstacles for a ball to bounce off, coloured tokens to count,
letter tiles to read.

Osmo built this idea into hardware and a closed app catalogue. This is the same
physical trick with none of the hardware assumptions, running as a web app that
installs to the home screen and works offline.

One objective drives the decisions below, and where anything conflicts it wins:

> **The rig is unknown.** Any tablet, any mirror, any table, any light.
> Whatever the setup, it should take under a minute to make it work.

That is not a feature; it is the constraint that shapes the whole system. The
sections that follow are mostly consequences of it.

---

## The one decision: nothing models the rig

The tempting design is to know about rigs: a table of iPad models and camera
offsets, the reflector's fold angle, the play area's dimensions in millimetres.
That design fails on the first device it has not seen, and the iPad line has
moved its front camera to the landscape edge, so "the first device it has not
seen" is now most of them.

Instead, **the entire physical model is four corners and an orientation.**

The player drags four handles onto the corners of the play area in the live
camera image. That yields a projective transform — a homography — from *board
space*, a normalised rectangle, to *camera pixels*. Everything the mirror does
to the image is already inside that transform:

| Physical fact | Where it goes |
|---|---|
| Mirror geometry, fold angle | into the homography |
| How far the tablet leans back | into the homography |
| Which camera, of several | chosen once, remembered |
| Which edge the camera is on | into the orientation |
| Whether light bounces once (handedness) | into the orientation's mirror bit |
| How big the play area is | nowhere — board space is normalised |

Nothing downstream knows a mirror exists. An Osmo base with the 2021 reflector,
a hand-cut mirror on a book stand, and a phone propped against a mug all
calibrate identically, and a rig nobody has tried needs no code.

Three details make this hold up in practice:

- **Which camera is part of the rig, so it is part of the setup.** A reflector
  over the front camera, a tablet face-down over the table, a laptop with a
  mirror on a book and an external webcam are all rigs, and no default serves
  them all. The choice is the player's, made on the calibration screen and
  remembered. Device labels are blank until camera permission has been granted,
  so the picker is populated only once a stream is running — which is why it
  lives on a screen that has already started one.
- **A calibration belongs to a camera.** The corners are meaningful only in the
  frame they were marked in, so the calibration records the device that made it
  and a game refuses to start on a board calibrated with a different one. The
  alternative is worse than an error: a game reacting confidently to the wrong
  part of the world, which reads as the app being broken rather than
  misconfigured.

- **Corners are stored normalised to the frame, not in pixels.** iPadOS may hand
  back a different capture resolution after the app is backgrounded, and a
  calibration the user did once must survive that.
- **Orientation is explicit, not inferred.** Handedness cannot be recovered from
  the corners: a mirror reverses it and a bare camera does not, and the corner
  ordering is normalised for sanity in both cases. A **Rotate** and a **Mirror**
  button cover all eight cases, checked against a live preview.

### Why the calibration screen shows two images

The live camera on the left, the rectified board on the right, updating as the
handles move. Nobody can judge a homography from four dots. Anyone can tell
whether the right-hand image looks like their table, the right way up. The
side-by-side is the whole design of that screen; the handles are incidental.

---

## The pipeline

```
 camera frame ──► rectify ──► board buffer ──► detectors ──► stabiliser ──► game
   1280x720       (gather        256x192       occupancy       promote        needs
   downscaled      table)        RGBA+luma     ink             on age        declared
   to 640x360                                  tokens          forget        up front
                                               tiles           on absence
```

**Everything downstream of rectification works in board space** — 256×192
pixels by default, with the play area filling it exactly. Three things follow:

1. Detector cost is fixed by the board resolution, not by the camera's. A better
   camera costs nothing.
2. A game plays identically whether the play area is a sheet of A4 or half a
   kitchen table.
3. Games are written against a rectangle, with no perspective maths anywhere.

Rectification is the only per-pixel use of the homography, so it is done through
a precomputed gather table: each board pixel's source offset is computed once,
when calibration or capture resolution changes, and each frame is a gather.
Sampling is nearest-neighbour on purpose — the board buffer is far smaller than
the capture, so this is downsampling, and every detector blurs or thresholds
afterwards anyway.

**Games declare what they need.** A game asking only for occupancy never pays
for ink, blobs, glyph matching or contour tracing. This is most of the frame
budget on the simpler games.

---

## The four detectors

Each is one pass over flat typed arrays. They are described here with their
failure modes, because the failure modes are what determined the method.

### Occupancy — what is on the table

Background subtraction against a reference of the empty board. The play surface
is static and the camera is bolted to the tablet, so a plain reference model
beats anything adaptive-per-pixel: it reacts instantly, costs one subtraction
per pixel, and never learns a piece into the background because a child left it
there for a minute.

Four refinements earn their place. The first is not a refinement at all — it is
the difference between this working and not, and it was learned the hard way on
a real iPad, where the first version reported the whole board as covered.

- **The camera adjusts itself, so every frame is scaled back onto the
  reference's exposure before anything is compared.** Auto-exposure and auto
  white balance react continuously to the scene: put a dark object on the table
  and the camera brightens *everything*, so every pixel differs from a stored
  reference at once. That is not a threshold in need of tuning — it is a
  comparison between two pictures taken under different exposures. One gain per
  channel corrects both effects (exposure moves the three together, white
  balance moves them apart), estimated from **medians**, which are unmoved
  until more than half the sampled pixels change. A mean would be dragged by the
  first object placed on the table, which is precisely the case this exists to
  handle.

  The sampler steps through the image by a prime that is coprime with the pixel
  count, rather than every nth pixel in scan order. Sampling on a fixed pitch
  aligns with anything else on a fixed pitch — a row of tiles, a grid of
  tokens — and can draw its entire sample from the objects instead of the table.

- **The reference is an average of a dozen frames**, not a snapshot. A single
  frame carries that instant's sensor noise into every later difference, and
  that noise is the same order as the threshold.
- **Every pixel has its own threshold**, from the variance learned alongside the
  mean. Under a mirror the image is dim, the sensor gain is high, and the noise
  is not uniform across the frame — a single global threshold has to be set for
  the worst part of it, and is then far too blunt everywhere else. A pixel must
  differ by a multiple of *its own* noise, with an absolute floor beneath.

  This has a useful side effect: a pixel that was inconsistent while the
  reference was being learned gets a wide threshold automatically, so a
  reference taken while something was moving distrusts exactly the region that
  was moving.
- **Shadow rejection.** A hand reaching in throws a shadow twice its own size,
  and a naive threshold treats the shadow as an object. A shadow scales all
  three channels roughly equally, so comparing *chromaticity* — colour with
  brightness divided out — rejects it while keeping genuinely dark objects.
- **Slow drift correction**, applied every twelfth frame, for the residue the
  gain correction does not cover.

Nothing is reported while the reference is being learned. A half-learned
background produces blobs that are pure artefact, and a game acting on them
would score the player for clearing the table.

**Fails on:** a play surface that is genuinely moved mid-game; a piece the exact
brightness of the table; someone changing the room lighting abruptly. All three
are fixed by relearning the empty board — and rather than leave a player staring
at a game that ignores them, the detector notices this state itself: a board
that reads as almost entirely covered for a sustained period says so, and the
game offers the one action that fixes it.

### Ink — drawn lines

Adaptive thresholding: compare each pixel to the mean of its neighbourhood,
computed in constant time from a summed-area table.

A drawn line is a small, low-contrast, *local* change on a sheet that may itself
have been nudged since the reference was taken — so background subtraction
reports the whole sheet. Local contrast survives the paper moving, the light
falling off across the play area, and the mirror's own vignetting.

**Fails on:** dark tables, which read as ink everywhere (hence a maximum-luma
cut); large solid pieces, which show up only as outlines, since the interior
matches its own neighbourhood. That second one is why ink and occupancy are
separate detectors rather than one tuned compromise, and why the physics collides
against their union.

### Tokens — coloured pieces

Connected-component labelling of the occupancy mask, then hue-first
classification of each blob's mean colour into eight buckets.

Deliberately coarse. The mirror is cheap plastic, auto white balance drifts with
the room, and a piece at the far edge is dimmer than one under the tablet's own
glow. Anything keyed on absolute RGB falls apart; hue with a saturation floor
survives. Every classification carries the **margin to the runner-up**, so a
sample sitting between orange and yellow is reported as uncertain rather than
guessed, and games can require a margin.

Labelling uses 4-connectivity, not 8: diagonal links merge tokens that touch
corner-to-corner, which happens constantly with tiles pushed together.

### Tiles — printed letters and digits

The least forgiving stage, so it is built to fail loudly. For each blob that is
tile-shaped (roughly square, solidly filling its bounding box, in a plausible
size range): rotate the crop upright by the blob's principal axis folded into
±45°, binarise with Otsu, normalise to the ink's own bounding box at 24×24, and
match against an atlas across all four quarter turns.

Two choices matter more than the algorithm:

- **The atlas is rendered in the browser, not shipped as data.** The printable
  tile sheet uses the same renderer, so tiles printed by the app are matched
  against templates with identical letterforms. Recognition of those is close to
  exact; other tile sets degrade from there.
- **Every match reports its margin over the runner-up.** O/0, I/1, S/5 and B/8
  are genuinely ambiguous at this resolution. Spell It shows uncertain tiles with
  a dashed outline and refuses to read them, which looks like the game noticing a
  problem rather than ignoring the player.

**Fails on:** tiles at an angle steeper than the deskew can fix, overlapping
tiles, and glyphs whose ink is a small fraction of the tile. All are visible in
the vision lab, which is the point of the vision lab.

### Stabilisation — between the detectors and the games

Per-frame detections flicker: a tile drops out for two frames when a sleeve
passes over it; a token's colour wobbles at a bucket boundary. A game reacting to
raw frames feels broken even when the detector is right 95% of the time.

So detections are tracked across frames by position, promoted to "stable" only
after several consistent sightings, and kept alive briefly after they vanish.
Promotion is one-way until the detection is forgotten — that hysteresis is what
stops a piece flickering between present and absent at the detector's threshold.
**Games only ever read stable sets.**

Games also require good states to be *held* for around a second before scoring.
A hand sweeping across a target covers it perfectly for one frame, and rewarding
that teaches the wrong thing.

---

## The game contract

A game receives a canvas, a stabilised view of the table, and a time step. It
owns nothing else — no camera, no calibration, no DOM, no service worker.

```ts
interface GameDef {
  needs: VisionNeeds;              // which detectors to run at all
  materials: string[];             // what to put on the table
  create(board: BoardUnits): GameInstance;
}

interface GameInstance {
  update(env: GameEnv): void;      // vision, dt, taps, audio
  render(env: GameEnv): void;      // board units → canvas via env.layout
  hud(): GameHud;                  // score, message, progress, time
}
```

Adding a game is one file and one registry line.

The games shipped here are chosen to exercise different detectors and to fail
differently: mask overlap (Silhouette), mask-as-collision-geometry (Bounce),
classification with counting (Colour Rush), recognition with ordering (Spell It).

One rendering rule matters enough to state: **games draw what the camera sees.**
A player who cannot see their own ramp on screen has no way to distinguish a
badly placed block from a badly calibrated board. Contours are traced from the
mask and filled as polygons rather than blitting the mask, so a pencil line stays
a crisp line at Retina resolution instead of a row of grey squares.

### Physics against a mask

Bounce collides balls against a blurred occupancy field rather than against
geometry. Blurring first is what makes this work: a binary mask has no usable
gradient — either zero or a cliff — while a blurred one has a gradient that
points out of the obstacle, which is exactly the collision normal.

Stepping is substepped by distance travelled, never more than one ball radius
per step. Without that, a ball crossing a pen line at speed simply teleports
through it, which is the first thing anyone hits when collision is sampled from
a mask.

---

## Performance

Measured with `npx vite-node tools/bench.ts`, board 256×192, every detector:

| Stage | Cost |
|---|---|
| occupancy | 1.56 ms |
| ↳ of which, exposure estimation | 0.21 ms |
| ink | 1.45 ms |
| field (blur) | 0.68 ms |
| blobs | 0.37 ms |
| contours | 1.29 ms |
| **all detectors** | **5.37 ms** |

Occupancy doubled when exposure correction and the per-pixel noise model went
in. That is the right trade: the cheaper version did not work on a real
tablet.

Per-frame allocation is zero: the blur, labelling and contour stages take
reusable buffers sized with the board. Before that they allocated roughly 400 KB
per frame, which at 30fps is 12 MB/s of garbage on a device that is also running
its camera and its screen at full brightness.

In the browser, the remaining cost is the camera readback — `drawImage` plus
`getImageData` — which is a synchronous GPU-to-CPU copy and is usually the single
largest item in the loop. It is reduced by capturing at half resolution, since
the board buffer is a few hundred pixels across.

### On Rust and WebAssembly

Worth doing eventually; not yet, and not for these stages.

The detectors are ~15 passes over 49k pixels. WebAssembly with SIMD might turn
3.2 ms into 1 ms, on a workload that is already inside the budget — while the
readback it cannot touch costs more. In exchange: a Rust toolchain in the build,
memory-interop glue, a larger payload for an app that should install over a
tethered phone, and much worse on-device debugging, which matters because
everything interesting only reproduces under a real mirror in a real room.

The order that actually pays:

1. **Measure on device** — the vision lab exists for this.
2. **Web Worker plus `OffscreenCanvas`**, so capture and detection leave the main
   thread and the game never stutters. Structurally worth more than making a
   1.5 ms pass into a 0.4 ms one.
3. **Then WebAssembly, where the numbers point.** Most likely glyph recognition:
   it wants capture-resolution crops rather than board-resolution ones, matched
   across templates and rotations, and it is the one stage whose cost grows with
   how much the player put on the table.

The design keeps that door open. Every hot function is a pure operation over
flat typed arrays with no allocation and no object churn across the boundary —
deliberately the shape a `wasm-bindgen` export takes — so substituting one is a
module swap, not a rewrite.

---

## Deliberately not done

- **No object recognition.** It reads shapes and colours, not things: a red brick
  and a red button are the same token. Everything above is classical computer
  vision — no model to download, no inference budget, nothing that fails in a way
  nobody can explain to a child.
- **No fiducial markers.** Printing AprilTags around the play area would make
  calibration automatic, and would also make the app useless to anyone without a
  printer. Four dragged handles cost thirty seconds, once.
- **No multi-row tile reading.** Spell It reads one row, left to right. That is
  also how tiles fit in front of a tablet.
- **No accounts, no network.** Nothing is uploaded, because there is nowhere to
  upload it to. Scores and calibration live in the browser's own storage.

## Where krptk would fit

Scores and calibration go through one small storage module, which is the seam a
syncer attaches to. [krptk](https://github.com/oetiker/krptk) — encrypted
per-user storage a PWA adopts in a few lines — would carry a family's progress
between devices without this app growing a backend, and without the operator
being able to read any of it. Nothing here depends on that; the module is a
dozen lines of `localStorage` today, and that is the point of it being a module.

## Open questions

- **Which capture resolution is actually best on device?** Half of 1280×720 is a
  guess that wants measuring against readback cost on real hardware.
- **Is 256×192 the right board resolution?** Small tiles want more; the physics
  and shape games want less. It is a calibration setting rather than a constant
  for exactly this reason, but there is no evidence yet for a good default.
- **How badly does glyph recognition degrade on Osmo's own tiles?** Untested —
  it needs the tiles.
- **Two-player split screen?** The play area divides trivially in board space,
  but no game here is designed around it yet.
