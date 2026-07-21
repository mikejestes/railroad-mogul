import { describe, it, expect } from 'vitest';
import { createGameState, type GameState } from '../../src/sim/state.ts';
import {
  canLayTrack,
  layTrack,
  buildStation,
  inCatchment,
  industriesInCatchment,
  TRACK_COST_PER_SEGMENT,
} from '../../src/sim/model/track.ts';
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
