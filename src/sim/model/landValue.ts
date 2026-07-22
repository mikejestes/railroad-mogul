import type { GameState } from '../state.ts';
import { terrainAt, type Terrain } from '../../world/geography.ts';
import { inCatchment } from './track.ts';
import { DISTRICT_FOOTPRINT_TILES, distanceToChord, activeDistrictFor } from './districts.ts';

/**
 * Land value (milestone 5 U5, R1/R2, KTD2). `landValueAt(state, wx, wy)` is
 * the itemized, derived-not-stored value field milestone 6 trades on: a
 * pure function of *stored path-dependent inputs* (stations, districts,
 * cuts — everything the game already keeps) that composes a terrain base,
 * station-catchment uplift, district-development uplift, and severance
 * depression into one integer-cents total. Nothing here is stored — value
 * itself is never written to `GameState`; the next query simply sees
 * whatever the inputs currently are, so no infrastructure event is ever a
 * cache-invalidation problem (KTD2's rejection of storing per-parcel
 * values).
 *
 * Itemization is exact by construction (not just by convention): every
 * contribution, including the floor adjustment, is pushed as a named item,
 * and `totalCents` is defined as their sum — so "`totalCents` equals the
 * sum of `items`" holds structurally, not just empirically. This is what
 * milestone 6's R9 ("the player can tell what caused a parcel's value to
 * move") starts from.
 *
 * Milestone 5 U7 adds the `derelict` item (KTD9) once `state.derelictSites`
 * exists — a constant, bottomed depression per abandoned site, never
 * deepening over time. U5 anticipated this: no restructuring was needed,
 * only one more contribution function and one more item push.
 */

/** Item names `landValueAt` can emit. `'floor-adjustment'` only appears when
 *  the raw (pre-floor) sum would otherwise fall below `LAND_VALUE_FLOOR` —
 *  see `landValueAt`'s docblock for why it exists at all. */
export type LandValueItemName =
  | 'terrain-base'
  | 'station-uplift'
  | 'district-development'
  | 'severance'
  | 'derelict'
  | 'floor-adjustment';

export interface LandValueItem {
  name: LandValueItemName;
  cents: number;
}

export interface LandValue {
  totalCents: number;
  items: LandValueItem[];
}

/** No parcel is ever valued below this floor, in integer cents (KTD2).
 *  Reached via a `'floor-adjustment'` item, never by clamping `totalCents`
 *  independently of `items` — see `landValueAt`'s docblock. */
export const LAND_VALUE_FLOOR = 50_00;

/** Base land value by terrain classification (`world/geography.ts`), before
 *  any infrastructure effect — the "raw dirt" component of `landValueAt`.
 *  Sea has no land value (a station can never be sited there — `buildStation`
 *  refuses sea tiles — so this row is never the *only* determinant of a
 *  buildable parcel's value, only ever a floor case for query coordinates a
 *  station never reaches). */
export const TERRAIN_BASE_CENTS: Record<Terrain, number> = {
  sea: 0,
  coast: 300_00,
  plains: 500_00,
  farmland: 450_00,
  forest: 350_00,
  marsh: 200_00,
  hills: 350_00,
  mountain: 150_00,
};

/** Station-catchment uplift present immediately at siting (AE1: value rises
 *  the moment the player sites a station, before any district has grown at
 *  all) — the peak value at the station tile itself, before development
 *  scaling. */
export const STATION_UPLIFT_BASE_CENTS = 1_500_00;

/** Additional station-catchment uplift at full (1.0) district development,
 *  on top of `STATION_UPLIFT_BASE_CENTS` — the depot alone creates some
 *  value; a thriving district around it creates more (KTD2's "scaled by
 *  district development"). */
export const STATION_UPLIFT_DEV_BONUS_CENTS = 1_500_00;

/**
 * Ceiling on the TOTAL additive `station-uplift` item at any one point
 * (milestone 6 U8's exploit gate). Without this, `stationUpliftItem` (below)
 * sums every covering station's uplift with no bound at all: a player can
 * buy out a catchment, then site any number of extra stations on or near
 * the same tile (each costing as little as `STATION_COST[0]`) purely to
 * inflate `landValueAt` at the parcels they already own, then `sellLand`
 * for a same-tick profit that routes entirely around the charter /
 * anticipation / spread anti-exploit design (KTD1/KTD2/KTD7) — verified:
 * +$400-plus for a handful of $50-$100 stations ringed around an owned
 * catchment, unbounded as more are added.
 *
 * The cap is set at twice a single station's own maximum possible peak
 * (`STATION_UPLIFT_BASE_CENTS + STATION_UPLIFT_DEV_BONUS_CENTS`, i.e. one
 * station at distance 0 and full (1.0) development) — enough headroom for
 * the legitimate case this composes for (two genuinely separate, nearby
 * stations, each serving its own city/district, whose catchments overlap
 * at the edge — `landValue.test.ts`'s "overlapping catchments compose
 * additively" scenario, and real play with two nearby towns each earning
 * their own station), but not enough for a third, fourth, ... Nth station
 * stacked on the same neighborhood to add anything further. Once two
 * stations' worth of uplift is already priced in, every additional stacked
 * station buys the exploiter nothing: `sellLand`'s `SALE_SPREAD_FRACTION`
 * (10%) plus each new station's own build cost then dominates any residual
 * (capped) delta, making stacking strictly a net loss — see
 * `tests/sim/landEconomics.e2e.test.ts`'s station-stacking exploit-gate
 * test. Two DIFFERENT, meaningfully separated stations at genuine peak
 * (distance 0 each, impossible in practice since one point can be at
 * distance 0 from at most one station, but the cap is sized against the
 * theoretical max so it is never the thing that quietly under-prices a
 * real two-city overlap) still compose additively up to this ceiling.
 */
