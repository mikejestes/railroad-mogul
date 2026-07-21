import { describe, it, expect } from 'vitest';
import { applyIntent, ensureDistrict } from '../../src/store/applyIntents.ts';
import { createGameState, serialize, type GameState } from '../../src/sim/state.ts';
import { findPath } from '../../src/sim/pathfinding.ts';
import type { Intent } from '../../src/store/gameStore.ts';

describe('applyIntent exhaustiveness (U3)', () => {
  it('throws rather than silently doing nothing on an unrecognized intent kind', () => {
    const state = createGameState(1);
    const bogus = { kind: 'doSomethingUnplanned' } as unknown as Intent;
    expect(() => applyIntent(state, bogus)).toThrow();
  });
});

<<<<<<< HEAD
describe('commitRoute intent (milestone 3 U4, R4/R5/R9/R10/R12, KTD2)', () => {
  // Anchored at (17,0)..(19,0) — the same flat, real, non-sea plains run
  // (DEFAULT_TERRAIN_SEED fallback) tests/sim/track.test.ts and
  // tests/sim/movement.test.ts's LINE_OX/LINE_OY neighborhood already rely
  // on; no structure applies to this stretch (verified against
  // tests/sim/trackCost.test.ts's own flat-plains fixture at the same seed).
  const OX = 17;
  const OY = 0;

  function buildableWorld(): GameState {
    const s = createGameState(1);
    s.world = { width: OX + 4, height: OY + 2 };
    s.moneyCents = 1_000_000_00;
    return s;
  }

  function commitSpur(): Intent {
    return { kind: 'commitRoute', waypoints: [{ x: OX, y: OY }, { x: OX + 2, y: OY }] };
  }

  it('debits exactly the surveyed totalCents, appends path.length - 1 segments, and records one route with the next serial id', () => {
    const s = buildableWorld();
    const before = s.moneyCents;

    applyIntent(s, commitSpur());

    expect(s.routes).toHaveLength(1);
    const route = s.routes[0];
    expect(route.id).toBe('route-0');
    expect(s.nextRouteId).toBe(1);
    expect(s.track.segments).toHaveLength(route.path.length - 1);
    expect(before - s.moneyCents).toBe(route.costCents);
    expect(Number.isInteger(s.moneyCents)).toBe(true);
  });

  it('insufficient funds leaves state byte-identical (no partial build)', () => {
    const s = buildableWorld();
    s.moneyCents = 0;
    const before = serialize(s);

    applyIntent(s, commitSpur());

    expect(serialize(s)).toBe(before);
    expect(s.routes).toHaveLength(0);
    expect(s.track.segments).toHaveLength(0);
  });

  it('a commitRoute with a sea waypoint is a no-op, independent of the UI', () => {
    const s = buildableWorld();
    const before = serialize(s);
    // x=0 sits west of every authored landmass box at any latitude — always
    // sea (see tests/sim/track.test.ts).
    applyIntent(s, { kind: 'commitRoute', waypoints: [{ x: 0, y: OY }, { x: OX, y: OY }] });

    expect(serialize(s)).toBe(before);
    expect(s.routes).toHaveLength(0);
  });

  it('trains pathfind across a committed route exactly as across hand-laid track (R12)', () => {
    const s = buildableWorld();
    applyIntent(s, commitSpur());
    const route = s.routes[0];
    const start = route.path[0];
    const end = route.path[route.path.length - 1];
    const path = findPath(s, start.x, start.y, end.x, end.y);
    expect(path).not.toBeNull();
    expect(path![0]).toEqual(start);
    expect(path![path!.length - 1]).toEqual(end);
  });
});

describe('district creation on station build (M4 U2, KTD10, R1, R3, R14)', () => {
  // A tile verified elsewhere in the suite (tests/sim/movement.test.ts) never
  // to be sea, since terrain is real authored geography, not a stored array.
  const OX = 17;
  const OY = 0;

  it('building a station creates exactly one district anchored at the station tile, with the next serial id', () => {
    const state = createGameState(1);
    state.world = { width: OX + 6, height: OY + 1 };
    state.moneyCents = 10_000_00;
    applyIntent(state, { kind: 'buildStation', x: OX, y: OY, radius: 1 });

    expect(state.districts).toHaveLength(1);
    const [district] = state.districts;
    expect(district.id).toBe('dst-0');
    expect(district.stationId).toBe(state.stations[0].id);
    expect(district.anchorX).toBe(OX);
    expect(district.anchorY).toBe(OY);
    expect(state.nextDistrictId).toBe(1);
  });

  it('a failed station build (sea tile) creates no district and does not advance the district counter', () => {
    const state = createGameState(1);
    // Large enough world that (0, 0) is in-bounds but still open Atlantic
    // (see movement.test.ts's LINE_OX/LINE_OY note) rather than failing the
    // build for the unrelated reason of being out of grid bounds.
    state.world = { width: 40, height: 28 };
    state.moneyCents = 10_000_00;
    applyIntent(state, { kind: 'buildStation', x: 0, y: 0, radius: 1 });
    expect(state.stations).toHaveLength(0);
    expect(state.districts).toHaveLength(0);
    expect(state.nextDistrictId).toBe(0);
  });

  it('a failed station build (unaffordable) creates no district and does not advance the district counter', () => {
    const state = createGameState(1);
    state.world = { width: OX + 6, height: OY + 1 };
    state.moneyCents = 0;
    applyIntent(state, { kind: 'buildStation', x: OX, y: OY, radius: 1 });
    expect(state.stations).toHaveLength(0);
    expect(state.districts).toHaveLength(0);
    expect(state.nextDistrictId).toBe(0);
  });

  it('building several stations creates a district per station with serially increasing ids', () => {
    const state = createGameState(1);
    state.world = { width: OX + 6, height: OY + 1 };
    state.moneyCents = 10_000_00;
    applyIntent(state, { kind: 'buildStation', x: OX, y: OY, radius: 1 });
    applyIntent(state, { kind: 'buildStation', x: OX + 3, y: OY, radius: 1 });
    expect(state.districts.map((d) => d.id)).toEqual(['dst-0', 'dst-1']);
    expect(state.districts.map((d) => d.stationId)).toEqual(state.stations.map((s) => s.id));
  });

  it('ensureDistrict is a no-op for a station id that already has a district', () => {
    const state = createGameState(1);
    const station = { id: 'stn-x', x: OX, y: OY, radius: 1 };
    ensureDistrict(state, station);
    ensureDistrict(state, station);
    expect(state.districts).toHaveLength(1);
    expect(state.nextDistrictId).toBe(1);
  });

  it('two runs from the same seed and intent log produce identical district arrays by serialization', () => {
    const run = () => {
      const state = createGameState(9);
      state.world = { width: OX + 6, height: OY + 1 };
      state.moneyCents = 10_000_00;
      applyIntent(state, { kind: 'buildStation', x: OX, y: OY, radius: 1 });
      applyIntent(state, { kind: 'buildStation', x: OX + 3, y: OY, radius: 1 });
      return state;
    };
    expect(serialize(run())).toBe(serialize(run()));
  });
});
