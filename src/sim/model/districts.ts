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
  /** Severance cuts (milestone 5 U3, KTD1): the chords of track segments and
   *  station footprints that have crossed this district's footprint since it
   *  was created, in world coordinates. APPEND-ONLY — no code path in this
   *  codebase removes an entry. Bounded by construction (a district's fixed
   *  footprint holds finitely many distinct segment chords) and defensively
   *  by `CUTS_CAP` with nearest-pair merging (`recordCuts`, below), so a
   *  pathological build spree cannot grow this list without limit. */
  cuts: Cut[];
}

/**
 * One severance cut (milestone 5 U3, KTD1): the chord of a track segment or
 * station footprint that crossed a district's footprint when it was built.
 * `strength` is the source's severance weight (`STATION_CUT_STRENGTH` or
 * `TRACK_CUT_STRENGTH`, below) — `severancePenalty` (U4) reads it alongside
 * the chord's length and centrality; nothing here is itself a damage number.
 */
export interface Cut {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  strength: number;
}

/**
 * The fixed radius (Chebyshev, world tiles) within which infrastructure
 * severs a district (U3), damage accrues length (U4), and relocation
 * continuity is judged (U7) — the plan's Assumptions. Set once, implicitly,
 * by the district's never-changing `anchorX`/`anchorY` (KTD1) and this
 * constant: deliberately *not* derived from milestone 4's `development`-
 * scaled scene extent (`world/streets.ts`'s `extentTilesFor`), which grows
 * and can shrink under milestone 4's decay — a footprint that moved with it
 * would let the same geometry drift in and out of severance eligibility
 * over time, intolerable for an append-only, never-heals cut list where
 * "was this chord ever in scope" must have one permanent answer.
 */
export const DISTRICT_FOOTPRINT_TILES = 6;

/** Severance weight of a station's own footprint (yards included) — a
 *  single point chord at the station's tile (KTD1). Heavier than a single
 *  track segment: a depot's footprint is a bigger, more permanent cut than
 *  one rail length. */
export const STATION_CUT_STRENGTH = 1.5;

/** Severance weight of one track segment (KTD1). */
export const TRACK_CUT_STRENGTH = 1;

/** Defensive hard cap on a single district's `cuts` list (KTD1). A
 *  district's fixed, finite footprint already bounds the number of distinct
 *  segment chords that can ever cross it in practice; this cap exists only
 *  to guarantee boundedness even under a pathological build spree, and is
 *  set comfortably above what normal play could ever reach. Exceeding it
 *  merges the nearest pair of cuts (`mergeNearestCuts`) rather than
 *  dropping data — the never-heals invariant applies to information, not to
 *  list length. */
export const CUTS_CAP = 64;

/** Whether world point `(x, y)` lies within `district`'s fixed footprint
 *  (Chebyshev, matching every other catchment-style check in this codebase
 *  — `inCatchment`, `track.ts`). */
function withinFootprint(district: District, x: number, y: number): boolean {
  return Math.max(Math.abs(x - district.anchorX), Math.abs(y - district.anchorY)) <= DISTRICT_FOOTPRINT_TILES;
}

/** Whether a chord crosses `district`'s footprint at all: every track
 *  segment this codebase ever builds connects Chebyshev-adjacent tiles
 *  (`canLayTrack`), so checking either endpoint is exact, not an
 *  approximation, for every chord this function is ever called with —
 *  including the degenerate station-footprint chord (`ax===bx`, `ay===by`),
 *  where both checks agree trivially. */
function chordCrossesFootprint(district: District, chord: Pick<Cut, 'ax' | 'ay' | 'bx' | 'by'>): boolean {
  return withinFootprint(district, chord.ax, chord.ay) || withinFootprint(district, chord.bx, chord.by);
}

