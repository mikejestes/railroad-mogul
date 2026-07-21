import { describe, it, expect } from 'vitest';
import { createGameState, addMoney, serialize, type GameState } from '../../src/sim/state.ts';
import { tick, type System } from '../../src/sim/tick.ts';
import { nextInt } from '../../src/sim/rng.ts';
import { generateGame } from '../../src/world/generate.ts';
import { applyIntent } from '../../src/store/applyIntents.ts';
import type { Intent } from '../../src/store/gameStore.ts';
import { landValueAt } from '../../src/sim/model/landValue.ts';

// A sample system that consumes the RNG and mutates integer money, so the
// determinism assertions exercise the ordered-systems + seeded-RNG path, not
// just a bare counter.
const rngIncomeSystem: System = (state, _dtDays) => {
  addMoney(state, nextInt(state.rng, 100) + 1);
};

describe('simulation kernel', () => {
  it('advances tick count and sim time by the fixed step', () => {
    const s = createGameState(1);
    tick(s, 2, []);
    tick(s, 2, []);
    expect(s.tick).toBe(2);
    expect(s.timeDays).toBe(4);
  });

  it('is deterministic: same seed + same systems + N ticks => identical state', () => {
    const run = (): GameState => {
      const s = createGameState(7);
      for (let i = 0; i < 50; i++) tick(s, 1, [rngIncomeSystem]);
      return s;
    };
    expect(serialize(run())).toBe(serialize(run()));
  });

  it('keeps money as an integer under repeated system application', () => {
    const s = createGameState(3);
    for (let i = 0; i < 200; i++) tick(s, 1, [rngIncomeSystem]);
    expect(Number.isInteger(s.moneyCents)).toBe(true);
  });

  it('serializes canonically regardless of key insertion order', () => {
    const a = createGameState(5);
    const b = createGameState(5);
    // Mutate the same logical fields in a different textual order.
    b.moneyCents = 0;
    b.timeDays = 0;
    a.timeDays = 0;
    a.moneyCents = 0;
    expect(serialize(a)).toBe(serialize(b));
  });

  it('restores from a serialized snapshot and continues identically', () => {
    const live = createGameState(11);
    for (let i = 0; i < 10; i++) tick(live, 1, [rngIncomeSystem]);
    const snapshot = serialize(live);

    // Continue the live run.
    for (let i = 0; i < 10; i++) tick(live, 1, [rngIncomeSystem]);
    const liveFinal = serialize(live);

    // Restore from snapshot and replay the same 10 ticks.
    const restored: GameState = JSON.parse(snapshot);
    for (let i = 0; i < 10; i++) tick(restored, 1, [rngIncomeSystem]);
    expect(serialize(restored)).toBe(liveFinal);
  });
});

describe('route surveying close-out (milestone 3 U7, R10)', () => {
  it('R10: a committed route parked for 365 sim days changes moneyCents by exactly zero — track carries no recurring cost', () => {
    const s = generateGame(21);
    // Same short, real, non-sea spur tests/persistence/roundtrip.test.ts's
    // route-commitment suite already verified against this seed.
    const commitParisSpur: Intent = { kind: 'commitRoute', waypoints: [{ x: 15, y: 12 }, { x: 17, y: 12 }] };
    applyIntent(s, commitParisSpur);
    expect(s.routes).toHaveLength(1); // the one-time build cost has already been paid
    const afterCommit = s.moneyCents;

    for (let day = 0; day < 365; day++) tick(s);

    expect(s.moneyCents).toBe(afterCommit);
  });

  it('the full determinism suite (Verification Contract) passes with routes and structured segments present: same seed, same intents, byte-identical serialization', () => {
    const run = (): GameState => {
      const s = generateGame(21);
      applyIntent(s, { kind: 'commitRoute', waypoints: [{ x: 15, y: 12 }, { x: 17, y: 12 }] });
      for (let i = 0; i < 30; i++) tick(s);
      return s;
    };
    expect(serialize(run())).toBe(serialize(run()));
  });
});

describe('station siting/severance close-out (milestone 5 U8, umbrella determinism/persistence)', () => {
  it('the full determinism suite passes with typed stations, cuts, and a relocation (derelict site) present: same seed, same intent log (including a move), byte-identical serialization', () => {
    const run = (): GameState => {
      const s = generateGame(21);
      s.moneyCents = 1_000_000_00;
      s.world = { width: 40, height: 28 };
      applyIntent(s, { kind: 'buildStation', x: 17, y: 0, radius: 2, stationType: 'passenger' });
      applyIntent(s, { kind: 'layTrack', ax: 17, ay: 0, bx: 18, by: 0 });
      const stationId = s.stations[0].id;
      applyIntent(s, { kind: 'moveStation', stationId, x: 19, y: 0 });
      applyIntent(s, { kind: 'buildStation', x: 17, y: 3, radius: 1, stationType: 'freight' });
      for (let i = 0; i < 60; i++) tick(s);
      return s;
    };
    const a = run();
    const b = run();
    expect(a.stations[0].stationType).toBe('passenger');
    expect(a.derelictSites.length).toBeGreaterThan(0);
    expect(a.districts.some((d) => d.cuts.length > 0)).toBe(true);
    expect(serialize(a)).toBe(serialize(b));
  });

  it("KTD2 proof: querying landValueAt across the map, any number of times, in any order, leaves serialization byte-identical", () => {
    const s = generateGame(21);
    s.moneyCents = 1_000_000_00;
    s.world = { width: 40, height: 28 };
    applyIntent(s, { kind: 'buildStation', x: 17, y: 0, radius: 2, stationType: 'freight' });
    applyIntent(s, { kind: 'layTrack', ax: 17, ay: 0, bx: 18, by: 0 });
    applyIntent(s, { kind: 'moveStation', stationId: s.stations[0].id, x: 20, y: 0 });
    for (let i = 0; i < 20; i++) tick(s);

    const before = serialize(s);
    for (let x = 10; x < 30; x++) {
      for (let y = 0; y < 10; y++) {
        landValueAt(s, x, y);
      }
    }
    // Repeat queries at the same coordinates, out of order, for good measure.
    landValueAt(s, 17, 0);
    landValueAt(s, 20, 0);
    landValueAt(s, 17, 0);
    expect(serialize(s)).toBe(before);
  });
});
