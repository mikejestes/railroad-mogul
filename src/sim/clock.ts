import type { GameState } from './state.ts';
import { tick } from './tick.ts';

/**
 * Real-time-with-pause clock (U12). Maps wall-clock time onto the kernel's
 * fixed timestep: it accumulates real milliseconds and runs whole fixed ticks,
 * so speed and pause change how many ticks run per frame — never the per-tick
 * result, which keeps determinism intact regardless of speed.
 *
 * Catch-up is clamped (adversarial hedge): a large real-time gap — e.g. a tab
 * that was backgrounded — can never run an unbounded burst of ticks in one
 * frame; excess accumulated time is dropped rather than replayed. Pairing this
 * with pause-on-blur in the host (main.ts) means a hidden tab simply pauses.
 */
export interface ClockOptions {
  /** Sim days advanced per fixed tick. */
  dtDays: number;
  /** Real milliseconds that map to one fixed tick at 1x speed. */
  realMsPerTick: number;
  /** Hard cap on ticks run in a single advance() call. */
  maxTicksPerFrame: number;
}

export const DEFAULT_CLOCK_OPTIONS: ClockOptions = {
  dtDays: 1,
  realMsPerTick: 120,
  maxTicksPerFrame: 20,
};

export class GameClock {
  paused = false;
  speed = 1;
  private accumulator = 0;

  constructor(
    private state: GameState,
    private options: ClockOptions = DEFAULT_CLOCK_OPTIONS,
    private onTick?: (state: GameState) => void,
  ) {}

  /**
   * Advance the clock by `realDeltaMs` of wall-clock time. Returns the number of
   * fixed ticks actually run this frame (0 when paused). Never runs more than
   * `maxTicksPerFrame` ticks, and drops any accumulated time beyond that so a
   * long gap cannot spiral.
   */
  advance(realDeltaMs: number): number {
    if (this.paused || realDeltaMs <= 0) return 0;

    const { realMsPerTick, maxTicksPerFrame, dtDays } = this.options;
    this.accumulator += realDeltaMs * this.speed;

    // Clamp the backlog so catch-up is bounded (no unbounded burst on refocus).
    const maxBacklog = realMsPerTick * maxTicksPerFrame;
    if (this.accumulator > maxBacklog) this.accumulator = maxBacklog;

    let ran = 0;
    while (this.accumulator >= realMsPerTick && ran < maxTicksPerFrame) {
      tick(this.state, dtDays);
      this.accumulator -= realMsPerTick;
      ran += 1;
    }
    if (ran > 0) this.onTick?.(this.state);
    return ran;
  }

  getState(): GameState {
    return this.state;
  }
}
