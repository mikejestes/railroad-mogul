import type { System } from '../tick.ts';
import type { City } from '../model/cities.ts';
import { demandForTier, populationForTier } from '../model/cities.ts';
import { GOODS, type GoodId } from '../model/goods.ts';

/**
 * City growth & evolution (U8, KTD5) — the spine of the game. Sustained
 * fulfillment of a city's FREIGHT demand grows it a size tier, which raises
 * existing demand and unlocks new demanded goods (R6, R8). Passenger and mail
 * fulfillment is excluded from the growth metric, so a city cannot grow on them
 * alone — freight is required (R7, AE2). Neglect lets progress decay (stagnation).
 */
export const GROWTH_THRESHOLD = 0.5; // avg freight fulfillment needed to make progress
export const GROWTH_DAYS_REQUIRED = 60; // sustained days to advance a tier
export const MAX_TIER = 5;

function isFreight(good: GoodId): boolean {
  const cls = GOODS[good].cargoClass;
  return cls !== 'passenger' && cls !== 'mail';
}

/** Average fulfillment across a city's demanded freight goods (0 if none demanded). */
export function freightFulfillment(city: City): number {
  const freightGoods = (Object.keys(city.demand) as GoodId[]).filter(isFreight);
  if (freightGoods.length === 0) return 0;
  let sum = 0;
  for (const g of freightGoods) sum += city.fulfillment[g] ?? 0;
  return sum / freightGoods.length;
}

export const growthSystem: System = (state, dtDays) => {
  for (const city of state.cities) {
    if (city.sizeTier >= MAX_TIER) continue;

    if (freightFulfillment(city) >= GROWTH_THRESHOLD) {
      city.growthProgress += dtDays;
    } else {
      city.growthProgress = Math.max(0, city.growthProgress - dtDays);
    }

    if (city.growthProgress >= GROWTH_DAYS_REQUIRED) {
      growCity(city);
      city.growthProgress = 0;
    }
  }
};

function growCity(city: City): void {
  city.sizeTier += 1;
  city.population = populationForTier(city.sizeTier);
  // Merge in the higher tier's demand (raises rates, adds newly-unlocked goods).
  const next = demandForTier(city.sizeTier);
  for (const g of Object.keys(next) as GoodId[]) {
    city.demand[g] = next[g]!;
  }
}
