import { describe, it, expect } from 'vitest';
import {
  generateDistrictScene,
  quantizeDistrict,
  buildingCountFor,
  extentTilesFor,
  cutsToSceneSpace,
  parcelInVacuum,
  QUANTUM,
  MIN_BUILDINGS,
  MAX_BUILDINGS,
  MAX_EXTENT_TILES,
  VACANCY_MAX_RATE,
  SEVERANCE_SCENE_RADIUS_FRAC,
  type DistrictScene,
} from '../../src/world/streets.ts';
import {
  makeDistrict,
  districtHealth,
  DISTRICT_FOOTPRINT_TILES,
  TRACK_CUT_STRENGTH,
  type District,
} from '../../src/sim/model/districts.ts';
import { createGameState, type GameState } from '../../src/sim/state.ts';

// Local factory, per repo test convention.
function station(id = 'stn-0', x = 5, y = 5) {
  return { id, x, y };
}

const ANCHOR = { x: 5, y: 5 };

/** Milestone 5 U6: `generateDistrictScene` now samples `landValueAt`, which
 *  reads `state.districts`/`state.stations` — so every call site needs a
 *  state with `d` actually present, matching how every real caller
 *  (`districtRenderer.ts`, `dev/debugHook.ts`) already has it. */
function stateWith(d: District): GameState {
  const s = createGameState(1);
  s.districts = [d];
  return s;
}

describe('street scene generation (M4 U6, KTD8)', () => {
  it('the same (seed, district, anchor) always generates a deep-equal scene', () => {
    const d = makeDistrict('dst-0', station());
    d.development = 0.5;
    d.residential = 0.3;
    d.commercial = 0.2;
    d.industrial = 0.1;
    d.density = 0.4;

    const a = generateDistrictScene(7, d, ANCHOR, stateWith(d));
    const b = generateDistrictScene(7, d, ANCHOR, stateWith(d));
    expect(a).toEqual(b);
  });

  it('a different district id generates a different scene', () => {
    const dA = makeDistrict('dst-a', station());
    dA.development = 0.5;
    const dB = makeDistrict('dst-b', station());
    dB.development = 0.5;

    const sceneA = generateDistrictScene(7, dA, ANCHOR, stateWith(dA));
    const sceneB = generateDistrictScene(7, dB, ANCHOR, stateWith(dB));
    expect(sceneA.footprints).not.toEqual(sceneB.footprints);
  });

  it('a different seed generates a different scene for the same district', () => {
    const d = makeDistrict('dst-0', station());
    d.development = 0.5;

    const sceneA = generateDistrictScene(7, d, ANCHOR, stateWith(d));
    const sceneB = generateDistrictScene(99, d, ANCHOR, stateWith(d));
    expect(sceneA.footprints).not.toEqual(sceneB.footprints);
  });

  describe('quantization stability (KTD8)', () => {
    it('a sub-quantum record change generates an identical scene', () => {
      const base = makeDistrict('dst-0', station());
      base.development = 0.5; // safely mid-quantum, away from a 1/16 boundary
      const nudged: District = { ...base, development: base.development + 0.001 };

      // Confirm the nudge really is sub-quantum before asserting on it.
      expect(quantizeDistrict(base).development).toBe(quantizeDistrict(nudged).development);

      expect(generateDistrictScene(7, base, ANCHOR, stateWith(base))).toEqual(generateDistrictScene(7, nudged, ANCHOR, stateWith(nudged)));
    });

    it('crossing a quantum boundary changes the scene', () => {
      const base = makeDistrict('dst-0', station());
      base.development = 0.5;
      const acrossBoundary: District = { ...base, development: base.development + QUANTUM };

      expect(quantizeDistrict(base).development).not.toBe(quantizeDistrict(acrossBoundary).development);
      expect(generateDistrictScene(7, base, ANCHOR, stateWith(base))).not.toEqual(generateDistrictScene(7, acrossBoundary, ANCHOR, stateWith(acrossBoundary)));
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

      const industrialScene = generateDistrictScene(7, industrial, ANCHOR, stateWith(industrial));
      const residentialScene = generateDistrictScene(7, residential, ANCHOR, stateWith(residential));

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
      const scene = generateDistrictScene(7, maxed, ANCHOR, stateWith(maxed));
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

      const lowScene = generateDistrictScene(7, lowHealth, ANCHOR, stateWith(lowHealth));
      const highScene = generateDistrictScene(7, highHealth, ANCHOR, stateWith(highHealth));
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
      const scene = generateDistrictScene(7, hamlet, ANCHOR, stateWith(hamlet));
      expect(scene.footprints.length).toBeGreaterThan(0);
      expect(scene.footprints.length).toBe(MIN_BUILDINGS);
      expect(scene.streets.length).toBeGreaterThan(0);
      expect(scene.stationSquare.x).toBe(ANCHOR.x);
      expect(scene.stationSquare.y).toBe(ANCHOR.y);
    });
  });
});