export const STATION_UPLIFT_CAP_CENTS = 2 * (STATION_UPLIFT_BASE_CENTS + STATION_UPLIFT_DEV_BONUS_CENTS);

/** Peak district-development uplift, reached at development 1.0 at the
 *  district's own anchor — a broader neighborhood-prosperity halo, distinct
 *  from (and reaching further than) any single station's own catchment
 *  falloff: it falls off across the full `DISTRICT_FOOTPRINT_TILES`, the
 *  same footprint severance is scoped to. */
export const DISTRICT_DEVELOPMENT_UPLIFT_CENTS = 1_000_00;

/** Peak severance depression at a cut's own chord, before falloff. Scaled
 *  by the cut's own `strength` (a station-footprint cut depresses more than
 *  a single track segment, matching `severancePenalty`'s own weighting,
 *  U4). */
export const SEVERANCE_DEPRESSION_PEAK_CENTS = 400_00;

/** Distance (world tiles) at which severance depression falls off to zero
 *  from a cut's chord — a local effect (border-vacuum blocks), much tighter
 *  than the district-wide `DISTRICT_FOOTPRINT_TILES` scope `severancePenalty`
 *  itself sums over. */
export const SEVERANCE_DEPRESSION_RADIUS_TILES = 2;

/** Peak derelict-site depression, at the abandoned tile itself (milestone 5
 *  U7, KTD9). Constant and bottomed — a derelict site depresses value by
 *  exactly this much, forever; it never deepens over time (`day` on
 *  `DerelictSite` is history/attribution only, never a decay input). */
export const DERELICT_DEPRESSION_PEAK_CENTS = 600_00;

/** Distance (world tiles) at which a derelict site's depression falls off
 *  to zero — a tight, local scar (KTD9), the same order of magnitude as
 *  `SEVERANCE_DEPRESSION_RADIUS_TILES`. */
