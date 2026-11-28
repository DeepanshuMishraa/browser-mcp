// Human-like pointer and keyboard timing.
// A naive driver teleports the mouse to the exact centre of the target and presses and releases in the same
// millisecond. With human input on, the pointer travels a curved, eased path from where it last was (cubic Bezier
// with a sideways bow, minimum-jerk speed profile, ~60-120 Hz samples, sub-pixel tremor), longer moves take longer
// (Fitts' law), clicks land a pixel or two off centre and hold 60-140 ms, and key presses are spaced 30-110 ms.
// MINI_BROWSER_HUMAN_INPUT=0 (or false/off/no) sends input at full speed.

export type Point = { x: number; y: number };
/** A point to move to after waiting `delayMs`. */
export type TimedPoint = Point & { delayMs: number };
export type Rand = () => number;

export function humanInputEnabled(value: string | undefined) {
  const v = value?.trim().toLowerCase();
  if (!v) return true;
  return !['0', 'false', 'off', 'no'].includes(v);
}

export const HUMAN_INPUT = humanInputEnabled(process.env.MINI_BROWSER_HUMAN_INPUT);

const between = (lo: number, hi: number, rand: Rand = Math.random) => lo + (hi - lo) * rand();

/** Waits a random time in [lo, hi] ms when human input is on; resolves at once otherwise. */
export function pause(lo: number, hi: number) {
  if (!HUMAN_INPUT) return Promise.resolve();
  return new Promise((r) => setTimeout(r, between(lo, hi)));
}

/** A point a pixel or two from `p`, so repeated clicks don't all hit the exact centre. */
export function nearby(p: Point, rand: Rand = Math.random): Point {
  return { x: p.x + between(-1.5, 1.5, rand), y: p.y + between(-1.5, 1.5, rand) };
}

/** Fitts-style movement time: grows with distance, with diminishing returns. */
export function moveDurationMs(distance: number) {
  return Math.min(650, 80 + 75 * Math.log2(1 + distance / 16));
}

/** Minimum-jerk position profile: slow start, fast middle, slow arrival. */
const minJerk = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);

function bezier(a: Point, b: Point, c: Point, d: Point, t: number): Point {
  const u = 1 - t;
  const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t] as const;
  return { x: k[0] * a.x + k[1] * b.x + k[2] * c.x + k[3] * d.x, y: k[0] * a.y + k[1] * b.y + k[2] * c.y + k[3] * d.y };
}

/** Pointer samples from `from` to `to`. The last sample is exactly `to`; coordinates never go negative. */
export function humanPath(from: Point, to: Point, rand: Rand = Math.random): TimedPoint[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 2) return [{ ...to, delayMs: 0 }];
  const duration = moveDurationMs(dist) * between(0.85, 1.15, rand);
  // Unit vector perpendicular to the move: both control points bow to the same side, by different amounts.
  const nx = -dy / dist;
  const ny = dx / dist;
  const bow = between(-0.15, 0.15, rand) * Math.min(dist, 400);
  const at = (along: number, side: number): Point => ({ x: from.x + dx * along + nx * side, y: from.y + dy * along + ny * side });
  const c1 = at(between(0.2, 0.4, rand), bow);
  const c2 = at(between(0.6, 0.8, rand), bow * between(0.3, 0.9, rand));
  const points: TimedPoint[] = [];
  for (let t = 0; t < duration; ) {
    const delayMs = Math.min(between(8, 16, rand), duration - t);
    t += delayMs;
    if (t >= duration) {
      points.push({ ...to, delayMs });
      break;
    }
    const p = bezier(from, c1, c2, to, minJerk(t / duration));
    points.push({ x: Math.max(0, p.x + between(-0.35, 0.35, rand)), y: Math.max(0, p.y + between(-0.35, 0.35, rand)), delayMs });
  }
  return points;
}
