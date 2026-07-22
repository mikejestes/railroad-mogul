import type { System } from '../tick.ts';
import { RECIPES, type GoodId } from '../model/goods.ts';
import { districtTrafficMultiplier } from '../model/districts.ts';

/**
 * Production system (U4, first in the KTD3 pipeline). Each tick, raw extractors
 * accumulate their output, and processors convert delivered inputs into their
 * output — the supply chain only advances as far as its inputs allow, which is
 * what makes hauling raws into a processor's catchment matter (R9).
 *
 * Cities also generate passengers and mail here (from population): outbound
 * travelers/mail waiting at the city's station to be hauled elsewhere. This is
 * revenue traffic, not a growth input — freight still gates city growth (R7).
 *
 * M4 U5 (KTD5, R7): passenger/mail generation is scaled by
 * `districtTrafficMultiplier` — a healthy district covering the city
 * generates more outbound traffic, the "good urbanism pays" loop. Freight
 * output (industry `outputStock`, below) is untouched (KTD9 isolation): only
 * passengers and mail couple to district health.
 */
export const OUTPUT_CAP = 40;
export const CITY_SUPPLY_CAP = 40;

/** Goods a city generates from population (as opposed to industry output). */
export const CITY_SUPPLIED_GOODS: GoodId[] = ['passengers', 'mail'];

export const productionSystem: System = (state, dtDays) => {
  // Cities generate passengers/mail at the same rate they demand them — a big
  // city both sends and receives a lot of traffic. Scaled by district health
  // in range (KTD5): a city with no districted station in range multiplies
  // by exactly 1, so pre-milestone traffic numbers are a regression case of
  // this same code path, not a special one.
  for (const city of state.cities) {
    const multiplier = districtTrafficMultiplier(state, city);
    for (const good of CITY_SUPPLIED_GOODS) {
      const rate = city.demand[good] ?? 0;
      if (rate <= 0) continue;
      city.supply[good] = Math.min(CITY_SUPPLY_CAP, (city.supply[good] ?? 0) + rate * multiplier * dtDays);
    }
  }

  for (const ind of state.industries) {
    const recipe = RECIPES[ind.type];
    const inputGoods = Object.keys(recipe.inputs) as GoodId[];

    if (inputGoods.length === 0) {
      // Raw extractor: accumulate output up to the cap.
      ind.outputStock = Math.min(OUTPUT_CAP, ind.outputStock + recipe.rate * dtDays);
      continue;
    }

    // Processor: how many cycles can inputs and rate support this tick?
    const desiredCycles = recipe.rate * dtDays;
    let feasible = desiredCycles;
    for (const g of inputGoods) {
      const need = recipe.inputs[g]!;
      const have = ind.inputStock[g] ?? 0;
      feasible = Math.min(feasible, have / need);
    }
    const cycles = Math.min(feasible, OUTPUT_CAP - ind.outputStock);
    if (cycles <= 0) continue;

    for (const g of inputGoods) {
      ind.inputStock[g] = (ind.inputStock[g] ?? 0) - recipe.inputs[g]! * cycles;
    }
    ind.outputStock += cycles;
  }
};
