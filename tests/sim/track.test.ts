import { describe, it, expect } from 'vitest';
import { createGameState, type GameState } from '../../src/sim/state.ts';
import {
  canLayTrack,
  layTrack,
  buildStation,
  inCatchment,
  industriesInCatchment,
  TRACK_COST_PER_SEGMENT,
  STATION_COST,
  effectiveGrade,
  gradeWeightMultiplier,
  segmentWeight,
  GRADE_WEIGHT_FACTOR,
  stationTypeOf,
  DEFAULT_STATION_TYPE,
  type TrackSegment,
  type StationType,
} from '../../src/sim/model/track.ts';
import { CUTTING_MAX_GRADE } from '../../src/sim/model/trackCost.ts';
import { moveCostFor, terrainAt } from '../../src/world/geography.ts';
import { makeIndustry } from '../../src/sim/model/industries.ts';
import { makeCity } from '../../src/sim/model/cities.ts';

// Local factory: a small buildable world. U2 replaced the box-derived terrain
// model with continuous field classification (`geography.ts`), and U3
// removed the stored `World.terrain` array entirely — `terrainAt(x, y)`
// (real, authored geography) is the only source of terrain now, so these
// tests can no longer hand-set every tile to a chosen type. Instead they
// anchor at (OX, OY), a 10x10 coordinate block verified (empirically, against
// the actual reference field/seed) to be entirely sea-free, rather than the
// tile origin (which is open Atlantic and would classify as sea).
const OX = 19;
const OY = 0;

function buildableWorld(w: number, h: number): GameState {
  const s = createGameState(1);
  s.world = { width: OX + w, height: OY + h };
  s.moneyCents = 1_000_000_00;
  return s;
}

describe('track building', () => {
  it('connects adjacent tiles and rejects non-adjacent or same tile', () => {
    const s = buildableWorld(5, 5);
    expect(canLayTrack(s, OX + 1, OY + 1, OX + 2, OY + 1)).toBe(true); // adjacent
    expect(canLayTrack(s, OX + 1, OY + 1, OX + 1, OY + 1)).toBe(false); // same tile
    expect(canLayTrack(s, OX + 1, OY + 1, OX + 4, OY + 1)).toBe(false); // too far
  });

  it('laying track deducts an integer cost', () => {
    const s = buildableWorld(4, 4);
    const before = s.moneyCents;
    const ok = layTrack(s, OX, OY, OX + 1, OY);
    expect(ok).toBe(true);
    expect(s.moneyCents).toBe(before - TRACK_COST_PER_SEGMENT);
    expect(Number.isInteger(s.moneyCents)).toBe(true);
    expect(s.track.segments).toHaveLength(1);
  });

  it('cannot build over sea', () => {
    const s = buildableWorld(3, 1);
    // x=0 (lon -11) sits west of every authored landmass box at any
    // latitude — always sea, regardless of the (OX, OY) buildable anchor
    // used elsewhere in this file.
    expect(buildStation(s, 'sea-stn', 0, OY, 2)).toBe(false);
  });

  it('catchment includes tiles within radius and excludes beyond', () => {
    const station = { id: 's', x: 10, y: 10, radius: 2 };
    expect(inCatchment(station, 10, 10)).toBe(true);
    expect(inCatchment(station, 12, 8)).toBe(true); // Chebyshev distance 2
    expect(inCatchment(station, 13, 10)).toBe(false); // distance 3
  });

  it('reports industries inside a station catchment', () => {
    const s = buildableWorld(10, 10);
    s.cities.push(makeCity('london', 'London', OX + 5, OY + 5));
    s.industries.push(makeIndustry('near', 'coalMine', OX + 6, OY + 5));
    buildStation(s, 'london-stn', OX + 5, OY + 5, 2);
    const station = s.stations.find((st) => st.id === 'london-stn')!;
    const found = industriesInCatchment(s, station).map((i) => i.id);
    expect(found).toContain('near');
  });
});

describe('station type (milestone 5 U1, R4/R6, KTD3)', () => {
  it('buildStation defaults to the mixed type when none is given', () => {
    const s = buildableWorld(4, 4);
    buildStation(s, 'stn-0', OX, OY, 2);
    expect(s.stations[0].stationType).toBe('mixed');
    expect(s.stations[0].stationType).toBe(DEFAULT_STATION_TYPE);
  });

  it('storing each type end to end: buildStation stores exactly the type it was given', () => {
    const types: StationType[] = ['freight', 'passenger', 'mixed'];
    const s = buildableWorld(10, 10);
    types.forEach((stationType, i) => {
      buildStation(s, `stn-${i}`, OX + i, OY, 1, stationType);
    });
    expect(s.stations.map((st) => st.stationType)).toEqual(types);
  });

  it('type round-trips through JSON serialization unchanged', () => {
    const s = buildableWorld(4, 4);
    buildStation(s, 'stn-0', OX, OY, 2, 'freight');
    const round = JSON.parse(JSON.stringify(s.stations[0])) as { stationType: StationType };
    expect(round.stationType).toBe('freight');
  });

  it("radius and cost are unaffected by type (independent-axes guard, KTD3)", () => {
    const types: StationType[] = ['freight', 'passenger', 'mixed'];
    for (const stationType of types) {
      const s = buildableWorld(4, 4);
      const before = s.moneyCents;
      buildStation(s, 'stn', OX, OY, 3, stationType);
      expect(before - s.moneyCents).toBe(STATION_COST[2]);
      expect(s.stations[0].radius).toBe(3);
    }
  });

  it('stationTypeOf falls back to the default for a station with no stored type (pre-M5 fixture compatibility)', () => {
    const untyped = { id: 's', x: 0, y: 0, radius: 1 };
    expect(stationTypeOf(untyped)).toBe(DEFAULT_STATION_TYPE);
    const typed = { id: 's', x: 0, y: 0, radius: 1, stationType: 'freight' as const };
    expect(stationTypeOf(typed)).toBe('freight');
  });
});

