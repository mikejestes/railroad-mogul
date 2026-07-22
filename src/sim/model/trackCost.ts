import type { GameState } from '../state.ts';
import type { Tile } from '../pathfinding.ts';
import { terrainAt, elevationAt, type Terrain } from '../../world/geography.ts';
import { riverTileKeys } from '../../world/rivers.ts';

/**
 * Per-step track build cost — terrain, grade, structures, land — as pure
 * functions with exported tuning constants (milestone 3 U2, KTD4-KTD6).
 *
 * Replaces the flat `TRACK_COST_PER_SEGMENT` + `MOUNTAIN_SURCHARGE` model
 * (`model/track.ts`, still used by the untouched `layTrack`/`canLayTrack`
 * path per R12): that two-term formula went vestigial the moment milestone 2
 * gave terrain continuous elevation and an eight-type palette — forest,
 * marsh, and hills priced identically to plains. `stepCost` is what makes
 * every acre of that palette, plus the slope between two tiles and the
 * obstacles in between, show up as a real number the player reacts to
 * (R6-R9). It is deliberately itemized (`StepCost`) rather than a single
 * total: AE3 needs a bridge to appear as its own line item, not folded
 * invisibly into a per-segment rate, and the survey panel (U6) sums these
 * items directly rather than re-deriving them.
 *
 * KTD4 — grade is derived, never stored: `rawGrade` is
 * `|Δelevation(a,b)| / dist`, straight from `geography.ts`'s `elevationAt`,
 * recomputed on every call rather than cached anywhere.
 *
 * KTD5 — a structure (bridge/tunnel/cutting) is chosen per step and caps
 * that step's *effective* grade (`effectiveGradeFor`) for both this
 * module's pricing and U5's operational weight — the two must never
 * disagree about what a structure buys, so both consume the same helper.
 *
 * KTD6 — the surveyor auto-selects the cheapest *legal* structure per
 * obstacle: a river tile always forces a bridge (mandatory, not optional —
 * you cannot lay track through open water); a raw grade above
 * `MAX_UNASSISTED_GRADE` forces a choice between a cutting (caps effective
 * grade to `CUTTING_MAX_GRADE`, cheap structure + residual grade cost) and a
 * tunnel (caps to 0, expensive structure + zero residual grade cost) —
 * `chooseGradeStructure` picks whichever *total* (structure + residual
 * grade) is lower. The player's lever stays the waypoint, not a per-obstacle
 * toggle (KTD6's explicit rejection).
 *
 * Symmetry: every input to `stepCost` (terrain factor average, |Δelevation|,
 * land factor average, river-tile membership of either endpoint) is computed
 * from the *unordered* pair `{a, b}`, so `stepCost(state, a, b)` and
 * `stepCost(state, b, a)` always agree — required for A* (U3) to treat the
 * tile graph as undirected.
 *
 * All money is integer cents (never floating point) — `Math.round` is
 * applied once per itemized field, and `totalCents` is the exact sum of the
 * (already-rounded) items, so the "itemization is complete" invariant holds
 * to the cent, not just approximately.
 *
 * Sea is unbuildable, mirroring `moveCostFor`'s `Infinity` in
 * `world/geography.ts`: `TRACK_TERRAIN_FACTOR.sea` and `LAND_BASE_FACTOR.sea`
 * are both `Infinity`, so any step touching a sea tile carries an infinite
 * `totalCents`. This is a computation signal consumed by U3's `surveyRoute`
 * (which refuses before ever handing such a step to A*) and is never written
 * into `GameState` — the determinism/save contract's "no Infinity in
 * serialized fields" rule applies to stored state, not to this intermediate
 * itemization.
 */

/** The three obstacle-crossing structures a segment can carry (U2/KTD5).
 *  Re-exported by `model/track.ts` (U4) as `TrackSegment.structure`'s type,
 *  so pricing and storage never define this union twice. */
export type TrackStructure = 'bridge' | 'tunnel' | 'cutting';

export interface StepCost {
  baseCents: number;
  terrainCents: number;
  gradeCents: number;
  structure?: TrackStructure;
  structureCents: number;
  landCents: number;
  totalCents: number;
  rawGrade: number;
  effectiveGrade: number;
}

// --- Base + terrain -----------------------------------------------------

/** Flat construction cost per tile of step distance, independent of terrain
 *  — grading and ballast a route needs regardless of what it crosses.
 *  Matches the pre-U2 milestone's flat `TRACK_COST_PER_SEGMENT` in
 *  magnitude, kept as this module's own constant since the two models are
 *  now independent (R12: the old flat model stays for `layTrack`/tests). */
