import type { System } from '../tick.ts';
import type { GoodId } from '../model/goods.ts';
import { districtTrafficMultiplier } from '../model/districts.ts';
import { CITY_SUPPLIED_GOODS } from './production.ts';

/**
 * Demand system (U4, second in the KTD3 pipeline). Each tick, every city's
 * unmet-demand backlog grows toward a cap at its per-day demand rate, and its
 * rolling fulfillment score decays. Deliveries (U7) drain the backlog and lift
 * fulfillment; with no trains running, backlogs simply fill and fulfillment
 * falls — the "market wants goods and isn't getting them" state.
 *
 * M4 U5 (KTD5, R7): passenger/mail backlog growth is scaled by
 * `districtTrafficMultiplier` — a healthy district covering the city makes
 * its residents want more travel/mail service. `CITY_SUPPLIED_GOODS`
 * (`production.ts`) is imported rather than re-declared so the two systems
 * never drift on which goods district health touches. The backlog *cap*
 * itself stays tied to the city's base demand rate — only the fill rate
 * scales — and freight demand growth is untouched entirely (KTD9 isolation):
 * `demandForTier`/city growth remain the trunk the umbrella contract
 * requires.
 */
export const MAX_BACKLOG_DAYS = 10;
/** Fulfillment half-life in days — how fast an unfed city's score decays. */
export const FULFILLMENT_DECAY_PER_DAY = 0.08;

export const demandSystem: System = (state, dtDays) => {
  for (const city of state.cities) {
    const multiplier = districtTrafficMultiplier(state, city);
    for (const good of Object.keys(city.demand) as GoodId[]) {
      const perDay = city.demand[good]!;
      const cap = perDay * MAX_BACKLOG_DAYS;
      const effectivePerDay = CITY_SUPPLIED_GOODS.includes(good) ? perDay * multiplier : perDay;
      const grown = (city.backlog[good] ?? 0) + effectivePerDay * dtDays;
      city.backlog[good] = Math.min(cap, grown);

      const decayed = (city.fulfillment[good] ?? 0) - FULFILLMENT_DECAY_PER_DAY * dtDays;
      city.fulfillment[good] = Math.max(0, decayed);
    }
  }
};
