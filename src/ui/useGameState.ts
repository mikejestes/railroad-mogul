import { useSyncExternalStore } from 'react';
import type { GameStore } from '../store/gameStore.ts';
import type { GameState } from '../sim/state.ts';
import type { SurveyController, SurveyProposal } from '../render/surveyController.ts';

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

/**
 * Subscribe to the live survey proposal (milestone 3 U6, KTD9). Applies the
 * same version-counter rule `useGameState` does, but combined across *two*
 * sources: the game store (a proposal's price can change from sim state it
 * doesn't otherwise observe — a city growing nearby, KTD2's preview
 * honesty) and the survey controller (a click or cursor move). Both mutate
 * in place and republish, so `useSyncExternalStore`'s snapshot must be a
 * changing primitive derived from both versions, never either store's state
 * object directly (see `docs/solutions/ui-bugs/
 * react-frozen-ui-over-mutable-store-state.md`) — a template string of the
 * two version numbers is cheap and always changes when either does.
 */
export function useSurveyProposal(store: GameStore, survey: SurveyController): SurveyProposal | null {
  useSyncExternalStore(
    (cb) => {
      const unsubStore = store.subscribe(cb);
      const unsubSurvey = survey.subscribe(cb);
      return () => {
        unsubStore();
        unsubSurvey();
      };
    },
    () => `${store.getVersion()}:${survey.getVersion()}`,
  );
  return survey.proposalFor(store.getState());
}
