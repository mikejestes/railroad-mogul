import type { GoodId } from './goods.ts';
import type { City } from './cities.ts';
import type { GameState } from '../state.ts';
import { inCatchment, stationTypeOf, type Station, type StationType } from './track.ts';

/**
 * The district model (M4 U1, KTD1–KTD5). A district is the compact aggregate
 * every other district-facing unit builds on: three bounded "form channels"
 * fed by delivered goods, a density channel, an overall built-out extent
 * (`development`), and a small growth-history footprint. Nothing else about
 * a district is stored — everything the health model or the street renderer
 * needs beyond these dozen numbers is *derived* by the pure functions below
 * (KTD1). This keeps the record plainly JSON-safe (R14) and lets AE1/AE5 be
 * proven here, before any system or renderer exists to complicate the
 * question.
 *
 * KTD2's goods-to-form table and KTD4's four Jacobs generators both live here
 * too, so the mapping from "what got delivered" to "what health reads as" is
 * one authoritative, tunable place — not logic duplicated across the
 * delivery, dynamics, and rendering units that each consume a piece of it.
 *
 * Forward-compatibility note (see the plan's Assumptions): milestone 5
 * narrows `ensureDistrict`'s idempotency from per-station-id to
 * per-(station id, anchor) once relocation can produce a second district for
 * one station id. Nothing in this file assumes per-station-id uniqueness —
 * that invariant is enforced by the caller (`applyIntents.ts`, U2), not here.
 */

/** A district's built form, in [0, 1] each — fed by accepted deliveries
 *  (KTD3) via `accrueDelivery`. Never negative, never above `CHANNEL_CAP`. */
export interface District {
  id: string;
  /** The station this district grows around. */
  stationId: string;
  /** The station's tile at district creation (KTD1) — milestone 5's
   *  relocation rules need the original anchor even after a station moves. */
  anchorX: number;
  anchorY: number;
  /** Housing/food-adjacent built form, [0, 1]. */
  residential: number;
  /** Shopfront/passenger-adjacent built form, [0, 1]. */
  commercial: number;
  /** Industrial/freight-adjacent built form, [0, 1]. */
  industrial: number;
  /** Density channel, [0, 1] — steel permits height (KTD2). */
  density: number;
  /** Overall built-out extent, [0, 1] — the renderer's scene-scale input
   *  (KTD8), not a persisted geometry boundary (see the plan's Assumptions). */
  development: number;
  /** Sim day of the district's first growth tick, or `null` before any
   *  growth has happened. */
  firstGrowthDay: number | null;
  /** Sim day of the district's most recent growth tick, or `null`. */
  lastGrowthDay: number | null;
  /** Count of distinct feeding episodes (bounded at `EPISODE_COUNT_CAP`) —
   *  the block-granularity input (KTD4). */
  episodeCount: number;
  /** Sim day of the most recent *accepted* delivery, or `null` before any
   *  delivery has been accepted (KTD3). Drives neglect/decline (KTD6). */
  lastDeliveryDay: number | null;
}

/** Every form/density channel is clamped to this ceiling (AE5). */
export const CHANNEL_CAP = 1;

function clamp01(value: number): number {
  return Math.min(CHANNEL_CAP, Math.max(0, value));
}

/** A freshly created district: a zero-development hamlet anchored at the
 *  station's tile (KTD10 — every station gets one, rural stations included). */
export function makeDistrict(id: string, station: { id: string; x: number; y: number }): District {
  return {
    id,
    stationId: station.id,
    anchorX: station.x,
    anchorY: station.y,
    residential: 0,
    commercial: 0,
    industrial: 0,
    density: 0,
    development: 0,
    firstGrowthDay: null,
    lastGrowthDay: null,
    episodeCount: 0,
    lastDeliveryDay: null,
  };
}

