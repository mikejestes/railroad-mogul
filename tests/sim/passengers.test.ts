import { describe, it, expect } from 'vitest';
import { createGameState, STARTING_CAPITAL, type GameState } from '../../src/sim/state.ts';
import { tick } from '../../src/sim/tick.ts';
import { productionSystem, CITY_SUPPLY_CAP } from '../../src/sim/systems/production.ts';
import { makeCity } from '../../src/sim/model/cities.ts';
import { makeTrain } from '../../src/sim/model/trains.ts';

describe('passengers & mail', () => {
  it('cities generate passenger and mail supply from population, up to a cap', () => {
    const s = createGameState(1);
    const city = makeCity('c', 'C', 0, 0, 1);
    s.cities.push(city);
    tick(s, 1, [productionSystem]);
    expect(city.supply.passengers).toBeGreaterThan(0);
    expect(city.supply.mail).toBeGreaterThan(0);
    for (let i = 0; i < 100; i++) tick(s, 1, [productionSystem]);
    expect(city.supply.passengers!).toBeLessThanOrEqual(CITY_SUPPLY_CAP);
  });

  // U3: terrain is no longer a stored array a fixture can fill with a
  // uniform placeholder — it comes from `terrainAt(x, y)` (real, authored
  // geography). Anchor at a coordinate range verified never to be sea (see
  // tests/sim/movement.test.ts's LINE_OX/LINE_OY) rather than the tile
  // origin (open Atlantic).
  const OX = 17;
  const OY = 0;

  /** Two cities on a connected line, a train looping between them. */
  function twoCityLine(): GameState {
    const s = createGameState(1);
    s.moneyCents = STARTING_CAPITAL;
    s.world = { width: OX + 6, height: OY + 1 };
    s.stations.push({ id: 'A', x: OX, y: OY, radius: 1 });
    s.stations.push({ id: 'B', x: OX + 4, y: OY, radius: 1 });
    for (let x = 0; x < 4; x++) s.track.segments.push({ ax: OX + x, ay: OY, bx: OX + x + 1, by: OY });
    s.cities.push(makeCity('cityA', 'Aville', OX, OY, 1));
    s.cities.push(makeCity('cityB', 'Bville', OX + 4, OY, 1));
    s.trains.push(
      makeTrain('t', 'american', [
        { stationId: 'A', loads: ['passengers', 'mail'], unload: true },
        { stationId: 'B', loads: ['passengers', 'mail'], unload: true },
      ]),
    );
    return s;
  }

  it('a train hauls passengers/mail city-to-city and earns fees', () => {
    const s = twoCityLine();
    const before = s.moneyCents;
    for (let i = 0; i < 200; i++) tick(s);
    expect(s.moneyCents).toBeGreaterThan(before); // paid for passenger/mail delivery
    // Delivery drained some of the destination's passenger backlog.
    const totalPax = s.cities.reduce((n, c) => n + (c.fulfillment.passengers ?? 0), 0);
    expect(totalPax).toBeGreaterThan(0);
  });

  it('hauling only passengers/mail does not grow a city (freight still gates growth)', () => {
    const s = twoCityLine(); // no freight industries anywhere
    for (let i = 0; i < 400; i++) tick(s);
    expect(s.cities.every((c) => c.sizeTier === 1)).toBe(true);
  });
});
