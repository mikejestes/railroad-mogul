import type { System } from '../tick.ts';
import type { GoodId } from '../model/goods.ts';

/**
 * Demand system (U4, second in the KTD3 pipeline). Each tick, every city's
 * unmet-demand backlog grows toward a cap at its per-day demand rate, and its
 * rolling fulfillment score decays. Deliveries (U7) drain the backlog and lift
 * fulfillment; with no trains running, backlogs simply fill and fulfillment
 * falls — the "market wants goods and isn't getting them" state.
 */
export const MAX_BACKLOG_DAYS = 10;
/** Fulfillment half-life in days — how fast an unfed city's score decays. */
export const FULFILLMENT_DECAY_PER_DAY = 0.08;

export const demandSystem: System = (state, dtDays) => {
  for (const city of state.cities) {
    for (const good of Object.keys(city.demand) as GoodId[]) {
      const perDay = city.demand[good]!;
      const cap = perDay * MAX_BACKLOG_DAYS;
      const grown = (city.backlog[good] ?? 0) + perDay * dtDays;
      city.backlog[good] = Math.min(cap, grown);

      const decayed = (city.fulfillment[good] ?? 0) - FULFILLMENT_DECAY_PER_DAY * dtDays;
      city.fulfillment[good] = Math.max(0, decayed);
    }
  }
};
