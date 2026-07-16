import type { GoodId } from './goods.ts';

/**
 * A city: a demand sink that grows when its demand is met (U8). Position is in
 * tile coords. `demand` is desired units per day at the current size tier;
 * `fulfillment` tracks recent delivery against demand and drives growth.
 */
export interface City {
  id: string;
  name: string;
  x: number;
  y: number;
  /** 0-based size tier; raised by sustained fulfillment (U8). */
  sizeTier: number;
  population: number;
  /** Desired units per day, per good, at the current size tier. */
  demand: Partial<Record<GoodId, number>>;
  /** Unmet demand accumulator per good; grows by demand/day, drained by delivery (U4/U7). */
  backlog: Partial<Record<GoodId, number>>;
  /** Rolling fulfillment score per good (0..1), updated by delivery (U7/U8). */
  fulfillment: Partial<Record<GoodId, number>>;
}

/**
 * Demand profile by size tier. Passengers and mail scale with population but are
 * never sufficient for growth on their own (freight is required — R7, enforced
 * in U8). Higher tiers unlock new demanded goods, which is what makes every
 * resource type eventually matter (R8, R9).
 */
export function demandForTier(tier: number): Partial<Record<GoodId, number>> {
  const base: Partial<Record<GoodId, number>> = {
    passengers: 3 + tier * 2,
    mail: 2 + tier,
    food: 2 + tier,
  };
  if (tier >= 1) base.goods = 1 + tier;
  if (tier >= 2) base.steel = 1 + (tier - 1);
  return base;
}

export function populationForTier(tier: number): number {
  return 50_000 * (tier + 1) * (tier + 1);
}

export function makeCity(id: string, name: string, x: number, y: number, tier = 0): City {
  return {
    id,
    name,
    x,
    y,
    sizeTier: tier,
    population: populationForTier(tier),
    demand: demandForTier(tier),
    backlog: {},
    fulfillment: {},
  };
}
