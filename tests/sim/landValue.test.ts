import { describe, it, expect } from 'vitest';
import {
  landValueAt,
  LAND_VALUE_FLOOR,
  TERRAIN_BASE_CENTS,
  STATION_UPLIFT_BASE_CENTS,
  STATION_UPLIFT_DEV_BONUS_CENTS,
  DISTRICT_DEVELOPMENT_UPLIFT_CENTS,
  SEVERANCE_DEPRESSION_RADIUS_TILES,
  type LandValue,
} from '../../src/sim/model/landValue.ts';
import { createGameState, type GameState } from '../../src/sim/state.ts';
import { makeDistrict, TRACK_CUT_STRENGTH, STATION_CUT_STRENGTH } from '../../src/sim/model/districts.ts';
import { terrainAt } from '../../src/world/geography.ts';

// Anchored at (OX, OY) — the same 10x10 sea-free coordinate block
// tests/sim/track.test.ts relies on (real, authored geography; no stored
// terrain array to hand-fill).
const OX = 19;
const OY = 0;

function baseState(): GameState {
  const s = createGameState(1);
  s.world = { width: OX + 20, height: OY + 20 };
  return s;
}

function sumItems(lv: LandValue): number {
  return lv.items.reduce((sum, item) => sum + item.cents, 0);
}

