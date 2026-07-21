import type { GameState } from '../sim/state.ts';
import type { Intent } from './gameStore.ts';
import { layTrack, buildStation, emitRoute } from '../sim/model/track.ts';
import { availableEngines, currentYear, engineById, makeTrain } from '../sim/model/trains.ts';
import { GOODS, type GoodId } from '../sim/model/goods.ts';
import { addMoney } from '../sim/state.ts';
import { surveyRoute } from '../sim/surveying.ts';

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
 *
 * The switch has an exhaustiveness check (U3): later milestones add several
 * more intent kinds, and a switch with no `default` silently no-ops on an
 * unhandled one — a failure mode indistinguishable from "nothing happened",
 * which is worse than a thrown error during development.
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
    case 'commitRoute': {
      // KTD2: re-run the same pure survey the UI previewed, from the
      // waypoints alone — never trust a UI-supplied path or cost. A refused
      // or unaffordable survey is a no-op (R5), so a stale/hostile intent
      // can never build or charge anything.
      const survey = surveyRoute(state, intent.waypoints);
      if (!survey.ok) break;
      if (state.moneyCents < survey.totalCents) break;
      emitRoute(state, `route-${state.nextRouteId++}`, intent.waypoints, survey);
      break;
    }
    default: {
      const unhandled: never = intent;
      throw new Error(`applyIntent: unhandled intent kind: ${(unhandled as Intent).kind}`);
    }
  }
}
