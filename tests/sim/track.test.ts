import { describe, it, expect } from 'vitest';
import { generateGame } from '../../src/world/generate.ts';
import {
  canLayTrack,
  layTrack,
  buildStation,
  inCatchment,
  industriesInCatchment,
  TRACK_COST_PER_SEGMENT,
} from '../../src/sim/model/track.ts';
import { makeIndustry } from '../../src/sim/model/industries.ts';

describe('track building', () => {
  it('connects adjacent tiles and rejects non-adjacent or same tile', () => {
    const s = generateGame(1);
    // Find a land tile with a land neighbour.
    const w = s.world;
    let ax = -1,
      ay = -1;
    for (let y = 1; y < w.height - 1 && ax < 0; y++) {
      for (let x = 1; x < w.width - 1; x++) {
        if (w.terrain[y * w.width + x] === 'land' && w.terrain[y * w.width + x + 1] === 'land') {
          ax = x;
          ay = y;
          break;
        }
      }
    }
    expect(ax).toBeGreaterThanOrEqual(0);
    expect(canLayTrack(s, ax, ay, ax + 1, ay)).toBe(true); // adjacent
    expect(canLayTrack(s, ax, ay, ax, ay)).toBe(false); // same tile
    expect(canLayTrack(s, ax, ay, ax + 3, ay)).toBe(false); // too far
  });

  it('laying track deducts an integer cost', () => {
    const s = generateGame(1);
    const before = s.moneyCents;
    // London -> east neighbour (forced land at city tile).
    const london = s.cities.find((c) => c.id === 'london')!;
    const ok = layTrack(s, london.x, london.y, london.x + 1, london.y);
    expect(ok).toBe(true);
    expect(s.moneyCents).toBe(before - TRACK_COST_PER_SEGMENT);
    expect(Number.isInteger(s.moneyCents)).toBe(true);
    expect(s.track.segments).toHaveLength(1);
  });

  it('cannot build over sea', () => {
    const s = generateGame(1);
    // Far south-west corner is sea in the coarse model.
    expect(buildStation(s, 'sea-stn', 0, s.world.height - 1, 2)).toBe(false);
  });

  it('catchment includes tiles within radius and excludes beyond', () => {
    const station = { id: 's', x: 10, y: 10, radius: 2 };
    expect(inCatchment(station, 10, 10)).toBe(true);
    expect(inCatchment(station, 12, 8)).toBe(true); // Chebyshev distance 2
    expect(inCatchment(station, 13, 10)).toBe(false); // distance 3
  });

  it('reports industries inside a station catchment', () => {
    const s = generateGame(1);
    const london = s.cities.find((c) => c.id === 'london')!;
    s.industries.push(makeIndustry('near', 'coalMine', london.x + 1, london.y));
    buildStation(s, 'london-stn', london.x, london.y, 2);
    const station = s.stations.find((st) => st.id === 'london-stn')!;
    const found = industriesInCatchment(s, station).map((i) => i.id);
    expect(found).toContain('near');
  });
});
