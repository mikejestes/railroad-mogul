import { describe, it, expect } from 'vitest';
import { applyIntent } from '../../src/store/applyIntents.ts';
import { createGameState } from '../../src/sim/state.ts';
import type { Intent } from '../../src/store/gameStore.ts';

describe('applyIntent exhaustiveness (U3)', () => {
  it('throws rather than silently doing nothing on an unrecognized intent kind', () => {
    const state = createGameState(1);
    const bogus = { kind: 'doSomethingUnplanned' } as unknown as Intent;
    expect(() => applyIntent(state, bogus)).toThrow();
  });
});
