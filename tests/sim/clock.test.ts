import { describe, it, expect } from 'vitest';
import { GameClock, type ClockOptions } from '../../src/sim/clock.ts';
import { createGameState, serialize } from '../../src/sim/state.ts';

const OPTS: ClockOptions = { dtDays: 1, realMsPerTick: 100, maxTicksPerFrame: 10 };

describe('game clock (U12)', () => {
  it('pause halts ticks', () => {
    const s = createGameState(1);
    const clock = new GameClock(s, OPTS);
    clock.paused = true;
    const ran = clock.advance(10_000);
    expect(ran).toBe(0);
    expect(s.tick).toBe(0);
  });

  it('runs one tick per realMsPerTick at 1x', () => {
    const s = createGameState(1);
    const clock = new GameClock(s, OPTS);
    expect(clock.advance(100)).toBe(1);
    expect(clock.advance(250)).toBe(2); // 2.5 -> 2 whole ticks, 0.5 carried
    expect(s.tick).toBe(3);
  });

  it('speed changes cadence but not the per-tick result (determinism holds)', () => {
    // Run 10 ticks at 1x and at 5x; identical state, since dtDays is fixed.
    const slow = createGameState(9);
    const clockSlow = new GameClock(slow, OPTS);
    for (let i = 0; i < 10; i++) clockSlow.advance(100);

    const fast = createGameState(9);
    const clockFast = new GameClock(fast, OPTS);
    clockFast.speed = 5;
    clockFast.advance(200); // 200 * 5 = 1000ms -> 10 ticks in one frame

    expect(slow.tick).toBe(10);
    expect(fast.tick).toBe(10);
    expect(serialize(fast)).toBe(serialize(slow));
  });

  it('clamps catch-up: a huge gap runs at most maxTicksPerFrame, never a burst', () => {
    const s = createGameState(1);
    const clock = new GameClock(s, OPTS);
    const ran = clock.advance(10_000_000); // enormous gap
    expect(ran).toBe(OPTS.maxTicksPerFrame);
    // And the backlog was dropped, so the next frame doesn't replay it.
    expect(clock.advance(0.0001)).toBe(0);
  });
});
