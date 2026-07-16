import { describe, it, expect } from 'vitest';
import { createGameState, STARTING_CAPITAL, type GameState } from '../../src/sim/state.ts';
import { tick } from '../../src/sim/tick.ts';
import { makeCity } from '../../src/sim/model/cities.ts';
import { makeTrain } from '../../src/sim/model/trains.ts';

/**
 * The whole deliver -> grow loop through the real pipeline (production, demand,
 * movement, delivery, growth). A train hauls food from a plant at A to a city
 * at B; sustained fulfillment grows the city and the player earns money.
 * This is the plan's global Definition of Done, proven in the simulation.
 */
function slice(): GameState {
  const s = createGameState(1);
  s.moneyCents = STARTING_CAPITAL;
  s.world = { width: 4, height: 3, terrain: new Array(12).fill('land') };
  s.stations.push({ id: 'A', x: 0, y: 0, radius: 1 });
  s.stations.push({ id: 'B', x: 2, y: 0, radius: 1 });
  s.track.segments.push({ ax: 0, ay: 0, bx: 1, by: 0 });
  s.track.segments.push({ ax: 1, ay: 0, bx: 2, by: 0 });

  // Food plant at A, kept supplied so it keeps producing food.
  s.industries.push({
    id: 'plant',
    type: 'foodPlant',
    x: 0,
    y: 0,
    output: 'food',
    outputStock: 8,
    inputStock: { grain: 100_000 },
  });

  // City at B that demands food (tier 0).
  s.cities.push(makeCity('metro', 'Metro', 2, 0, 0));

  // A train that loads food at A and delivers it at B, looping.
  const train = makeTrain('t', 'american', [
    { stationId: 'A', loads: ['food'], unload: false },
    { stationId: 'B', loads: [], unload: true },
  ]);
  s.trains.push(train);
  return s;
}

describe('deliver -> grow loop (Definition of Done)', () => {
  it('a well-served city grows and the player earns money', () => {
    const s = slice();
    const startCash = s.moneyCents;
    const startTier = s.cities[0].sizeTier;

    // Run a few sim-years of the full pipeline.
    for (let day = 0; day < 800; day++) tick(s);

    expect(s.moneyCents).toBeGreaterThan(startCash); // fees earned (R3)
    expect(s.cities[0].sizeTier).toBeGreaterThan(startTier); // city grew (R6, R7)
    // Growth unlocked new demand beyond food (R8).
    expect(s.cities[0].demand.goods).toBeGreaterThan(0);
  });

  it('is deterministic end to end: same seed => identical run', () => {
    const run = () => {
      const s = slice();
      for (let day = 0; day < 300; day++) tick(s);
      return `${s.moneyCents}:${s.cities[0].sizeTier}:${s.cities[0].backlog.food ?? 0}`;
    };
    expect(run()).toBe(run());
  });
});
