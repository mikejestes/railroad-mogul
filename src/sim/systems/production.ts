import type { System } from '../tick.ts';
import { RECIPES, type GoodId } from '../model/goods.ts';

/**
 * Production system (U4, first in the KTD3 pipeline). Each tick, raw extractors
 * accumulate their output, and processors convert delivered inputs into their
 * output — the supply chain only advances as far as its inputs allow, which is
 * what makes hauling raws into a processor's catchment matter (R9).
 */
export const OUTPUT_CAP = 40;

export const productionSystem: System = (state, dtDays) => {
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
