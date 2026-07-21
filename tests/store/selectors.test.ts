import { describe, it, expect } from 'vitest';
import {
  cityDemand,
  playerCash,
  routeFeePreview,
  trainSummaries,
  trainStatus,
  routeGaps,
  industryStarved,
  industryOutputPressure,
} from '../../src/store/selectors.ts';
import { createGameState, type GameState } from '../../src/sim/state.ts';
import { makeCity } from '../../src/sim/model/cities.ts';
import { makeTrain } from '../../src/sim/model/trains.ts';
import { makeIndustry } from '../../src/sim/model/industries.ts';
import { OUTPUT_CAP } from '../../src/sim/systems/production.ts';

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

describe('industry read-model selectors (U6)', () => {
  it('flags a processor as starved when an input is below the recipe requirement', () => {
    const mill = makeIndustry('mill', 'steelMill', 4, 4); // needs iron: 2, coal: 2 per cycle
    mill.inputStock = { iron: 1, coal: 5 };
    expect(industryStarved(mill)).toBe(true);
  });

  it('does not flag a processor as starved once every input is sufficient', () => {
    const mill = makeIndustry('mill', 'steelMill', 4, 4);
    mill.inputStock = { iron: 2, coal: 2 };
    expect(industryStarved(mill)).toBe(false);
  });

  it('never flags a raw extractor as starved, since it has no recipe inputs', () => {
    const mine = makeIndustry('mine', 'coalMine', 1, 1);
    expect(industryStarved(mine)).toBe(false);
  });

  it('reports output pressure as 0 for an empty stockpile and its maximum exactly at OUTPUT_CAP', () => {
    const mine = makeIndustry('mine', 'coalMine', 1, 1);
    expect(industryOutputPressure(mine)).toBe(0);
    mine.outputStock = OUTPUT_CAP;
    expect(industryOutputPressure(mine)).toBe(1);
    mine.outputStock = OUTPUT_CAP / 2;
    expect(industryOutputPressure(mine)).toBeCloseTo(0.5, 5);
  });

  it('clamps output pressure to 1 even if stock somehow exceeds the cap', () => {
    const mine = makeIndustry('mine', 'coalMine', 1, 1);
    mine.outputStock = OUTPUT_CAP + 10;
    expect(industryOutputPressure(mine)).toBe(1);
  });
});

describe('connectivity feedback (the stuck-train fix)', () => {
  // U3: terrain is no longer a stored array a fixture can fill with a
  // uniform placeholder — it comes from `terrainAt(x, y)` (real, authored
  // geography). Anchor at a coordinate range verified never to be sea (see
  // tests/sim/movement.test.ts's LINE_OX/LINE_OY) rather than the tile
  // origin (open Atlantic).
  const OX = 17;
  const OY = 0;

  function twoStations(connected: boolean): GameState {
    const s = createGameState(1);
    s.world = { width: OX + 6, height: OY + 1 };
    s.stations.push({ id: 'A', x: OX, y: OY, radius: 1 });
    s.stations.push({ id: 'B', x: OX + 3, y: OY, radius: 1 });
    if (connected) for (let x = 0; x < 3; x++) s.track.segments.push({ ax: OX + x, ay: OY, bx: OX + x + 1, by: OY });
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
    t1.x = OX;
    t1.y = OY;
    t1.targetIndex = 1; // heading to B, which has no track
    disc.trains.push(t1);
    expect(trainStatus(disc, t1)).toBe('idle — no track to next stop');

    const conn = twoStations(true);
    const t2 = makeTrain('t', 'planet', [
      { stationId: 'A', loads: [], unload: true },
      { stationId: 'B', loads: [], unload: true },
    ]);
    t2.initialized = true;
    t2.x = OX;
    t2.y = OY;
    t2.targetIndex = 1;
    conn.trains.push(t2);
    expect(trainStatus(conn, t2)).toBe('running');
  });
});
