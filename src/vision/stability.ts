/**
 * Temporal stabilisation.
 *
 * Per-frame detections flicker: a tile drops out for two frames when a sleeve
 * passes over it, a token's colour wobbles between orange and yellow at the
 * bucket boundary. Games that react to raw frames feel broken even when the
 * detector is right 95% of the time.
 *
 * This tracks detections across frames by position, promotes one to "stable"
 * only after it has been seen consistently, and keeps it alive briefly after it
 * disappears. Every game reads stable sets, never raw frames.
 */

export interface Observation<T> {
  /** Identity of the thing observed — a character, a colour name. */
  key: string;
  x: number;
  y: number;
  value: T;
}

export interface Tracked<T> extends Observation<T> {
  /** Consecutive frames matched since it appeared. */
  age: number;
  /** Frames since it was last seen. */
  missing: number;
  stable: boolean;
}

export interface StabiliserOptions {
  /** Frames of consistent detection before something is reported as stable. */
  promoteAfter?: number;
  /** Frames of absence tolerated before it is dropped. */
  forgetAfter?: number;
  /** How far a detection may move between frames and still be the same thing, in board pixels. */
  radius?: number;
  /** Position smoothing, 0-1; higher follows the raw detection more closely. */
  smoothing?: number;
}

export class Stabiliser<T> {
  private items: Array<Tracked<T>> = [];
  private readonly opts: Required<StabiliserOptions>;

  constructor(opts: StabiliserOptions = {}) {
    this.opts = {
      promoteAfter: opts.promoteAfter ?? 4,
      forgetAfter: opts.forgetAfter ?? 6,
      radius: opts.radius ?? 18,
      smoothing: opts.smoothing ?? 0.35,
    };
  }

  reset(): void {
    this.items = [];
  }

  /** Feed one frame of detections; returns the full tracked set. */
  update(observations: Array<Observation<T>>): Array<Tracked<T>> {
    const { promoteAfter, forgetAfter, radius, smoothing } = this.opts;
    const taken = new Set<number>();

    for (const obs of observations) {
      let best = -1;
      let bestD = radius;
      for (let i = 0; i < this.items.length; i++) {
        if (taken.has(i)) continue;
        const it = this.items[i];
        if (it.key !== obs.key) continue;
        const d = Math.hypot(it.x - obs.x, it.y - obs.y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }

      if (best >= 0) {
        const it = this.items[best];
        taken.add(best);
        it.x += (obs.x - it.x) * smoothing;
        it.y += (obs.y - it.y) * smoothing;
        it.value = obs.value;
        it.age++;
        it.missing = 0;
        it.stable = it.age >= promoteAfter;
      } else {
        this.items.push({ ...obs, age: 1, missing: 0, stable: promoteAfter <= 1 });
        taken.add(this.items.length - 1);
      }
    }

    for (let i = 0; i < this.items.length; i++) {
      if (taken.has(i)) continue;
      const it = this.items[i];
      it.missing++;
      // Age decays only while a detection is still unpromoted, so something
      // that blinks in and out never accumulates enough age to be trusted. A
      // promoted detection keeps its age: how long it survives an occlusion is
      // `forgetAfter`'s job alone, and decaying age here would quietly override
      // it. Promotion is deliberately one-way until the item is forgotten —
      // that hysteresis is what stops a piece flickering between present and
      // absent at the detector's threshold.
      if (!it.stable) it.age = Math.max(0, it.age - 1);
    }

    this.items = this.items.filter(
      (it) => it.missing <= forgetAfter && (it.stable || it.age > 0),
    );
    return this.items;
  }

  /** Only the detections that have earned trust. */
  stable(): Array<Tracked<T>> {
    return this.items.filter((it) => it.stable);
  }
}