/**
 * Shortest Euclidean distance from point `(px, py)` to a chord's segment
 * (the standard clamped-projection formula; degenerates cleanly to
 * point-to-point distance for a zero-length station-footprint chord).
 * Exported and shared by `sim/model/landValue.ts` (U5, per-tile severance
 * depression) and `world/streets.ts` (U4, per-parcel vacuum-band
 * membership) so the two "how far is this point from this cut" derivations
 * — one in world coordinates, one in rescaled scene coordinates, but the
 * same geometry either way — can never drift apart.
 */
export function distanceToChord(px: number, py: number, chord: Pick<Cut, 'ax' | 'ay' | 'bx' | 'by'>): number {
  const dx = chord.bx - chord.ax;
  const dy = chord.by - chord.ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - chord.ax, py - chord.ay);
  const t = Math.max(0, Math.min(1, ((px - chord.ax) * dx + (py - chord.ay) * dy) / lengthSq));
  return Math.hypot(px - (chord.ax + t * dx), py - (chord.ay + t * dy));
}

/** Squared distance between two cuts' midpoints — cheap, monotonic with the
 *  real distance, and all `mergeNearestCuts` needs to rank pairs. */
function cutMidpointDistanceSq(a: Cut, b: Cut): number {
  const amx = (a.ax + a.bx) / 2;
  const amy = (a.ay + a.by) / 2;
  const bmx = (b.ax + b.bx) / 2;
  const bmy = (b.ay + b.by) / 2;
  return (amx - bmx) ** 2 + (amy - bmy) ** 2;
}

/**
 * Merge the two geometrically nearest cuts in `cuts` into one (KTD1's
 * defensive cap): the never-heals invariant governs *information*, not list
 * length, so past `CUTS_CAP` the record combines rather than drops. The
 * merged chord is the midpoint-to-midpoint average of the two originals and
 * its strength is their sum — nearby severance stays represented, at
 * reduced geometric precision, rather than vanishing. Deterministic:
 * ties break on the lower pair of indices (array order, never Map/Set
 * iteration), and `cuts` is mutated in place.
 */
function mergeNearestCuts(cuts: Cut[]): void {
  if (cuts.length < 2) return;
  let bestI = 0;
  let bestJ = 1;
  let bestDistSq = Infinity;
  for (let i = 0; i < cuts.length; i++) {
    for (let j = i + 1; j < cuts.length; j++) {
      const d = cutMidpointDistanceSq(cuts[i], cuts[j]);
      if (d < bestDistSq) {
        bestDistSq = d;
        bestI = i;
        bestJ = j;
      }
    }
  }
  const a = cuts[bestI];
  const b = cuts[bestJ];
  const merged: Cut = {
    ax: (a.ax + b.ax) / 2,
    ay: (a.ay + b.ay) / 2,
    bx: (a.bx + b.bx) / 2,
    by: (a.by + b.by) / 2,
    strength: a.strength + b.strength,
  };
  cuts.splice(bestJ, 1); // remove the higher index first so bestI stays valid
  cuts[bestI] = merged;
}

/**
 * Append `chords` to every district in `districts` whose footprint they
 * cross (milestone 5 U3, KTD1/KTD7). The one authoritative path every cut
 * source routes through — `layTrack`/`buildStation` (`model/track.ts`),
 * `emitRoute` (milestone 3's `commitRoute` path), and `ensureDistrict`'s
 * backfill (`store/applyIntents.ts`) all call this, so build-time recording
 * and creation-time backfill can never disagree about what counts as a cut
 * (KTD7). Exact-duplicate geometry (same `ax`/`ay`/`bx`/`by`/`strength`,
 * already recorded on that district) is skipped rather than re-appended —
 * cheap idempotency for a caller that might record the same segment twice
 * (e.g. a district backfilled from track that already crossed it once).
 * NEVER removes a cut; the only shrinkage `mergeNearestCuts` performs is a
 * length-preserving-or-shrinking merge past `CUTS_CAP`, not a deletion of
 * information.
 */
