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
import { applyIntent } from '../../src/store/applyIntents.ts';
import type { Intent } from '../../src/store/gameStore.ts';
import { generateDistrictScene } from '../../src/world/streets.ts';

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

  it('a v3 save round-trips and resumes byte-identically, matching the snapshot-and-replay pattern', () => {
    expect(SCHEMA_VERSION).toBe(3);
    const live = generateGame(21);
    for (let i = 0; i < 12; i++) tick(live);
    const snapshot = serializeSave(live);
    expect((JSON.parse(snapshot) as { version: number }).version).toBe(3);

    for (let i = 0; i < 12; i++) tick(live);
    const liveFinal = serialize(live);

    const resumed = deserializeSave(snapshot);
    for (let i = 0; i < 12; i++) tick(resumed);
    expect(serialize(resumed)).toBe(liveFinal);
  });

  it('an old-version envelope throws a clear error naming both versions (KTD11)', () => {
    const legacyEnvelope = JSON.stringify({ version: 2, savedAtDay: 0, state: '{}' });
    expect(() => deserializeSave(legacyEnvelope)).toThrow(
      `Unsupported save version 2 (expected ${SCHEMA_VERSION})`,
    );
  });
});

describe('route commitment persistence (milestone 3 U4, KTD10)', () => {
  // Paris (15,12) at the canonical grid — real, non-sea coordinates
  // (verified against seed 21's reference field) — a short survey commits
  // at least one segment and one route without crossing sea.
  const commitParisSpur: Intent = { kind: 'commitRoute', waypoints: [{ x: 15, y: 12 }, { x: 17, y: 12 }] };

  it('a save containing committed routes and structured segments round-trips and resumes byte-identically', () => {
    const live = generateGame(21);
    applyIntent(live, commitParisSpur);
    expect(live.routes.length).toBe(1);
    expect(live.track.segments.length).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) tick(live);

    const restored = deserializeSave(serializeSave(live));
    expect(serialize(restored)).toBe(serialize(live));
  });

  it('segments without a structure serialize with no structure key at all (no undefined in JSON)', () => {
    const live = generateGame(21);
    applyIntent(live, commitParisSpur);
    const restored = JSON.parse(serialize(live)) as { track: { segments: Array<Record<string, unknown>> } };
    for (const seg of restored.track.segments) {
      if (!('structure' in seg)) continue; // fine: only present when a segment has one
      expect(seg.structure).not.toBeUndefined();
    }
    // At least one segment from this short, flat spur has no structure —
    // confirms the omission path is actually exercised, not just legal.
    expect(restored.track.segments.some((seg) => !('structure' in seg))).toBe(true);
  });

  it('replaying the same intent sequence from the same seed produces byte-identical serialized state', () => {
    const run = () => {
      const s = generateGame(21);
      applyIntent(s, commitParisSpur);
      for (let i = 0; i < 8; i++) tick(s);
      return s;
    };
    expect(serialize(run())).toBe(serialize(run()));
  });
});

describe('district persistence (M4 U2/U8, R3, R14, AE4)', () => {
  it('districts round-trip through serialize/deserializeSave byte-identically', () => {
    const state = generateGame(5);
    state.moneyCents = 1_000_000_00;
    state.world = { width: 40, height: 28 };
    applyIntent(state, { kind: 'buildStation', x: 17, y: 0, radius: 1 });
    for (let i = 0; i < 40; i++) tick(state);

    const restored = deserializeSave(serializeSave(state));
    expect(serialize(restored)).toBe(serialize(state));
    expect(restored.districts).toHaveLength(state.districts.length);
  });

  it('AE4: a save serializes to the same size whether or not district scenes were generated for it', () => {
    const before = generateGame(6);
    before.moneyCents = 1_000_000_00;
    before.world = { width: 40, height: 28 };
    applyIntent(before, { kind: 'buildStation', x: 17, y: 0, radius: 1 });
    for (let i = 0; i < 60; i++) tick(before);
    const beforeSave = serializeSave(before);

    const after = generateGame(6);
    after.moneyCents = 1_000_000_00;
    after.world = { width: 40, height: 28 };
    applyIntent(after, { kind: 'buildStation', x: 17, y: 0, radius: 1 });
    for (let i = 0; i < 60; i++) tick(after);
    // Generate street scenes for every district between generating and
    // saving "after" — scene generation must touch no state (R9, R11).
    for (const district of after.districts) {
      generateDistrictScene(after.rng.seed, district, { x: district.anchorX, y: district.anchorY });
    }
    const afterSave = serializeSave(after);

    expect(afterSave).toBe(beforeSave);
  });
});
