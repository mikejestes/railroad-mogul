import type { GameState } from '../sim/state.ts';
import type { Intent } from './gameStore.ts';
import { layTrack, buildStation, emitRoute, moveStation, type Station } from '../sim/model/track.ts';
import { availableEngines, currentYear, engineById, makeTrain } from '../sim/model/trains.ts';
import { GOODS, type GoodId } from '../sim/model/goods.ts';
import { addMoney } from '../sim/state.ts';
import { surveyRoute } from '../sim/surveying.ts';
import {
  makeDistrict,
  recordCuts,
  TRACK_CUT_STRENGTH,
  DISTRICT_FOOTPRINT_TILES,
  activeDistrictFor,
  type Cut,
} from '../sim/model/districts.ts';
import { charterRoute, consumeCharters, buyLand, sellLand } from '../sim/model/land.ts';

const ALL_GOODS = Object.keys(GOODS) as GoodId[];

/**
 * Create a district for a newly built (or relocated) station (M4 U2,
 * KTD10). Every station gets one — rural stations included, per R1's "each
 * station has a district" and KTD10's station-town reading of a freight
 * halt that stays a hamlet until fed.
 *
 * Milestone 5 U7 (KTD8): idempotency narrows from per-station-id to
 * per-(station id, CURRENT anchor) — the anchor this call would create a
 * district at, i.e. the station's current tile. Calling this for a station
 * that already has a district anchored exactly where the station currently
 * sits is a silent no-op (unchanged from M4's behavior for any station that
 * has never moved: its current tile *is* its original anchor). But once a
 * station has relocated beyond its old district's footprint, its current
 * tile no longer matches that old district's anchor, so this check no
 * longer suppresses creation — a *second* district is created, anchored at
 * the new site, while the old one (still carrying the same `stationId`, for
 * historical attribution) is left exactly as it was (R14). The `moveStation`
 * intent handler below is `ensureDistrict`'s only relocation-path caller,
 * and only calls it when the move actually left the old footprint — see its
 * own comment for the within-footprint case, which intentionally does not
 * call this at all.
 *
 * Milestone 5 U3 (KTD7): a brand-new district backfills cuts from every
 * *pre-existing* track segment that crosses its footprint — "the cut was
 * physically there first." This routes through the same `recordCuts` helper
 * `layTrack`/`buildStation`/`emitRoute` use (`sim/model/track.ts`), so build-
 * time recording and creation-time backfill can never disagree about what
 * counts as a cut. Deliberately does NOT also self-cut the new district from
 * the station's own footprint: the anchor is the new district's dead center,
 * so a universal self-cut there would be the worst possible centrality
 * (KTD5, U4) for literally every station ever built, baking in a fixed
 * penalty no siting choice could avoid — contrary to R10's "edge vs middle
 * is a siting decision." `buildStation`/`moveStation` (`model/track.ts`)
 * still record the station's footprint as a cut into any *other*,
 * already-existing neighboring district it happens to fall inside.
 */
export function ensureDistrict(state: GameState, station: Station): void {
  if (state.districts.some((d) => d.stationId === station.id && d.anchorX === station.x && d.anchorY === station.y)) {
    return;
  }
  const id = `dst-${state.nextDistrictId++}`;
  const district = makeDistrict(id, station);
  state.districts.push(district);
  const chords: Cut[] = state.track.segments.map((seg) => ({
    ax: seg.ax,
    ay: seg.ay,
    bx: seg.bx,
    by: seg.by,
    strength: TRACK_CUT_STRENGTH,
  }));
  recordCuts([district], chords);
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
      const built = buildStation(state, id, intent.x, intent.y, intent.radius, intent.stationType);
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
      // Milestone 6 U2 (KTD1): building inside a live charter's corridor
      // consumes it — a charter's fate (consumed vs. lapsed) is decided here
      // or by landSystem's expiry, never both.
      consumeCharters(state, survey.path);
      break;
    }
    case 'moveStation': {
      // KTD8's flow diagram: capture the district *currently serving* this
      // station before `moveStation` mutates its position. This is
      // deliberately NOT a raw anchor-equality match against the station's
      // current tile — a district's anchor is fixed at creation (KTD1), and
      // a within-footprint move (R14) never mints a new one, so after even
      // one such move the station's tile no longer equals any district's
      // anchor. Matching by exact anchor-equality only ever worked for a
      // station that had never moved; on a *second* move it silently missed,
      // minting a spurious extra district and orphaning the real one. This
      // is the same "which record is this station's activity credited to"
      // question `activeDistrictFor` already answers for `delivery.ts` and
      // `landValue.ts` (last-created record for the station id, since
      // `state.districts` only ever appends) — reusing it here keeps the
      // resolution rule one and the same everywhere, not a second, subtly
      // different lookup just for relocation.
      const station = state.stations.find((s) => s.id === intent.stationId);
      if (!station) break;
      const oldDistrict = activeDistrictFor(state, station.id);
      const moved = moveStation(state, intent.stationId, intent.x, intent.y);
      if (!moved) break;
      if (oldDistrict) {
        const withinFootprint =
          Math.max(Math.abs(intent.x - oldDistrict.anchorX), Math.abs(intent.y - oldDistrict.anchorY)) <=
          DISTRICT_FOOTPRINT_TILES;
        // Within the old district's footprint: it continues being served —
        // same record, development intact (R14) — so `ensureDistrict` is
        // deliberately NOT called here; there is nothing new to create.
        // Beyond it: the old district goes unserved (M4's stagnation-then-
        // decline takes over) and a new one is ensured at the new site,
        // keyed by the station's new anchor (KTD8's narrowed idempotency).
        if (!withinFootprint) ensureDistrict(state, station);
      } else {
        // No district exists for this station id at all (shouldn't happen in
        // normal play — every built station gets one — but stay correct
        // under a hand-crafted or test-fixture state).
        ensureDistrict(state, station);
      }
      break;
    }
    case 'charterRoute':
      // Milestone 6 U2 (KTD1): self-contained validate-then-mutate
      // (`buyTrain`'s precedent) — re-surveys from waypoints, debits the
      // fee, grants corridor rights; a refused or unaffordable charter is a
      // no-op, `nextCharterId` included.
      charterRoute(state, intent.waypoints);
      break;
    case 'buyLand':
      // Milestone 6 U3 (KTD2/KTD3/KTD8): rights + affordability validated
      // inside `buyLand` itself; a refusal is a no-op, `nextParcelId`
      // included.
      buyLand(state, intent.address);
      break;
    case 'sellLand':
      // Milestone 6 U3 (KTD7): unknown parcel id is a no-op.
      sellLand(state, intent.parcelId);
      break;
    default: {
      const unhandled: never = intent;
      throw new Error(`applyIntent: unhandled intent kind: ${(unhandled as Intent).kind}`);
    }
  }
}
