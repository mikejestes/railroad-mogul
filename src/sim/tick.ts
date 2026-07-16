import type { GameState } from './state.ts';
import { SYSTEMS } from './systems/index.ts';

/**
 * A simulation system: reads and mutates game state for one concern (economy,
 * movement, growth, ...). Systems import no render/DOM code, so the kernel runs
 * headlessly and deterministically (KTD2). `dtDays` is the fixed sim-time step
 * for this tick.
 */
export type System = (state: GameState, dtDays: number) => void;

/**
 * Advance the simulation by one fixed step. Runs every system in the fixed
 * pipeline order (KTD3), then advances the clock. Pure with respect to the
 * outside world: given the same state and dt, it always produces the same
 * result — the property the U2 determinism gate and U11 save/replay depend on.
 *
 * The clock (U12) decides how many fixed ticks to run per real frame; `tick`
 * itself never reads wall-clock time.
 */
export function tick(state: GameState, dtDays = 1, systems: System[] = SYSTEMS): void {
  for (const system of systems) {
    system(state, dtDays);
  }
  state.timeDays += dtDays;
  state.tick += 1;
}