export function recordCuts(districts: District[], chords: Cut[]): void {
  for (const district of districts) {
    for (const chord of chords) {
      if (!chordCrossesFootprint(district, chord)) continue;
      const exists = district.cuts.some(
        (c) => c.ax === chord.ax && c.ay === chord.ay && c.bx === chord.bx && c.by === chord.by && c.strength === chord.strength,
      );
      if (exists) continue;
      district.cuts.push({ ax: chord.ax, ay: chord.ay, bx: chord.bx, by: chord.by, strength: chord.strength });
      if (district.cuts.length > CUTS_CAP) mergeNearestCuts(district.cuts);
    }
  }
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
    cuts: [],
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
 * Jacobs health (milestone 4's KTD4, R6; renamed from `districtHealth` in
 * milestone 5 U4, KTD6): the weighted mean of the four generators alone,
 * with no opinion about severance. Always in [0, 1] since every input
 * generator is and the weights sum to 1.
 *
 * Milestone 5 U4 (KTD6): this is milestone 4's entire `districtHealth`
 * function, renamed — its body is unchanged. `districtHealth` (below) now
 * names the *composed* quantity (`jacobsHealth × (1 − severancePenalty)`);
 * every milestone-4 caller that wants the four-generator mean alone
 * (untouched by severance) should call `jacobsHealth` directly instead.
 */
export function jacobsHealth(district: District): number {
  return (
    HEALTH_WEIGHTS.useMix * useMix(district) +
    HEALTH_WEIGHTS.blockGranularity * blockGranularity(district) +
    HEALTH_WEIGHTS.ageVariety * ageVariety(district) +
    HEALTH_WEIGHTS.density * densityScore(district)
  );
}

// --- Severance (milestone 5 U4, R7/R8/R9/R10, KTD5/KTD6) -------------------

/** Severance penalty is squashed toward this ceiling, strictly below 1
 *  (KTD6) — however many or however strong a district's cuts, its health is
 *  damaged, never zeroed. A cut district still has *some* traffic value;
 *  the story is decline, not erasure. */
export const SEVERANCE_PENALTY_MAX = 0.6;

/** Saturation rate of the penalty curve against summed cut contribution
 *  (KTD5) — tuned so a single track-strength cut through a district's
 *  center produces a modest, legible penalty, and a handful of crossings
 *  saturate well short of `SEVERANCE_PENALTY_MAX`. */
export const SEVERANCE_K = 0.15;

/** A degenerate (station-footprint) chord has zero geometric length
 *  (`ax === bx`, `ay === by`) but is still a real severance source (R7: "a
 *  station, its yards") — treated as this many tiles of effective length
 *  (KTD5) so it contributes on the same footing as a short track segment,
 *  rather than vanishing from the penalty sum entirely. */
export const MIN_CUT_LENGTH = 1;

/**
 * One cut's contribution to `district`'s severance penalty (KTD5):
 * `strength × length × centrality`. `length` is the chord's world-tile
 * length, floored at `MIN_CUT_LENGTH` for degenerate (point) chords.
 * `centrality` is a linear falloff from 1 (a chord through the anchor) to 0
 * (a chord at the district's footprint edge, `DISTRICT_FOOTPRINT_TILES`
 * away) — this is what makes R10 a numeric property of geometry: the same
 * chord, closer to the anchor, always contributes more.
 */
function cutContribution(district: District, cut: Cut): number {
  const length = Math.max(MIN_CUT_LENGTH, Math.hypot(cut.bx - cut.ax, cut.by - cut.ay));
  const midX = (cut.ax + cut.bx) / 2;
  const midY = (cut.ay + cut.by) / 2;
  const distFromAnchor = Math.hypot(midX - district.anchorX, midY - district.anchorY);
  const centrality = clamp01(1 - distFromAnchor / DISTRICT_FOOTPRINT_TILES);
  return cut.strength * length * centrality;
}

/**
 * Severance penalty for `district` (KTD5), in `[0, SEVERANCE_PENALTY_MAX)`.
 * Sums every cut's `cutContribution` and squashes the total through a
 * saturating curve (`1 - exp(-k * raw)`) scaled to `SEVERANCE_PENALTY_MAX` —
 * monotonic in cut count and strength (more/stronger cuts never reduce the
 * penalty), and bounded strictly below `SEVERANCE_PENALTY_MAX` (< 1, KTD6)
 * for any finite cut list, however large. An uncut district (`cuts: []`,
 * every district before milestone 5 and every fresh one after it) scores
 * exactly 0 — `districtHealth` below is then byte-identical to `jacobsHealth`
 * alone, the regression guard milestone 4's callers depend on.
 */
export function severancePenalty(district: District): number {
  if (district.cuts.length === 0) return 0;
  const raw = district.cuts.reduce((sum, c) => sum + cutContribution(district, c), 0);
  return SEVERANCE_PENALTY_MAX * (1 - Math.exp(-SEVERANCE_K * raw));
}

/**
 * District health (milestone 5 U4, KTD6): `jacobsHealth × (1 −
 * severancePenalty)` — severance is a fifth, multiplicative factor on
 * milestone 4's four-generator mean, never zeroing a district (bounded
 * below 1 by `severancePenalty`'s own ceiling). This is the export name
 * every milestone-4 caller (`districtTrafficMultiplier` below,
 * `world/streets.ts`'s scene generator) already used — the definition
 * moved, but every call site is untouched, so R9 ("severance costs the
 * player money") needs no new plumbing: the cut flows through the exact
 * loop the player is paid by.
 */
export function districtHealth(district: District): number {
  return jacobsHealth(district) * (1 - severancePenalty(district));
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
 * The district currently "matched to" a station id (milestone 5 U7, KTD8):
 * `state.districts` can hold more than one record with the same
 * `stationId` after a beyond-footprint relocation (`ensureDistrict`'s
 * narrowed per-(station id, anchor) idempotency, `store/applyIntents.ts`) —
 * the abandoned district keeps the id for historical attribution, but only
 * the *most recently created* one for that id is the record a station's
 * current activity (deliveries, catchment-based traffic) should credit.
 * Since `state.districts` only ever appends (never reorders or removes,
 * R14), "most recent" is simply the last match in array order — no Map/Set
 * needed, no iteration-order ambiguity.
 */
export function activeDistrictFor(state: GameState, stationId: string): District | undefined {
  let found: District | undefined;
  for (const district of state.districts) {
    if (district.stationId === stationId) found = district;
  }
  return found;
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
 *
 * Milestone 5 U7 (KTD8): only considers each station's *active* district
 * (`activeDistrictFor`) — after a relocation beyond the old district's
 * footprint, an abandoned district sharing the same `stationId` would
 * otherwise be checked against the same (single, current) station position
 * a second time, double-crediting one station's catchment as if two
 * stations served it.
 */
export function districtTrafficMultiplier(state: GameState, city: City, good?: TrafficGood): number {
  let deviationSum = 0;
  let typeSkew = 0;
  const seenStationIds = new Set<string>();
  for (const district of state.districts) {
    if (seenStationIds.has(district.stationId)) continue; // only the active record per station counts
    seenStationIds.add(district.stationId);
    const active = activeDistrictFor(state, district.stationId)!;
    if (active.development < DEVELOPMENT_FLOOR) continue;
    const station = state.stations.find((s) => s.id === active.stationId);
    if (!station) continue;
    if (!inCatchment(station, city.x, city.y)) continue;
    deviationSum += districtHealth(active) - HEALTH_NEUTRAL;
    if (good) typeSkew += districtTrafficWeight(station, good) - 1;
  }
  const multiplier = 1 + TRAFFIC_MULTIPLIER_K * deviationSum + typeSkew;
  return Math.min(MULT_MAX, Math.max(MULT_MIN, multiplier));
}
