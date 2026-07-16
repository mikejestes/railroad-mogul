/**
 * The goods catalog and industry recipes (U4, referenced by U3 placement).
 *
 * Cargo class drives fee weighting (U7) the way the original's class 0–4 did,
 * but here it is one input among several, never a shortcut around demand (R2).
 * The chain includes a genuine multi-stage path (iron + coal -> steel -> goods)
 * so "using every resource type" is actually exercised (R9).
 */
export type GoodId =
  | 'coal'
  | 'iron'
  | 'grain'
  | 'cattle'
  | 'steel'
  | 'food'
  | 'goods'
  | 'passengers'
  | 'mail';

export type CargoClass = 'passenger' | 'mail' | 'processed' | 'bulk';

export interface Good {
  id: GoodId;
  name: string;
  cargoClass: CargoClass;
  /** Base per-unit fee rate before demand/timeliness/distance/saturation. */
  baseRate: number;
}

export const GOODS: Record<GoodId, Good> = {
  passengers: { id: 'passengers', name: 'Passengers', cargoClass: 'passenger', baseRate: 12 },
  mail: { id: 'mail', name: 'Mail', cargoClass: 'mail', baseRate: 14 },
  goods: { id: 'goods', name: 'Manufactured Goods', cargoClass: 'processed', baseRate: 20 },
  steel: { id: 'steel', name: 'Steel', cargoClass: 'processed', baseRate: 14 },
  food: { id: 'food', name: 'Food', cargoClass: 'processed', baseRate: 11 },
  coal: { id: 'coal', name: 'Coal', cargoClass: 'bulk', baseRate: 6 },
  iron: { id: 'iron', name: 'Iron Ore', cargoClass: 'bulk', baseRate: 7 },
  grain: { id: 'grain', name: 'Grain', cargoClass: 'bulk', baseRate: 6 },
  cattle: { id: 'cattle', name: 'Cattle', cargoClass: 'bulk', baseRate: 8 },
};

export type IndustryType =
  | 'coalMine'
  | 'ironMine'
  | 'farm'
  | 'ranch'
  | 'steelMill'
  | 'factory'
  | 'foodPlant';

export interface Recipe {
  type: IndustryType;
  name: string;
  /** Goods consumed per production cycle (empty for raw producers). */
  inputs: Partial<Record<GoodId, number>>;
  /** Good produced per cycle. */
  output: GoodId;
  /** Units produced per production cycle when inputs are available. */
  rate: number;
}

export const RECIPES: Record<IndustryType, Recipe> = {
  coalMine: { type: 'coalMine', name: 'Coal Mine', inputs: {}, output: 'coal', rate: 4 },
  ironMine: { type: 'ironMine', name: 'Iron Mine', inputs: {}, output: 'iron', rate: 3 },
  farm: { type: 'farm', name: 'Farm', inputs: {}, output: 'grain', rate: 4 },
  ranch: { type: 'ranch', name: 'Ranch', inputs: {}, output: 'cattle', rate: 3 },
  steelMill: { type: 'steelMill', name: 'Steel Mill', inputs: { iron: 2, coal: 2 }, output: 'steel', rate: 2 },
  factory: { type: 'factory', name: 'Factory', inputs: { steel: 2 }, output: 'goods', rate: 2 },
  foodPlant: { type: 'foodPlant', name: 'Food Plant', inputs: { grain: 2 }, output: 'food', rate: 3 },
};

/** Raw extractors — placed on resource tiles by seeded generation (U3). */
export const RAW_INDUSTRY_TYPES: IndustryType[] = ['coalMine', 'ironMine', 'farm', 'ranch'];
/** Processors — placed near cities by seeded generation (U3). */
export const PROCESSOR_INDUSTRY_TYPES: IndustryType[] = ['steelMill', 'factory', 'foodPlant'];
