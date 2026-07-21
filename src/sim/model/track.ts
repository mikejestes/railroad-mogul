import type { GameState, World } from '../state.ts';
import type { Tile } from '../pathfinding.ts';
import { moveCostFor, terrainAt, elevationAt } from '../../world/geography.ts';
import { addMoney } from '../state.ts';
import { effectiveGradeFor, type StepCost, type TrackStructure } from './trackCost.ts';

/**
 * Track & stations (U5). Track segments connect adjacent tiles and form the
 * graph that trains pathfind over (U6). Stations have a catchment radius;
 * industries and city tiles within radius supply and demand through the
 * station — the original's proven catchment economics, mouse-driven (R14).
 *
 * U3 change: terrain lookups used to index a stored `World.terrain` array;
 * that array is gone (R9 — terrain is never stored), so every lookup here
 * calls `terrainAt(x, y)` directly instead (KTD1). `World` is kept as the
 * parameter type on `segmentWeight` purely for bounds context and call-site
 * stability elsewhere in the codebase, even though this module no longer
 * reads terrain data off it.
 *
 * Milestone 3 U4/U5 changes (KTD1, KTD5, KTD8): `TrackSegment` gains an
 * optional `structure` — a player-bought bridge/tunnel/cutting, priced and
 * chosen by `trackCost.ts`'s `stepCost` at survey time (U2/U3) and carried
 * onto the segment at commit (`emitRoute`, below) so it can later relieve
 * that segment's effective grade during movement (`segmentWeight`, U5). A
 * `Route` is the first-class stored record of a committed survey (KTD1):
 * small, path-dependent state distinct from the segments it emits, so "which
 * line is this" is never re-derived from an undifferentiated segment soup.
 * `layTrack`/`canLayTrack` and their flat cost model are untouched (R12) —
 * hand-laid track never carries a structure, and the old model stays for
 * tests and the debug hook, independent of `trackCost.ts`.
 *
 * Milestone 5 U1 (KTD3): `Station` gains `stationType` — a second, independent
 * axis from `radius`. Chosen in the build UI at siting time, defaulted to
 * `'mixed'` here (the single source of truth for the default — see
 * `buildStation` below) so any caller that omits it, including pre-M5 test
 * fixtures constructed with an object literal, still gets the neutral type
 * rather than `undefined`. Type carries no cost of its own (`STATION_COST`
 * still keys off `radius` alone) and is preserved through relocation
 * (`moveStation`, U7) — re-typing a station is a re-siting decision the
 * product has not asked for.
 */
export interface TrackSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Obstacle-crossing structure this segment required, if any (U4/U5,
   *  KTD5). Omitted — never set to `undefined` — for a plain segment, so
   *  the serialized shape of pre-milestone-3 and hand-laid segments is
   *  unchanged (R12, the determinism/save contract's no-`undefined` rule). */
  structure?: TrackStructure;
}

/**
 * A committed route (U4, KTD1): the player-facing record of one surveyed
 * line, distinct from the `TrackSegment`s it emits into
 * `state.track.segments` (which remain the graph trains actually pathfind
 * over — `pathfinding.ts` is untouched). `waypoints` is what the player
 * chose; `path` is what `surveyRoute` resolved it to — kept separately since
 * a waypoint list is short and human-meaningful while the path is the full
 * tile-by-tile resolution.
 */
export interface Route {
  id: string;
  waypoints: Tile[];
  path: Tile[];
  costCents: number;
  committedDay: number;
}

/**
 * Station type (milestone 5 U1, KTD3): an axis independent of `radius`.
 * Chosen at siting; shapes what a district becomes around the station
 * (`STATION_TYPE_MODIFIERS`, `sim/model/districts.ts`, U2) without affecting
 * catchment size or cost. `'mixed'` is the neutral default — identical to
 * pre-M5 behavior (regression guard).
 */
export type StationType = 'freight' | 'passenger' | 'mixed';

/** The default station type when none is chosen (KTD3) — the single source
 *  of truth `buildStation` falls back to. */
export const DEFAULT_STATION_TYPE: StationType = 'mixed';

