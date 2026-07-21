import { CITY_SEEDS, GRID_HEIGHT, GRID_WIDTH, project, terrainAt, type Terrain } from './geography.ts';
import { createGameState, STARTING_CAPITAL, type GameState } from '../sim/state.ts';
import { makeCity } from '../sim/model/cities.ts';
import { makeIndustry } from '../sim/model/industries.ts';
import { RAW_INDUSTRY_TYPES, PROCESSOR_INDUSTRY_TYPES, type IndustryType } from '../sim/model/goods.ts';
import { nextInt, type RngState } from '../sim/rng.ts';
import { buildRiverGraph } from './rivers.ts';

/**
 * Build a full game world from a seed (U3, KTD6). Real geography is fixed —
 * cities and terrain come from `geography.ts` — but resource and industry
 * placement is seeded, so every run is the same recognizable Europe with a
 * fresh economic puzzle (R10).
 *
 * U3 change (R9): generation used to eagerly materialize a `GRID_WIDTH *
 * GRID_HEIGHT` terrain array and store it on `state.world`. That array is
 * gone — `terrainAt(x, y)` (`geography.ts`) is queried directly wherever a
 * tile's terrain matters, and `state.world` carries only the grid dimensions
 * pathfinding and placement need to stay in bounds. City tiles are no longer
 * force-set to a generic 'land' value either: the authored landmask KTD5
 * layers into `terrainAt` (see `geography.ts`) already guarantees every
 * `LAND_BOXES` box — and every real city sits inside one — is never `sea`,
 * so AE3 ("every city sits on land") holds structurally rather than by an
 * explicit override.
 *
 * U5 change (KTD6, R7): the coarse river flow graph is built once here, from
 * the same world `seed` (not `state.rng`, which the RNG-driven placement
 * below advances — river routing is a pure function of seed and grid
 * dimensions, independent of anything the RNG stream produces, so it does
 * not matter whether it runs before or after placement, and running before
 * keeps the RNG stream identical to pre-U5 generation).
 *
 * U6 change (R8): raw-extractor placement used to draw uniformly at random
 * from every non-sea tile *with replacement* — no terrain association
 * (a coal mine was as likely on farmland as on a mountain), no spacing (two
 * extractors could land on the same tile), no clustering (sites scattered
 * evenly instead of reading as deposits). `placeRawIndustries` now draws only
 * from tiles each recipe's terrain favors and clusters sites into
 * "spot noise"-style patches via `placeClusteredSites` (see its docblock).
 * `nearbyLand` (processors) gained the same "never share a tile" guarantee —
 * it used to search a fixed, RNG-independent ring of offsets around a city
 * with no awareness of what earlier industries had already claimed, so two
 * processors assigned to the same city could resolve to the identical tile.
 * It now spirals outward from the city, skipping any tile already in the
 * shared `occupied` set.
 */
export function generateGame(seed: number): GameState {
  const state = createGameState(seed);
  state.moneyCents = STARTING_CAPITAL;
  state.world = { width: GRID_WIDTH, height: GRID_HEIGHT };
  state.rivers = buildRiverGraph(seed, GRID_WIDTH, GRID_HEIGHT);

  // 1. Cities at their real projected positions.
  for (const seedCity of CITY_SEEDS) {
    const { x, y } = project(seedCity);
    state.cities.push(makeCity(seedCity.id, seedCity.name, x, y));
  }

  // 2. Seeded resource extractors on terrain their recipe favors, clustered
  //    and spaced (R8), and processors near cities. Placement draws from the
  //    state RNG so it is reproducible per seed (R10).
  const landTiles = collectLandTiles(state);
  const occupied = new Set<string>();
  placeRawIndustries(state, landTiles, occupied);
  placeProcessors(state, occupied);

  return state;
}

function collectLandTiles(state: GameState): Array<{ x: number; y: number }> {
  const tiles: Array<{ x: number; y: number }> = [];
  const { width, height } = state.world;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (terrainAt(x, y) !== 'sea') tiles.push({ x, y });
    }
  }
  return tiles;
}

const RAW_PER_TYPE = 5;
const PROCESSORS = 6;

/**
 * Terrain each raw extractor's recipe favors (U6, R8): coal and iron are
 * mined, so they favor the elevated terrain that reads as ore-bearing (hills
 * and mountain); farms favor the fertile lowland types; ranches favor open
 * plains. Processors (`steelMill`/`factory`/`foodPlant`) have no terrain
 * affinity of their own — they place near cities regardless of terrain, same
 * as before U6 — so they are intentionally absent from this map.
 */
export const RAW_FAVORED_TERRAIN: Partial<Record<IndustryType, Terrain[]>> = {
  coalMine: ['hills', 'mountain'],
  ironMine: ['hills', 'mountain'],
  farm: ['farmland', 'plains'],
  ranch: ['plains'],
};

/**
 * Minimum Chebyshev-distance separation enforced between any two same-type
 * extractors (U6, R8) — the floor that stops sites from stacking up in a
 * single tile-wide clump.
 */
export const MIN_EXTRACTOR_SEPARATION = 2;

/**
 * A candidate at most this far (Chebyshev) from an already-placed site of
 * the same type reads as belonging to the same deposit patch (U6, R8).
 */
