/**
 * Ball physics against the table.
 *
 * Everything is in board units — the play area is 0..1 across and 0..1/aspect
 * down — so a game plays identically whether the physical play area is a sheet
 * of A4 or a whole kitchen table, and a recalibration mid-game does not change
 * how the ball falls.
 */

import { fieldNormal, sampleField, type FieldRef } from "./field.js";

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** Set when the ball leaves play; the game recycles it. */
  dead: boolean;
}

export interface PhysicsOptions {
  /** Board units per second squared. */
  gravity?: number;
  /** Fraction of speed kept through a bounce. */
  restitution?: number;
  /** Tangential damping on contact, 0 = ice, 1 = velcro. */
  friction?: number;
  /** Occupancy above which a point counts as inside an obstacle. */
  solidAt?: number;
  /** Speed cap, so a ball squeezed between two moving hands cannot be launched. */
  maxSpeed?: number;
}

const DEFAULTS: Required<PhysicsOptions> = {
  gravity: 0.9,
  restitution: 0.55,
  friction: 0.12,
  solidAt: 0.5,
  maxSpeed: 3,
};

/**
 * Advance one ball.
 *
 * Substepped by the distance travelled rather than by a fixed count: a slow
 * ball costs one step, and a fast one takes as many as it needs to never move
 * more than its own radius per step. Without that, a ball crossing a pen line
 * at speed simply teleports through it — the failure everyone hits first when
 * collision is sampled from a mask.
 */
export function stepBall(
  ball: Ball,
  field: FieldRef,
  boardW: number,
  boardH: number,
  dt: number,
  opts: PhysicsOptions = {},
): void {
  const o = { ...DEFAULTS, ...opts };
  // Board units per field pixel: the field is indexed in pixels, the ball
  // lives in board units, and mixing them up is the classic silent bug here.
  const scale = field.w;
  const radiusPx = ball.r * scale;

  const speed = Math.hypot(ball.vx, ball.vy);
  const travel = speed * dt * scale;
  const steps = Math.max(1, Math.min(8, Math.ceil(travel / Math.max(1, radiusPx))));
  const h = dt / steps;

  for (let i = 0; i < steps; i++) {
    ball.vy += o.gravity * h;

    const sp = Math.hypot(ball.vx, ball.vy);
    if (sp > o.maxSpeed) {
      ball.vx *= o.maxSpeed / sp;
      ball.vy *= o.maxSpeed / sp;
    }

    ball.x += ball.vx * h;
    ball.y += ball.vy * h;

    const px = ball.x * scale;
    const py = ball.y * scale;

    if (sampleField(field, px, py) > o.solidAt) {
      const n = fieldNormal(field, px, py);
      if (n.x === 0 && n.y === 0) {
        // Deep inside a large obstacle the field is flat and has no usable
        // normal. Rather than freeze, back the ball out along its own motion:
        // it entered that way, so reversing is always a way out.
        const back = Math.hypot(ball.vx, ball.vy) || 1;
        ball.x -= (ball.vx / back) * (radiusPx / scale);
        ball.y -= (ball.vy / back) * (radiusPx / scale);
        ball.vy *= -o.restitution;
      } else {
        resolveContact(ball, n, o, scale);
      }
    }

    // Side walls keep play inside the calibrated area; the floor is the
    // game's business, since some games catch balls and some let them out.
    if (ball.x < ball.r) {
      ball.x = ball.r;
      ball.vx = Math.abs(ball.vx) * o.restitution;
    } else if (ball.x > boardW - ball.r) {
      ball.x = boardW - ball.r;
      ball.vx = -Math.abs(ball.vx) * o.restitution;
    }

    if (ball.y > boardH + ball.r * 4) {
      ball.dead = true;
      return;
    }
  }
}

function resolveContact(
  ball: Ball,
  n: { x: number; y: number },
  o: Required<PhysicsOptions>,
  scale: number,
): void {
  // Push out along the normal so the ball never rests inside the obstacle,
  // then reflect. Separating before reflecting matters: reflecting first lets
  // the next substep find the ball still inside and reflect it back in, which
  // reads as a ball vibrating against a pencil line.
  const push = (ball.r * 0.6) + 1 / scale;
  ball.x += n.x * push;
  ball.y += n.y * push;

  const along = ball.vx * n.x + ball.vy * n.y;
  if (along < 0) {
    const tx = ball.vx - along * n.x;
    const ty = ball.vy - along * n.y;
    ball.vx = tx * (1 - o.friction) - along * n.x * o.restitution;
    ball.vy = ty * (1 - o.friction) - along * n.y * o.restitution;
  }
}
