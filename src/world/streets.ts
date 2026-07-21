import type { District } from '../sim/model/districts.ts';
import { districtHealth, blockGranularity, ageVariety } from '../sim/model/districts.ts';

/**
 * Street-scene generation (M4 U6, KTD8, R2/R9/R11/R12). `generateDistrictScene`
 * is the one function everything visual reads from: a pure function of
 * (seed, quantized district record, anchor) that lays out a station square,
 * radiating main streets, and building footprints — deterministic, bounded,
 * and never stored (R9). Zooming into a district a player has never visited
 * produces full detail with no save growth (R11), because there is nothing
 * to grow: the scene is regenerated from the record every time it's asked
 * for, and the renderer (`render/districtRenderer.ts`, U7) is the only thing
 * that caches it, by value.
 *
 * KTD8 — record inputs are quantized to 1/16ths (`QUANTUM`) before anything
 * is derived from them, so a tick that nudges `development` by a thousandth
 * produces byte-for-byte the same scene (cache stability); only a change
 * that crosses a quantum boundary regenerates one. `episodeCount` and the
 * growth-day fields are already discrete/bounded — they are *not*
 * quantized, since they do not fluctuate the way the continuous channels do
 * and their exact value is meaningful to `blockGranularity`/`ageVariety`.
 *
 * Randomness comes only from hashing (seed, district id, element index) —
 * never from `state.rng`, which the sim owns exclusively (the same
 * discipline `world/rivers.ts` follows for its own noise sampling). The
 * `seed` parameter is expected to be `state.rng.seed` — plain data read by
 * value, not a draw from the RNG stream — the same value `world/geography.ts`
 * threads to `configureTerrainSeed` and `dev/debugHook.ts` exposes.
 *
 * This is directional guidance, not a layout spec (the plan's own words):
 * the invariants that matter are determinism, quantization stability,
 * boundedness, and record-conditioned variety (AE1) — the aesthetic itself
 * is free to change without touching those.
 */

// --- Quantization (KTD8) ---

/** Continuous record fields are rounded to the nearest multiple of this
 *  before anything is derived from them, so sub-quantum ticks (e.g.
 *  `development` drifting by 0.001) produce an identical scene. */
export const QUANTUM = 1 / 16;

function quantize(value: number): number {
  return Math.round(value / QUANTUM) * QUANTUM;
}

export interface QuantizedChannels {
  development: number;
  residential: number;
  commercial: number;
  industrial: number;
  density: number;
}

/** Quantize the continuous, scene-relevant fields of a district record
 *  (KTD8). Exported so the renderer's cache key (U7) can be derived from the
 *  exact same quantization this module's generation uses — the cache key
 *  *is* the derivation input, per KTD8. */
export function quantizeDistrict(district: District): QuantizedChannels {
  return {
    development: quantize(district.development),
    residential: quantize(district.residential),
    commercial: quantize(district.commercial),
    industrial: quantize(district.industrial),
    density: quantize(district.density),
  };
}

// --- Deterministic hashing: (seed, district id, element index) -> [0, 1) ---

/** djb2, a small, fast, well-distributed string hash — used only to fold a
 *  district's string id into the numeric hash below, never as a randomness
 *  source on its own. */
