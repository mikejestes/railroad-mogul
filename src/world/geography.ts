/**
 * Real European geography projected onto the tile grid (U2/U3, KTD5, KTD6).
 *
 * Milestone-2 U7 addition (KTD9, R10) — exported `elevationAt(x, y)`
 * alongside `terrainAt`, factored to share the exact same tile-to-field
 * coordinate transform (`fieldCoords`, below) so the two never disagree
 * about which point in field space a tile maps to. Added for
 * `dev/debugHook.ts`, which needs a numeric elevation value (not just a
 * classified label) to let a browser driver assert terrain by value rather
 * than by screenshot.
 *
 * U2 change: `terrainAt` used to look a tile up in a handful of hand-drawn
 * lon/lat landmass boxes (`land | sea | mountain`, nothing else). It now
 * classifies the continuous elevation/moisture/temperature fields from
 * `fields.ts` (U1) through `classifyTerrain` (also `fields.ts`) into a wider
 * palette — R3, R4: enough terrain variety that most of the map is worth
 * routing around or through deliberately, driven by continuous elevation
 * rather than a single discrete label.
 *
 * U3 change (KTD5) — authored geography is now a *mask* layered over that
 * classification, not a competitor to it: `LAND_BOXES` (the same hand-drawn
 * lon/lat boxes the pre-U2 coarse model used as its entire terrain source)
 * are consulted first. A coordinate outside every box is unconditionally
 * `sea`, regardless of what the fields say — the fields never get to erase a
 * real coastline. A coordinate inside a box is never `sea` — if the fields'
 * own classification would have been `sea` there (elevation at/below sea
 * level), it falls back to `coast` instead, since "authored land that the
 * fields think is low-lying" reads as coastline, not open ocean. Every other
 * classification (plains, forest, mountain, ...) inside a box passes through
 * unchanged, so real Europe still carries the full palette's variety (R3),
 * it just cannot be erased into the sea by generation (R6). This retires
 * `'land'` from `Terrain` — it was kept only for fixtures built around the
 * stored `World.terrain` array this unit removes (see `state.ts`); every
 * caller now gets a specific palette member instead, never the generic
 * legacy value.
 *
 * Seeding note (still open, inherited from U1/U2) — the field instance
 * backing `terrainAt` is built once from a fixed placeholder seed
 * (`REFERENCE_FIELD_SEED`), not the game's actual per-run world seed. R1
 * ("function of world seed *and* coordinates") is satisfied at the
 * `fields.ts` layer (U1, tested directly there); wiring the real per-game
 * seed through *this* module's reference instance is out of scope for R6
 * (the only requirement this unit carries) and is left for a future unit if
 * ever needed — `terrainAt` keeps its documented 2-argument shape exactly as
 * KTD5 anticipated ("swapping in a real landmask is documented as a change to
 * `terrainAt` alone"), so nothing about this deferral changes its signature.
 *
 * Scale note (U3) — tile coordinates are multiplied by
 * `REFERENCE_FIELD_SCALE` before being handed to the fields, so the ~1120-
 * tile game grid samples a wide enough slice of the noise for real variety
 * (see `REFERENCE_FIELD_SCALE`'s own comment for why).
 *
 * Sign note — `fields.ts`'s `temperatureAt` treats larger `wy` as further
 * north (temperature falls as `wy` grows), but this module's tile `y` grows
 * *south* (`project`, below). `terrainAt` negates `y` before calling into the
 * fields so the climate gradient points the right way (north cooler, south
 * warmer) rather than inheriting `fields.ts`'s opposite convention verbatim.
 *
 * Tile scale (KTD6): the grid spans lon [-11, 25], lat [35, 60] at
 * TILE_DEGREES per tile, i.e. ~0.9° ≈ ~100 km per tile — continent-scale, the
 * right order for a tycoon map without an unwieldy tile count.
 */
import { createTerrainFields, classifyTerrain, type TerrainFields } from './fields.ts';

export const LON_MIN = -11;
export const LON_MAX = 25;
export const LAT_MIN = 35;
export const LAT_MAX = 60;
export const TILE_DEGREES = 0.9;

export const GRID_WIDTH = Math.round((LON_MAX - LON_MIN) / TILE_DEGREES); // 40
export const GRID_HEIGHT = Math.round((LAT_MAX - LAT_MIN) / TILE_DEGREES); // ~28

/** The terrain palette (U2/U3, R3, R4). Every classified tile is exactly one
 *  of these eight — see the module docblock for why `'land'` is gone. */
export type Terrain = 'sea' | 'coast' | 'plains' | 'farmland' | 'forest' | 'marsh' | 'hills' | 'mountain';

/** Every `Terrain` member, for exhaustive iteration in tests. */
export const TERRAIN_TYPES: Terrain[] = ['sea', 'coast', 'plains', 'farmland', 'forest', 'marsh', 'hills', 'mountain'];

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

// Placeholder reference seed for the field instance behind `terrainAt` (see
// "Seeding note" in the module docblock). Threading the real per-game seed
// through here is deferred — R6, the requirement this unit carries, does not
// need it (see the docblock). Chosen empirically (of a handful tried) for
// producing a plausible spread of the palette across the authored landmass
// at REFERENCE_FIELD_SCALE below, rather than for any other property.
const REFERENCE_FIELD_SEED = 7;

