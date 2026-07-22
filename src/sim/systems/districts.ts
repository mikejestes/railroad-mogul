import type { System } from '../tick.ts';
import { EPISODE_COUNT_CAP } from '../model/districts.ts';

/**
 * District dynamics (M4 U4, KTD6). Inserted after delivery and before growth
 * in the tick pipeline (`systems/index.ts`) — districts read the deliveries
 * the same tick applied and settle before city growth reads anything.
 *
 * Each tick, a district's `development` advances toward the level its
 * channels currently support (`developmentTarget`) *while it has been fed
 * recently* (a delivery within `NEGLECT_DAYS`); growth stamps
 * `firstGrowthDay`/`lastGrowthDay` and — when growth resumes after a gap of
 * at least `EPISODE_GAP_DAYS` — increments the bounded `episodeCount`
 * (block-granularity input, KTD4). After `NEGLECT_DAYS` without an accepted
 * delivery, the district stagnates, then declines: channels and development
 * decay at `DECLINE_RATE_PER_DAY`, a documented fraction of the growth rate
 * (KTD6's asymmetry — decay reads as a district going quiet, not a rubber
 * band snapping back, the same taste the origin plan's relocation decision
 * already committed to).
 *
 * All rates are per-day and multiply `dtDays`, matching every other system's
 * shape (production.ts, demand.ts).
 */

/** Development advances toward its channel-supported target at this rate per
 *  day, while the district has been fed within `NEGLECT_DAYS`. */
export const GROWTH_RATE_PER_DAY = 0.01;

/** Decline is this fraction of the growth rate (KTD6's asymmetry) — slower
 *  than growth, so neglect reads as stagnation-then-quiet, not punishment. */
export const DECLINE_RATE_FRACTION = 0.25;

/** Decay rate applied to `development` and every form channel once a
 *  district has gone `NEGLECT_DAYS` without an accepted delivery. */
export const DECLINE_RATE_PER_DAY = GROWTH_RATE_PER_DAY * DECLINE_RATE_FRACTION;

/** Days without an accepted delivery before a district stops growing and
 *  begins to decline (AE3). */
export const NEGLECT_DAYS = 30;

/** A growth gap of at least this many days, after growth has already
 *  started once, counts as the start of a new feeding episode
 *  (block-granularity input, KTD4) rather than a continuation of the last. */
export const EPISODE_GAP_DAYS = 14;

/**
 * The development level a district's current channels support — growth
 * chases this, never exceeds it. The average of the three form channels: a
 * district that is only ever fed one good tops out well below full
 * development, the same way a real one-industry station-town does.
 */
export function developmentTarget(channels: { residential: number; commercial: number; industrial: number }): number {
  return (channels.residential + channels.commercial + channels.industrial) / 3;
}

export const districtSystem: System = (state, dtDays) => {
  const day = state.timeDays;

  for (const district of state.districts) {
    const neglected = district.lastDeliveryDay === null || day - district.lastDeliveryDay >= NEGLECT_DAYS;

    if (!neglected) {
      const target = developmentTarget(district);
      if (target > district.development) {
        const before = district.development;
        district.development = Math.min(target, district.development + GROWTH_RATE_PER_DAY * dtDays);
        if (district.development > before) {
          if (district.firstGrowthDay === null) {
            district.firstGrowthDay = day;
            district.episodeCount = 1;
          } else {
            const gapDays = district.lastGrowthDay === null ? Infinity : day - district.lastGrowthDay;
            if (gapDays >= EPISODE_GAP_DAYS) {
              district.episodeCount = Math.min(EPISODE_COUNT_CAP, district.episodeCount + 1);
            }
          }
          district.lastGrowthDay = day;
        }
      }
      continue;
    }

    // Neglected: hold what remains, decaying slowly rather than snapping back.
    const decay = DECLINE_RATE_PER_DAY * dtDays;
    district.development = Math.max(0, district.development - decay);
    district.residential = Math.max(0, district.residential - decay);
    district.commercial = Math.max(0, district.commercial - decay);
    district.industrial = Math.max(0, district.industrial - decay);
    district.density = Math.max(0, district.density - decay);
  }
};