describe('cutsToSceneSpace and parcelInVacuum (milestone 5 U4, R7/R8/R10, KTD10)', () => {
  it('a cut through the anchor rescales to the scene origin; a cut at the footprint edge rescales to the scene edge', () => {
    const extent = 0.8;
    const [throughAnchor] = cutsToSceneSpace(
      [{ ax: ANCHOR.x, ay: ANCHOR.y, bx: ANCHOR.x, by: ANCHOR.y, strength: 1 }],
      ANCHOR,
      extent,
    );
    expect(throughAnchor.ax).toBeCloseTo(0, 9);
    expect(throughAnchor.ay).toBeCloseTo(0, 9);

    const [atEdge] = cutsToSceneSpace(
      [{ ax: ANCHOR.x + DISTRICT_FOOTPRINT_TILES, ay: ANCHOR.y, bx: ANCHOR.x + DISTRICT_FOOTPRINT_TILES, by: ANCHOR.y, strength: 1 }],
      ANCHOR,
      extent,
    );
    expect(atEdge.ax).toBeCloseTo(extent, 9);
  });

  it('parcelInVacuum is true within the band radius of a chord and false well outside it', () => {
    const sceneCuts = [{ ax: -1, ay: 0, bx: 1, by: 0 }];
    expect(parcelInVacuum(0, 0, sceneCuts, 0.1)).toBe(true); // on the chord itself
    expect(parcelInVacuum(0, 0.05, sceneCuts, 0.1)).toBe(true); // within the band
    expect(parcelInVacuum(0, 5, sceneCuts, 0.1)).toBe(false); // far outside
  });
});

describe('severance conditions the scene (milestone 5 U4, R7/R8/R10, KTD10)', () => {
  it('every parcel the vacuum-band predicate marks near a through-the-anchor cut is forced vacant with heightClass 0', () => {
    const developed: District = {
      ...makeDistrict('dst-cut', station()),
      residential: 0.4,
      commercial: 0.35,
      industrial: 0.3,
      density: 0.6,
      development: 0.7,
      episodeCount: 20,
      firstGrowthDay: 0,
      lastGrowthDay: 700,
    };
    // A real approach line through the anchor (R7: "the track approaching
    // it"), not a degenerate point — it needs to reach out to where
    // buildings actually cluster (block radii floor at 0.35 * extent,
    // `blockCountFor`/the placement loop above) to have anything to sever.
    const cut: District = {
      ...developed,
      cuts: [{ ax: ANCHOR.x - 3, ay: ANCHOR.y, bx: ANCHOR.x + 3, by: ANCHOR.y, strength: TRACK_CUT_STRENGTH }],
    };
    const cutScene = generateDistrictScene(7, cut, ANCHOR, stateWith(cut));

    const extent = extentTilesFor(quantizeDistrict(developed).development);
    const sceneCuts = cutsToSceneSpace(cut.cuts, ANCHOR, extent);
    const radius = extent * SEVERANCE_SCENE_RADIUS_FRAC;

    let severedCount = 0;
    for (const f of cutScene.footprints) {
      const bx = f.rect.x + f.rect.width / 2 - ANCHOR.x;
      const by = f.rect.y + f.rect.height / 2 - ANCHOR.y;
      if (parcelInVacuum(bx, by, sceneCuts, radius)) {
        severedCount++;
        expect(f.vacant).toBe(true);
        expect(f.heightClass).toBe(0);
      }
    }
    // A cut through the anchor, in a district with several parcels
    // clustered near it, severs at least one.
    expect(severedCount).toBeGreaterThan(0);
  });

  it('a cut recorded far outside the footprint (severancePenalty 0, rescaled far from every parcel) leaves the scene byte-identical to the uncut district', () => {
    const base: District = { ...makeDistrict('dst-far', station()), development: 0.6, residential: 0.4, commercial: 0.3, industrial: 0.3 };
    const uncutScene = generateDistrictScene(7, base, ANCHOR, stateWith(base));

    // Far enough beyond DISTRICT_FOOTPRINT_TILES that severancePenalty's own
    // centrality term clamps to 0 (no health effect) AND cutsToSceneSpace's
    // proportional rescaling places it nowhere near any parcel's stylized
    // position (parcels never range further than `extent` from the anchor).
    const FAR = DISTRICT_FOOTPRINT_TILES * 50;
    const farCut: District = {
      ...base,
      cuts: [{ ax: ANCHOR.x + FAR, ay: ANCHOR.y + FAR, bx: ANCHOR.x + FAR, by: ANCHOR.y + FAR, strength: TRACK_CUT_STRENGTH }],
    };
    expect(districtHealth(farCut)).toBe(districtHealth(base)); // severancePenalty clamped to 0

    const cutScene = generateDistrictScene(7, farCut, ANCHOR, stateWith(farCut));
    expect(cutScene).toEqual(uncutScene);
  });
});

