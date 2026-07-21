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
// U3: terrain is no longer a stored array a fixture can fill with a uniform
// placeholder — it comes from `terrainAt(x, y)` (real, authored geography).
// Anchor at a coordinate range verified never to be sea (see
// tests/sim/movement.test.ts's LINE_OX/LINE_OY) rather than the tile origin
// (open Atlantic).
const OX = 17;
const OY = 0;

function slice(): GameState {
  const s = createGameState(1);
  s.moneyCents = STARTING_CAPITAL;
  s.world = { width: OX + 4, height: OY + 3 };
  s.stations.push({ id: 'A', x: OX, y: OY, radius: 1 });
  s.stations.push({ id: 'B', x: OX + 2, y: OY, radius: 1 });
  s.track.segments.push({ ax: OX, ay: OY, bx: OX + 1, by: OY });
  s.track.segments.push({ ax: OX + 1, ay: OY, bx: OX + 2, by: OY });

  // Food plant at A, kept supplied so it keeps producing food.
  s.industries.push({
    id: 'plant',
    type: 'foodPlant',
    x: OX,
    y: OY,
    output: 'food',
    outputStock: 8,
    inputStock: { grain: 100_000 },
  });

  // City at B that demands food (tier 0).
  s.cities.push(makeCity('metro', 'Metro', OX + 2, OY, 0));

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
