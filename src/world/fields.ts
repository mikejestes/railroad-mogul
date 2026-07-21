/**
 * Terrain field functions: elevation, moisture, temperature as pure functions
 * of continuous world coordinates (U1, KTD1, KTD2, KTD3, KTD4).
 *
 * KTD1 — every field takes floating-point world coordinates, never a tile
 * index, so sampling at any resolution is evaluating the same continuous
 * function on a different grid: tiers agree by construction, no stitching.
 *
 * KTD2 — noise comes from `fastnoise-lite` (OpenSimplex2). Each logical
 * "layer" (an elevation octave, a warp axis, moisture, temperature) gets its
 * own instance seeded from the world seed plus a fixed per-layer offset,
 * because the library's own docs warn that domain-warp settings on an
 * instance also perturb ordinary noise sampled from that same instance, and
 * because decorrelating octaves this way (rather than reusing one instance at
 * different frequencies) avoids the periodic coincidences plain frequency
 * scaling can produce.
 *
 * KTD3 — elevation is domain-warped: `detail(p + warpFbm(p))`, not
 * `detail(p)`. Plain fractal noise reads as undifferentiated blobby hills;
 * warping the sample point by another fBm folds the noise into elongated,
 * ridge-like structures, which is what makes mountain ranges (rather than
 * mountain blobs) fall out of the same code (R5).
 *
 * KTD4 — `elevationAt` takes an `octaves` budget so the renderer can drop
 * high-frequency octaves at coarse zoom tiers (sub-pixel detail that would
 * only alias) while the simulation always asks for the full budget. Octave
 * amplitudes decay geometrically (`ELEVATION_GAIN` per step) and are
 * normalized against the *full* octave count rather than the requested one,
 * so dropping octaves shifts the result by a bounded, computable amount
 * instead of an arbitrary one (see the AE1 test for the exact bound).
 *
 * Elevation is unitless in `[MIN_ELEVATION, MAX_ELEVATION]` with
 * `SEA_LEVEL` at the midpoint; classification into a terrain palette is a
 * separate concern (U2). Temperature treats `wy` as a latitude-like
 * coordinate that increases northward — temperature falls as `wy` grows,
 * matching the climate gradient this world approximates. Callers that wire
 * fields to the tile grid (U2/U3) are responsible for the sign of that
 * mapping; this module makes no assumption about how `wy` relates to screen
 * or lon/lat coordinates beyond "larger means further north."
 *
 * U2 addition — `classifyTerrain(elevation, moisture, temperature)` turns
 * those three field values into a `Terrain` (R3, R4). Sea and mountain are
 * genuine hard elevation cutoffs — real-world coastlines and treelines are
 * effectively binary, and the U2 acceptance scenarios treat them as
 * unconditional ("mountain regardless of moisture", "sea regardless of
 * other fields"). Between those two edges, vegetation is chosen by
 * smoothstep-weighted suitability over moisture and temperature rather than
 * nested hard cuts: each candidate biome's suitability rises and falls
 * smoothly across its band, so the boundary between (say) forest and
 * farmland falls wherever the two suitability curves cross instead of at an
 * arbitrary axis-aligned threshold box — biomes fade into each other rather
 * than snapping. The function takes field *values*, not coordinates, so it
 * has no seed or coordinate dependency of its own; callers (`geography.ts`)
 * are responsible for sampling the fields first.
 */
import FastNoiseLite from 'fastnoise-lite';
import type { Terrain } from './geography.ts';

/** Elevation is unitless, bounded, with sea level at the midpoint. */
export const MIN_ELEVATION = -1;
export const MAX_ELEVATION = 1;
export const SEA_LEVEL = 0;

/** Full octave budget for elevation detail; the simulation always uses this. */
export const FULL_OCTAVES = 8;

/** Per-octave amplitude decay and frequency growth (KTD3, KTD4). */
export const ELEVATION_GAIN = 0.5;
// Not exactly 2.0: avoids the axis-aligned artifacts plain doubling can
// produce in domain-warped fBm (see plan Assumptions).
export const ELEVATION_LACUNARITY = 1.97;
export const ELEVATION_BASE_FREQUENCY = 0.015;