const CLUSTER_RADIUS = 4;

/**
 * A candidate at least this far from every already-placed site of the same
 * type starts a visually distinct new patch (U6, R8). Kept strictly greater
 * than `CLUSTER_RADIUS` so there is a genuine gap band between the two —
 * candidates that fall in the gap are skipped, which is what keeps patches
 * reading as separate deposits instead of one even scatter across the whole
 * favored region.
 */
const CLUSTER_CENTER_SEPARATION = 7;

/** How far `nearbyLand` spirals outward from a city before giving up. */
const PROCESSOR_SEARCH_RADIUS = 6;

function chebyshev(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Fisher-Yates shuffle driven by the sim RNG (deterministic per seed, R10). */
function shuffled<T>(rng: RngState, items: T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = nextInt(rng, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Greedily accept sites from a shuffled favored-terrain candidate list,
 * producing "spot noise"-style patches (U6, R8) instead of an even scatter:
 * a candidate is accepted only if it is at least `MIN_EXTRACTOR_SEPARATION`
 * from every already-accepted site of the same type, and either close enough
 * to read as part of an existing patch (`<= CLUSTER_RADIUS`) or far enough to
 * start a new one (`>= CLUSTER_CENTER_SEPARATION`). The first accepted site
 * always starts a patch, so a non-empty candidate list always yields at
 * least one site. Shuffling once up front (rather than repeatedly scanning
 * in grid order) is what keeps different seeds producing different patch
 * shapes from the same fixed favored-tile set, and stops the algorithm from
 * always favoring low-(x,y) corners of the map.
 */
function placeClusteredSites(
  rng: RngState,
  candidates: Array<{ x: number; y: number }>,
  targetCount: number,
  occupied: Set<string>,
): Array<{ x: number; y: number }> {
  const pool = shuffled(rng, candidates);
  const sites: Array<{ x: number; y: number }> = [];
  for (const candidate of pool) {
    if (sites.length >= targetCount) break;
    const key = `${candidate.x},${candidate.y}`;
    if (occupied.has(key)) continue;
    if (sites.length > 0) {
      const nearest = Math.min(...sites.map((s) => chebyshev(s, candidate)));
      if (nearest < MIN_EXTRACTOR_SEPARATION) continue;
      if (nearest > CLUSTER_RADIUS && nearest < CLUSTER_CENTER_SEPARATION) continue;
    }
    sites.push(candidate);
    occupied.add(key);
  }
  return sites;
}

/**
 * Place raw extractors on terrain their recipe favors, clustered and spaced
 * (U6, R8). `occupied` is shared with `placeProcessors` so nothing placed
 * later can land on a tile an extractor already claimed.
 */
function placeRawIndustries(
  state: GameState,
  landTiles: Array<{ x: number; y: number }>,
  occupied: Set<string>,
): void {
  let n = 0;
  for (const type of RAW_INDUSTRY_TYPES) {
    const favored = RAW_FAVORED_TERRAIN[type] ?? [];
    const candidates = landTiles.filter((tile) => favored.includes(terrainAt(tile.x, tile.y)));
    const sites = placeClusteredSites(state.rng, candidates, RAW_PER_TYPE, occupied);
    for (const site of sites) {
      state.industries.push(makeIndustry(`ind-${n++}`, type, site.x, site.y));
    }
  }
}

function placeProcessors(state: GameState, occupied: Set<string>): void {
  if (state.cities.length === 0) return;
  let n = state.industries.length;
  for (let i = 0; i < PROCESSORS; i++) {
    const type: IndustryType = PROCESSOR_INDUSTRY_TYPES[nextInt(state.rng, PROCESSOR_INDUSTRY_TYPES.length)];
    const city = state.cities[nextInt(state.rng, state.cities.length)];
    const spot = nearbyLand(state, city.x, city.y, occupied);
    state.industries.push(makeIndustry(`ind-${n++}`, type, spot.x, spot.y));
    occupied.add(`${spot.x},${spot.y}`);
  }
}

/** Every offset at exactly Chebyshev distance `radius` from the origin, in a
 *  fixed deterministic scan order (ascending dx, then dy). */
function ringOffsets(radius: number): Array<[number, number]> {
  const offsets: Array<[number, number]> = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) === radius) offsets.push([dx, dy]);
    }
  }
  return offsets;
}

/**
 * Nearest non-sea, unoccupied tile to a city, searched ring by ring outward
 * (U6, R8). Falls back to the city's own tile only if every ring up to
 * `PROCESSOR_SEARCH_RADIUS` is exhausted — with 16 cities and `PROCESSORS`
 * capped well below that, this should not be reachable in practice, but the
 * fallback keeps the function total rather than throwing.
 */
function nearbyLand(state: GameState, cx: number, cy: number, occupied: Set<string>): { x: number; y: number } {
  const { width, height } = state.world;
  for (let radius = 1; radius <= PROCESSOR_SEARCH_RADIUS; radius++) {
    for (const [dx, dy] of ringOffsets(radius)) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      if (occupied.has(`${x},${y}`)) continue;
      if (terrainAt(x, y) === 'sea') continue;
      return { x, y };
    }
  }
  return { x: cx, y: cy };
}