export const DERELICT_DEPRESSION_RADIUS_TILES = 1.5;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The station-uplift SHAPE alone (milestone 6 KTD2): peak
 * `STATION_UPLIFT_BASE_CENTS + STATION_UPLIFT_DEV_BONUS_CENTS * development`
 * at `distance === 0`, linear falloff to 0 at `radius`. Factored out of
 * `stationUpliftItem` (below) so milestone 6's anticipation pricing
 * (`sim/model/land.ts`'s `projectedUplift`) instantiates this *exact* shape
 * with pinned reference inputs (a documented reference radius and a pinned
 * `ANTICIPATION_REFERENCE_DEVELOPMENT`, never the live — often zero — district
 * record) rather than a second, hand-copied formula that could silently drift
 * out of sync with what a real station's catchment will pay out once built.
 * Pure; `distance` beyond `radius` (or a non-positive `radius`, guarded the
 * same way `stationFalloff` was) contributes nothing.
 */
export function stationUpliftShapeCents(radius: number, development: number, distance: number): number {
  if (radius <= 0) return distance <= 0 ? STATION_UPLIFT_BASE_CENTS + STATION_UPLIFT_DEV_BONUS_CENTS * clamp01(development) : 0;
  if (distance > radius) return 0;
  const falloff = 1 - distance / radius;
  return falloff * (STATION_UPLIFT_BASE_CENTS + STATION_UPLIFT_DEV_BONUS_CENTS * clamp01(development));
}

/** Terrain-base item: a pure function of coordinates, no state input at all
 *  (R1's spatial variation substrate). */
function terrainBaseItem(wx: number, wy: number): LandValueItem {
  return { name: 'terrain-base', cents: TERRAIN_BASE_CENTS[terrainAt(wx, wy)] };
}

/** Station-uplift item (R2, AE1): summed across every station whose
 *  catchment covers `(wx, wy)` — overlapping catchments compose additively,
 *  per the plan's own test scenario, up to `STATION_UPLIFT_CAP_CENTS` (U8's
 *  exploit gate — see that constant's own docblock for why the cap exists
 *  and why it is sized where it is). Uses the shared `inCatchment` (matching
 *  falloff-zero exactly at the catchment edge, Chebyshev) and
 *  `stationUpliftShapeCents` for the peak/falloff math (milestone 6, KTD2).
 *  The cap is applied to the summed total, never per-station, so it never
 *  changes the shape any single covering station contributes — only bounds
 *  how many of them can stack before the rest becomes free. */
function stationUpliftItem(state: GameState, wx: number, wy: number): LandValueItem {
  let cents = 0;
  for (const station of state.stations) {
    if (!inCatchment(station, wx, wy)) continue;
    const dist = Math.max(Math.abs(wx - station.x), Math.abs(wy - station.y));
    // Milestone 5 U7 (KTD8): the station's *active* district, not merely
    // the first one sharing its id — see `activeDistrictFor`'s own docblock.
    const district = activeDistrictFor(state, station.id);
    const development = district ? clamp01(district.development) : 0;
    cents += stationUpliftShapeCents(station.radius, development, dist);
  }
  const capped = Math.min(cents, STATION_UPLIFT_CAP_CENTS);
  return { name: 'station-uplift', cents: Math.round(capped) };
}

/** District-development item (R3's value substrate): summed across every
 *  district whose footprint covers `(wx, wy)`. Zero for a fresh
 *  (`development === 0`) district — `station-uplift`'s base term alone
 *  covers AE1's "value rises at siting" requirement; this item is the
 *  additional halo a district earns by actually growing. */
function districtDevelopmentItem(state: GameState, wx: number, wy: number): LandValueItem {
  let cents = 0;
  for (const district of state.districts) {
    const dist = Math.max(Math.abs(wx - district.anchorX), Math.abs(wy - district.anchorY));
    if (dist > DISTRICT_FOOTPRINT_TILES) continue;
    const falloff = 1 - dist / DISTRICT_FOOTPRINT_TILES;
    cents += falloff * DISTRICT_DEVELOPMENT_UPLIFT_CENTS * clamp01(district.development);
  }
  return { name: 'district-development', cents: Math.round(cents) };
}

/** Severance item (R7's value-side consequence): negative, distance-falloff
 *  depression from every district's cuts near `(wx, wy)`. Uses the shared
 *  `distanceToChord` (`sim/model/districts.ts`) — the same point-to-segment
 *  geometry `world/streets.ts`'s scene conditioning uses, so "how far is
 *  this point from this cut" never drifts between the two derivations. */
function severanceItem(state: GameState, wx: number, wy: number): LandValueItem {
  let cents = 0;
  for (const district of state.districts) {
    for (const cut of district.cuts) {
      const dist = distanceToChord(wx, wy, cut);
      if (dist > SEVERANCE_DEPRESSION_RADIUS_TILES) continue;
      const falloff = 1 - dist / SEVERANCE_DEPRESSION_RADIUS_TILES;
      cents += falloff * SEVERANCE_DEPRESSION_PEAK_CENTS * cut.strength;
    }
  }
  const rounded = Math.round(cents);
  return { name: 'severance', cents: rounded === 0 ? 0 : -rounded }; // avoid emitting -0
}

/** Derelict item (milestone 5 U7, R13, KTD9): negative, distance-falloff
 *  depression from every abandoned station site near `(wx, wy)`. Constant
 *  per site (no `day`-based deepening) and bottomed the same way severance
 *  is — a scar, not a spreading disease. */
function derelictItem(state: GameState, wx: number, wy: number): LandValueItem {
  let cents = 0;
  for (const site of state.derelictSites) {
    const dist = Math.hypot(wx - site.x, wy - site.y);
    if (dist > DERELICT_DEPRESSION_RADIUS_TILES) continue;
    const falloff = 1 - dist / DERELICT_DEPRESSION_RADIUS_TILES;
    cents += falloff * DERELICT_DEPRESSION_PEAK_CENTS;
  }
  const rounded = Math.round(cents);
  return { name: 'derelict', cents: rounded === 0 ? 0 : -rounded }; // avoid emitting -0
}

/**
 * Itemized land value at world coordinate `(wx, wy)` (KTD2). Pure: repeated
 * queries, in any order, never mutate `state` and always return the same
 * result for the same inputs (the determinism/purity substrate the plan's
 * U5 test scenarios and U8's save-flatness proof both rest on).
 *
 * The floor is enforced as its own itemized entry rather than by clamping
 * `totalCents` independently of `items`: if the raw sum of every
 * contribution above falls below `LAND_VALUE_FLOOR`, a `'floor-adjustment'`
 * item makes up exactly the difference, so `totalCents` — always defined as
 * the sum of `items` — never disagrees with its own itemization while still
 * never dropping below the floor. The item is omitted entirely when the raw
 * sum already clears the floor (the common case).
 */
export function landValueAt(state: GameState, wx: number, wy: number): LandValue {
  const items: LandValueItem[] = [
    terrainBaseItem(wx, wy),
    stationUpliftItem(state, wx, wy),
    districtDevelopmentItem(state, wx, wy),
    severanceItem(state, wx, wy),
    derelictItem(state, wx, wy),
  ];
  const rawSum = items.reduce((sum, item) => sum + item.cents, 0);
  const totalCents = Math.max(LAND_VALUE_FLOOR, rawSum);
  if (totalCents !== rawSum) {
    items.push({ name: 'floor-adjustment', cents: totalCents - rawSum });
  }
  return { totalCents, items };
}
