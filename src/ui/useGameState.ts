import { useSyncExternalStore } from 'react';
import type { GameStore } from '../store/gameStore.ts';
import type { GameState } from '../sim/state.ts';

/**
 * Subscribe a React component to the game store's snapshots (U10). Re-renders
 * only when the store publishes a new snapshot on tick — never per render
 * frame — keeping React out of the hot path (KTD1).
 */
export function useGameState(store: GameStore): GameState {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getState(),
  );
}
