import type { GoodId } from './goods.ts';
import type { GameState } from '../state.ts';
import type { Tile } from '../pathfinding.ts';

/**
 * Engines, trains, and eras (U6). Engines trade speed against pulling power and
 * unlock as the sim year reaches their era — the progression the player wanted
 * to work up through (R11). A train carries a consist along a route of stops,
 * moving over the track graph (pathfinding.ts).
 */
export interface Engine {
  id: string;
  name: string;
  /** Tiles of weighted path traversed per sim day. */
  speed: number;
  /** Maximum number of cars it can pull. */
  power: number;
  /** Year the engine becomes buyable. */
  eraYear: number;
  cost: number;
}

export const ENGINES: Engine[] = [
  { id: 'planet', name: 'Planet 2-2-0', speed: 2, power: 3, eraYear: 1830, cost: 40_000_00 },
  { id: 'norris', name: 'Norris 4-2-0', speed: 3, power: 4, eraYear: 1840, cost: 60_000_00 },
  { id: 'american', name: 'American 4-4-0', speed: 4, power: 6, eraYear: 1860, cost: 80_000_00 },
  { id: 'atlantic', name: 'Atlantic 4-4-2', speed: 6, power: 7, eraYear: 1895, cost: 120_000_00 },
  { id: 'pacific', name: 'Pacific 4-6-2', speed: 8, power: 10, eraYear: 1915, cost: 180_000_00 },
];

export function engineById(id: string): Engine | undefined {
  return ENGINES.find((e) => e.id === id);
}

export function currentYear(state: GameState): number {
  return state.startYear + Math.floor(state.timeDays / 365);
}

export function availableEngines(year: number): Engine[] {
  return ENGINES.filter((e) => e.eraYear <= year);
}

export interface CarLoad {
  good: GoodId;
  qty: number;
  /** Tile the cargo was loaded at (for the fee distance factor, U7). */
  originX: number;
  originY: number;
  /** Sim day the cargo was loaded (for the fee timeliness factor, U7). */
  loadedDay: number;
}

export interface RouteStop {
  stationId: string;
  /** Goods to pick up here (from station catchment supply). */
  loads: GoodId[];
  /** Whether to unload/deliver carried cargo here. */
  unload: boolean;
}

export interface Train {
  id: string;
  engineId: string;
  /** Units carried per car. */
  capacityPerCar: number;
  cars: CarLoad[];
  route: RouteStop[];
  /** Index of the stop the train is heading to (advances cyclically). */
  targetIndex: number;
  /** False until movement places the train at route[0]. JSON-safe (NaN would
   *  serialize to null and break the save round-trip), so this survives save/load. */
  initialized: boolean;
  /** Current tile position (valid once `initialized`). */
  x: number;
  y: number;
  /** Resolved tile path to the current target stop (empty until resolved). */
  path: Tile[];
  /** Index of the last-reached node in `path`. */
  pathPos: number;
  /** Remaining weighted distance to path[pathPos + 1]. */
  distToNext: number;
  /** Set to the station id on arrival; delivery (U7) processes then clears it. */
  atStationId: string | null;
}

export const CAPACITY_PER_CAR = 8;

export function makeTrain(id: string, engineId: string, route: RouteStop[]): Train {
  return {
    id,
    engineId,
    capacityPerCar: CAPACITY_PER_CAR,
    cars: [],
    route,
    targetIndex: 0,
    initialized: false,
    x: 0,
    y: 0,
    path: [],
    pathPos: 0,
    distToNext: 0,
    atStationId: null,
  };
}

/** Total units currently loaded across all cars. */
export function totalCargo(train: Train): number {
  return train.cars.reduce((sum, c) => sum + c.qty, 0);
}
