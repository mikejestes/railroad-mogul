import { describe, it, expect } from 'vitest';
import {
  classifyTerrain,
  SEA_LEVEL,
  MOUNTAIN_ELEVATION,
  HILLS_ELEVATION,
  MARSH_MOISTURE_HIGH,
} from '../../src/world/fields.ts';
import { moveCostFor, TERRAIN_TYPES, type Terrain } from '../../src/world/geography.ts';

describe('terrain palette and classification (U2)', () => {
  it('every Terrain member has a finite moveCostFor except sea, which is Infinity', () => {
    for (const terrain of TERRAIN_TYPES) {
      const cost = moveCostFor(terrain);
      if (terrain === 'sea') {
        expect(cost).toBe(Infinity);
      } else {
        expect(Number.isFinite(cost)).toBe(true);
      }
    }
  });

  it('elevation above the mountain threshold classifies as mountain regardless of moisture', () => {
    const elevation = MOUNTAIN_ELEVATION + 0.1;
    for (const moisture of [0, 0.5, 1]) {
      expect(classifyTerrain(elevation, moisture, 15)).toBe('mountain');
    }
  });

  it('elevation below sea level classifies as sea regardless of other fields', () => {
    const elevation = SEA_LEVEL - 0.3;
    for (const [moisture, temperature] of [
      [0, -10],
      [0.5, 15],
      [1, 40],
    ]) {
      expect(classifyTerrain(elevation, moisture, temperature)).toBe('sea');
    }
  });

  it('high moisture at low elevation classifies as marsh; low moisture at moderate elevation does not', () => {
    const lowElevation = HILLS_ELEVATION / 2; // inside the lowland band, well below hills
    expect(classifyTerrain(lowElevation, MARSH_MOISTURE_HIGH, 15)).toBe('marsh');

    const moderateElevation = HILLS_ELEVATION - 0.02; // still lowland, near the hills edge
    expect(classifyTerrain(moderateElevation, 0.05, 15)).not.toBe('marsh');
  });

  it('classification is stable across the smoothstep band — no oscillation on repeated evaluation', () => {
    // A point sitting exactly between the forest and farmland suitability
    // bands, where a flaky comparison would be most likely to flip.
    const elevation = HILLS_ELEVATION - 0.05;
    const moisture = 0.3;
    const temperature = 15;
    const first = classifyTerrain(elevation, moisture, temperature);
    for (let i = 0; i < 50; i++) {
      expect(classifyTerrain(elevation, moisture, temperature)).toBe(first);
    }
  });

  it('existing track-cost tests still pass with mountain cost unchanged', () => {
    expect(moveCostFor('mountain')).toBe(3);
    expect(moveCostFor('sea')).toBe(Infinity);
    expect(moveCostFor('plains')).toBe(1);
  });

  it('classification only ever produces a member of the current Terrain palette', () => {
    // U3 retired the legacy 'land' value from Terrain entirely; every
    // classification is one of the eight remaining specific palette entries.
    const seen = new Set<Terrain>();
    for (let e = -1; e <= 1; e += 0.05) {
      for (let m = 0; m <= 1; m += 0.1) {
        seen.add(classifyTerrain(e, m, 15));
      }
    }
    for (const terrain of seen) {
      expect(TERRAIN_TYPES).toContain(terrain);
    }
  });
});