export interface Station {
  id: string;
  x: number;
  y: number;
  /** Chebyshev catchment radius (Depot 1 / Station 2 / Terminal 3). */
  radius: number;
  /** Freight yard / passenger terminal / mixed depot (milestone 5, KTD3).
   *  Independent of `radius`; fixed at siting and preserved through
   *  relocation. Optional — `buildStation` (below) always sets a concrete
   *  value for a player-built station, never leaving it `undefined`; the
   *  field stays optional on the interface only so pre-milestone-5 test
   *  fixtures across the suite that construct a `Station` literal by hand
   *  (`{ id, x, y, radius }`, with no opinion about type) keep type-checking
   *  unchanged. Every reader goes through `stationTypeOf` (below), never
   *  this field directly, so the 'mixed'-default fallback lives in one
   *  place. */
  stationType?: StationType;
}

/** A station's effective type (KTD3): the stored field, or
 *  `DEFAULT_STATION_TYPE` ('mixed') when absent — the one place the
 *  optional-field fallback happens, so `sim/model/districts.ts`'s accrual
 *  modifiers and the renderer's glyph selection can never disagree about
 *  what an untyped (pre-M5-fixture) station's type reads as. */
export function stationTypeOf(station: Station): StationType {
  return station.stationType ?? DEFAULT_STATION_TYPE;
}

export interface TrackNetwork {
  segments: TrackSegment[];
}

export const TRACK_COST_PER_SEGMENT = 50_00; // cents
export const MOUNTAIN_SURCHARGE = 100_00;
export const STATION_COST = [50_00, 100_00, 200_00]; // by radius-1 index

function inBounds(world: World, x: number, y: number): boolean {
  return x >= 0 && x < world.width && y >= 0 && y < world.height;
}

/** Whether a track segment between two tiles is legal (adjacent, on buildable land). */
export function canLayTrack(state: GameState, ax: number, ay: number, bx: number, by: number): boolean {
  const w = state.world;
  if (!inBounds(w, ax, ay) || !inBounds(w, bx, by)) return false;
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  if (dx === 0 && dy === 0) return false;
  if (dx > 1 || dy > 1) return false; // must be adjacent (incl. diagonal)
  if (terrainAt(ax, ay) === 'sea' || terrainAt(bx, by) === 'sea') return false;
  return true;
}

function segmentCost(seg: TrackSegment): number {
  const a = terrainAt(seg.ax, seg.ay);
  const b = terrainAt(seg.bx, seg.by);
  let cost = TRACK_COST_PER_SEGMENT;
  if (a === 'mountain' || b === 'mountain') cost += MOUNTAIN_SURCHARGE;
  return cost;
}

/** Lay a track segment if legal and affordable; returns success. */
export function layTrack(state: GameState, ax: number, ay: number, bx: number, by: number): boolean {
  if (!canLayTrack(state, ax, ay, bx, by)) return false;
  const seg: TrackSegment = { ax, ay, bx, by };
  const cost = segmentCost(seg);
  if (state.moneyCents < cost) return false;
  state.track.segments.push(seg);
  addMoney(state, -cost);
  return true;
}

/**
 * Emit a successfully surveyed route's segments and record (U4, KTD1/KTD2).
 * The caller (`applyIntents.ts`'s `commitRoute` handling) has already run
 * `surveyRoute`, confirmed `ok: true`, and checked affordability — this
 * function only shapes that result into stored state and pays for it; it
 * never re-validates buildability itself, so there is exactly one place
 * (`surveyRoute`) that decides what a route costs and where it goes (KTD2).
 * One `TrackSegment` is pushed per consecutive pair in `path`, carrying
 * `steps[i]`'s structure where it has one; `Route.path`/`waypoints` record
 * the survey's resolution and the player's original clicks, respectively.
 */
export function emitRoute(
  state: GameState,
  id: string,
  waypoints: Tile[],
  survey: { path: Tile[]; steps: StepCost[]; totalCents: number },
): void {
  for (let i = 0; i + 1 < survey.path.length; i++) {
    const a = survey.path[i];
    const b = survey.path[i + 1];
    const structure = survey.steps[i]?.structure;
    const seg: TrackSegment = { ax: a.x, ay: a.y, bx: b.x, by: b.y, ...(structure ? { structure } : {}) };
    state.track.segments.push(seg);
  }
  state.routes.push({
    id,
    waypoints: waypoints.map((t) => ({ x: t.x, y: t.y })),
    path: survey.path.map((t) => ({ x: t.x, y: t.y })),
    costCents: survey.totalCents,
    committedDay: state.timeDays,
  });
  addMoney(state, -survey.totalCents);
}

