import type { GameState } from './state.ts';
import type { Tile } from './pathfinding.ts';
import { terrainAt, elevationAt } from '../world/geography.ts';
import {
  stepCost,
  type StepCost,
  BASE_COST_PER_TILE,
  LAND_BASE_COST_PER_TILE,
  TRACK_TERRAIN_FACTOR,
  LAND_BASE_FACTOR,
} from './model/trackCost.ts';

/**
 * The pure survey: waypoints in, cheapest buildable path with itemized cost
 * and a grade profile out — or a legible refusal (milestone 3 U3, KTD3).
 *
 * KTD2 — this is the *only* place a route's path and cost are computed.
 * `surveyRoute` is called twice with identical arguments: once by the UI
 * (`SurveyPanel`, U6) for the live preview, once by the sim inside
 * `applyIntent` (U4) at commit time. Because both calls run the same pure
 * function of `(state, waypoints)`, the preview cannot disagree with what
 * commit actually pays — a stale UI proposal, a race with a concurrent
 * state change, or a hand-crafted intent can never commit a route at the
 * wrong price, and replaying an intent log stays byte-deterministic.
 *
 * KTD3 — pathfinding is A* per leg (one search between each consecutive
 * pair of waypoints), not one search across all waypoints at once: a
 * waypoint constrains the path by construction (the leg must start and end
 * there), which is simpler and more predictable than a soft-constraint
 * penalty that only *encourages* passing near a point. The grid is small
 * (40x28, ~1,120 tiles), so even several per-leg searches stay
 * sub-millisecond — cheap enough to re-run on every cursor move (U6).
 *
 * Determinism (KTD3): every source of nondeterminism a naive A* could leak
 * is closed off here. Neighbor expansion always iterates `NEIGHBOR_OFFSETS`
 * in the same fixed order. The open set is broken by a *total* order — f,
 * then g, then tile key (`x`, then `y`, numerically) — never by `Map`/`Set`
 * iteration order, which V8 happens to preserve for string keys today but
 * which is not a language guarantee this kernel should depend on. Two
 * equal-cost paths therefore always resolve to the same one, on every run,
 * on every machine.
 *
 * The heuristic (`heuristicCost`) is admissible by construction: it is the
 * straight-line (Euclidean) tile distance to the goal times the cheapest
 * possible real per-tile-distance cost the model can ever produce —
 * `MIN_COST_PER_TILE`, derived from `trackCost.ts`'s own exported minimum
 * terrain and land factors (the cheapest terrain, zero grade, zero
 * structure, zero city uplift) rather than a separately-tuned guess that
 * could silently drift out of sync with the real cost model and make the
 * search suboptimal.
 */

/** 8-connected neighborhood (D8), excluding the cell itself, in a fixed
 *  iteration order (KTD3) — the same order used everywhere else in the
 *  codebase that walks a tile's neighbors (`rivers.ts`). */
const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

function tileKey(t: Tile): string {
  return `${t.x},${t.y}`;
}

function sameTile(a: Tile, b: Tile): boolean {
  return a.x === b.x && a.y === b.y;
}

/** The cheapest per-tile-distance cost `stepCost` can ever produce: the
 *  cheapest non-sea terrain factor, the cheapest non-sea land factor, zero
 *  grade cost, zero structure cost, zero city uplift. Derived from
 *  `trackCost.ts`'s own exported tables so the heuristic can never drift out
 *  of sync with the real cost model and become inadmissible (KTD3). */
const MIN_TRACK_TERRAIN_FACTOR = Math.min(
  ...Object.entries(TRACK_TERRAIN_FACTOR)
    .filter(([t]) => t !== 'sea')
    .map(([, v]) => v),
);
const MIN_LAND_FACTOR = Math.min(
  ...Object.entries(LAND_BASE_FACTOR)
    .filter(([t]) => t !== 'sea')
    .map(([, v]) => v),
);
export const MIN_COST_PER_TILE = BASE_COST_PER_TILE * MIN_TRACK_TERRAIN_FACTOR + LAND_BASE_COST_PER_TILE * MIN_LAND_FACTOR;

function heuristicCost(a: Tile, b: Tile): number {
  return Math.hypot(a.x - b.x, a.y - b.y) * MIN_COST_PER_TILE;
}

interface OpenEntry {
  x: number;
  y: number;
  g: number;
  f: number;
}

/** Total deterministic ordering for the open-set pop (KTD3): lower f wins;
 *  ties break on lower g; remaining ties break on tile key (x, then y,
 *  numerically) — never on insertion or Map/Set iteration order. */
function betterCandidate(a: OpenEntry, b: OpenEntry): boolean {
  if (a.f !== b.f) return a.f < b.f;
  if (a.g !== b.g) return a.g < b.g;
  if (a.x !== b.x) return a.x < b.x;
  return a.y < b.y;
}

interface Leg {
  path: Tile[];
  steps: StepCost[];
}

/**
 * A* over the tile grid from `start` to `goal`, cost-weighted by
 * `stepCost(...).totalCents` (KTD3). Returns the inclusive tile path and its
 * per-step itemization, or `null` if they are not connected by any
 * buildable (non-sea) path. `start === goal` (by value) short-circuits to a
 * single-tile, zero-step leg rather than searching.
 */
