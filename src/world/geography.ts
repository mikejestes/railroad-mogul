/**
 * Real European geography projected onto the tile grid (U3, KTD6).
 *
 * v1 scope note: cities sit at their real lon/lat (this is what makes the map
 * "recognizable Europe"), but the coastline/terrain is a coarse box-based
 * approximation of the landmasses rather than a full coastline raster. That is
 * a deliberate v1 simplification — swapping in a real landmask (e.g. Natural
 * Earth) later is a change to `terrainAt` alone, nothing else.
 *
 * Tile scale (KTD6): the grid spans lon [-11, 25], lat [35, 60] at
 * TILE_DEGREES per tile, i.e. ~0.9° ≈ ~100 km per tile — continent-scale, the
 * right order for a tycoon map without an unwieldy tile count.
 */
export const LON_MIN = -11;
export const LON_MAX = 25;
export const LAT_MIN = 35;
export const LAT_MAX = 60;
export const TILE_DEGREES = 0.9;

export const GRID_WIDTH = Math.round((LON_MAX - LON_MIN) / TILE_DEGREES); // 40
export const GRID_HEIGHT = Math.round((LAT_MAX - LAT_MIN) / TILE_DEGREES); // ~28

export type Terrain = 'land' | 'sea' | 'mountain';

export interface LonLat {
  lon: number;
  lat: number;
}

export interface CitySeed extends LonLat {
  id: string;
  name: string;
}

/** Equirectangular projection: lon/lat -> integer tile coords (y grows south). */
export function project(lonlat: LonLat): { x: number; y: number } {
  const x = Math.round((lonlat.lon - LON_MIN) / TILE_DEGREES);
  const y = Math.round((LAT_MAX - lonlat.lat) / TILE_DEGREES);
  return {
    x: Math.min(GRID_WIDTH - 1, Math.max(0, x)),
    y: Math.min(GRID_HEIGHT - 1, Math.max(0, y)),
  };
}

// Coarse landmass boxes in lon/lat (approximate; v1). A tile is land if its
// centre falls in any box, mountain if in a mountain box, else sea.
const LAND_BOXES: Array<[number, number, number, number]> = [
  // [lonMin, lonMax, latMin, latMax]
  [-9, 3, 36, 44], // Iberia
  [-5, 8, 43, 51], // France + Low Countries
  [-8, 2, 50, 59], // British Isles (coarse; includes some sea)
  [6, 24, 45, 55], // Central Europe
  [7, 19, 38, 47], // Italy
  [4, 25, 55, 60], // Southern Scandinavia / Baltic coast
  [13, 25, 40, 47], // Balkans / SE Europe
];

const MOUNTAIN_BOXES: Array<[number, number, number, number]> = [
  [6, 14, 45, 48], // Alps
  [-2, 2, 42, 44], // Pyrenees
];

function inAnyBox(lon: number, lat: number, boxes: Array<[number, number, number, number]>): boolean {
  return boxes.some(([loMin, loMax, laMin, laMax]) => lon >= loMin && lon <= loMax && lat >= laMin && lat <= laMax);
}

/** Terrain at a tile, derived from the coarse landmass boxes. */
export function terrainAt(x: number, y: number): Terrain {
  const lon = LON_MIN + x * TILE_DEGREES;
  const lat = LAT_MAX - y * TILE_DEGREES;
  if (inAnyBox(lon, lat, MOUNTAIN_BOXES)) return 'mountain';
  if (inAnyBox(lon, lat, LAND_BOXES)) return 'land';
  return 'sea';
}

/** Per-tile movement cost used by train routing (U6). Sea is impassable. */
export function moveCostFor(terrain: Terrain): number {
  switch (terrain) {
    case 'land':
      return 1;
    case 'mountain':
      return 3;
    case 'sea':
      return Infinity;
  }
}

/** A curated set of real European cities (recognizable positions). */
export const CITY_SEEDS: CitySeed[] = [
  { id: 'london', name: 'London', lon: -0.13, lat: 51.51 },
  { id: 'paris', name: 'Paris', lon: 2.35, lat: 48.86 },
  { id: 'berlin', name: 'Berlin', lon: 13.4, lat: 52.52 },
  { id: 'madrid', name: 'Madrid', lon: -3.7, lat: 40.42 },
  { id: 'rome', name: 'Rome', lon: 12.5, lat: 41.9 },
  { id: 'vienna', name: 'Vienna', lon: 16.37, lat: 48.21 },
  { id: 'amsterdam', name: 'Amsterdam', lon: 4.9, lat: 52.37 },
  { id: 'munich', name: 'Munich', lon: 11.58, lat: 48.14 },
  { id: 'milan', name: 'Milan', lon: 9.19, lat: 45.46 },
  { id: 'barcelona', name: 'Barcelona', lon: 2.17, lat: 41.39 },
  { id: 'hamburg', name: 'Hamburg', lon: 10.0, lat: 53.55 },
  { id: 'warsaw', name: 'Warsaw', lon: 21.01, lat: 52.23 },
  { id: 'prague', name: 'Prague', lon: 14.42, lat: 50.08 },
  { id: 'zurich', name: 'Zurich', lon: 8.54, lat: 47.37 },
  { id: 'lyon', name: 'Lyon', lon: 4.83, lat: 45.76 },
  { id: 'naples', name: 'Naples', lon: 14.27, lat: 40.85 },
];