function hashString(s: string): number {
  let h = 5381 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

/** splitmix32-style finalizer (the same shape `sim/rng.ts` uses for its own
 *  deterministic hash) over an arbitrary list of integer components, folded
 *  together — good avalanche, so neighboring element indices don't yield
 *  correlated values. */
function hashInts(...ints: number[]): number {
  let z = 0x9e3779b9 >>> 0;
  for (const n of ints) {
    z = (z + (Math.imul(n | 0, 0x85ebca6b) >>> 0)) >>> 0;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
  }
  return z >>> 0;
}

/** A deterministic float in [0, 1) from (seed, districtId, ...salt). Every
 *  call site below passes a distinct integer `salt` component (an element
 *  index, a purpose tag) so two draws for the same building never correlate. */
function hash01(seed: number, districtIdHash: number, ...salt: number[]): number {
  return hashInts(seed, districtIdHash, ...salt) / 4294967296;
}

// --- Scene shape ---

export type BuildingUse = 'residential' | 'commercial' | 'industrial';

export interface Footprint {
  /** World-tile-space rectangle (anchor-relative offsets already applied). */
  rect: { x: number; y: number; width: number; height: number };
  /** 0 (lowest) .. HEIGHT_CLASSES - 1 (tallest). */
  heightClass: number;
  use: BuildingUse;
  /** 0 (newest) .. AGE_CLASSES - 1 (oldest). */
  ageClass: number;
  /** Vacant/boarded — the health cue the scene carries without a HUD (R8). */
  vacant: boolean;
}

export interface StreetSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface DistrictScene {
  districtId: string;
  /** World-tile-space station square. */
  stationSquare: { x: number; y: number; size: number };
  streets: StreetSegment[];
  footprints: Footprint[];
}

// --- Bounded, development-driven scene parameters ---

export const MIN_BUILDINGS = 2;
export const MAX_BUILDINGS = 240;

export const MIN_MAIN_STREETS = 2;
export const MAX_MAIN_STREETS = 8;

/** Scene radius (world tiles) at zero development — enough for a station
 *  square and a building or two, never an empty scene. */
export const MIN_EXTENT_TILES = 0.12;
/** Scene radius (world tiles) at full development — a district's visual
 *  footprint spans roughly one tile around its anchor at full development
 *  (plan Assumptions; a deliberate stylization, not a persisted boundary —
 *  see the plan's milestone-5 forward-compatibility note). */
export const MAX_EXTENT_TILES = 1;

export const STATION_SQUARE_SIZE = 0.05;

export const HEIGHT_CLASSES = 5;
export const AGE_CLASSES = 4;

/** How many blocks a fully fine-grained district (`blockGranularity` = 1)
 *  organizes its buildings into, vs. one superblock at granularity 0. */
export const MIN_BLOCKS = 1;
export const MAX_BLOCKS = 24;

/** Vacancy rate at health = 0; scales linearly to 0 at health = 1 (R8). */
export const VACANCY_MAX_RATE = 0.5;

function lerp(a: number, b: number, t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return a + (b - a) * clamped;
}

export function buildingCountFor(development: number): number {
  return Math.round(lerp(MIN_BUILDINGS, MAX_BUILDINGS, development));
}

export function extentTilesFor(development: number): number {
  return lerp(MIN_EXTENT_TILES, MAX_EXTENT_TILES, development);
}

export function mainStreetCountFor(development: number): number {
  return Math.round(lerp(MIN_MAIN_STREETS, MAX_MAIN_STREETS, development));
}

function blockCountFor(granularity: number): number {
  return Math.round(lerp(MIN_BLOCKS, MAX_BLOCKS, granularity));
}

/** Pick a building's use from the district's channel shares, biased toward
 *  commercial near the station (KTD2's "commercial concentrating near the
 *  station"). Falls back to residential — a plausible starter-hamlet
 *  default — when the district has no built form of any kind yet. */
function pickUse(q: QuantizedChannels, roll: number, radiusFrac: number): BuildingUse {
  const commercialBoost = 1 + (1 - radiusFrac) * 0.5; // up to +50% closer to the station
  const r = q.residential;
  const c = q.commercial * commercialBoost;
  const ind = q.industrial;
  const total = r + c + ind;
  if (total <= 0) return 'residential';
  const rr = roll * total;
  if (rr < r) return 'residential';
  if (rr < r + c) return 'commercial';
  return 'industrial';
}

function heightClassFor(density: number, jitter: number): number {
  const base = density * (HEIGHT_CLASSES - 1);
  const jittered = base + (jitter - 0.5);
  return Math.min(HEIGHT_CLASSES - 1, Math.max(0, Math.round(jittered)));
}

function ageClassFor(ageVarietyScore: number, jitter: number): number {
  const spread = ageVarietyScore * (AGE_CLASSES - 1);
  return Math.min(AGE_CLASSES - 1, Math.max(0, Math.round(jitter * spread)));
}

/**
 * Generate a district's street scene (M4 U6, KTD8). Pure: the same
 * (seed, district, anchor) always produces a deep-equal scene; the sim
 * stores none of this. `seed` is expected to be `state.rng.seed` (plain
 * data — see module docblock), never `state.rng` itself.
 */
export function generateDistrictScene(
  seed: number,
  district: District,
  anchor: { x: number; y: number },
): DistrictScene {
  const q = quantizeDistrict(district);
  const idHash = hashString(district.id);

  // Derive the four Jacobs-generator inputs from a shape that carries the
  // quantized continuous fields but the record's real (already-discrete)
  // growth history, so `blockGranularity`/`ageVariety`/health react to the
  // same quantization the geometry below does. `useMix` itself is not drawn
  // on directly here — building use is drawn from the raw channel shares
  // (`pickUse`, below) — but it folds into `health`, which vacancy reads.
  const shape: District = { ...district, ...q };
  const health = districtHealth(shape);
  const granularity = blockGranularity(shape);
  const age = ageVariety(shape);

  const extent = extentTilesFor(q.development);
  const buildingCount = buildingCountFor(q.development);
  const streetCount = mainStreetCountFor(q.development);
  const blockCount = blockCountFor(granularity);

  const streets: StreetSegment[] = [];
  for (let b = 0; b < streetCount; b++) {
    const baseAngle = (2 * Math.PI * b) / streetCount;
    const jitter = (hash01(seed, idHash, 1, b) - 0.5) * (Math.PI / streetCount) * 0.6;
    const angle = baseAngle + jitter;
    streets.push({
      ax: anchor.x,
      ay: anchor.y,
      bx: anchor.x + Math.cos(angle) * extent,
      by: anchor.y + Math.sin(angle) * extent,
    });
  }

  // Block anchors: evenly spaced around the district, each a candidate
  // cluster center buildings scatter near (KTD4's block-granularity input
  // made visible — many small blocks read as fine grain, few as superblocks).
  const blockAngles: number[] = [];
  const blockRadii: number[] = [];
  for (let b = 0; b < blockCount; b++) {
    const baseAngle = (2 * Math.PI * b) / blockCount;
    const jitter = (hash01(seed, idHash, 2, b) - 0.5) * (Math.PI / blockCount);
    blockAngles.push(baseAngle + jitter);
    blockRadii.push(lerp(extent * 0.35, extent, hash01(seed, idHash, 3, b)));
  }

  const footprints: Footprint[] = [];
  const parcelSize = Math.max(0.006, extent / Math.sqrt(buildingCount + 1) / 3);
  for (let i = 0; i < buildingCount; i++) {
    const blockIndex = blockCount > 0 ? hashInts(seed, idHash, 4, i) % blockCount : 0;
    const blockAngle = blockAngles[blockIndex] ?? 0;
    const blockRadius = blockRadii[blockIndex] ?? extent * 0.5;
    const blockSpread = extent / blockCount + parcelSize;

    const offsetAngle = hash01(seed, idHash, 5, i) * 2 * Math.PI;
    const offsetRadius = hash01(seed, idHash, 6, i) * blockSpread;
    const bx = Math.cos(blockAngle) * blockRadius + Math.cos(offsetAngle) * offsetRadius;
    const by = Math.sin(blockAngle) * blockRadius + Math.sin(offsetAngle) * offsetRadius;
    const radiusFrac = Math.min(1, Math.hypot(bx, by) / (extent || 1));

    const use = pickUse(q, hash01(seed, idHash, 7, i), radiusFrac);
    const heightJitter = hash01(seed, idHash, 8, i);
    const ageJitter = hash01(seed, idHash, 9, i);
    const vacancyRoll = hash01(seed, idHash, 10, i);

    footprints.push({
      rect: {
        x: anchor.x + bx - parcelSize / 2,
        y: anchor.y + by - parcelSize / 2,
        width: parcelSize,
        height: parcelSize,
      },
      heightClass: heightClassFor(q.density, heightJitter),
      use,
      ageClass: ageClassFor(age, ageJitter),
      vacant: vacancyRoll < (1 - health) * VACANCY_MAX_RATE,
    });
  }

  return {
    districtId: district.id,
    stationSquare: { x: anchor.x, y: anchor.y, size: STATION_SQUARE_SIZE },
    streets,
    footprints,
  };
}