describe('value-form coupling (milestone 5 U6, R3, KTD10)', () => {
  function radiusFracOf(f: DistrictScene['footprints'][number], extent: number): number {
    const bx = f.rect.x + f.rect.width / 2 - ANCHOR.x;
    const by = f.rect.y + f.rect.height / 2 - ANCHOR.y;
    return Math.min(1, Math.hypot(bx, by) / (extent || 1));
  }

  it('parcels near the station (high value) carry taller height classes than fringe parcels in the same scene', () => {
    const d: District = {
      ...makeDistrict('dst-rich', station()),
      development: 1,
      residential: 0.5,
      commercial: 0.5,
      industrial: 0.3,
      density: 0.2, // low density-driven base, so any height lift is attributable to value, not q.density
    };
    const s = stateWith(d);
    s.stations.push({ id: d.stationId, x: ANCHOR.x, y: ANCHOR.y, radius: 3 });
    const scene = generateDistrictScene(7, d, ANCHOR, s);
    const extent = extentTilesFor(quantizeDistrict(d).development);

    const withFrac = scene.footprints.filter((f) => !f.vacant).map((f) => ({ f, radiusFrac: radiusFracOf(f, extent) }));
    const near = withFrac.filter((x) => x.radiusFrac < 0.3);
    const far = withFrac.filter((x) => x.radiusFrac > 0.7);
    expect(near.length).toBeGreaterThan(0);
    expect(far.length).toBeGreaterThan(0);

    const avgHeight = (xs: typeof near) => xs.reduce((sum, x) => sum + x.f.heightClass, 0) / xs.length;
    expect(avgHeight(near)).toBeGreaterThan(avgHeight(far));
  });

  it('a value change that crosses VALUE_QUANTUM_CENTS regenerates the scene; a sub-quantum change does not', () => {
    // `d` itself never changes across the three states below — only a
    // throwaway second district's cut (far from `d`'s own anchor, so it
    // never enters `d`'s own severance/vacuum-band story) perturbs the
    // *sampled value* at the scene's anchor. Any scene difference is then
    // attributable solely to value quantization, never to quantizeDistrict's
    // own (unrelated) channel quantization.
    const d: District = { ...makeDistrict('dst-q', station()), development: 0.5 };

    const perturb = (strength: number): District => ({
      ...makeDistrict('dst-perturb', { id: 'other-stn', x: 9999, y: 9999 }),
      cuts: [{ ax: ANCHOR.x, ay: ANCHOR.y, bx: ANCHOR.x, by: ANCHOR.y, strength }],
    });

    const baseScene = generateDistrictScene(7, d, ANCHOR, stateWith(d));

    const subQuantumState = stateWith(d);
    subQuantumState.districts.push(perturb(0.05)); // |Δcents| = 2000 < half the 5000 quantum window
    const subQuantumScene = generateDistrictScene(7, d, ANCHOR, subQuantumState);
    expect(subQuantumScene).toEqual(baseScene);

    const crossingState = stateWith(d);
    crossingState.districts.push(perturb(0.1)); // |Δcents| = 4000 > half the quantum window
    const crossingScene = generateDistrictScene(7, d, ANCHOR, crossingState);
    expect(crossingScene).not.toEqual(baseScene);
  });

  it('composes with severance: a high-value corridor crossed by a cut still renders the vacuum band (U4 local conditioning wins, KTD10)', () => {
    const d: District = {
      ...makeDistrict('dst-corridor', station()),
      development: 1,
      residential: 0.5,
      commercial: 0.5,
      industrial: 0.3,
      density: 0.2,
      // A real approach line through the anchor (see the U4 severance test
      // above for why a degenerate point chord wouldn't reach the block
      // ring where buildings actually cluster).
      cuts: [{ ax: ANCHOR.x - 3, ay: ANCHOR.y, bx: ANCHOR.x + 3, by: ANCHOR.y, strength: TRACK_CUT_STRENGTH }],
    };
    const s = stateWith(d);
    s.stations.push({ id: d.stationId, x: ANCHOR.x, y: ANCHOR.y, radius: 3 }); // high value everywhere nearby
    const scene = generateDistrictScene(7, d, ANCHOR, s);
    const extent = extentTilesFor(quantizeDistrict(d).development);
    const sceneCuts = cutsToSceneSpace(d.cuts, ANCHOR, extent);
    const radius = extent * SEVERANCE_SCENE_RADIUS_FRAC;

    let severedCount = 0;
    for (const f of scene.footprints) {
      const bx = f.rect.x + f.rect.width / 2 - ANCHOR.x;
      const by = f.rect.y + f.rect.height / 2 - ANCHOR.y;
      if (parcelInVacuum(bx, by, sceneCuts, radius)) {
        severedCount++;
        expect(f.vacant).toBe(true);
        expect(f.heightClass).toBe(0); // not lifted by the high-value corridor around it
      }
    }
    expect(severedCount).toBeGreaterThan(0);
  });
});