function astarLeg(state: GameState, start: Tile, goal: Tile): Leg | null {
  if (sameTile(start, goal)) return { path: [{ x: start.x, y: start.y }], steps: [] };

  const { width, height } = state.world;
  const startKey = tileKey(start);
  const goalKey = tileKey(goal);

  const gScore = new Map<string, number>([[startKey, 0]]);
  const cameFrom = new Map<string, Tile>();
  const closed = new Set<string>();
  const open: OpenEntry[] = [{ x: start.x, y: start.y, g: 0, f: heuristicCost(start, goal) }];

  while (open.length > 0) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) {
      if (betterCandidate(open[i], open[bi])) bi = i;
    }
    const current = open.splice(bi, 1)[0];
    const currentKey = tileKey(current);
    if (closed.has(currentKey)) continue;
    closed.add(currentKey);
    if (currentKey === goalKey) break;

    for (const [dx, dy] of NEIGHBOR_OFFSETS) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const neighborKey = `${nx},${ny}`;
      if (closed.has(neighborKey)) continue;

      const edgeCost = stepCost(state, { x: current.x, y: current.y }, { x: nx, y: ny }).totalCents;
      if (!Number.isFinite(edgeCost)) continue; // sea (or otherwise unbuildable): not a real edge

      const tentativeG = current.g + edgeCost;
      const bestKnownG = gScore.get(neighborKey);
      if (bestKnownG !== undefined && tentativeG >= bestKnownG) continue;

      gScore.set(neighborKey, tentativeG);
      cameFrom.set(neighborKey, { x: current.x, y: current.y });
      open.push({ x: nx, y: ny, g: tentativeG, f: tentativeG + heuristicCost({ x: nx, y: ny }, goal) });
    }
  }

  if (!gScore.has(goalKey)) return null;

  const path: Tile[] = [{ x: goal.x, y: goal.y }];
  let ck = goalKey;
  while (ck !== startKey) {
    const prev = cameFrom.get(ck);
    if (!prev) return null; // defensive: gScore.has(goalKey) guarantees a chain exists
    path.push(prev);
    ck = tileKey(prev);
  }
  path.reverse();

  const steps: StepCost[] = [];
  for (let i = 0; i + 1 < path.length; i++) steps.push(stepCost(state, path[i], path[i + 1]));
  return { path, steps };
}

export type SurveyRefusalReason = 'endpoint-on-sea' | 'waypoint-on-sea' | 'no-path';

/** One point on the route's cumulative-distance/elevation grade profile
 *  (U6's panel readout). `distance` is cumulative tile-distance from the
 *  route's start; `elevation` is `elevationAt` at that path point. */
export interface ProfilePoint {
  distance: number;
  elevation: number;
}

export type SurveyResult =
  | {
      ok: true;
      path: Tile[];
      steps: StepCost[];
      totalCents: number;
      maxGrade: number;
      profile: ProfilePoint[];
    }
  | {
      ok: false;
      reason: SurveyRefusalReason;
    };

function buildProfile(path: Tile[]): ProfilePoint[] {
  const profile: ProfilePoint[] = [];
  let distance = 0;
  for (let i = 0; i < path.length; i++) {
    if (i > 0) distance += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    profile.push({ distance, elevation: elevationAt(path[i].x, path[i].y) });
  }
  return profile;
}

/**
 * Survey a route through `waypoints` (at least a start and an end tile) —
 * pure function of `(state, waypoints)` (KTD2). Returns the cheapest
 * buildable path A* finds leg by leg between consecutive waypoints,
 * itemized and profiled, or a legible refusal (R5, AE4): `'endpoint-on-sea'`
 * when the first or last waypoint is unbuildable, `'waypoint-on-sea'` when
 * an intermediate one is, and `'no-path'` when every waypoint is on land but
 * no buildable route connects them (or fewer than two waypoints were given).
 */
export function surveyRoute(state: GameState, waypoints: Tile[]): SurveyResult {
  if (waypoints.length < 2) return { ok: false, reason: 'no-path' };

  const isSea = (t: Tile) => terrainAt(t.x, t.y) === 'sea';
  if (isSea(waypoints[0]) || isSea(waypoints[waypoints.length - 1])) {
    return { ok: false, reason: 'endpoint-on-sea' };
  }
  for (let i = 1; i < waypoints.length - 1; i++) {
    if (isSea(waypoints[i])) return { ok: false, reason: 'waypoint-on-sea' };
  }

  const path: Tile[] = [waypoints[0]];
  const steps: StepCost[] = [];
  for (let i = 0; i + 1 < waypoints.length; i++) {
    const leg = astarLeg(state, waypoints[i], waypoints[i + 1]);
    if (!leg) return { ok: false, reason: 'no-path' };
    // Skip leg.path[0]: it duplicates the previous leg's last tile (the
    // shared waypoint), so concatenation never repeats a tile.
    for (let j = 1; j < leg.path.length; j++) path.push(leg.path[j]);
    steps.push(...leg.steps);
  }

  const totalCents = steps.reduce((sum, s) => sum + s.totalCents, 0);
  const maxGrade = steps.reduce((max, s) => Math.max(max, s.rawGrade), 0);

  return { ok: true, path, steps, totalCents, maxGrade, profile: buildProfile(path) };
}
