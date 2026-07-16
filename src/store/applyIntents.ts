import type { GameState } from '../sim/state.ts';
import type { Intent } from './gameStore.ts';
import { layTrack, buildStation } from '../sim/model/track.ts';
import { availableEngines, currentYear, engineById, makeTrain } from '../sim/model/trains.ts';
import { GOODS, type GoodId } from '../sim/model/goods.ts';
import { addMoney } from '../sim/state.ts';

const ALL_GOODS = Object.keys(GOODS) as GoodId[];

/** Create a train on a route if the engine is available, affordable, and the
 *  route names at least two real stations. Returns whether it was created. */
export function buyTrain(state: GameState, engineId: string, stationIds: string[]): boolean {
  const engine = engineById(engineId);
  if (!engine) return false;
  if (!availableEngines(currentYear(state)).some((e) => e.id === engineId)) return false;
  const stops = stationIds.filter((id) => state.stations.some((s) => s.id === id));
  if (stops.length < 2) return false;
  if (state.moneyCents < engine.cost) return false;

  const train = makeTrain(`train-${state.nextTrainId++}`, engineId, stops.map((id) => ({ stationId: id, loads: ALL_GOODS, unload: true })));
  state.trains.push(train);
  addMoney(state, -engine.cost);
  return true;
}

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
    case 'buyTrain':
      buyTrain(state, intent.engineId, intent.stationIds);
      break;
  }
}
