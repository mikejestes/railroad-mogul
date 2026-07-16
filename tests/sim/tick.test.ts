import { describe, it, expect } from 'vitest';
import { createGameState, addMoney, serialize, type GameState } from '../../src/sim/state.ts';
import { tick, type System } from '../../src/sim/tick.ts';
import { nextInt } from '../../src/sim/rng.ts';

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
