import type { GoodId, IndustryType } from './goods.ts';
import { RECIPES } from './goods.ts';

/**
 * An industry site: produces a good each production cycle (U4). Raw extractors
 * have no inputs and accumulate output directly; processors consume delivered
 * inputs (fed by trains via catchment, U7) to make their output — this is the
 * supply chain the player's network stitches together.
 */
export interface Industry {
  id: string;
  type: IndustryType;
  x: number;
  y: number;
  output: GoodId;
  /** Units of finished output waiting to be hauled out. */
  outputStock: number;
  /** Delivered inputs waiting to be processed (empty for raw extractors). */
  inputStock: Partial<Record<GoodId, number>>;
}

export function makeIndustry(id: string, type: IndustryType, x: number, y: number): Industry {
  return {
    id,
    type,
    x,
    y,
    output: RECIPES[type].output,
    outputStock: 0,
    inputStock: {},
  };
}
