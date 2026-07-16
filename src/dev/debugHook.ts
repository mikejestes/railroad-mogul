import type { GameStore, Intent } from '../store/gameStore.ts';
import type { GameClock } from '../sim/clock.ts';
import type { GameState } from '../sim/state.ts';
import { applyIntent, buyTrain } from '../store/applyIntents.ts';

/**
 * Dev-only inspection & control hook (installed behind import.meta.env.DEV).
 * Exposes `window.__game` so a browser driver — or you at the console — can read
 * sim state directly (cash, cities, trains) and perform build/train actions
 * without synthesizing pointer events. This is what makes browser verification
 * assert on numbers, not just pixels. Never shipped in a production build.
 */
export interface DebugApi {
  /** Live game state (always current). */
  readonly state: GameState;
  store: GameStore;
  clock: GameClock;
  seed: number;
  dispatch(intent: Intent): void;
  /** Apply any queued intents now (the rAF loop does this each frame in-app;
   *  call it in automation where a background tab throttles rAF). */
  drain(): void;
  buildStation(x: number, y: number, radius?: number): void;
  layTrack(ax: number, ay: number, bx: number, by: number): void;
  /** Create a train looping between two stations; returns its id. */
  buyTrain(fromStationId: string, toStationId: string, engineId?: string): string;
  /** Snapshot of headline numbers for quick assertions. */
  summary(): { tick: number; year: number; cash: number; cities: number; stations: number; trains: number };
}

declare global {
  interface Window {
    __game?: DebugApi;
  }
}

export function installDebugHook(store: GameStore, clock: GameClock, seed: number): void {
  // Apply immediately and publish, so hook-driven builds land regardless of
  // whether the rAF loop (which drains the normal intent queue) is running —
  // a background/automated tab throttles rAF, so queued dispatch wouldn't apply.
  const applyNow = (intent: Intent) => {
    applyIntent(store.getState(), intent);
    store.publish(store.getState());
  };

  const api: DebugApi = {
    get state() {
      return store.getState();
    },
    store,
    clock,
    seed,
    dispatch: (intent) => store.dispatch(intent),
    drain: () => {
      for (const intent of store.drainIntents()) applyIntent(store.getState(), intent);
      store.publish(store.getState());
    },
    buildStation: (x, y, radius = 2) => applyNow({ kind: 'buildStation', x, y, radius }),
    layTrack: (ax, ay, bx, by) => applyNow({ kind: 'layTrack', ax, ay, bx, by }),
    buyTrain: (fromStationId, toStationId, engineId = 'american') => {
      const ok = buyTrain(store.getState(), engineId, [fromStationId, toStationId]);
      if (!ok) throw new Error('buyTrain failed: engine unavailable/unaffordable or fewer than 2 valid stations');
      const s = store.getState();
      return s.trains[s.trains.length - 1].id;
    },
    summary: () => {
      const s = store.getState();
      return {
        tick: s.tick,
        year: s.startYear + Math.floor(s.timeDays / 365),
        cash: s.moneyCents / 100,
        cities: s.cities.length,
        stations: s.stations.length,
        trains: s.trains.length,
      };
    },
  };

  window.__game = api;
}
