import { useSyncExternalStore } from 'react';
import type { GameStore } from '../store/gameStore.ts';
import type { GameState } from '../sim/state.ts';

/**
 * Subscribe a React component to the game store's snapshots (U10). Re-renders
 * only when the store publishes a new snapshot on tick — never per render
 * frame — keeping React out of the hot path (KTD1).
 */
export function useGameState(store: GameStore): GameState {
  // Track the store's version (a changing primitive) so React re-renders every
  // tick; then read the live, in-place-mutated state. Returning the state
  // object directly would freeze the UI, since its reference never changes.
  useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getVersion(),
  );
  return store.getState();
}
