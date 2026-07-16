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

  /** Two cities on a connected line, a train looping between them. */
  function twoCityLine(): GameState {
    const s = createGameState(1);
    s.moneyCents = STARTING_CAPITAL;
    s.world = { width: 6, height: 1, terrain: new Array(6).fill('land') };
    s.stations.push({ id: 'A', x: 0, y: 0, radius: 1 });
    s.stations.push({ id: 'B', x: 4, y: 0, radius: 1 });
    for (let x = 0; x < 4; x++) s.track.segments.push({ ax: x, ay: 0, bx: x + 1, by: 0 });
    s.cities.push(makeCity('cityA', 'Aville', 0, 0, 1));
    s.cities.push(makeCity('cityB', 'Bville', 4, 0, 1));
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
