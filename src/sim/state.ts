import { createRng, type RngState } from './rng.ts';

/**
 * The whole simulation world as plain, serializable data (KTD2). No class
 * instances, no Maps at this layer — every field JSON-round-trips so a save is
 * just a canonical serialization of this object plus the RNG counter.
 *
 * Later units extend this: U3 adds the tile grid and cities, U4 goods/industry
 * stockpiles and demand, U5 track, U6 trains. They append fields; they do not
 * change the money-is-integer or canonical-serialization contracts.
 */
export interface GameState {
  /** Fixed ticks elapsed since the game began. */
  tick: number;
  /** Sim time elapsed, in whole days. */
  timeDays: number;
  /** Player cash in integer cents — never floating point (KTD2). */
  moneyCents: number;
  /** Serializable RNG stream driving all in-sim randomness. */
  rng: RngState;
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
    schemaVersion: SCHEMA_VERSION,
  };
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
