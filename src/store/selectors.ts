import type { GameState } from '../sim/state.ts';
import type { GoodId } from '../sim/model/goods.ts';
import { GOODS } from '../sim/model/goods.ts';
import { computeFee } from '../sim/systems/delivery.ts';
import { inCatchment, type Station } from '../sim/model/track.ts';
import { findPath } from '../sim/pathfinding.ts';
import type { Train } from '../sim/model/trains.ts';

/**
 * Read-model selectors shared by the map overlays (U9) and the management UI
 * (U10). They turn raw sim state into the numbers the player sees — city
 * demand, expected route fees, finances — so the map can show *why* a route
 * pays what it pays (R13). Pure functions of state: trivially unit-testable,
 * and the UI never touches sim internals directly.
 */
export interface DemandRow {
  good: GoodId;
  name: string;
  demandPerDay: number;
  backlog: number;
  fulfillment: number;
}

/** A city's current demand picture, most-wanted (highest backlog) first. */
export function cityDemand(state: GameState, cityId: string): DemandRow[] {
  const city = state.cities.find((c) => c.id === cityId);
  if (!city) return [];
  const rows: DemandRow[] = (Object.keys(city.demand) as GoodId[]).map((good) => ({
    good,
    name: GOODS[good].name,
    demandPerDay: city.demand[good] ?? 0,
    backlog: city.backlog[good] ?? 0,
    fulfillment: city.fulfillment[good] ?? 0,
  }));
  return rows.sort((a, b) => b.backlog - a.backlog);
}

/** Player cash in whole currency units (from integer cents). */
export function playerCash(state: GameState): number {
  return state.moneyCents / 100;
}

/**
 * Expected fee for hauling `qty` of `good` between two stations, used for the
 * on-map route preview (R13). Distance comes from the station positions;
 * transit time is estimated at ~1 day/tile. Returns cents.
 */
export function routeFeePreview(
  state: GameState,
  good: GoodId,
  fromStationId: string,
  toStationId: string,
  qty: number,
): number {
  const from = state.stations.find((s) => s.id === fromStationId);
  const to = state.stations.find((s) => s.id === toStationId);
  if (!from || !to) return 0;

  const distance = Math.hypot(from.x - to.x, from.y - to.y);
  const transitDays = Math.max(1, Math.round(distance));

  // Aggregate demand across cities in the destination station's catchment.
  // Shares the one catchment definition with delivery via inCatchment (they
  // must not drift if the catchment shape ever changes).
  let backlog = 0;
  let demandPerDay = 0;
  for (const city of state.cities) {
    if (inCatchment(to, city.x, city.y)) {
      backlog += city.backlog[good] ?? 0;
      demandPerDay += city.demand[good] ?? 0;
    }
  }

  return computeFee({ good, qty, backlog, demandPerDay, transitDays, distance });
}

/** Human-readable station label: the nearest city in catchment, else its tile. */
export function stationLabel(state: GameState, station: Station): string {
  const city = state.cities.find((c) => inCatchment(station, c.x, c.y));
  return city ? `near ${city.name}` : `(${station.x}, ${station.y})`;
}

/**
 * Human-readable status for a train — crucially, it explains a stopped train.
 * A train idles when its route stations aren't joined by a continuous track, so
 * we surface that instead of leaving it silently motionless (the "why won't my
 * train move?" gap).
 */
export function trainStatus(state: GameState, train: Train): string {
  if (!train.initialized) return 'starting';
  const at = train.atStationId ? state.stations.find((s) => s.id === train.atStationId) : null;
  if (at) return `at ${stationLabel(state, at)}`;
  const target = state.stations.find((s) => s.id === train.route[train.targetIndex]?.stationId);
  if (!target) return 'no destination';
  const path = findPath(state, train.x, train.y, target.x, target.y);
  return path ? 'running' : 'idle — no track to next stop';
}

/**
 * Consecutive route stops NOT joined by track, as readable "A → B" strings.
 * Used by the Buy Train panel to warn before dispatching a train that can't run.
 */
export function routeGaps(state: GameState, stationIds: string[]): string[] {
  const gaps: string[] = [];
  for (let i = 0; i + 1 < stationIds.length; i++) {
    const a = state.stations.find((s) => s.id === stationIds[i]);
    const b = state.stations.find((s) => s.id === stationIds[i + 1]);
    if (a && b && !findPath(state, a.x, a.y, b.x, b.y)) {
      gaps.push(`${stationLabel(state, a)} → ${stationLabel(state, b)}`);
    }
  }
  return gaps;
}

export interface TrainSummary {
  id: string;
  engineId: string;
  atStationId: string | null;
  cargoUnits: number;
  status: string;
}

export function trainSummaries(state: GameState): TrainSummary[] {
  return state.trains.map((t) => ({
    id: t.id,
    engineId: t.engineId,
    atStationId: t.atStationId,
    cargoUnits: t.cars.reduce((n, c) => n + c.qty, 0),
    status: trainStatus(state, t),
  }));
}
