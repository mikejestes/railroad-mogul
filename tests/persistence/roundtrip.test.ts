import { describe, it, expect } from 'vitest';
import {
  MemorySaveStore,
  serializeSave,
  deserializeSave,
} from '../../src/persistence/saveStore.ts';
import { generateGame } from '../../src/world/generate.ts';
import { serialize, SCHEMA_VERSION } from '../../src/sim/state.ts';
import { tick } from '../../src/sim/tick.ts';

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