describe('effectiveGrade and grade-aware segmentWeight (milestone 3 U5, KTD4/KTD5/KTD8, R11)', () => {
  // Real, non-sea adjacent pairs at the DEFAULT_TERRAIN_SEED fallback (this
  // file never calls configureTerrainSeed, same convention as OX/OY above):
  // a near-flat pair and a steep one (grade > MAX_UNASSISTED_GRADE), both
  // empirically verified against the actual reference field.
  const FLAT: TrackSegment = { ax: 17, ay: 0, bx: 18, by: 0 };
  const STEEP: TrackSegment = { ax: 18, ay: 10, bx: 19, by: 10 };

  it('a plain (no-structure) segment has effectiveGrade equal to its raw |Δelevation| / distance', () => {
    expect(effectiveGrade(FLAT)).toBeGreaterThan(0);
    expect(effectiveGrade(STEEP)).toBeGreaterThan(effectiveGrade(FLAT));
  });

  it('a bridge or tunnel caps effectiveGrade to 0; a cutting caps it to CUTTING_MAX_GRADE', () => {
    const rawSteepGrade = effectiveGrade(STEEP);
    expect(rawSteepGrade).toBeGreaterThan(CUTTING_MAX_GRADE);

    expect(effectiveGrade({ ...STEEP, structure: 'bridge' })).toBe(0);
    expect(effectiveGrade({ ...STEEP, structure: 'tunnel' })).toBe(0);
    expect(effectiveGrade({ ...STEEP, structure: 'cutting' })).toBe(CUTTING_MAX_GRADE);
  });

  it('gradeWeightMultiplier: 1 at zero grade, and a parameterized factor of 0 collapses to exactly 1 regardless of grade (regression guard)', () => {
    expect(gradeWeightMultiplier(0)).toBe(1);
    expect(gradeWeightMultiplier(effectiveGrade(STEEP), 0)).toBe(1);
    expect(gradeWeightMultiplier(effectiveGrade(STEEP))).toBe(1 + GRADE_WEIGHT_FACTOR * effectiveGrade(STEEP));
  });

  it('a tunneled segment weighs exactly what the pre-grade formula would give (grade fully neutralized); a cutting weighs strictly between raw-grade and tunneled', () => {
    const raw = segmentWeight({ width: 0, height: 0 }, STEEP); // no structure: full raw grade applies
    const cutting = segmentWeight({ width: 0, height: 0 }, { ...STEEP, structure: 'cutting' });
    const tunnel = segmentWeight({ width: 0, height: 0 }, { ...STEEP, structure: 'tunnel' });

    // The pre-grade (milestone-2) formula: dist * average terrain move cost,
    // with no grade multiplier at all.
    const preGradeWeight = tunnel; // tunnel's effectiveGrade is 0, multiplier collapses to 1
    expect(gradeWeightMultiplier(effectiveGrade({ ...STEEP, structure: 'tunnel' }))).toBe(1);

    expect(tunnel).toBeLessThan(cutting);
    expect(cutting).toBeLessThan(raw);
    expect(tunnel).toBe(preGradeWeight);
  });

  it('a tunneled (zero-grade) segment equals the exact pre-milestone-3 formula, hand-reconstructed from moveCostFor/terrainAt', () => {
    // Direct regression guard (parameterized via tunneling, since real
    // terrain offers no guaranteed zero-grade pair): the pre-grade formula
    // was dist * average(moveCostFor(terrainAt(a)), moveCostFor(terrainAt(b)))
    // with no multiplier at all — reconstruct it independently of
    // segmentWeight's own implementation and compare.
    const tunneled: TrackSegment = { ...STEEP, structure: 'tunnel' };
    const dist = Math.hypot(STEEP.ax - STEEP.bx, STEEP.ay - STEEP.by);
    const a = moveCostFor(terrainAt(STEEP.ax, STEEP.ay));
    const b = moveCostFor(terrainAt(STEEP.bx, STEEP.by));
    const preGradeFormula = dist * ((a + b) / 2);
    expect(segmentWeight({ width: 0, height: 0 }, tunneled)).toBeCloseTo(preGradeFormula, 9);
  });
});