export const BASE_COST_PER_TILE = 50_00; // cents

/**
 * Terrain build-cost multiplier, covering the full eight-member palette
 * (Plan Assumptions, tuned during implementation against AE1). Deliberately
 * distinct from `moveCostFor` (`geography.ts`, movement/routing cost) even
 * though both track the same *ordering* — plains/coast/farmland cheapest,
 * then forest, then hills, then mountain, then marsh most expensive — build
 * cost spreads them out (forest and hills are tied under `moveCostFor` but
 * not here) because acquiring and grading forest is measurably cheaper than
 * hillside earthwork, a distinction movement cost has no reason to make.
 * `sea` is `Infinity`, mirroring `moveCostFor` — sea is never buildable.
 */
export const TRACK_TERRAIN_FACTOR: Record<Terrain, number> = {
  sea: Infinity,
  coast: 1,
  plains: 1,
  farmland: 1,
  forest: 1.5,
  hills: 2,
  mountain: 3,
  marsh: 3.5,
};

// --- Grade ----------------------------------------------------------------

/** Raw grade at/above this always forces a structure (KTD5/KTD6). Chosen
 *  empirically against the actual shipped elevation field: a spread of
 *  seeds sampled at grid resolution puts the adjacent-tile grade median
 *  around 0.008-0.01 and the 90th percentile around 0.02-0.024, so this
 *  threshold requires a structure on roughly the steepest tenth of steps —
 *  enough for AE1's "short and steep" arm to carry real structure cost
 *  without every third step needing one. */
export const MAX_UNASSISTED_GRADE = 0.02;

/** The effective grade a cutting caps a step to (KTD5) — deliberately below
 *  `MAX_UNASSISTED_GRADE` (roughly the sampled median), so a cutting reads
 *  as "genuinely gentler," not merely "technically legal." */
export const CUTTING_MAX_GRADE = 0.01;

/** Grade cost scales with the *square* of grade relative to
 *  `MAX_UNASSISTED_GRADE` (R7: steepness costs more than length trades for)
 *  — this is the per-tile cost at exactly the unassisted-grade threshold;
 *  a step at half that grade costs a quarter as much, one at double (once a
 *  structure has capped it back down, if it ever gets that steep unassisted)
 *  costs four times as much. */
export const GRADE_COST_FACTOR = 40_00; // cents per tile at grade === MAX_UNASSISTED_GRADE

/** Grade cost (cents) for a step of `dist` tiles at effective grade `grade`
 *  (KTD4/R7): squared relative to `MAX_UNASSISTED_GRADE` so steepness costs
 *  superlinearly rather than in proportion to length. */
function gradeCostFor(grade: number, dist: number): number {
  const ratio = grade / MAX_UNASSISTED_GRADE;
  return Math.round(GRADE_COST_FACTOR * dist * ratio * ratio);
}

/**
 * A structure's effect on a step's *effective* grade (KTD4/KTD5): a bridge
 * or tunnel is built level (0), a cutting caps to `CUTTING_MAX_GRADE`, and
 * an unstructured step keeps its raw grade. Shared by this module's pricing
 * and U5's `segmentWeight` (`model/track.ts`) so the two can never disagree
 * about what a structure bought.
 */
export function effectiveGradeFor(rawGrade: number, structure?: TrackStructure): number {
  switch (structure) {
    case 'bridge':
    case 'tunnel':
      return 0;
    case 'cutting':
      return Math.min(rawGrade, CUTTING_MAX_GRADE);
    default:
      return rawGrade;
  }
}

// --- Structures -------------------------------------------------------

/** Structure build cost per tile of step distance (KTD6), before
 *  `CUTTING_EXCESS_COST_FACTOR` below. Ordered cutting < bridge < tunnel: a
 *  cutting is earthwork, a bridge is a real span but usually short, a
 *  tunnel is the most expensive way to remove grade entirely. Starting
 *  points per the plan's Assumptions, tuned during implementation so both
 *  structures are actually reachable (see `CUTTING_EXCESS_COST_FACTOR`) and
 *  against AE1 (see `tests/sim/surveying.test.ts`). */
export const CUTTING_COST_PER_TILE = 80_00; // cents
export const BRIDGE_COST_PER_TILE = 120_00; // cents
export const TUNNEL_COST_PER_TILE = 150_00; // cents

