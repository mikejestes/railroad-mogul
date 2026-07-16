import { describe, it, expect } from 'vitest';
import { cityDemand, playerCash, routeFeePreview, trainSummaries, trainStatus, routeGaps } from '../../src/store/selectors.ts';
import { createGameState, type GameState } from '../../src/sim/state.ts';
import { makeCity } from '../../src/sim/model/cities.ts';
import { makeTrain } from '../../src/sim/model/trains.ts';

describe('read-model selectors (U9)', () => {
  it('reports a city\'s live demand, most-wanted first', () => {
    const s = createGameState(1);
    const city = makeCity('c', 'Testville', 5, 5, 1);
    city.backlog = { food: 5, goods: 20 };
    s.cities.push(city);
    const rows = cityDemand(s, 'c');
    expect(rows[0].good).toBe('goods'); // highest backlog first
    expect(rows.find((r) => r.good === 'food')!.backlog).toBe(5);
  });

  it('exposes player cash from integer cents', () => {
    const s = createGameState(1);
    s.moneyCents = 1_234_56;
    expect(playerCash(s)).toBeCloseTo(1234.56, 2);
  });

  it('previews a route fee consistent with the destination demand', () => {
    const s = createGameState(1);
    s.stations.push({ id: 'A', x: 0, y: 0, radius: 2 });
    s.stations.push({ id: 'B', x: 6, y: 0, radius: 2 });
    const city = makeCity('metro', 'Metro', 6, 0, 1);
    city.backlog = { food: 30 };
    s.cities.push(city);

    const demanded = routeFeePreview(s, 'food', 'A', 'B', 5);
    expect(demanded).toBeGreaterThan(0);

    // A good the destination doesn't demand previews at zero.
    const undemanded = routeFeePreview(s, 'steel', 'A', 'B', 5);
    expect(undemanded).toBe(0);
  });

  it('summarizes trains for the UI', () => {
    const s = createGameState(1);
    const t = makeTrain('t1', 'planet', [
      { stationId: 'A', loads: [], unload: true },
      { stationId: 'B', loads: [], unload: true },
    ]);
    t.cars.push({ good: 'coal', qty: 6, originX: 0, originY: 0, loadedDay: 0 });
    s.trains.push(t);
    const [summary] = trainSummaries(s);
    expect(summary.id).toBe('t1');
    expect(summary.cargoUnits).toBe(6);
  });
});

describe('connectivity feedback (the stuck-train fix)', () => {
  function twoStations(connected: boolean): GameState {
    const s = createGameState(1);
    s.world = { width: 6, height: 1, terrain: new Array(6).fill('land') };
    s.stations.push({ id: 'A', x: 0, y: 0, radius: 1 });
    s.stations.push({ id: 'B', x: 3, y: 0, radius: 1 });
    if (connected) for (let x = 0; x < 3; x++) s.track.segments.push({ ax: x, ay: 0, bx: x + 1, by: 0 });
    return s;
  }

  it('reports a route gap when stations are not joined by track', () => {
    expect(routeGaps(twoStations(false), ['A', 'B'])).toHaveLength(1);
    expect(routeGaps(twoStations(true), ['A', 'B'])).toHaveLength(0);
  });

  it('train status explains an idle train (no track) vs a running one', () => {
    const disc = twoStations(false);
    const t1 = makeTrain('t', 'planet', [
      { stationId: 'A', loads: [], unload: true },
      { stationId: 'B', loads: [], unload: true },
    ]);
    t1.initialized = true;
    t1.x = 0;
    t1.y = 0;
    t1.targetIndex = 1; // heading to B, which has no track
    disc.trains.push(t1);
    expect(trainStatus(disc, t1)).toBe('idle — no track to next stop');

    const conn = twoStations(true);
    const t2 = makeTrain('t', 'planet', [
      { stationId: 'A', loads: [], unload: true },
      { stationId: 'B', loads: [], unload: true },
    ]);
    t2.initialized = true;
    t2.x = 0;
    t2.y = 0;
    t2.targetIndex = 1;
    conn.trains.push(t2);
    expect(trainStatus(conn, t2)).toBe('running');
  });
});
