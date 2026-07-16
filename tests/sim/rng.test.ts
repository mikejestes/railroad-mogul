import { describe, it, expect } from 'vitest';
import { createRng, nextFloat, nextInt, cloneRng, type RngState } from '../../src/sim/rng.ts';

describe('seeded RNG', () => {
  it('reproduces the identical sequence for the same seed', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const seqA = Array.from({ length: 20 }, () => nextFloat(a));
    const seqB = Array.from({ length: 20 }, () => nextFloat(b));
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 20 }, () => nextFloat(a));
    const seqB = Array.from({ length: 20 }, () => nextFloat(b));
    expect(seqA).not.toEqual(seqB);
  });

  it('restores mid-stream from a serialized counter', () => {
    const live = createRng(999);
    for (let i = 0; i < 7; i++) nextFloat(live);
    // Snapshot the counter mid-stream, keep drawing, then restore and replay.
    const snapshot: RngState = cloneRng(live);
    const continued = Array.from({ length: 10 }, () => nextFloat(live));
    const restored = cloneRng(snapshot);
    const replayed = Array.from({ length: 10 }, () => nextFloat(restored));
    expect(replayed).toEqual(continued);
  });

  it('yields floats in [0, 1) and bounded integers', () => {
    const r = createRng(42);
    for (let i = 0; i < 1000; i++) {
      const f = nextFloat(r);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
    for (let i = 0; i < 1000; i++) {
      const n = nextInt(r, 5);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(5);
    }
  });
});
