import { createRng, type RngState } from './rng.ts';
import type { City } from './model/cities.ts';
import type { Industry } from './model/industries.ts';
import type { Station, TrackNetwork, Route, DerelictSite } from './model/track.ts';
import type { Train } from './model/trains.ts';
import type { District } from './model/districts.ts';
import type { RiverGraph } from '../world/rivers.ts';

/**
 * The whole simulation world as plain, serializable data (KTD2). No class
 * instances, no Maps at this layer — every field JSON-round-trips so a save is
 * just a canonical serialization of this object plus the RNG counter.
 *
 * Later units extend this: U3 adds the tile grid and cities, U4 goods/industry
 * stockpiles and demand, U5 track, U6 trains. They append fields; they do not
 * change the money-is-integer or canonical-serialization contracts.
 *
 * U3/R9 change: `World` no longer stores a `terrain` array. Terrain is a pure
 * function of coordinates (`terrainAt` in `world/geography.ts`) evaluable at
 * any resolution without being generated or stored first — the whole point of
 * the milestone (KTD1). `World` now carries only grid dimensions, which bound
 * `x`/`y` for placement and pathfinding; nothing about terrain content lives
 * here, so the save no longer grows with map size or how much of it has been
 * viewed.
 *
 * Milestone 2 U5 addition: `rivers` carries the coarse river flow graph
 * (`world/rivers.ts`). It is the one deliberate, bounded exception to
 * "terrain is never stored" (KTD6, R7) — flow accumulation needs neighbor
 * knowledge and cannot be evaluated per coordinate the way elevation/
 * moisture/temperature can. `createGameState` seeds it with an empty graph;
 * `generateGame` (`world/generate.ts`) fills it in once world dimensions are
 * known, the same pattern `world` itself already follows.
 */
export interface World {
  width: number;
  height: number;
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
  /** Coarse river flow graph, computed once at generation and stored — the
   *  one deliberate exception to "terrain is never stored" (U5, KTD6). */
  rivers: RiverGraph;
  /** Cities: demand sinks that grow when fed (U3, U8). */
  cities: City[];
  /** Industry sites: producers and processors (U3, U4). */
  industries: Industry[];
  /** Player-laid track graph (U5). */
  track: TrackNetwork;
  /** Player-built stations with catchment (U5). */
  stations: Station[];
  /** Trains running the network (U6). */
  trains: Train[];
  /** Committed routes (milestone 3 U4, KTD1): the player-facing record of
   *  each surveyed-and-built line, distinct from the `TrackSegment`s it
   *  emits into `track.segments` (the graph trains actually pathfind over). */
  routes: Route[];
  /** One district per station, in creation order (M4 U2, KTD1, KTD10). A
   *  compact aggregate per station — never individual buildings (R3). */
  districts: District[];
  /** Monotonic counter for player-built station ids; serialized so ids stay
   *  unique and deterministic across save/load and replay. */
  nextStationId: number;
  /** Monotonic counter for player-bought train ids (same rationale). */
  nextTrainId: number;
  /** Monotonic counter for committed-route ids (same rationale, U4). */
  nextRouteId: number;
  /** Monotonic counter for district ids (M4 U2, R14) — serialized so ids
   *  stay unique and deterministic across save/load and replay, the same
   *  discipline `nextStationId`/`nextTrainId` already follow. */
  nextDistrictId: number;
  /** Calendar year the game began (U6 era progression). */
  startYear: number;
  /** Abandoned station sites (milestone 5 U7, KTD8/KTD9): every tile a
   *  station moved away from, in move order. APPEND-ONLY — no code path in
   *  this codebase removes an entry, the same permanence discipline
   *  `District.cuts` follows (U3). A fixed, constant depression forever
   *  (KTD9) — moving a station leaves a scar that does not heal and does
   *  not deepen. */
  derelictSites: DerelictSite[];
  /** Save-format version, for migrations (U11). */
  schemaVersion: number;
}

export const START_YEAR = 1830;

/**
 * Save-format version. Bumped 1 -> 2 because `World.terrain` — a stored array
 * serialized under schema 1 — was removed in U3 (terrain-substrate milestone
 * U7, KTD9) in favor of pure field evaluation; a v1 envelope's `state` JSON
 * carries a shape `deserializeSave` can no longer interpret correctly.
 *
 * Bumped 2 -> 3 (route-surveying milestone U4, KTD10) because `GameState.routes`,
 * `nextRouteId`, and the optional `TrackSegment.structure` field
 * (`model/track.ts`) change the stored shape.
 *
 * Bumped 3 -> 4 (city-districts milestone U2, KTD11) because `state.districts`
 * and `nextDistrictId` are new required fields a schema-3 save's `state` JSON
 * does not carry; a district's channels are a readout of delivery history that
 * was never recorded before, so nothing could synthesize them. Same precedent
 * throughout: there is still no save UI, autosave, or load path in the running
 * app (persistence is exercised only by tests), so no older save can exist in
 * the wild to strand, and `migrate` in `persistence/saveStore.ts` refuses a
 * version mismatch outright rather than fabricating fields an older save never
 * had. Bump this again, and add a real migration step, the next time a
 * stored-state shape changes after a save path ships.
 *
 * Bumped 4 -> 5 (station siting/severance milestone U7, KTD11): `Station`
 * gains an optional `stationType`, `District` gains `cuts`, and
 * `state.derelictSites` is a new required field — none of which a
 * schema-4 save's `state` JSON carries. Same precedent again: `cuts` and
 * `derelictSites` are permanent, path-dependent history (which infrastructure
 * severed what, and when a station was abandoned) that was never recorded
 * before this milestone, so there is nothing to synthesize it from; `migrate`
 * refuses the version mismatch outright rather than fabricating a severance
 * history that never happened.
 */
export const SCHEMA_VERSION = 5;

export function createGameState(seed: number): GameState {
  return {
    tick: 0,
    timeDays: 0,
    moneyCents: 0,
    rng: createRng(seed),
    world: { width: 0, height: 0 },
    rivers: { rivers: [] },
    cities: [],
    industries: [],
    track: { segments: [] },
    stations: [],
    trains: [],
    routes: [],
    districts: [],
    nextStationId: 0,
    nextTrainId: 0,
    nextRouteId: 0,
    nextDistrictId: 0,
    startYear: START_YEAR,
    derelictSites: [],
    schemaVersion: SCHEMA_VERSION,
  };
}

/** Starting capital for a new game, in integer cents (~$1,000,000). */
export const STARTING_CAPITAL = 1_000_000_00;

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
