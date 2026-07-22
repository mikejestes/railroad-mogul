import { describe, it, expect } from 'vitest';
import {
  generateDistrictScene,
  quantizeDistrict,
  buildingCountFor,
  extentTilesFor,
  QUANTUM,
  MIN_BUILDINGS,
  MAX_BUILDINGS,
  MAX_EXTENT_TILES,
  VACANCY_MAX_RATE,
  type DistrictScene,
} from '../../src/world/streets.ts';
import { makeDistrict, districtHealth, type District } from '../../src/sim/model/districts.ts';

// Local factory, per repo test convention.
function station(id = 'stn-0', x = 5, y = 5) {
  return { id, x, y };
}

const ANCHOR = { x: 5, y: 5 };

describe('street scene generation (M4 U6, KTD8)', () => {
  it('the same (seed, district, anchor) always generates a deep-equal scene', () => {
    const d = makeDistrict('dst-0', station());
    d.development = 0.5;
    d.residential = 0.3;
    d.commercial = 0.2;
    d.industrial = 0.1;
    d.density = 0.4;

    const a = generateDistrictScene(7, d, ANCHOR);
    const b = generateDistrictScene(7, d, ANCHOR);
    expect(a).toEqual(b);
  });

  it('a different district id generates a different scene', () => {
    const dA = makeDistrict('dst-a', station());
    dA.development = 0.5;
    const dB = makeDistrict('dst-b', station());
    dB.development = 0.5;

    const sceneA = generateDistrictScene(7, dA, ANCHOR);
    const sceneB = generateDistrictScene(7, dB, ANCHOR);
    expect(sceneA.footprints).not.toEqual(sceneB.footprints);
  });

  it('a different seed generates a different scene for the same district', () => {
    const d = makeDistrict('dst-0', station());
    d.development = 0.5;

    const sceneA = generateDistrictScene(7, d, ANCHOR);
    const sceneB = generateDistrictScene(99, d, ANCHOR);
    expect(sceneA.footprints).not.toEqual(sceneB.footprints);
  });

  describe('quantization stability (KTD8)', () => {
    it('a sub-quantum record change generates an identical scene', () => {
      const base = makeDistrict('dst-0', station());
      base.development = 0.5; // safely mid-quantum, away from a 1/16 boundary
      const nudged: District = { ...base, development: base.development + 0.001 };

      // Confirm the nudge really is sub-quantum before asserting on it.
      expect(quantizeDistrict(base).development).toBe(quantizeDistrict(nudged).development);

      expect(generateDistrictScene(7, base, ANCHOR)).toEqual(generateDistrictScene(7, nudged, ANCHOR));
    });

    it('crossing a quantum boundary changes the scene', () => {
      const base = makeDistrict('dst-0', station());
      base.development = 0.5;
      const acrossBoundary: District = { ...base, development: base.development + QUANTUM };

      expect(quantizeDistrict(base).development).not.toBe(quantizeDistrict(acrossBoundary).development);
      expect(generateDistrictScene(7, base, ANCHOR)).not.toEqual(generateDistrictScene(7, acrossBoundary, ANCHOR));
    });
  });

  describe('AE1 (scene level): built form reflects what was delivered', () => {
    it('a steel+goods-fed record has taller heights and more industrial/commercial parcels than a food-only record, which has more residential', () => {
      const industrial: District = {
        ...makeDistrict('dst-i', station()),
        residential: 0,
        commercial: 0.6,
        industrial: 0.6,
        density: 0.6,
        development: 0.6,
      };
      const residential: District = {
        ...makeDistrict('dst-r', station()),
        residential: 0.6,
        commercial: 0,
        industrial: 0,
        density: 0,
        development: 0.6,
      };

      const industrialScene = generateDistrictScene(7, industrial, ANCHOR);
      const residentialScene = generateDistrictScene(7, residential, ANCHOR);

      const avgHeight = (scene: DistrictScene) =>
        scene.footprints.reduce((sum, f) => sum + f.heightClass, 0) / scene.footprints.length;
      const countByUse = (scene: DistrictScene, use: string) => scene.footprints.filter((f) => f.use === use).length;

      expect(avgHeight(industrialScene)).toBeGreaterThan(avgHeight(residentialScene));
      expect(countByUse(industrialScene, 'commercial') + countByUse(industrialScene, 'industrial')).toBeGreaterThan(
        countByUse(residentialScene, 'commercial') + countByUse(residentialScene, 'industrial'),
      );
      expect(countByUse(residentialScene, 'residential')).toBeGreaterThan(countByUse(industrialScene, 'residential'));
    });
  });

  describe('bounded scene parameters', () => {
    it('building count and extent are bounded functions of development, staying under documented ceilings at max development', () => {
      expect(buildingCountFor(1)).toBeLessThanOrEqual(MAX_BUILDINGS);
      expect(buildingCountFor(1)).toBe(MAX_BUILDINGS);
      expect(extentTilesFor(1)).toBeLessThanOrEqual(MAX_EXTENT_TILES);
      expect(extentTilesFor(1)).toBe(MAX_EXTENT_TILES);
      expect(buildingCountFor(0)).toBe(MIN_BUILDINGS);
    });

    it('a maxed-out district record stays within scene-parameter ceilings end to end', () => {
      const maxed: District = {
        ...makeDistrict('dst-max', station()),
        residential: 1,
        commercial: 1,
        industrial: 1,
        density: 1,
        development: 1,
        episodeCount: 60,
        firstGrowthDay: 0,
        lastGrowthDay: 2000,
      };
      const scene = generateDistrictScene(7, maxed, ANCHOR);
      expect(scene.footprints.length).toBeLessThanOrEqual(MAX_BUILDINGS);
      for (const f of scene.footprints) {
        expect(Math.hypot(f.rect.x - ANCHOR.x, f.rect.y - ANCHOR.y)).toBeLessThanOrEqual(MAX_EXTENT_TILES + 0.05);
      }
    });
  });

  describe('vacancy tracks health (R8 substrate)', () => {
    it('a low-health record generates a higher vacancy rate than a high-health record of equal development', () => {
      const lowHealth: District = {
        ...makeDistrict('dst-low', station()),
        residential: 0.9,
        commercial: 0,
        industrial: 0,
        density: 0.1,
        development: 0.5,
        episodeCount: 1,
        firstGrowthDay: 0,
        lastGrowthDay: 0,
      };
      const highHealth: District = {
        ...makeDistrict('dst-high', station()),
        residential: 0.35,
        commercial: 0.35,
        industrial: 0.3,
        density: 0.5,
        development: 0.5,
        episodeCount: 20,
        firstGrowthDay: 0,
        lastGrowthDay: 720,
      };
      expect(districtHealth(lowHealth)).toBeLessThan(districtHealth(highHealth));

      const lowScene = generateDistrictScene(7, lowHealth, ANCHOR);
      const highScene = generateDistrictScene(7, highHealth, ANCHOR);
      const vacancyRate = (scene: DistrictScene) =>
        scene.footprints.filter((f) => f.vacant).length / scene.footprints.length;

      expect(vacancyRate(lowScene)).toBeGreaterThan(vacancyRate(highScene));
      // Sanity: vacancy stays within the documented ceiling.
      expect(vacancyRate(lowScene)).toBeLessThanOrEqual(VACANCY_MAX_RATE + 1e-9);
    });
  });

  describe('zero-development hamlet (R9/R11 substrate)', () => {
    it('a zero-development record generates a minimal hamlet — a station square and a building or two — not an empty scene', () => {
      const hamlet = makeDistrict('dst-hamlet', station());
      const scene = generateDistrictScene(7, hamlet, ANCHOR);
      expect(scene.footprints.length).toBeGreaterThan(0);
      expect(scene.footprints.length).toBe(MIN_BUILDINGS);
      expect(scene.streets.length).toBeGreaterThan(0);
      expect(scene.stationSquare.x).toBe(ANCHOR.x);
      expect(scene.stationSquare.y).toBe(ANCHOR.y);
    });
  });
});