/**
 * Per-unit form contribution of a delivered good (KTD2). Every `GoodId` has a
 * non-zero row — a table, not code branches, so AE1's "difference corresponds
 * to what was delivered" is a property of data an implementer can tune
 * without touching accrual logic (R8's panel-free legibility inherits this
 * one authoritative mapping).
 *
 * - Food and cattle thicken residential (people need to eat); grain carries
 *   the same small residential weight as cattle — it is a farm crop on its
 *   way to becoming food, not a mineral, so it is not industrial.
 * - Manufactured goods build commercial frontage; passengers do too, weakly
 *   (a station that moves people builds shopfronts); mail carries a small
 *   commercial weight for the same city-to-city-traffic reason as passengers.
 * - Coal, iron, and steel build industrial character; steel additionally
 *   raises `density` — steel permits height (the origin's key decision).
 */
export const GOOD_FORM_WEIGHTS: Record<
  GoodId,
  Partial<Record<'residential' | 'commercial' | 'industrial' | 'density', number>>
> = {
  food: { residential: 0.02 },
  cattle: { residential: 0.015 },
  grain: { residential: 0.008 },
  goods: { commercial: 0.02 },
  passengers: { commercial: 0.006 },
  mail: { commercial: 0.008 },
  coal: { industrial: 0.015 },
  iron: { industrial: 0.015 },
  steel: { industrial: 0.02, density: 0.01 },
};

/**
 * Per-station-type accrual modifiers (milestone 5 U2, KTD4): scales
 * `GOOD_FORM_WEIGHTS` at accrual time so what a station is *for* shapes what
 * grows around it, independently of catchment size (R5). A freight yard
 * amplifies industrial and density accrual and damps commercial (freight
 * doesn't build shopfronts); a passenger terminal amplifies commercial and
 * residential (foot traffic builds both) and damps industrial slightly (a
 * passenger station is a poor freight yard). `mixed` carries no entries —
 * every channel falls through to the `?? 1` identity in `accrueDelivery`
 * below — so accrual through a mixed depot is byte-identical to milestone
 * 4's undifferentiated behavior (regression guard; the same "mixed is
 * neutral" rule `STATION_TYPE_TRAFFIC_WEIGHTS` below follows).
 */
export const STATION_TYPE_MODIFIERS: Record<
  StationType,
  Partial<Record<'residential' | 'commercial' | 'industrial' | 'density', number>>
> = {
  freight: { commercial: 0.5, industrial: 1.5, density: 1.3 },
  passenger: { residential: 1.3, commercial: 1.4, industrial: 0.6 },
  mixed: {},
};

/**
 * Credit a district for `qty` units of `good` accepted at its station
 * (KTD3 — the caller, `unloadCargo` in `systems/delivery.ts`, is responsible
 * for only ever passing *accepted* quantities; this function itself has no
 * opinion about what "accepted" means). Every channel clamps to
 * `CHANNEL_CAP` (AE5) regardless of how far beyond it `qty` would otherwise
 * push it. Stamps `lastDeliveryDay`; does not touch `development` or growth
 * history — that is the dynamics system's job (U4).
 *
 * `stationType` (milestone 5 U2, KTD4) defaults to `'mixed'` — the same
 * default `stationTypeOf` falls back to — so every pre-M5 call site
 * (including the many existing tests that build a district without an
 * opinion about type) accrues exactly as milestone 4 did. `GOOD_FORM_WEIGHTS`
 * stays the base table; `STATION_TYPE_MODIFIERS` scales it per channel,
 * never the other way around, so the two tables can be tuned independently.
 */
export function accrueDelivery(
  district: District,
  good: GoodId,
  qty: number,
  day: number,
  stationType: StationType = 'mixed',
): void {
  if (qty <= 0) return;
  const weights = GOOD_FORM_WEIGHTS[good];
  const modifiers = STATION_TYPE_MODIFIERS[stationType];
  if (weights.residential) {
    district.residential = clamp01(district.residential + weights.residential * (modifiers.residential ?? 1) * qty);
  }
  if (weights.commercial) {
    district.commercial = clamp01(district.commercial + weights.commercial * (modifiers.commercial ?? 1) * qty);
  }
  if (weights.industrial) {
    district.industrial = clamp01(district.industrial + weights.industrial * (modifiers.industrial ?? 1) * qty);
  }
  if (weights.density) {
    district.density = clamp01(district.density + weights.density * (modifiers.density ?? 1) * qty);
  }
  district.lastDeliveryDay = day;
}