/**
 * A cutting's price grows with how far raw grade exceeds
 * `MAX_UNASSISTED_GRADE` (KTD6) — a deeper cut for steeper ground, the same
 * intuition real earthwork follows — rather than staying flat at
 * `CUTTING_COST_PER_TILE` regardless of severity. Without this, cutting's
 * *residual* grade cost is capped at `gradeCostFor(CUTTING_MAX_GRADE, dist)`
 * no matter how steep the raw grade is, so a flat cutting price would always
 * undercut the flat `TUNNEL_COST_PER_TILE` and a tunnel could never win —
 * the "cheaper of the two candidates" comparison would be decorative. This
 * factor is the multiplier applied to `(rawGrade - MAX_UNASSISTED_GRADE) /
 * MAX_UNASSISTED_GRADE` on top of the base cutting price, so mild grade
 * violations stay cheap cuttings and severe ones cross over to a tunnel.
 */
export const CUTTING_EXCESS_COST_FACTOR = 3;

interface StructureChoice {
  structure?: TrackStructure;
  structureCents: number;
  effectiveGrade: number;
}

/** Cutting structure price for a step (KTD6): base price scaled up by how
 *  far raw grade exceeds `MAX_UNASSISTED_GRADE` (see
 *  `CUTTING_EXCESS_COST_FACTOR`). Only meaningfully called above the
 *  threshold, where the excess ratio is positive. */
function cuttingStructureCentsFor(rawGrade: number, dist: number): number {
  const excessRatio = Math.max(0, rawGrade - MAX_UNASSISTED_GRADE) / MAX_UNASSISTED_GRADE;
  return Math.round(CUTTING_COST_PER_TILE * dist * (1 + CUTTING_EXCESS_COST_FACTOR * excessRatio));
}

/**
 * Choose the cheaper of a cutting or a tunnel for a step whose raw grade
 * exceeds `MAX_UNASSISTED_GRADE` (KTD6) — compared on *total* cost
 * (structure price plus whatever residual grade cost the structure leaves
 * behind), not structure price alone, since a cutting is cheaper to build
 * but leaves a steeper residual grade than a tunnel's zero. Called only when
 * `rawGrade > MAX_UNASSISTED_GRADE`; a step within the unassisted grade
 * needs no structure at all.
 */
function chooseGradeStructure(rawGrade: number, dist: number): StructureChoice {
  const cuttingEffectiveGrade = effectiveGradeFor(rawGrade, 'cutting');
  const cuttingStructureCents = cuttingStructureCentsFor(rawGrade, dist);
  const cuttingTotal = cuttingStructureCents + gradeCostFor(cuttingEffectiveGrade, dist);

  const tunnelEffectiveGrade = effectiveGradeFor(rawGrade, 'tunnel');
  const tunnelStructureCents = Math.round(TUNNEL_COST_PER_TILE * dist);
  const tunnelTotal = tunnelStructureCents; // gradeCostFor(0, dist) === 0

  if (tunnelTotal < cuttingTotal) {
    return { structure: 'tunnel', structureCents: tunnelStructureCents, effectiveGrade: tunnelEffectiveGrade };
  }
  return { structure: 'cutting', structureCents: cuttingStructureCents, effectiveGrade: cuttingEffectiveGrade };
}

/** Whether a step between `a` and `b` must bridge a river (KTD6/R8): either
 *  endpoint lands on a `riverTileKeys(state.rivers)` tile. Mandatory —
 *  a river always forces a bridge, never a tunnel/cutting alternative,
 *  since those relieve grade, not water. */
function crossesRiver(state: GameState, a: Tile, b: Tile): boolean {
  const rivers = riverTileKeys(state.rivers);
  return rivers.has(`${a.x},${a.y}`) || rivers.has(`${b.x},${b.y}`);
}

// --- Land -------------------------------------------------------------

/** Baseline land cost per tile of step distance, before terrain and city
 *  proximity (interim proxy, see plan preservation note — replaced wholesale
 *  by milestone 5's land-value field). */
export const LAND_BASE_COST_PER_TILE = 10_00; // cents

/**
 * Land-value factor by terrain (interim proxy, R9). Settled/fertile terrain
 * (plains, coast, farmland) costs more to acquire than wild or marginal
 * terrain (forest, hills, marsh, mountain) — the inverse of
 * `TRACK_TERRAIN_FACTOR`'s ordering, deliberately: build cost prices
 * *difficulty of construction*, land cost prices *what the ground is worth*,
 * and rugged terrain is simultaneously hard to build on and cheap to buy.
 * `sea` is `Infinity` for completeness, though `TRACK_TERRAIN_FACTOR.sea`
 * already makes any sea-touching step unbuildable on its own.
 */