// `fields.ts`'s base frequencies (U1) were tuned and validated against a
// broad coordinate range, not against this module's ~40x28 tile grid — U2
// found empirically that sampling the fields 1:1 with tile indices leaves
// elevation nearly flat across the whole authored map (mountain/hills
// essentially never occur; see this module's git history and U2's
// completion notes). Scaling tile coordinates up before handing them to the
// fields makes the same small grid cover more of the noise's structure, so
// real variety (R3) and plausible mountain ranges (R5) show up within the
// actual game grid, without retuning any of `fields.ts`'s own frequency
// constants (owned by U1/U2). Empirically chosen (see the same scan as
// `REFERENCE_FIELD_SEED`) — not derived from `TILE_DEGREES` or any other
// existing constant.
const REFERENCE_FIELD_SCALE = 64;

let referenceFields: TerrainFields | null = null;

/** Lazily build the module's reference field set once, not per tile. */
function getReferenceFields(): TerrainFields {
  if (!referenceFields) referenceFields = createTerrainFields(REFERENCE_FIELD_SEED);
  return referenceFields;
}

// Authored landmass boxes in lon/lat (U3, KTD5). These are the same coarse
// boxes the pre-U2 model used as its *entire* terrain source (see git history
// on this file) — repurposed here as a mask that keeps real coastlines
// authoritative over generated classification rather than competing with it.
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

/** A tile classification the fields would never produce on their own — used
 *  as the fallback when authored land sits at/below sea level (U3, KTD5):
 *  "authored land the fields think is low-lying" reads as coastline. */
const MASKED_LAND_FALLBACK: Terrain = 'coast';

function isAuthoredLand(x: number, y: number): boolean {
  const lon = LON_MIN + x * TILE_DEGREES;
  const lat = LAT_MAX - y * TILE_DEGREES;
  return LAND_BOXES.some(([loMin, loMax, laMin, laMax]) => lon >= loMin && lon <= loMax && lat >= laMin && lat <= laMax);
}

// The 7 hand-drawn LAND_BOXES leave real coverage gaps at their seams (e.g.
// Amsterdam's lat 52.37 falls between the France box's 51 ceiling and the
// Scandinavia box's 55 floor) — the same gap the pre-U2 model patched by
// force-setting every city's *stored* tile to 'land' after generation. There
// is no stored tile to force anymore, so `terrainAt` instead folds the 16
// real city tiles into the landmask directly: AE3 ("every city sits on
// land") is guaranteed for the same reason it always was — cities are
// authored positions, not generated ones — just enforced in the mask rather
// than after the fact.
let cityTileKeys: Set<string> | null = null;

function isCityTile(x: number, y: number): boolean {
  if (!cityTileKeys) {
    cityTileKeys = new Set(
      CITY_SEEDS.map((c) => {
        const p = project(c);
        return `${p.x},${p.y}`;
      }),
    );
  }
  return cityTileKeys.has(`${x},${y}`);
}

/**
 * Terrain at a tile (U2/U3). Classifies the continuous elevation/moisture/
 * temperature fields (`fields.ts`) at this tile through `classifyTerrain`,
 * then applies the authored landmask (KTD5): outside every `LAND_BOXES` box
 * (and not one of the 16 real city tiles — see `isCityTile`) is
 * unconditionally `sea`; inside the mask, a fields-classified `sea` is
 * softened to `MASKED_LAND_FALLBACK` and every other classification passes
 * through untouched. `y` is negated before reaching the fields — see "Sign
 * note" in the module docblock — so climate still runs cooler north, warmer
 * south.
 */
export function terrainAt(x: number, y: number): Terrain {
  const authoredLand = isAuthoredLand(x, y) || isCityTile(x, y);
  if (!authoredLand) return 'sea';

  const elevation = elevationAt(x, y);
  const { moisture, temperature } = climateAt(x, y);
  const classified = classifyTerrain(elevation, moisture, temperature);
  return classified === 'sea' ? MASKED_LAND_FALLBACK : classified;
}

/** Shared tile-to-field coordinate transform (U3's `REFERENCE_FIELD_SCALE`
 *  scale-up plus the "Sign note" `y` negation) — `elevationAt` and
 *  `terrainAt` must agree on where a tile lands in field space, so both
 *  route through this rather than each re-deriving `wx`/`wy`. */
function fieldCoords(x: number, y: number): { wx: number; wy: number } {
  return { wx: x * REFERENCE_FIELD_SCALE, wy: -y * REFERENCE_FIELD_SCALE };
}

function climateAt(x: number, y: number): { moisture: number; temperature: number } {
  const { wx, wy } = fieldCoords(x, y);
  const fields = getReferenceFields();
  return { moisture: fields.moistureAt(wx, wy), temperature: fields.temperatureAt(wx, wy) };
}

/**
 * Raw elevation at a tile (milestone-2 U7, R10), on the same reference field
 * instance and coordinate transform `terrainAt` uses internally — so a
 * browser driver can assert, e.g., "this mountain tile has elevation above
 * `MOUNTAIN_ELEVATION`" and get an answer consistent with what `terrainAt`
 * actually classified. Exposed for `dev/debugHook.ts`; not otherwise
 * consumed within this milestone (elevation-priced track costs are
 * milestone 3's job per the plan's Scope Boundaries).
 */
export function elevationAt(x: number, y: number): number {
  const { wx, wy } = fieldCoords(x, y);
  return getReferenceFields().elevationAt(wx, wy);
}

/**
 * Per-tile movement cost used by train routing (U2, U6). Sea is impassable.
 * Mountain stays at its pre-U2 cost (3) so existing track-cost assertions
 * elsewhere in the suite (mountain surcharge, routing weight) are unaffected
 * by widening the palette around it.
 */
export function moveCostFor(terrain: Terrain): number {
  switch (terrain) {
    case 'sea':
      return Infinity;
    case 'plains':
    case 'coast':
    case 'farmland':
      return 1;
    case 'forest':
    case 'hills':
      return 2;
    case 'mountain':
      return 3;
    case 'marsh':
      return 4;
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