/** Elevation = continent mask (broad shape) + warped detail (ridges). */
export const CONTINENT_WEIGHT = 0.55;
export const DETAIL_WEIGHT = 0.45;
const CONTINENT_FREQUENCY = 0.0015;

/** Domain warp applied to the sample point before the detail fBm (KTD3). */
const WARP_OCTAVES = 3;
const WARP_GAIN = 0.5;
const WARP_LACUNARITY = 1.97;
const WARP_BASE_FREQUENCY = 0.01;
const WARP_AMPLITUDE = 60;

const MOISTURE_OCTAVES = 4;
const MOISTURE_GAIN = 0.5;
const MOISTURE_LACUNARITY = 1.97;
const MOISTURE_BASE_FREQUENCY = 0.02;

const TEMPERATURE_NOISE_OCTAVES = 3;
const TEMPERATURE_NOISE_GAIN = 0.5;
const TEMPERATURE_NOISE_LACUNARITY = 1.97;
const TEMPERATURE_NOISE_BASE_FREQUENCY = 0.02;
const TEMPERATURE_NOISE_AMPLITUDE_C = 4;
const BASE_TEMPERATURE_C = 12;
/** Degrees C lost per unit of `wy` moving north (see module docblock). */
const TEMPERATURE_LATITUDE_GRADIENT_C = 0.5;

/** Distinct per-octave seed offset so octaves don't correlate (KTD2). */
const OCTAVE_SEED_STRIDE = 97;
// Per-layer salts keep every noise instance's derived seed distinct even
// though several layers use the same OCTAVE_SEED_STRIDE stepping.
const ELEVATION_SEED_SALT = 0;
const WARP_X_SEED_SALT = 10_000;
const WARP_Y_SEED_SALT = 20_000;
const CONTINENT_SEED_SALT = 30_000;
const MOISTURE_SEED_SALT = 40_000;
const TEMPERATURE_SEED_SALT = 50_000;

export interface TerrainFields {
  /** Elevation at a world coordinate, in [MIN_ELEVATION, MAX_ELEVATION]. */
  elevationAt(wx: number, wy: number, octaves?: number): number;
  /** Moisture at a world coordinate, in [0, 1]. */
  moistureAt(wx: number, wy: number): number;
  /** Approximate temperature at a world coordinate, in degrees C. */
  temperatureAt(wx: number, wy: number): number;
}

function deriveSeed(seed: number, salt: number, index: number): number {
  return (seed + salt + index * OCTAVE_SEED_STRIDE) >>> 0;
}

function buildInstances(seed: number, salt: number, count: number): FastNoiseLite[] {
  const instances: FastNoiseLite[] = [];
  for (let i = 0; i < count; i++) {
    const instance = new FastNoiseLite(deriveSeed(seed, salt, i));
    instance.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    instances.push(instance);
  }
  return instances;
}

/** Sum of geometrically decaying amplitudes over `octaves` steps (KTD4). */
function amplitudeSum(gain: number, octaves: number): number {
  let amplitude = 1;
  let total = 0;
  for (let i = 0; i < octaves; i++) {
    total += amplitude;
    amplitude *= gain;
  }
  return total;
}

/**
 * Fractal sum over `octaves` noise instances, normalized against
 * `fullAmplitudeSum` (the sum for the *full* octave budget, not the
 * requested one) so truncating octaves shifts the result by a bounded amount
 * rather than changing the normalization itself (KTD4).
 */
