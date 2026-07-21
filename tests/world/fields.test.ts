import { describe, it, expect } from 'vitest';
import {
  createTerrainFields,
  MIN_ELEVATION,
  MAX_ELEVATION,
  SEA_LEVEL,
  FULL_OCTAVES,
  ELEVATION_GAIN,
  DETAIL_WEIGHT,
  type TerrainFields,
} from '../../src/world/fields.ts';

// Local factory: a fresh field set for a given seed, per repo test convention.
function makeFields(seed = 1): TerrainFields {
  return createTerrainFields(seed);
}

// Sum of a geometric amplitude series, mirroring the normalization fields.ts
// uses internally (KTD4) — used here only to derive the AE1 truncation bound
// from exported constants, never to duplicate a tuning value.
function geometricAmplitudeSum(gain: number, octaves: number): number {
  let amplitude = 1;
  let total = 0;
  for (let i = 0; i < octaves; i++) {
    total += amplitude;
    amplitude *= gain;
  }
  return total;
}

describe('terrain fields (KTD1, KTD2)', () => {
  it('AE2: evaluating coordinates forward and in reverse order produces identical values', () => {
    const fields = makeFields(42);
    const coords: Array<[number, number]> = [];
    for (let i = 0; i < 24; i++) {
      coords.push([i * 3.7 - 15, i * -2.3 + 9]);
    }

    const forward = coords.map(([x, y]) => ({
      elevation: fields.elevationAt(x, y),
      moisture: fields.moistureAt(x, y),
      temperature: fields.temperatureAt(x, y),
    }));
    const reversed = [...coords]
      .reverse()
      .map(([x, y]) => ({
        elevation: fields.elevationAt(x, y),
        moisture: fields.moistureAt(x, y),
        temperature: fields.temperatureAt(x, y),
      }))
      .reverse();

    expect(reversed).toEqual(forward);
  });

  it('AE1: elevation at full and truncated octave budgets differ within the geometric-decay bound', () => {
    const fields = makeFields(7);
    const truncatedOctaves = 3;
    const points: Array<[number, number]> = [
      [12.5, -4.25],
      [-800, 300],
      [0, 0],
      [5000, -5000],
    ];

    const fullAmplitude = geometricAmplitudeSum(ELEVATION_GAIN, FULL_OCTAVES);
    const truncatedAmplitude = geometricAmplitudeSum(ELEVATION_GAIN, truncatedOctaves);
    const bound = (DETAIL_WEIGHT * (fullAmplitude - truncatedAmplitude)) / fullAmplitude;

    for (const [x, y] of points) {
      const full = fields.elevationAt(x, y, FULL_OCTAVES);
      const truncated = fields.elevationAt(x, y, truncatedOctaves);
      expect(Math.abs(full - truncated)).toBeLessThanOrEqual(bound + 1e-9);
    }
  });

  it('the same seed produces identical values across two separately constructed field sets', () => {
    const a = createTerrainFields(99);
    const b = createTerrainFields(99);
    const points: Array<[number, number]> = [
      [0, 0],
      [10.5, -3.25],
      [-200, 450],
    ];
    for (const [x, y] of points) {
      expect(a.elevationAt(x, y)).toBe(b.elevationAt(x, y));
      expect(a.moistureAt(x, y)).toBe(b.moistureAt(x, y));
      expect(a.temperatureAt(x, y)).toBe(b.temperatureAt(x, y));
    }
  });

  it('different seeds produce different values at the same coordinate', () => {
    const a = createTerrainFields(1);
    const b = createTerrainFields(2);
    expect(a.elevationAt(10, 10)).not.toBe(b.elevationAt(10, 10));
    expect(a.moistureAt(10, 10)).not.toBe(b.moistureAt(10, 10));
    expect(a.temperatureAt(10, 10)).not.toBe(b.temperatureAt(10, 10));
  });

  it('elevation stays within [MIN_ELEVATION, MAX_ELEVATION] across a large sample of coordinates', () => {
    const fields = makeFields(123);
    for (let i = 0; i < 400; i++) {
      const x = (i * 137.31) % 4000 - 2000;
      const y = (i * 61.17) % 4000 - 2000;
      const elevation = fields.elevationAt(x, y);
      expect(elevation).toBeGreaterThanOrEqual(MIN_ELEVATION);
      expect(elevation).toBeLessThanOrEqual(MAX_ELEVATION);
    }
    // Sanity: SEA_LEVEL sits inside the elevation range it partitions.
    expect(SEA_LEVEL).toBeGreaterThan(MIN_ELEVATION);
    expect(SEA_LEVEL).toBeLessThan(MAX_ELEVATION);
  });

  it('is continuous across fractional coordinates, not stepped to the nearest lattice point', () => {
    const fields = makeFields(5);
    const y = 12.3;
    const atLattice = fields.elevationAt(5, y);
    const atFraction = fields.elevationAt(5.5, y);
    // A stepped/floored implementation would make the fractional sample
    // identical to the lattice point it floors to.
    expect(atFraction).not.toBe(atLattice);

    const atNearbyFraction = fields.elevationAt(5.5 + 1e-4, y);
    expect(Math.abs(atNearbyFraction - atFraction)).toBeLessThan(0.01);
  });

  it('temperature decreases with latitude on average across a north-south transect', () => {
    const fields = makeFields(3);
    const x = 0;
    let southSum = 0; // small wy
    let northSum = 0; // large wy
    const samples = 20;
    for (let i = 0; i < samples; i++) {
      southSum += fields.temperatureAt(x + i, i);
      northSum += fields.temperatureAt(x + i, i + 200);
    }
    expect(northSum / samples).toBeLessThan(southSum / samples);
  });
});
