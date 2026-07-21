import type { GameState } from '../sim/state.ts';
import type { Intent } from './gameStore.ts';
import { layTrack, buildStation, emitRoute, type Station } from '../sim/model/track.ts';
import { availableEngines, currentYear, engineById, makeTrain } from '../sim/model/trains.ts';
import { GOODS, type GoodId } from '../sim/model/goods.ts';
import { addMoney } from '../sim/state.ts';
import { surveyRoute } from '../sim/surveying.ts';
import { makeDistrict } from '../sim/model/districts.ts';

const ALL_GOODS = Object.keys(GOODS) as GoodId[];

/**
 * Create a district for a newly built station (M4 U2, KTD10). Every station
 * gets one — rural stations included, per R1's "each station has a
 * district" and KTD10's station-town reading of a freight halt that stays a
 * hamlet until fed. Idempotent per station id (KTD10): calling this for a
 * station that already has a district is a silent no-op rather than a
 * duplicate, since the only caller (`applyIntent`'s `buildStation` case)
 * only reaches here after `buildStation` reports success, and success can
 * only ever mint a station id once (`state.nextStationId`).
 *
 * Forward-compat note (plan Assumptions): this per-station-id idempotency
 * check is deliberately *not* a permanent invariant elsewhere in the
 * codebase — milestone 5's relocation rules narrow it to per-(station id,
 * anchor) once a station can move and leave its old district behind. Do not
 * add tests that treat per-station-id idempotency as load-bearing beyond
 * this milestone.
 */
export function ensureDistrict(state: GameState, station: Station): void {
  if (state.districts.some((d) => d.stationId === station.id)) return;
  const id = `dst-${state.nextDistrictId++}`;
  state.districts.push(makeDistrict(id, station));
}

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
    case 'buildStation': {
      const id = `stn-${state.nextStationId++}`;
      const built = buildStation(state, id, intent.x, intent.y, intent.radius);
      if (built) {
        // buildStation pushes onto state.stations on success; the one it
        // just pushed is the last element (KTD10 — gate district creation on
        // a successful build, per the plan's ground-truth note on this case).
        const station = state.stations[state.stations.length - 1];
        ensureDistrict(state, station);
      }
      break;
    }
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
