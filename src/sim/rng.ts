/**
 * Seeded, counter-based PRNG for the deterministic simulation kernel (KTD2).
 *
 * Randomness is a pure function of (seed, counter): drawing a value advances
 * the counter, and the value at any counter is recomputed by hashing — so the
 * whole stream is fully serializable and restorable by saving just these two
 * integers. This is what lets a mid-run snapshot resume with a byte-identical
 * future (U11 save/load, U2 determinism gate).
 */
export interface RngState {
  seed: number;
  counter: number;
}

export function createRng(seed: number): RngState {
  return { seed: seed >>> 0, counter: 0 };
}

export function cloneRng(rng: RngState): RngState {
  return { seed: rng.seed, counter: rng.counter };
}

/**
 * Deterministic hash of (seed, counter) -> uint32. A splitmix32-style finalizer
 * gives good avalanche so nearby counters don't yield correlated values.
 */
function hash(seed: number, counter: number): number {
  let z = (seed + Math.imul(counter, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  z = (z ^ (z >>> 15)) >>> 0;
  return z >>> 0;
}

/** Draw the next float in [0, 1), advancing the counter. */
export function nextFloat(rng: RngState): number {
  rng.counter = (rng.counter + 1) >>> 0;
  return hash(rng.seed, rng.counter) / 4294967296;
}

/** Draw the next integer in [0, maxExclusive), advancing the counter. */
export function nextInt(rng: RngState, maxExclusive: number): number {
  if (maxExclusive <= 0) return 0;
  return Math.floor(nextFloat(rng) * maxExclusive);
}