/** Build a station if the tile is buildable and affordable; returns success.
 *  `stationType` defaults to `DEFAULT_STATION_TYPE` ('mixed', KTD3) — type
 *  carries no cost of its own, so it never affects the affordability check. */
export function buildStation(
  state: GameState,
  id: string,
  x: number,
  y: number,
  radius: number,
  stationType: StationType = DEFAULT_STATION_TYPE,
): boolean {
  const w = state.world;
  if (!inBounds(w, x, y) || terrainAt(x, y) === 'sea') return false;
  const cost = STATION_COST[Math.min(STATION_COST.length - 1, Math.max(0, radius - 1))];
  if (state.moneyCents < cost) return false;
  state.stations.push({ id, x, y, radius, stationType });
  addMoney(state, -cost);
  return true;
}

/** Is a tile within a station's Chebyshev catchment radius? */
export function inCatchment(station: Station, x: number, y: number): boolean {
  return Math.max(Math.abs(station.x - x), Math.abs(station.y - y)) <= station.radius;
}

export function industriesInCatchment(state: GameState, station: Station) {
  return state.industries.filter((i) => inCatchment(station, i.x, i.y));
}

export function citiesInCatchment(state: GameState, station: Station) {
  return state.cities.filter((c) => inCatchment(station, c.x, c.y));
}

/**
 * A built segment's effective grade (milestone 3 U5, KTD4/KTD5): raw grade
 * from `elevationAt` at the segment's endpoints — the same derivation
 * `trackCost.ts`'s `stepCost` uses at survey time — capped by whatever
 * structure the segment carries via the shared `effectiveGradeFor` helper,
 * so pricing (U2/U3) and operations (this function) can never disagree
 * about what a structure bought. Nothing about grade is stored on the
 * segment itself (KTD4: terrain is a function, not stored data) — only
 * `structure` is (a player purchase), and grade is re-derived from it here
 * every time it's needed.
 */
export function effectiveGrade(seg: TrackSegment): number {
  const dist = Math.hypot(seg.ax - seg.bx, seg.ay - seg.by);
  const rawGrade = Math.abs(elevationAt(seg.bx, seg.by) - elevationAt(seg.ax, seg.ay)) / dist;
  return effectiveGradeFor(rawGrade, seg.structure);
}

/**
 * Tuning constant for how sharply grade slows a segment down (U5, KTD8, R11)
 * — the `k` in `weight = dist * terrainCost * (1 + k * effectiveGrade)`.
 * Kept modest deliberately: real adjacent-tile grades sampled across seeds
 * sit mostly in the 0.008-0.025 range (see `trackCost.ts`'s
 * `MAX_UNASSISTED_GRADE` derivation), so a factor of 25 turns a step at
 * that unassisted-grade threshold into roughly a 1.5x weight — a real,
 * measurable slowdown (AE2) without swamping terrain cost or making steep
 * track functionally unusable. Coupling grade to engine power was
 * considered and deferred (KTD8) — this single multiplier is the entire
 * operational effect grade has.
 */
export const GRADE_WEIGHT_FACTOR = 25;

/**
 * The `(1 + k * effectiveGrade)` multiplier `segmentWeight` applies (KTD8).
 * Exported and parameterized (`factor` defaults to `GRADE_WEIGHT_FACTOR`)
 * specifically so a test can pass `factor: 0` directly — a regression guard
 * that the weight collapses to the exact pre-milestone-3 formula, without
 * depending on finding a real segment whose grade happens to be exactly
 * zero (real terrain offers no such guarantee).
 */
export function gradeWeightMultiplier(grade: number, factor: number = GRADE_WEIGHT_FACTOR): number {
  return 1 + factor * grade;
}

/** Total move-cost weight of a segment, for train routing (U6; grade term
 *  added U5, KTD8, R11). `_world` is kept as a parameter (unused) only so
 *  call sites elsewhere in the codebase that pass `state.world` need no
 *  change — terrain is looked up globally by coordinate now, not off the
 *  `World` object (see module docblock). */
export function segmentWeight(_world: World, seg: TrackSegment): number {
  const a = moveCostFor(terrainAt(seg.ax, seg.ay));
  const b = moveCostFor(terrainAt(seg.bx, seg.by));
  const dist = Math.hypot(seg.ax - seg.bx, seg.ay - seg.by);
  return ((a + b) / 2) * dist * gradeWeightMultiplier(effectiveGrade(seg));
}
