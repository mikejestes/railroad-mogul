import { describe, it, expect } from 'vitest';
import { computeFee } from '../../src/sim/systems/delivery.ts';
import { createGameState, type GameState } from '../../src/sim/state.ts';
import { tick } from '../../src/sim/tick.ts';
import { movementSystem, departTrain } from '../../src/sim/systems/movement.ts';
import { deliverySystem } from '../../src/sim/systems/delivery.ts';
import { makeCity } from '../../src/sim/model/cities.ts';
import { makeTrain } from '../../src/sim/model/trains.ts';

describe('demand-coupled fee model (KTD4)', () => {
  it('AE1: a demanded good pays more than an undemanded one over the same distance', () => {
    const demanded = computeFee({ good: 'food', qty: 5, backlog: 20, demandPerDay: 4, transitDays: 1, distance: 10 });
    const undemanded = computeFee({ good: 'food', qty: 5, backlog: 0, demandPerDay: 0, transitDays: 1, distance: 10 });
    expect(demanded).toBeGreaterThan(0);
    expect(undemanded).toBe(0);
  });

  it('AE1: repeated over-supply pays less each time as backlog drains', () => {
    // Simulate three successive deliveries draining a backlog of 12 at 4 units each.
    let backlog = 12;
    const fees: number[] = [];
    for (let i = 0; i < 3; i++) {
      fees.push(computeFee({ good: 'food', qty: 4, backlog, demandPerDay: 4, transitDays: 1, distance: 10 }));
      backlog -= 4;
    }
    expect(fees[0]).toBeGreaterThan(fees[1]);
    expect(fees[1]).toBeGreaterThan(fees[2]);
  });

  it('clamps at a non-negative floor — never pay-to-deliver', () => {
    const fee = computeFee({ good: 'food', qty: 5, backlog: 0, demandPerDay: 4, transitDays: 40, distance: 0 });
    expect(fee).toBeGreaterThanOrEqual(0);
  });

  it('timeliness: a slower delivery of the same load pays less', () => {
    const fast = computeFee({ good: 'goods', qty: 5, backlog: 20, demandPerDay: 4, transitDays: 1, distance: 10 });
    const slow = computeFee({ good: 'goods', qty: 5, backlog: 20, demandPerDay: 4, transitDays: 12, distance: 10 });
    expect(fast).toBeGreaterThan(slow);
  });

  it('AE3: outcome turns on demand, not cargo class — matched freight can beat a long passenger haul', () => {
    // Passengers have a higher base rate than manufactured goods, yet a
    // well-matched, high-demand freight delivery out-earns a low-demand
    // passenger one — so class alone does not dominate (R2).
    const freight = computeFee({ good: 'goods', qty: 8, backlog: 40, demandPerDay: 8, transitDays: 1, distance: 12 });
    const passengers = computeFee({ good: 'passengers', qty: 8, backlog: 2, demandPerDay: 8, transitDays: 6, distance: 30 });
    expect(freight).toBeGreaterThan(passengers);
    // And with the demand reversed, passengers win — proving it is demand-driven.
    const freightLow = computeFee({ good: 'goods', qty: 8, backlog: 2, demandPerDay: 8, transitDays: 6, distance: 12 });
    const passengersHigh = computeFee({ good: 'passengers', qty: 8, backlog: 40, demandPerDay: 8, transitDays: 1, distance: 30 });
    expect(passengersHigh).toBeGreaterThan(freightLow);
  });
});

describe('delivery integration', () => {
  /** Two stations on a straight line with a producing coal mine at the origin. */
  function deliveryWorld(): GameState {
    const s = createGameState(1);
    s.world = { width: 6, height: 3, terrain: new Array(18).fill('land') };
    s.stations.push({ id: 'A', x: 0, y: 0, radius: 1 });
    s.stations.push({ id: 'B', x: 4, y: 0, radius: 1 });
    for (let x = 0; x < 4; x++) s.track.segments.push({ ax: x, ay: 0, bx: x + 1, by: 0 });
    // City at B that demands food; a food source at A.
    const city = makeCity('metropolis', 'Metropolis', 4, 0, 0);
    city.backlog = { food: 30 };
    s.cities.push(city);
    s.industries.push({ id: 'food-a', type: 'foodPlant', x: 0, y: 0, output: 'food', outputStock: 8, inputStock: {} });
    return s;
  }

  it('a delivery of a demanded good credits money', () => {
    const s = deliveryWorld();
    const train = makeTrain('t', 'american', [
      { stationId: 'A', loads: ['food'], unload: false },
      { stationId: 'B', loads: [], unload: true },
    ]);
    s.trains.push(train);

    const before = s.moneyCents;
    let guard = 0;
    // Run the movement+delivery slice until the train has looped A->B->A once.
    while (guard++ < 200 && s.moneyCents === before) {
      tick(s, 1, [movementSystem, deliverySystem]);
      // departTrain is invoked inside deliverySystem on each station arrival.
    }
    expect(s.moneyCents).toBeGreaterThan(before);
    // The city's food backlog was drained by the delivery.
    expect(s.cities[0].backlog.food!).toBeLessThan(30);
  });

  // Silence unused-import lint when only some helpers are exercised above.
  it('departTrain is available to the delivery flow', () => {
    const t = makeTrain('x', 'planet', [
      { stationId: 'A', loads: [], unload: true },
      { stationId: 'B', loads: [], unload: true },
    ]);
    departTrain(t);
    expect(t.targetIndex).toBe(1);
  });
});
