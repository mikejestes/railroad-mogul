import { describe, it, expect } from 'vitest';
import {
  MemorySaveStore,
  serializeSave,
  deserializeSave,
} from '../../src/persistence/saveStore.ts';
import { generateGame } from '../../src/world/generate.ts';
import { serialize, SCHEMA_VERSION } from '../../src/sim/state.ts';
import { tick } from '../../src/sim/tick.ts';
import { GRID_HEIGHT, GRID_WIDTH, terrainAt, elevationAt } from '../../src/world/geography.ts';

describe('save/load persistence', () => {
  it('round-trips to an identical state', () => {
    const s = generateGame(7);
    for (let i = 0; i < 20; i++) tick(s);
    const restored = deserializeSave(serializeSave(s));
    expect(serialize(restored)).toBe(serialize(s));
  });

  it('a run resumed from a snapshot ticks identically to an uninterrupted run', () => {
    const live = generateGame(11);
    for (let i = 0; i < 15; i++) tick(live);
    const snapshot = serializeSave(live);

    for (let i = 0; i < 15; i++) tick(live);
    const liveFinal = serialize(live);

    const resumed = deserializeSave(snapshot);
    for (let i = 0; i < 15; i++) tick(resumed);
    expect(serialize(resumed)).toBe(liveFinal);
  });

  it('embeds a schema version', () => {
    const s = generateGame(1);
    const env = JSON.parse(serializeSave(s));
    expect(env.version).toBe(SCHEMA_VERSION);
  });

  it('MemorySaveStore saves, lists, loads, and removes slots', async () => {
    const store = new MemorySaveStore();
    const s = generateGame(3);
    await store.save('slot-1', s);
    expect(await store.list()).toEqual(['slot-1']);
    const loaded = await store.load('slot-1');
    expect(loaded).not.toBeNull();
    expect(serialize(loaded!)).toBe(serialize(s));
    await store.remove('slot-1');
    expect(await store.list()).toEqual([]);
    expect(await store.load('missing')).toBeNull();
  });
});

describe('determinism, persistence, and schema migration (U7, KTD9, R9, R10)', () => {
  it('AE5: a save taken after sampling terrain across many coordinates matches one taken before', () => {
    // Terrain is a pure function of coordinates (KTD1), never of GameState —
    // querying it, in any volume, from a view a player has scrolled through
    // must not grow or otherwise alter the save (R9). Sample every tile of
    // the grid (terrain + elevation) between generating and saving "after"
    // to stand in for "viewing several regions at the finest tier" (AE5).
    const before = generateGame(9);
    const beforeSave = serializeSave(before);

    const after = generateGame(9);
    for (let x = 0; x < GRID_WIDTH; x++) {
      for (let y = 0; y < GRID_HEIGHT; y++) {
        terrainAt(x, y);
        elevationAt(x, y);
      }
    }
    const afterSave = serializeSave(after);

    expect(afterSave).toBe(beforeSave);
  });

  it('a v1 envelope throws a clear error naming both versions', () => {
    const legacyEnvelope = JSON.stringify({ version: 1, savedAtDay: 0, state: '{}' });
    expect(() => deserializeSave(legacyEnvelope)).toThrow(
      `Unsupported save version 1 (expected ${SCHEMA_VERSION})`,
    );
  });

  it('a v2 save round-trips and resumes byte-identically, matching the snapshot-and-replay pattern', () => {
    expect(SCHEMA_VERSION).toBe(2);
    const live = generateGame(21);
    for (let i = 0; i < 12; i++) tick(live);
    const snapshot = serializeSave(live);
    expect((JSON.parse(snapshot) as { version: number }).version).toBe(2);

    for (let i = 0; i < 12; i++) tick(live);
    const liveFinal = serialize(live);

    const resumed = deserializeSave(snapshot);
    for (let i = 0; i < 12; i++) tick(resumed);
    expect(serialize(resumed)).toBe(liveFinal);
  });
});