// --- KTD4: the four Jacobs generators, each a pure function of the record ---

/** A channel share exactly at 1/3 is perfectly mixed (three equal channels). */
const UNIFORM_SHARE = 1 / 3;
/** The maximum possible sum of absolute deviations from `UNIFORM_SHARE`,
 *  reached when one channel holds the district's entire built form (shares
 *  `[1, 0, 0]`): `|1 - 1/3| + |0 - 1/3| + |0 - 1/3| = 4/3`. Used to normalize
 *  `useMix` into [0, 1]. */
const MAX_SHARE_DEVIATION = 2 * (1 - UNIFORM_SHARE);

/**
 * Mixed use (KTD4): 1 minus the normalized deviation of the three channel
 * shares from uniform. A district with no built form at all (a hamlet) has
 * no use to be mixed, so it scores 0 rather than the vacuous "perfectly
 * balanced" 1 a naive uniform-shares fallback would produce.
 */
export function useMix(district: District): number {
  const total = district.residential + district.commercial + district.industrial;
  if (total <= 0) return 0;
  const shares = [district.residential / total, district.commercial / total, district.industrial / total];
  const deviation = shares.reduce((sum, s) => sum + Math.abs(s - UNIFORM_SHARE), 0);
  return clamp01(1 - deviation / MAX_SHARE_DEVIATION);
}

/** Feeding episodes at or above this count read as maximally fine-grained
 *  block structure (KTD4) — `blockGranularity` saturates to 1 here. */
export const EPISODE_TARGET = 20;
/** Hard ceiling on `District.episodeCount` (AE5) — comfortably above
 *  `EPISODE_TARGET` so the granularity curve has already saturated well
 *  before the accumulator itself could be accused of growing unboundedly. */
export const EPISODE_COUNT_CAP = 60;

/** Block granularity (KTD4): a district that grew in many separate episodes
 *  has fine grain; a single boom builds superblocks. */
export function blockGranularity(district: District): number {
  return clamp01(district.episodeCount / EPISODE_TARGET);
}

/** Growth spread over at least this many days reads as maximal age variety
 *  (KTD4) — `ageVariety` saturates to 1 here. */
export const AGE_SPAN_DAYS = 720;

/** Age variety (KTD4): growth spread over time yields mixed building ages; a
 *  district that grew in a single instant (or has never grown) has none. */
export function ageVariety(district: District): number {
  if (district.firstGrowthDay === null || district.lastGrowthDay === null) return 0;
  const span = district.lastGrowthDay - district.firstGrowthDay;
  return clamp01(span / AGE_SPAN_DAYS);
}

/** The `density` channel value at which `densityScore` saturates to 1 — a
 *  plateau curve (KTD4): too sparse scores low, but there is no
 *  over-density penalty at this scale, so anything at or above the plateau
 *  scores the maximum. */
export const DENSITY_PLATEAU = 0.5;

/** Density score (KTD4): a plateau curve peaking at sufficient density. */
export function densityScore(district: District): number {
  return clamp01(district.density / DENSITY_PLATEAU);
}

/** Equal weighting across the four Jacobs generators (KTD4) — no single
 *  generator is privileged; a district must be reasonably good on all four
 *  to read as healthy, matching Jacobs' own claim that the generators work
 *  in combination, not as substitutes for one another. */
export const HEALTH_WEIGHTS = {
  useMix: 0.25,
  blockGranularity: 0.25,
  ageVariety: 0.25,
  density: 0.25,
} as const;

/**
 * District health (KTD4, R6): the weighted mean of the four generators.
 * Always in [0, 1] since every input generator is and the weights sum to 1.
 */
export function districtHealth(district: District): number {
  return (
    HEALTH_WEIGHTS.useMix * useMix(district) +
    HEALTH_WEIGHTS.blockGranularity * blockGranularity(district) +
    HEALTH_WEIGHTS.ageVariety * ageVariety(district) +
    HEALTH_WEIGHTS.density * densityScore(district)
  );
}

