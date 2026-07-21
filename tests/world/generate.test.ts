import { describe, it, expect } from 'vitest';
import { generateGame, RAW_FAVORED_TERRAIN, MIN_EXTRACTOR_SEPARATION } from '../../src/world/generate.ts';
import { serialize } from '../../src/sim/state.ts';
import { CITY_SEEDS, project, terrainAt, GRID_WIDTH, GRID_HEIGHT } from '../../src/world/geography.ts';
import { RAW_INDUSTRY_TYPES } from '../../src/sim/model/goods.ts';

describe('world generation (U3, KTD5)', () => {
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
    for (const ind of state.industries) {
      expect(terrainAt(ind.x, ind.y)).not.toBe('sea');
    }
    for (const city of state.cities) {
      expect(terrainAt(city.x, city.y)).not.toBe('sea');
    }
  });

  it('generates the full curated city set', () => {
    const state = generateGame(3);
    expect(state.cities).toHaveLength(CITY_SEEDS.length);
  });

  it('AE3: all 16 city positions classify as land (never sea) after generation', () => {
    const state = generateGame(1);
    expect(state.cities).toHaveLength(16);
    for (const city of state.cities) {
      expect(terrainAt(city.x, city.y)).not.toBe('sea');
    }
  });

  it('a coordinate well inside the Atlantic classifies as sea; a coordinate well inside France does not', () => {
    // Far west of every authored landmass box, mid-latitude — open ocean.
    expect(terrainAt(0, 14)).toBe('sea');
    // Well inside the France + Low Countries box (lon [-5,8], lat [43,51]),
    // away from every edge — always authored land.
    const franceInterior = project({ lon: 1, lat: 47 });
    expect(terrainAt(franceInterior.x, franceInterior.y)).not.toBe('sea');
  });

  it('the generated world contains at least four distinct terrain types across a sample transect', () => {
    const seen = new Set<string>();
    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        seen.add(terrainAt(x, y));
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it('serialize() output no longer contains a terrain array, and the world round-trips through save/load unchanged', () => {
    const state = generateGame(5);
    expect(serialize(state)).not.toContain('"terrain"');
    const restored = JSON.parse(serialize(state));
    expect(restored.world).toEqual({ width: GRID_WIDTH, height: GRID_HEIGHT });
    expect(serialize(restored)).toBe(serialize(state));
  });
});

describe('resource placement with spatial logic (U6, R8)', () => {
  // Exercised across many seeds rather than one: placement is RNG-driven and
  // the spacing/clustering guarantees need to hold for every run, not just a
  // lucky draw.
  const SEEDS = Array.from({ length: 25 }, (_, i) => i * 7 + 1);

  it('no two industries occupy the same tile', () => {
    for (const seed of SEEDS) {
      const state = generateGame(seed);
      const seen = new Set<string>();
      for (const ind of state.industries) {
        const key = `${ind.x},${ind.y}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  it('every raw-extractor industry sits on a terrain type its recipe favors', () => {
    for (const seed of SEEDS) {
      const state = generateGame(seed);
      for (const ind of state.industries) {
        const favored = RAW_FAVORED_TERRAIN[ind.type];
        if (!favored) continue; // processors have no terrain affinity (U6 docblock)
        expect(favored).toContain(terrainAt(ind.x, ind.y));
      }
    }
  });

  it('minimum separation between same-type extractors is respected across a large sample of seeds', () => {
    for (const seed of SEEDS) {
      const state = generateGame(seed);
      for (const type of RAW_INDUSTRY_TYPES) {
        const sites = state.industries.filter((i) => i.type === type);
        for (let i = 0; i < sites.length; i++) {
          for (let j = i + 1; j < sites.length; j++) {
            const distance = Math.max(Math.abs(sites[i].x - sites[j].x), Math.abs(sites[i].y - sites[j].y));
            expect(distance).toBeGreaterThanOrEqual(MIN_EXTRACTOR_SEPARATION);
          }
        }
      }
    }
  });

  it('placement is deterministic per seed: two generations from the same seed produce identical industry arrays', () => {
    for (const seed of [11, 42, 123]) {
      const a = generateGame(seed);
      const b = generateGame(seed);
      expect(serialize(a)).toBe(serialize(b));
      expect(a.industries).toEqual(b.industries);
    }
  });

  it('every raw industry type is placed at least once, so no resource type can be absent from a run', () => {
    for (const seed of SEEDS) {
      const state = generateGame(seed);
      for (const type of RAW_INDUSTRY_TYPES) {
        expect(state.industries.some((i) => i.type === type)).toBe(true);
      }
    }
  });
});
