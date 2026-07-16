import { createRng, type RngState } from './rng.ts';
import type { Terrain } from '../world/geography.ts';
import type { City } from './model/cities.ts';
import type { Industry } from './model/industries.ts';
import type { Station, TrackNetwork } from './model/track.ts';

/**
 * The whole simulation world as plain, serializable data (KTD2). No class
 * instances, no Maps at this layer — every field JSON-round-trips so a save is
 * just a canonical serialization of this object plus the RNG counter.
 *
 * Later units extend this: U3 adds the tile grid and cities, U4 goods/industry
 * stockpiles and demand, U5 track, U6 trains. They append fields; they do not
 * change the money-is-integer or canonical-serialization contracts.
 */
/** The tile grid. `terrain` is row-major, length width*height (U3). */
export interface World {
  width: number;
  height: number;
  terrain: Terrain[];
}

export interface GameState {
  /** Fixed ticks elapsed since the game began. */
  tick: number;
  /** Sim time elapsed, in whole days. */
  timeDays: number;
  /** Player cash in integer cents — never floating point (KTD2). */
  moneyCents: number;
  /** Serializable RNG stream driving all in-sim randomness. */
  rng: RngState;
  /** The tile grid (empty until U3 generation fills it). */
  world: World;
  /** Cities: demand sinks that grow when fed (U3, U8). */
  cities: City[];
  /** Industry sites: producers and processors (U3, U4). */
  industries: Industry[];
  /** Player-laid track graph (U5). */
  track: TrackNetwork;
  /** Player-built stations with catchment (U5). */
  stations: Station[];
  /** Save-format version, for migrations (U11). */
  schemaVersion: number;
}

export const SCHEMA_VERSION = 1;

export function createGameState(seed: number): GameState {
  return {
    tick: 0,
    timeDays: 0,
    moneyCents: 0,
    rng: createRng(seed),
    world: { width: 0, height: 0, terrain: [] },
    cities: [],
    industries: [],
    track: { segments: [] },
    stations: [],
    schemaVersion: SCHEMA_VERSION,
  };
}

/** Starting capital for a new game, in integer cents (~$1,000,000). */
export const STARTING_CAPITAL = 1_000_000_00;

/** Row-major tile index helper. */
export function tileIndex(world: World, x: number, y: number): number {
  return y * world.width + x;
}

/** Adjust player cash. Callers pass integer cents; guarded to stay integer. */
export function addMoney(state: GameState, deltaCents: number): void {
  state.moneyCents += Math.trunc(deltaCents);
}

/**
 * Canonical serialization: JSON with recursively sorted object keys so the
 * output depends only on values, never on key insertion order. This is the
 * determinism/save contract — two states with equal values serialize
 * byte-identically. Arrays keep their order (order is meaningful); plain
 * objects are key-sorted. When later units introduce Maps, convert them to
 * sorted-key arrays here rather than relying on Map iteration order.
 */
export function serialize(state: GameState): string {
  return JSON.stringify(sortValue(state));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
