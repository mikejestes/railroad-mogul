/**
 * Discrete zoom tiers with directional hysteresis (U4, KTD5, R5, R6).
 *
 * KTD4 (semantic zoom) means what an entity draws as changes with zoom
 * rather than just its size, and KTD5 says that mapping is a small fixed set
 * of tiers, not continuous level-of-detail — 2D tile games read better as a
 * few distinct representations than as a smoothly interpolated one, and a
 * single scale threshold produces visible flicker when the camera rests
 * exactly on it.
 *
 * Each tier (other than the lowest) carries the thresholds for the boundary
 * *below* it: `upThreshold` is how far scale must climb, approached from the
 * tier below, before this tier is entered; `downThreshold` is how far scale
 * must fall, approached from within this tier, before it is exited back
 * down. `downThreshold < upThreshold` for every boundary — the gap between
 * them is the hysteresis band (R6/AE2): a scale resting anywhere inside that
 * band keeps whatever tier the camera already had, regardless of which side
 * it was approached from, so nudging the zoom back and forth near a boundary
 * does not flicker.
 *
 * `tierFor` takes the current tier as an input specifically so that band is
 * directional — it is not a pure scale-to-tier lookup table.
 */
export type ZoomTierId = 'continent' | 'region' | 'local';

export interface ZoomTierDef {
  id: ZoomTierId;
  /** Scale must exceed this, approached from the tier below, to enter this tier. Unused (sentinel) for the lowest tier, which has no tier below it. */
  upThreshold: number;
  /** Scale must fall below this, approached from within this tier, to retreat to the tier below. Unused (sentinel) for the lowest tier, which has no tier below it. */
  downThreshold: number;
}

/** Scale (pixels per world unit, same units as `Camera.scale`) above which the
 * camera advances from `continent` into `region`; below which it retreats
 * from `region` back to `continent`. */
export const REGION_UP_THRESHOLD = 24;
export const REGION_DOWN_THRESHOLD = 16;

/** Scale above which the camera advances from `region` into `local`; below
 * which it retreats from `local` back to `region`. */
export const LOCAL_UP_THRESHOLD = 140;
export const LOCAL_DOWN_THRESHOLD = 100;

/**
 * Ordered lowest-scale tier first. `continent`'s thresholds are never read
 * by `tierFor` (there is no tier below it to advance from or retreat to) —
 * they exist only so every entry shares one shape.
 */
export const ZOOM_TIERS: readonly ZoomTierDef[] = [
  { id: 'continent', upThreshold: -Infinity, downThreshold: -Infinity },
  { id: 'region', upThreshold: REGION_UP_THRESHOLD, downThreshold: REGION_DOWN_THRESHOLD },
  { id: 'local', upThreshold: LOCAL_UP_THRESHOLD, downThreshold: LOCAL_DOWN_THRESHOLD },
];

/**
 * Resolve the zoom tier for `scale`, given the tier the camera is already in.
 * Pure and total: walks up through `ZOOM_TIERS` while `scale` clears the next
 * tier's `upThreshold`, then walks down while it falls short of the current
 * tier's `downThreshold`. Only one direction ever actually moves for a given
 * call — the two passes exist so a scale change that jumps across more than
 * one boundary at once (e.g. a huge wheel delta) still lands on the correct
 * end tier (R6) rather than only the adjacent one.
 */
export function tierFor(scale: number, currentTier: ZoomTierId): ZoomTierId {
  let index = ZOOM_TIERS.findIndex((tier) => tier.id === currentTier);
  if (index === -1) index = 0; // defensive: an unrecognized tier id falls back to the lowest

  while (index < ZOOM_TIERS.length - 1 && scale > ZOOM_TIERS[index + 1].upThreshold) {
    index++;
  }
  while (index > 0 && scale < ZOOM_TIERS[index].downThreshold) {
    index--;
  }

  return ZOOM_TIERS[index].id;
}