// --- KTD5: the traffic-multiplier selector, hosted here (not in
// src/store/selectors.ts) because sim systems (production.ts, demand.ts)
// call it and the sim layer must never import from the store layer.
// src/store/selectors.ts re-exports this verbatim for UI/selector callers. ---

/** Health exactly at this value contributes nothing to the traffic
 *  multiplier — only deviation above or below it moves traffic (KTD5). */
export const HEALTH_NEUTRAL = 0.5;
/** Coefficient applied to the summed health deviation before the +1 base. */
export const TRAFFIC_MULTIPLIER_K = 0.6;
/** Clamp band for the resulting multiplier (KTD5). */
export const MULT_MIN = 0.5;
export const MULT_MAX = 2;
/** A district below this `development` is excluded from the sum entirely
 *  (KTD5's floor) — a fresh station must be neutral (multiplier exactly 1),
 *  never a debuff, or siting a station becomes locally irrational. */
export const DEVELOPMENT_FLOOR = 0.05;

/** The two goods station type skews (milestone 5 U2, KTD4). A subset of
 *  `GoodId` — the only goods `production.ts`/`demand.ts` scale by district
 *  health at all (`CITY_SUPPLIED_GOODS`). */
export type TrafficGood = 'passengers' | 'mail';

/**
 * Per-type traffic-mix weights (milestone 5 U2, KTD4): skews a district's
 * contribution to passenger/mail traffic *independently of health* — a
 * passenger terminal contributes more passenger traffic, a freight yard
 * more mail-and-demand-side traffic, so two districts tied on health still
 * read differently (AE2's traffic-level arm). `mixed` is neutral (1, 1):
 * `districtTrafficMultiplier` called with a `good` for a mixed-anchored
 * district returns exactly what omitting `good` would (regression guard —
 * the same "mixed is identity" rule `STATION_TYPE_MODIFIERS` above follows).
 */
export const STATION_TYPE_TRAFFIC_WEIGHTS: Record<StationType, Record<TrafficGood, number>> = {
  freight: { passengers: 0.7, mail: 1.3 },
  passenger: { passengers: 1.3, mail: 0.7 },
  mixed: { passengers: 1, mail: 1 },
};

/** A single district's contribution weight to `good` traffic (KTD4) — the
 *  anchoring station's type, looked up through `stationTypeOf` so an
 *  untyped (pre-M5-fixture) station reads as neutral. */
export function districtTrafficWeight(station: Station, good: TrafficGood): number {
  return STATION_TYPE_TRAFFIC_WEIGHTS[stationTypeOf(station)][good];
}

/**
 * Passenger/mail traffic multiplier for `city` (KTD5). Sums each qualifying
 * district's *health deviation* from `HEALTH_NEUTRAL` — not full per-district
 * multipliers — over every district whose station catchment covers the city,
 * so the coefficient and clamp apply once to the combined deviation rather
 * than compounding per district. A city with no qualifying district gets
 * exactly 1 (base multiplier, zero deviation summed).
 *
 * Milestone 5 U2 (KTD4) adds the optional `good` parameter: when given, each
 * qualifying district also contributes `districtTrafficWeight(station, good)
 * - 1` — a term independent of health, so type-driven traffic differences
 * survive even between two districts of equal health (AE2). Omitting `good`
 * (every pre-M5 call site) is byte-identical to milestone 4's formula.
 */
export function districtTrafficMultiplier(state: GameState, city: City, good?: TrafficGood): number {
  let deviationSum = 0;
  let typeSkew = 0;
  for (const district of state.districts) {
    if (district.development < DEVELOPMENT_FLOOR) continue;
    const station = state.stations.find((s) => s.id === district.stationId);
    if (!station) continue;
    if (!inCatchment(station, city.x, city.y)) continue;
    deviationSum += districtHealth(district) - HEALTH_NEUTRAL;
    if (good) typeSkew += districtTrafficWeight(station, good) - 1;
  }
  const multiplier = 1 + TRAFFIC_MULTIPLIER_K * deviationSum + typeSkew;
  return Math.min(MULT_MAX, Math.max(MULT_MIN, multiplier));
}
