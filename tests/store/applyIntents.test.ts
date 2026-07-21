import { describe, it, expect } from 'vitest';
import { applyIntent, ensureDistrict } from '../../src/store/applyIntents.ts';
import { createGameState, serialize, type GameState } from '../../src/sim/state.ts';
import { findPath } from '../../src/sim/pathfinding.ts';
import type { Intent } from '../../src/store/gameStore.ts';
import { STATION_COST } from '../../src/sim/model/track.ts';
import { DISTRICT_FOOTPRINT_TILES, accrueDelivery, jacobsHealth, activeDistrictFor } from '../../src/sim/model/districts.ts';

describe('applyIntent exhaustiveness (U3)', () => {
  it('throws rather than silently doing nothing on an unrecognized intent kind', () => {
    const state = createGameState(1);
    const bogus = { kind: 'doSomethingUnplanned' } as unknown as Intent;
    expect(() => applyIntent(state, bogus)).toThrow();
  });
});

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

describe('moveStation intent (milestone 5 U7, R11/R12/R13/R14, KTD8)', () => {
  // The same 10x10 sea-free block tests/sim/track.test.ts's own buildableWorld
  // anchors at — verified against the real reference field/seed, not a
  // stored terrain array.
  const OX = 19;
  const OY = 0;

  function buildableWorld(): GameState {
    const state = createGameState(1);
    state.world = { width: 40, height: 20 };
    state.moneyCents = 1_000_000_00;
    return state;
  }

  it('moving within the old district\'s footprint keeps the same single district served (no new district created)', () => {
    const state = buildableWorld();
    applyIntent(state, { kind: 'buildStation', x: OX, y: OY, radius: 2 });
    const station = state.stations[0];
    expect(3).toBeLessThanOrEqual(DISTRICT_FOOTPRINT_TILES); // sanity: the move below stays inside the footprint

    applyIntent(state, { kind: 'moveStation', stationId: station.id, x: OX + 3, y: OY });

    expect(state.districts).toHaveLength(1);
    expect(state.stations[0].x).toBe(OX + 3);
    expect(state.districts[0].stationId).toBe(station.id);
  });

  it('FIX regression: TWO successive within-footprint moves stay served by the same single district, with development preserved (AE5/R14)', () => {
    const state = buildableWorld();
    applyIntent(state, { kind: 'buildStation', x: OX, y: OY, radius: 2 });
    const stationId = state.stations[0].id;
    const district = state.districts[0];
    for (let i = 0; i < 30; i++) accrueDelivery(district, 'steel', 3, i);
    district.development = 0.6;
    const developmentBefore = district.development;
    const residentialBefore = district.residential;

    // First move: within the original footprint (anchor OX,OY; footprint
    // radius DISTRICT_FOOTPRINT_TILES) — no new district (already covered
    // above). This used to work even with the buggy anchor-equality lookup,
    // since the station had never moved before this call.
    applyIntent(state, { kind: 'moveStation', stationId, x: OX + 3, y: OY });
    expect(state.districts).toHaveLength(1);

    // Second move: still within the ORIGINAL district's footprint, but the
    // station's tile (OX+3, OY) no longer equals the district's anchor
    // (OX, OY) — the exact bug this test guards against. A raw
    // anchor-equality lookup against the station's *current* tile would
    // find no match here, wrongly minting a spurious dst-1 and orphaning
    // the real, developed district.
    applyIntent(state, { kind: 'moveStation', stationId, x: OX + 5, y: OY });

    expect(state.districts).toHaveLength(1); // still exactly one district
    expect(state.districts[0].id).toBe(district.id); // the same original record
    expect(state.districts[0].development).toBe(developmentBefore); // preserved
    expect(state.districts[0].residential).toBe(residentialBefore); // preserved
    expect(state.stations[0].x).toBe(OX + 5);
  });

  it('FIX regression: activeDistrictFor still returns the developed district after two within-footprint moves', () => {
    const state = buildableWorld();
    applyIntent(state, { kind: 'buildStation', x: OX, y: OY, radius: 2 });
    const stationId = state.stations[0].id;
    state.districts[0].development = 0.5;

    applyIntent(state, { kind: 'moveStation', stationId, x: OX + 3, y: OY });
    applyIntent(state, { kind: 'moveStation', stationId, x: OX + 5, y: OY });

    const active = activeDistrictFor(state, stationId);
    expect(active).toBeDefined();
    expect(active!.id).toBe(state.districts[0].id);
    expect(active!.development).toBe(0.5);
  });

  it('AE5: a developed district whose station moves within the footprint keeps its channels/development/growth history intact (jacobsHealth unchanged)', () => {
    const state = buildableWorld();
    applyIntent(state, { kind: 'buildStation', x: OX, y: OY, radius: 2 });
    const district = state.districts[0];
    for (let i = 0; i < 30; i++) accrueDelivery(district, 'steel', 3, i);
    district.development = 0.6;
    district.firstGrowthDay = 0;
    district.lastGrowthDay = 100;
    district.episodeCount = 10;
    const before = { ...district };
    const cutsCountBefore = district.cuts.length; // `before.cuts` aliases the same array — snapshot the count separately
    const jacobsHealthBefore = jacobsHealth(district);

    applyIntent(state, { kind: 'moveStation', stationId: state.stations[0].id, x: OX + 2, y: OY + 1 });

    expect(state.districts).toHaveLength(1); // no new district — still the same record
    expect(state.districts[0].residential).toBe(before.residential);
    expect(state.districts[0].commercial).toBe(before.commercial);
    expect(state.districts[0].industrial).toBe(before.industrial);
    expect(state.districts[0].density).toBe(before.density);
    expect(state.districts[0].development).toBe(before.development);
    // jacobsHealth (the four-generator mean, R14's "development survives")
    // is untouched by the move — but the relocated station's new footprint
    // is itself a fresh cut into the same district (R7/R12: infrastructure,
    // including a relocated station, severs; the player cannot undo a cut),
    // so districtHealth (which composes severance) may legitimately be
    // lower after the move even though nothing about growth history reset.
    expect(jacobsHealth(state.districts[0])).toBe(jacobsHealthBefore);
    expect(state.districts[0].cuts.length).toBeGreaterThan(cutsCountBefore);
  });

  it('moving beyond the old footprint leaves the old district record intact (unserved, per M4 decline) and ensures a new district at the new site', () => {
    const state = buildableWorld();
    applyIntent(state, { kind: 'buildStation', x: OX, y: OY, radius: 2 });
    const oldDistrictId = state.districts[0].id;
    const oldDistrictSnapshot = { ...state.districts[0] };
    const stationId = state.stations[0].id;

    const FAR = DISTRICT_FOOTPRINT_TILES + 2; // beyond DISTRICT_FOOTPRINT_TILES
    applyIntent(state, { kind: 'moveStation', stationId, x: OX + FAR, y: OY });

    expect(state.districts).toHaveLength(2);
    const old = state.districts.find((d) => d.id === oldDistrictId)!;
    expect(old).toEqual(oldDistrictSnapshot); // untouched — R14, development survives the move
    const fresh = state.districts.find((d) => d.id !== oldDistrictId)!;
    expect(fresh.stationId).toBe(stationId); // same station id, historical-attribution-safe
    expect(fresh.anchorX).toBe(OX + FAR);
    expect(fresh.anchorY).toBe(OY);
    expect(fresh.development).toBe(0); // a fresh hamlet, not carried over from the old one
  });

  it('cost is the full station cost with no refund; money changes by exactly that amount', () => {
    const state = buildableWorld();
    applyIntent(state, { kind: 'buildStation', x: OX, y: OY, radius: 3 });
    const beforeMoney = state.moneyCents;

    applyIntent(state, { kind: 'moveStation', stationId: state.stations[0].id, x: OX + 2, y: OY });

    expect(beforeMoney - state.moneyCents).toBe(STATION_COST[2]); // radius-3 cost
  });

  it('an unaffordable move is a no-op with state byte-identical', () => {
    const state = buildableWorld();
    applyIntent(state, { kind: 'buildStation', x: OX, y: OY, radius: 1 });
    state.moneyCents = 0;
    const before = serialize(state);

    applyIntent(state, { kind: 'moveStation', stationId: state.stations[0].id, x: OX + 2, y: OY });

    expect(serialize(state)).toBe(before);
  });

  it('a sea-tile move is a no-op with state byte-identical', () => {
    const state = buildableWorld();
    applyIntent(state, { kind: 'buildStation', x: OX, y: OY, radius: 1 });
    const before = serialize(state);

    applyIntent(state, { kind: 'moveStation', stationId: state.stations[0].id, x: 0, y: OY });

    expect(serialize(state)).toBe(before);
  });

  it('an unknown station id is a no-op', () => {
    const state = buildableWorld();
    applyIntent(state, { kind: 'buildStation', x: OX, y: OY, radius: 1 });
    const before = serialize(state);

    applyIntent(state, { kind: 'moveStation', stationId: 'ghost', x: OX + 2, y: OY });

    expect(serialize(state)).toBe(before);
  });

  it('replaying the same intent sequence (including a beyond-footprint move) from the same seed is byte-identical', () => {
    const run = () => {
      const state = buildableWorld();
      applyIntent(state, { kind: 'buildStation', x: OX, y: OY, radius: 2, stationType: 'freight' });
      const stationId = state.stations[0].id;
      applyIntent(state, { kind: 'moveStation', stationId, x: OX + DISTRICT_FOOTPRINT_TILES + 2, y: OY });
      return state;
    };
    expect(serialize(run())).toBe(serialize(run()));
  });
});
