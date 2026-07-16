import { describe, it, expect } from 'vitest';
import { generateGame } from '../../src/world/generate.ts';
import { serialize, tileIndex } from '../../src/sim/state.ts';
import { CITY_SEEDS, project } from '../../src/world/geography.ts';

describe('world generation', () => {
  it('is deterministic: same seed => identical world', () => {
    expect(serialize(generateGame(42))).toBe(serialize(generateGame(42)));
  });

  it('produces different economies for different seeds', () => {
    // Same geography, but resource/industry placement differs.
    const a = generateGame(1);
    const b = generateGame(2);
    const posA = a.industries.map((i) => `${i.type}:${i.x},${i.y}`).join('|');
    const posB = b.industries.map((i) => `${i.type}:${i.x},${i.y}`).join('|');
    expect(posA).not.toBe(posB);
    // Geography (city positions) is identical across seeds.
    expect(a.cities.map((c) => c.id)).toEqual(b.cities.map((c) => c.id));
  });

  it('places cities at their real projected tile positions', () => {
    const state = generateGame(7);
    const london = state.cities.find((c) => c.id === 'london')!;
    const rome = state.cities.find((c) => c.id === 'rome')!;
    const expectedLondon = project(CITY_SEEDS.find((c) => c.id === 'london')!);
    expect({ x: london.x, y: london.y }).toEqual(expectedLondon);
    // London is north-west of Rome: smaller y (further north), smaller x (west).
    expect(london.y).toBeLessThan(rome.y);
    expect(london.x).toBeLessThan(rome.x);
  });

  it('never places an industry or city on a sea tile', () => {
    const state = generateGame(99);
    const { terrain } = state.world;
    for (const ind of state.industries) {
      expect(terrain[tileIndex(state.world, ind.x, ind.y)]).not.toBe('sea');
    }
    for (const city of state.cities) {
      expect(terrain[tileIndex(state.world, city.x, city.y)]).toBe('land');
    }
  });

  it('generates the full curated city set', () => {
    const state = generateGame(3);
    expect(state.cities).toHaveLength(CITY_SEEDS.length);
  });
});
