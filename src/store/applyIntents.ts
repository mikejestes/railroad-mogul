import type { GameState } from '../sim/state.ts';
import type { Intent } from './gameStore.ts';
import { layTrack, buildStation } from '../sim/model/track.ts';

/**
 * Apply a queued player intent to sim state (U10). The clock drains the store's
 * intent queue each frame and applies them just before ticking, so player
 * actions land deterministically between ticks. Build validation and cost live
 * in the sim model (`track.ts`); this is only the dispatch.
 *
 * Station ids come from a serialized `state.nextStationId` counter, so they stay
 * unique and deterministic across save/load and replay (no module-level state).
 */
export function applyIntent(state: GameState, intent: Intent): void {
  switch (intent.kind) {
    case 'layTrack':
      layTrack(state, intent.ax, intent.ay, intent.bx, intent.by);
      break;
    case 'buildStation':
      buildStation(state, `stn-${state.nextStationId++}`, intent.x, intent.y, intent.radius);
      break;
  }
}