describe('landValueAt (milestone 5 U5, R1/R2, KTD2)', () => {
  describe('itemization completeness (M6 R9 substrate)', () => {
    it('totalCents equals the sum of items everywhere — an unserved, uncut tile', () => {
      const s = baseState();
      const lv = landValueAt(s, OX, OY);
      expect(lv.totalCents).toBe(sumItems(lv));
    });

    it('totalCents equals the sum of items everywhere — a tile inside a station catchment and a developed district', () => {
      const s = baseState();
      s.stations.push({ id: 'stn', x: OX, y: OY, radius: 3 });
      const d = makeDistrict('dst', { id: 'stn', x: OX, y: OY });
      d.development = 0.8;
      s.districts.push(d);
      const lv = landValueAt(s, OX + 1, OY);
      expect(lv.totalCents).toBe(sumItems(lv));
    });

    it('totalCents equals the sum of items everywhere under stacked depressions (severance + floor)', () => {
      const s = baseState();
      s.stations.push({ id: 'stn', x: OX, y: OY, radius: 1 });
      const d = makeDistrict('dst', { id: 'stn', x: OX, y: OY });
      for (let i = 0; i < 20; i++) {
        d.cuts.push({ ax: OX, ay: OY, bx: OX + 1, by: OY, strength: STATION_CUT_STRENGTH * 5 });
      }
      s.districts.push(d);
      const lv = landValueAt(s, OX, OY);
      expect(lv.totalCents).toBe(sumItems(lv));
    });
  });

  describe('purity (determinism substrate)', () => {
    it('repeated queries, in any order, return identical results and never mutate state', () => {
      const s = baseState();
      s.stations.push({ id: 'stn', x: OX, y: OY, radius: 2 });
      s.districts.push(makeDistrict('dst', { id: 'stn', x: OX, y: OY }));
      const before = JSON.stringify(s);

      const a = landValueAt(s, OX, OY);
      landValueAt(s, OX + 1, OY); // an intervening query at a different coordinate
      const c = landValueAt(s, OX, OY); // same coordinate as `a`, queried after the one above

      expect(a).toEqual(c);
      expect(JSON.stringify(s)).toBe(before);
    });
  });

  describe('terrain base (R1)', () => {
    it('is a pure function of coordinates alone, matching TERRAIN_BASE_CENTS for the classified terrain', () => {
      const s = baseState();
      const terrain = terrainAt(OX, OY);
      const lv = landValueAt(s, OX, OY);
      const terrainItem = lv.items.find((i) => i.name === 'terrain-base');
      expect(terrainItem?.cents).toBe(TERRAIN_BASE_CENTS[terrain]);
    });
  });

  describe('AE1: siting creates value (R1, R2)', () => {
    it('siting a station raises land value at its own tile, monotonically less toward the catchment edge, and zero uplift beyond it', () => {
      const unserved = baseState();
      const unservedValue = landValueAt(unserved, OX, OY).totalCents;

      const served = baseState();
      served.stations.push({ id: 'stn', x: OX, y: OY, radius: 3 });
      served.districts.push(makeDistrict('dst', { id: 'stn', x: OX, y: OY }));

      const atStation = landValueAt(served, OX, OY).totalCents;
      const near = landValueAt(served, OX + 1, OY).totalCents;
      const edge = landValueAt(served, OX + 3, OY).totalCents;
      const beyond = landValueAt(served, OX + 4, OY).totalCents;

      expect(atStation).toBeGreaterThan(unservedValue);
      expect(atStation).toBeGreaterThan(near);
      expect(near).toBeGreaterThan(edge);
      // Beyond the catchment: no station-uplift item contribution — same as unserved.
      const beyondItems = landValueAt(served, OX + 4, OY).items;
      const beyondStationUplift = beyondItems.find((i) => i.name === 'station-uplift');
      expect(beyondStationUplift?.cents ?? 0).toBe(0);
      void beyond;
    });

    it('the station-uplift base term is present immediately at siting, before any district development', () => {
      const s = baseState();
      s.stations.push({ id: 'stn', x: OX, y: OY, radius: 2 });
      const d = makeDistrict('dst', { id: 'stn', x: OX, y: OY });
      expect(d.development).toBe(0);
      s.districts.push(d);
      const item = landValueAt(s, OX, OY).items.find((i) => i.name === 'station-uplift');
      expect(item?.cents).toBe(STATION_UPLIFT_BASE_CENTS);
    });

    it('a mature district contributes the additional development bonus on top of the base term', () => {
      const s = baseState();
      s.stations.push({ id: 'stn', x: OX, y: OY, radius: 2 });
      const d = makeDistrict('dst', { id: 'stn', x: OX, y: OY });
      d.development = 1;
      s.districts.push(d);
      const item = landValueAt(s, OX, OY).items.find((i) => i.name === 'station-uplift');
      expect(item?.cents).toBe(STATION_UPLIFT_BASE_CENTS + STATION_UPLIFT_DEV_BONUS_CENTS);
    });
  });

  describe('overlapping catchments compose additively (KTD2)', () => {
    it('a tile covered by two station catchments has a station-uplift item equal to the sum of each alone', () => {
      const s = baseState();
      s.stations.push({ id: 'a', x: OX, y: OY, radius: 3 });
      s.stations.push({ id: 'b', x: OX + 2, y: OY, radius: 3 });
      s.districts.push(makeDistrict('dst-a', { id: 'a', x: OX, y: OY }));
      s.districts.push(makeDistrict('dst-b', { id: 'b', x: OX + 2, y: OY }));

      const soloA = baseState();
      soloA.stations.push({ id: 'a', x: OX, y: OY, radius: 3 });
      soloA.districts.push(makeDistrict('dst-a', { id: 'a', x: OX, y: OY }));

      const soloB = baseState();
      soloB.stations.push({ id: 'b', x: OX + 2, y: OY, radius: 3 });
      soloB.districts.push(makeDistrict('dst-b', { id: 'b', x: OX + 2, y: OY }));

      const midpoint = OX + 1;
      const both = landValueAt(s, midpoint, OY).items.find((i) => i.name === 'station-uplift')!.cents;
      const onlyA = landValueAt(soloA, midpoint, OY).items.find((i) => i.name === 'station-uplift')!.cents;
      const onlyB = landValueAt(soloB, midpoint, OY).items.find((i) => i.name === 'station-uplift')!.cents;
      expect(both).toBe(onlyA + onlyB);
    });
  });

  describe('severance depresses value near a cut (R7 value-side)', () => {
    it('value near a cut is lower than the same coordinate without the cut, with falloff by distance', () => {
      // No station here deliberately — isolating severance's own
      // distance-falloff from station-uplift's competing falloff (a query
      // point can be simultaneously "closer to the cut" and "closer to the
      // station", which would confound this comparison).
      const uncut = baseState();
      const uncutValue = landValueAt(uncut, OX, OY).totalCents;

      const cutState = baseState();
      const d = makeDistrict('dst', { id: 'stn', x: OX, y: OY });
      d.cuts.push({ ax: OX, ay: OY, bx: OX + 1, by: OY, strength: TRACK_CUT_STRENGTH });
      cutState.districts.push(d);

      const atCut = landValueAt(cutState, OX, OY).totalCents;
      const near = landValueAt(cutState, OX, OY + 1).totalCents;
      const far = landValueAt(cutState, OX, OY + SEVERANCE_DEPRESSION_RADIUS_TILES + 5).totalCents;

      expect(atCut).toBeLessThan(uncutValue);
      expect(atCut).toBeLessThan(near); // falls off with distance from the cut
      expect(near).toBeLessThanOrEqual(far);
    });

    it('a severance item does not appear (contributes 0) far beyond SEVERANCE_DEPRESSION_RADIUS_TILES', () => {
      const s = baseState();
      const d = makeDistrict('dst', { id: 'stn', x: OX, y: OY });
      d.cuts.push({ ax: OX, ay: OY, bx: OX + 1, by: OY, strength: TRACK_CUT_STRENGTH });
      s.districts.push(d);
      const item = landValueAt(s, OX, OY + SEVERANCE_DEPRESSION_RADIUS_TILES + 10).items.find((i) => i.name === 'severance');
      expect(item?.cents).toBe(0);
    });

    it('a heavier-strength cut depresses more than a lighter one at the same distance', () => {
      const light = baseState();
      const dLight = makeDistrict('dst', { id: 'stn', x: OX, y: OY });
      dLight.cuts.push({ ax: OX, ay: OY, bx: OX + 1, by: OY, strength: TRACK_CUT_STRENGTH });
      light.districts.push(dLight);

      const heavy = baseState();
      const dHeavy = makeDistrict('dst', { id: 'stn', x: OX, y: OY });
      dHeavy.cuts.push({ ax: OX, ay: OY, bx: OX + 1, by: OY, strength: STATION_CUT_STRENGTH });
      heavy.districts.push(dHeavy);

      const lightItem = landValueAt(light, OX, OY).items.find((i) => i.name === 'severance')!.cents;
      const heavyItem = landValueAt(heavy, OX, OY).items.find((i) => i.name === 'severance')!.cents;
      expect(heavyItem).toBeLessThan(lightItem); // more negative
    });
  });

  describe('district-development uplift (R3 substrate)', () => {
    it('is zero for a fresh (zero-development) district and positive for a developed one, at the same coordinate', () => {
      const fresh = baseState();
      fresh.districts.push(makeDistrict('dst', { id: 'stn', x: OX, y: OY }));
      const freshItem = landValueAt(fresh, OX, OY).items.find((i) => i.name === 'district-development')!.cents;
      expect(freshItem).toBe(0);

      const developed = baseState();
      const d = makeDistrict('dst', { id: 'stn', x: OX, y: OY });
      d.development = 1;
      developed.districts.push(d);
      const developedItem = landValueAt(developed, OX, OY).items.find((i) => i.name === 'district-development')!.cents;
      expect(developedItem).toBe(DISTRICT_DEVELOPMENT_UPLIFT_CENTS);
    });
  });

  describe('the floor holds under stacked depressions (KTD2)', () => {
    it('totalCents never drops below LAND_VALUE_FLOOR, and a floor-adjustment item makes up exactly the difference when invoked', () => {
      const s = baseState();
      const d = makeDistrict('dst', { id: 'stn', x: OX, y: OY });
      // Pile on many heavy cuts at the same tile so the raw sum goes deeply negative.
      for (let i = 0; i < 50; i++) {
        d.cuts.push({ ax: OX + i * 0.001, ay: OY, bx: OX + i * 0.001 + 0.0001, by: OY, strength: STATION_CUT_STRENGTH * 10 });
      }
      s.districts.push(d);
      const lv = landValueAt(s, OX, OY);
      expect(lv.totalCents).toBeGreaterThanOrEqual(LAND_VALUE_FLOOR);
      expect(lv.totalCents).toBe(LAND_VALUE_FLOOR);
      const floorItem = lv.items.find((i) => i.name === 'floor-adjustment');
      expect(floorItem).toBeDefined();
      const rawSum = lv.items.filter((i) => i.name !== 'floor-adjustment').reduce((sum, i) => sum + i.cents, 0);
      expect(floorItem!.cents).toBe(lv.totalCents - rawSum);
      expect(lv.totalCents).toBe(sumItems(lv)); // itemization completeness still holds at the floor
    });

    it('no floor-adjustment item appears when the raw sum already clears the floor', () => {
      const s = baseState();
      const lv = landValueAt(s, OX, OY);
      expect(lv.items.find((i) => i.name === 'floor-adjustment')).toBeUndefined();
    });
  });

  describe('integer cents (repo money convention)', () => {
    it('every item and the total are integers', () => {
      const s = baseState();
      s.stations.push({ id: 'stn', x: OX, y: OY, radius: 2 });
      const d = makeDistrict('dst', { id: 'stn', x: OX, y: OY });
      d.development = 0.37;
      d.cuts.push({ ax: OX, ay: OY, bx: OX + 1, by: OY, strength: 1.3 });
      s.districts.push(d);
      const lv = landValueAt(s, OX, OY);
      expect(Number.isInteger(lv.totalCents)).toBe(true);
      for (const item of lv.items) expect(Number.isInteger(item.cents)).toBe(true);
    });
  });
});
