import type { GameStore, Intent } from '../store/gameStore.ts';
import type { GameClock } from '../sim/clock.ts';
import type { GameState } from '../sim/state.ts';
import { GOODS, type GoodId } from '../sim/model/goods.ts';
import { makeTrain, engineById } from '../sim/model/trains.ts';

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
  const allGoods = Object.keys(GOODS) as GoodId[];

  const api: DebugApi = {
    get state() {
      return store.getState();
    },
    store,
    clock,
    seed,
    dispatch: (intent) => store.dispatch(intent),
    buildStation: (x, y, radius = 2) => store.dispatch({ kind: 'buildStation', x, y, radius }),
    layTrack: (ax, ay, bx, by) => store.dispatch({ kind: 'layTrack', ax, ay, bx, by }),
    buyTrain: (fromStationId, toStationId, engineId = 'american') => {
      const engine = engineById(engineId);
      if (!engine) throw new Error(`Unknown engine: ${engineId}`);
      const s = store.getState();
      const train = makeTrain(`train-${s.trains.length}`, engineId, [
        { stationId: fromStationId, loads: allGoods, unload: true },
        { stationId: toStationId, loads: allGoods, unload: true },
      ]);
      s.moneyCents -= engine.cost;
      s.trains.push(train);
      return train.id;
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