export const LAND_BASE_FACTOR: Record<Terrain, number> = {
  sea: Infinity,
  plains: 1,
  coast: 1,
  farmland: 1.2,
  forest: 0.8,
  hills: 0.7,
  marsh: 0.6,
  mountain: 0.5,
};

/** Tiles within which city proximity raises land cost (R9's interim
 *  city-proximity proxy, see plan preservation note); linear falloff to 0
 *  at exactly this distance. */
export const CITY_LAND_RADIUS = 4;

/** Per-size-tier land-cost uplift (cents per tile of step distance) at the
 *  city's own tile, falling off linearly to 0 at `CITY_LAND_RADIUS`. */
export const CITY_LAND_UPLIFT_PER_TIER = 20_00; // cents

/** City-proximity land uplift at a single tile (R9's interim proxy): the
 *  strongest nearby city wins (not summed — two nearby cities don't double
 *  the price of the same acre), scaled by `sizeTier` and falling off
 *  linearly with distance. Zero outside `CITY_LAND_RADIUS` of every city. */
function cityUpliftAt(state: GameState, x: number, y: number): number {
  let best = 0;
  for (const city of state.cities) {
    const dist = Math.hypot(city.x - x, city.y - y);
    if (dist >= CITY_LAND_RADIUS) continue;
    const falloff = 1 - dist / CITY_LAND_RADIUS;
    const uplift = CITY_LAND_UPLIFT_PER_TIER * (city.sizeTier + 1) * falloff;
    if (uplift > best) best = uplift;
  }
  return best;
}

/** Land cost (cents) for a step between `a` and `b` (R9): terrain factor and
 *  city uplift are each averaged across both endpoints so the result is
 *  symmetric in `{a, b}`. */
function landCostFor(state: GameState, a: Tile, b: Tile, dist: number): number {
  const factorA = LAND_BASE_FACTOR[terrainAt(a.x, a.y)];
  const factorB = LAND_BASE_FACTOR[terrainAt(b.x, b.y)];
  const avgFactor = (factorA + factorB) / 2;
  const avgUplift = (cityUpliftAt(state, a.x, a.y) + cityUpliftAt(state, b.x, b.y)) / 2;
  return Math.round((LAND_BASE_COST_PER_TILE * avgFactor + avgUplift) * dist);
}

// --- Entry point ------------------------------------------------------

/**
 * Itemized build cost for one track step between adjacent tiles `a` and `b`
 * (U2/KTD4-KTD6). Does not check adjacency — callers (U3's `surveyRoute`)
 * only ever call this on 8-connected neighbor pairs the way `canLayTrack`
 * already requires. Sea makes `totalCents` `Infinity` rather than throwing,
 * so a caller (A*) can treat it as a normal (if unusably expensive) edge
 * weight; `surveyRoute` refuses a sea endpoint/waypoint before search ever
 * begins, so this is defense in depth, not the primary refusal path.
 */
export function stepCost(state: GameState, a: Tile, b: Tile): StepCost {
  const dist = Math.hypot(a.x - b.x, a.y - b.y);

  const terrainFactorA = TRACK_TERRAIN_FACTOR[terrainAt(a.x, a.y)];
  const terrainFactorB = TRACK_TERRAIN_FACTOR[terrainAt(b.x, b.y)];
  const avgTerrainFactor = (terrainFactorA + terrainFactorB) / 2;

  const baseCents = Math.round(BASE_COST_PER_TILE * dist);
  const terrainCents = Math.round(BASE_COST_PER_TILE * dist * (avgTerrainFactor - 1));

  const rawGrade = Math.abs(elevationAt(b.x, b.y) - elevationAt(a.x, a.y)) / dist;

  let structure: TrackStructure | undefined;
  let structureCents = 0;
  let effectiveGrade = rawGrade;

  if (crossesRiver(state, a, b)) {
    structure = 'bridge';
    structureCents = Math.round(BRIDGE_COST_PER_TILE * dist);
    effectiveGrade = effectiveGradeFor(rawGrade, 'bridge');
  } else if (rawGrade > MAX_UNASSISTED_GRADE) {
    const choice = chooseGradeStructure(rawGrade, dist);
    structure = choice.structure;
    structureCents = choice.structureCents;
    effectiveGrade = choice.effectiveGrade;
  }

  const gradeCents = gradeCostFor(effectiveGrade, dist);
  const landCents = landCostFor(state, a, b, dist);
  const totalCents = baseCents + terrainCents + gradeCents + structureCents + landCents;

  return {
    baseCents,
    terrainCents,
    gradeCents,
    ...(structure ? { structure } : {}),
    structureCents,
    landCents,
    totalCents,
    rawGrade,
    effectiveGrade,
  };
}