function fbm(
  instances: FastNoiseLite[],
  x: number,
  y: number,
  octaves: number,
  baseFrequency: number,
  lacunarity: number,
  gain: number,
  fullAmplitudeSum: number,
): number {
  const n = Math.max(0, Math.min(octaves, instances.length));
  let amplitude = 1;
  let frequency = baseFrequency;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += instances[i].GetNoise(x * frequency, y * frequency) * amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return fullAmplitudeSum > 0 ? sum / fullAmplitudeSum : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Build a fresh set of field functions from a world seed (U1). Noise
 * instances are constructed once here and closed over by the returned
 * functions, which are otherwise pure — the same seed always produces the
 * same fields (R1), and two independently constructed field sets from the
 * same seed agree exactly.
 */
export function createTerrainFields(seed: number): TerrainFields {
  const elevationInstances = buildInstances(seed, ELEVATION_SEED_SALT, FULL_OCTAVES);
  const warpXInstances = buildInstances(seed, WARP_X_SEED_SALT, WARP_OCTAVES);
  const warpYInstances = buildInstances(seed, WARP_Y_SEED_SALT, WARP_OCTAVES);
  const continentInstance = new FastNoiseLite(deriveSeed(seed, CONTINENT_SEED_SALT, 0));
  continentInstance.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
  const moistureInstances = buildInstances(seed, MOISTURE_SEED_SALT, MOISTURE_OCTAVES);
  const temperatureNoiseInstances = buildInstances(seed, TEMPERATURE_SEED_SALT, TEMPERATURE_NOISE_OCTAVES);

  const elevationFullAmplitude = amplitudeSum(ELEVATION_GAIN, FULL_OCTAVES);
  const warpFullAmplitude = amplitudeSum(WARP_GAIN, WARP_OCTAVES);
  const moistureFullAmplitude = amplitudeSum(MOISTURE_GAIN, MOISTURE_OCTAVES);
  const temperatureNoiseFullAmplitude = amplitudeSum(TEMPERATURE_NOISE_GAIN, TEMPERATURE_NOISE_OCTAVES);

  function elevationAt(wx: number, wy: number, octaves: number = FULL_OCTAVES): number {
    // Domain warp (KTD3): displace the sample point by its own fBm before
    // sampling the detail field, so ridges fold rather than blob.
    const warpX =
      fbm(warpXInstances, wx, wy, WARP_OCTAVES, WARP_BASE_FREQUENCY, WARP_LACUNARITY, WARP_GAIN, warpFullAmplitude) *
      WARP_AMPLITUDE;
    const warpY =
      fbm(warpYInstances, wx, wy, WARP_OCTAVES, WARP_BASE_FREQUENCY, WARP_LACUNARITY, WARP_GAIN, warpFullAmplitude) *
      WARP_AMPLITUDE;

    const continent = continentInstance.GetNoise(wx * CONTINENT_FREQUENCY, wy * CONTINENT_FREQUENCY);
    const detail = fbm(
      elevationInstances,
      wx + warpX,
      wy + warpY,
      octaves,
      ELEVATION_BASE_FREQUENCY,
      ELEVATION_LACUNARITY,
      ELEVATION_GAIN,
      elevationFullAmplitude,
    );

    return clamp(CONTINENT_WEIGHT * continent + DETAIL_WEIGHT * detail, MIN_ELEVATION, MAX_ELEVATION);
  }

  function moistureAt(wx: number, wy: number): number {
    const raw = fbm(
      moistureInstances,
      wx,
      wy,
      MOISTURE_OCTAVES,
      MOISTURE_BASE_FREQUENCY,
      MOISTURE_LACUNARITY,
      MOISTURE_GAIN,
      moistureFullAmplitude,
    );
    return clamp((raw + 1) / 2, 0, 1);
  }

  function temperatureAt(wx: number, wy: number): number {
    const noise = fbm(
      temperatureNoiseInstances,
      wx,
      wy,
      TEMPERATURE_NOISE_OCTAVES,
      TEMPERATURE_NOISE_BASE_FREQUENCY,
      TEMPERATURE_NOISE_LACUNARITY,
      TEMPERATURE_NOISE_GAIN,
      temperatureNoiseFullAmplitude,
    );
    return BASE_TEMPERATURE_C - TEMPERATURE_LATITUDE_GRADIENT_C * wy + noise * TEMPERATURE_NOISE_AMPLITUDE_C;
  }

  return { elevationAt, moistureAt, temperatureAt };
}

// --- Classification (U2, R3, R4) -------------------------------------------

/**
 * Elevation at/above this is mountain, regardless of moisture or temperature.
 * `elevation = CONTINENT_WEIGHT*continent + DETAIL_WEIGHT*detail` rarely
 * approaches its theoretical ceiling (MAX_ELEVATION) in practice — reaching
 * it requires the continent term and every detail octave to peak together,
 * which is statistically rare. Empirically (a broad sample at a reference
 * seed) the composed elevation's high tail sits around 0.25-0.35, so 0.28
 * carves out roughly the top few percent as mountain — rare enough to read
 * as a range worth routing around (R5), not so rare it never appears.
 */
export const MOUNTAIN_ELEVATION = 0.28;
/** Elevation at/above this (and below MOUNTAIN_ELEVATION) is hills. */
export const HILLS_ELEVATION = 0.14;
/** Elevation at/below this, in the lowland band, defaults to coast. */
export const COAST_ELEVATION = 0.03;

/** Moisture band over which marsh suitability ramps from 0 to 1. */
export const MARSH_MOISTURE_LOW = 0.65;
export const MARSH_MOISTURE_HIGH = 0.85;

/** Moisture and temperature bands over which forest suitability ramps. */
export const FOREST_MOISTURE_LOW = 0.4;
export const FOREST_MOISTURE_HIGH = 0.6;
export const FOREST_TEMPERATURE_LOW_C = 2;
export const FOREST_TEMPERATURE_HIGH_C = 22;

/** Moisture and temperature bands over which farmland suitability ramps. */
export const FARMLAND_MOISTURE_LOW = 0.2;
export const FARMLAND_MOISTURE_HIGH = 0.4;
export const FARMLAND_TEMPERATURE_LOW_C = 8;
export const FARMLAND_TEMPERATURE_HIGH_C = 28;

/** A suitability score crosses "wins" at 0.5 — the midpoint of its ramp. */
const SUITABILITY_WIN_THRESHOLD = 0.5;

/** Standard GLSL-style smoothstep: 0 below edge0, 1 above edge1, eased between. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Classify a terrain palette entry from field values (U2, R3, R4). See the
 * module docblock for the smoothstep-suitability rationale. Sea and
 * mountain are hard elevation cutoffs; hills and coast are elevation bands;
 * everything in between (the "lowland" band) is chosen by whichever of
 * marsh/forest/farmland has the highest moisture/temperature suitability,
 * falling back to coast (very low elevation) or plains (everywhere else) if
 * none of them clear the win threshold.
 */
export function classifyTerrain(elevation: number, moisture: number, temperature: number): Terrain {
  if (elevation <= SEA_LEVEL) return 'sea';
  if (elevation >= MOUNTAIN_ELEVATION) return 'mountain';
  if (elevation >= HILLS_ELEVATION) return 'hills';

  const marshSuitability = smoothstep(MARSH_MOISTURE_LOW, MARSH_MOISTURE_HIGH, moisture);
  if (marshSuitability >= SUITABILITY_WIN_THRESHOLD) return 'marsh';

  const forestSuitability =
    smoothstep(FOREST_MOISTURE_LOW, FOREST_MOISTURE_HIGH, moisture) *
    smoothstep(FOREST_TEMPERATURE_LOW_C, FOREST_TEMPERATURE_HIGH_C, temperature);
  const farmlandSuitability =
    smoothstep(FARMLAND_MOISTURE_LOW, FARMLAND_MOISTURE_HIGH, moisture) *
    smoothstep(FARMLAND_TEMPERATURE_LOW_C, FARMLAND_TEMPERATURE_HIGH_C, temperature);

  if (forestSuitability >= SUITABILITY_WIN_THRESHOLD && forestSuitability >= farmlandSuitability) return 'forest';
  if (farmlandSuitability >= SUITABILITY_WIN_THRESHOLD) return 'farmland';
  if (elevation <= COAST_ELEVATION) return 'coast';
  return 'plains';
}
