import { describe, it, expect } from 'vitest';
import { createGameState } from '../../src/sim/state.ts';
import { tick } from '../../src/sim/tick.ts';
import { growthSystem, GROWTH_DAYS_REQUIRED } from '../../src/sim/systems/growth.ts';
import { makeCity } from '../../src/sim/model/cities.ts';

describe('city growth (KTD5)', () => {
  it('AE2: a city fed only passengers and mail does not grow', () => {
    const s = createGameState(1);
    const city = makeCity('c', 'Testville', 0, 0, 0);
    // Perfectly fulfil passengers and mail, but never freight (food).
    city.fulfillment = { passengers: 1, mail: 1 };
    s.cities.push(city);
    for (let i = 0; i < GROWTH_DAYS_REQUIRED * 3; i++) tick(s, 1, [growthSystem]);
    expect(city.sizeTier).toBe(0);
    expect(city.growthProgress).toBe(0);
  });

  it('sustained freight fulfillment advances the size tier', () => {
    const s = createGameState(1);
    const city = makeCity('c', 'Testville', 0, 0, 0);
    city.fulfillment = { food: 0.9 }; // freight kept well above threshold
    s.cities.push(city);
    for (let i = 0; i < GROWTH_DAYS_REQUIRED + 1; i++) tick(s, 1, [growthSystem]);
    expect(city.sizeTier).toBe(1);
  });

  it('growth unlocks new demanded goods', () => {
    const s = createGameState(1);
    const city = makeCity('c', 'Testville', 0, 0, 0);
    city.fulfillment = { food: 1 };
    s.cities.push(city);
    expect(city.demand.goods).toBeUndefined(); // tier 0 does not demand manufactured goods
    for (let i = 0; i < GROWTH_DAYS_REQUIRED + 1; i++) tick(s, 1, [growthSystem]);
    expect(city.sizeTier).toBe(1);
    expect(city.demand.goods).toBeGreaterThan(0); // tier 1 unlocks it (R8)
  });

  it('a neglected city stagnates: progress decays back to zero', () => {
    const s = createGameState(1);
    const city = makeCity('c', 'Testville', 0, 0, 0);
    s.cities.push(city);
    // Build some progress, then let fulfillment lapse.
    city.fulfillment = { food: 1 };
    for (let i = 0; i < 30; i++) tick(s, 1, [growthSystem]);
    expect(city.growthProgress).toBeGreaterThan(0);
    city.fulfillment = { food: 0 };
    for (let i = 0; i < 40; i++) tick(s, 1, [growthSystem]);
    expect(city.growthProgress).toBe(0);
    expect(city.sizeTier).toBe(0);
  });
});
