import {
  CITY_SEEDS,
  GRID_HEIGHT,
  GRID_WIDTH,
  project,
  terrainAt,
  type Terrain,
} from './geography.ts';
import { createGameState, tileIndex, type GameState } from '../sim/state.ts';
import { makeCity } from '../sim/model/cities.ts';
import { makeIndustry } from '../sim/model/industries.ts';
import { RAW_INDUSTRY_TYPES, PROCESSOR_INDUSTRY_TYPES, type IndustryType } from '../sim/model/goods.ts';
import { nextInt } from '../sim/rng.ts';

/**
 * Build a full game world from a seed (U3, KTD6). Real geography is fixed —
 * cities and terrain come from `geography.ts` — but resource and industry
 * placement is seeded, so every run is the same recognizable Europe with a
 * fresh economic puzzle (R10).
 */
export function generateGame(seed: number): GameState {
  const state = createGameState(seed);

  // 1. Terrain grid from the coarse landmass model.
  const terrain: Terrain[] = new Array(GRID_WIDTH * GRID_HEIGHT);
  for (let y = 0; y < GRID_HEIGHT; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      terrain[y * GRID_WIDTH + x] = terrainAt(x, y);
    }
  }
  state.world = { width: GRID_WIDTH, height: GRID_HEIGHT, terrain };

  // 2. Cities at real projected positions; force their tile to land so no city
  //    ever lands in the sea (the coarse coastline can't be trusted at a city).
  for (const seedCity of CITY_SEEDS) {
    const { x, y } = project(seedCity);
    terrain[tileIndex(state.world, x, y)] = 'land';
    state.cities.push(makeCity(seedCity.id, seedCity.name, x, y));
  }

  // 3. Seeded resource extractors on land tiles, and processors near cities.
  //    Placement draws from the state RNG so it is reproducible per seed (R10).
  const landTiles = collectLandTiles(state);
  placeRawIndustries(state, landTiles);
  placeProcessors(state);

  return state;
}

function collectLandTiles(state: GameState): Array<{ x: number; y: number }> {
  const tiles: Array<{ x: number; y: number }> = [];
  const { width, height, terrain } = state.world;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (terrain[y * width + x] === 'land') tiles.push({ x, y });
    }
  }
  return tiles;
}

const RAW_PER_TYPE = 5;
const PROCESSORS = 6;

function placeRawIndustries(state: GameState, landTiles: Array<{ x: number; y: number }>): void {
  let n = 0;
  for (const type of RAW_INDUSTRY_TYPES) {
    for (let i = 0; i < RAW_PER_TYPE; i++) {
      if (landTiles.length === 0) return;
      const pick = landTiles[nextInt(state.rng, landTiles.length)];
      state.industries.push(makeIndustry(`ind-${n++}`, type, pick.x, pick.y));
    }
  }
}

function placeProcessors(state: GameState): void {
  if (state.cities.length === 0) return;
  let n = state.industries.length;
  for (let i = 0; i < PROCESSORS; i++) {
    const type: IndustryType = PROCESSOR_INDUSTRY_TYPES[nextInt(state.rng, PROCESSOR_INDUSTRY_TYPES.length)];
    const city = state.cities[nextInt(state.rng, state.cities.length)];
    // Place adjacent to the city on a land tile (fallback: on the city tile).
    const spot = nearbyLand(state, city.x, city.y);
    state.industries.push(makeIndustry(`ind-${n++}`, type, spot.x, spot.y));
  }
}

function nearbyLand(state: GameState, cx: number, cy: number): { x: number; y: number } {
  const { width, height, terrain } = state.world;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, -1],
  ]) {
    const x = cx + dx;
    const y = cy + dy;
    if (x >= 0 && x < width && y >= 0 && y < height && terrain[y * width + x] === 'land') {
      return { x, y };
    }
  }
  return { x: cx, y: cy };
}
