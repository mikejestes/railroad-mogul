import type { GameState } from '../sim/state.ts';
import type { GoodId } from '../sim/model/goods.ts';
import { GOODS, RECIPES } from '../sim/model/goods.ts';
import { computeFee } from '../sim/systems/delivery.ts';
import { inCatchment, type Station } from '../sim/model/track.ts';
import { findPath } from '../sim/pathfinding.ts';
import type { Train } from '../sim/model/trains.ts';
import type { Industry } from '../sim/model/industries.ts';
import { OUTPUT_CAP } from '../sim/systems/production.ts';
import {
  currentParcelValueAt,
  ALL_PARCEL_VALUE_ITEM_NAMES,
  type ParcelAddress,
  type ParcelValueItemName,
  type ParcelValueItem,
} from '../sim/model/land.ts';

/**
 * Read-model selectors shared by the map overlays (U9) and the management UI
 * (U10). They turn raw sim state into the numbers the player sees — city
 * demand, expected route fees, finances — so the map can show *why* a route
 * pays what it pays (R13). Pure functions of state: trivially unit-testable,
 * and the UI never touches sim internals directly.
 *
 * M4 U5 (KTD5) / M5 U2 (KTD4): `districtTrafficMultiplier` and
 * `trafficMixByGood` are re-exported here (not defined here) — they live in
 * `sim/model/districts.ts` because sim systems (`production.ts`,
 * `demand.ts`) call them directly (the latter threading `good` through to
 * pick up the station-type traffic skew, AE2) and the sim layer must never
 * import from the store layer. This re-export is so UI/selector callers
 * that expect district-facing reads to live alongside the rest of the
 * read-model still find them at the conventional import path.
 */
export { districtTrafficMultiplier, trafficMixByGood } from '../sim/model/districts.ts';

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

/**
 * Whether a processor is currently starved of at least one input good it
 * needs for its recipe (U6/R7) — the reason a mill can sit idle even with
 * inbound rail service, surfaced so the map can show it at a glance instead
 * of the player having to open a panel to find out. Raw extractors have no
 * recipe inputs (`src/sim/model/goods.ts`), so they are never starved.
 */
export function industryStarved(industry: Industry): boolean {
  const recipe = RECIPES[industry.type];
  const inputGoods = Object.keys(recipe.inputs) as GoodId[];
  return inputGoods.some((good) => (industry.inputStock[good] ?? 0) < recipe.inputs[good]!);
}

/**
 * Normalized output-stock pressure (0..1), reaching its maximum exactly at
 * `OUTPUT_CAP` (`src/sim/systems/production.ts`) — imported rather than
 * duplicated, so the two never drift. Used to show how close an industry is
 * to backing up and needing a pickup (U6/R7).
 */
export function industryOutputPressure(industry: Industry): number {
  return Math.min(1, industry.outputStock / OUTPUT_CAP);
}

/** One named cause of a parcel's value having moved (R9, AE4) — positive for
 *  appreciation, negative for depreciation. */
export interface AttributionItem {
  name: ParcelValueItemName;
  cents: number;
}

/** Milestone 6 U5 (KTD6, R8/R9): what a held parcel is worth now, what it
 *  cost, and why the two differ — everything `LandPanel` (U6) renders
 *  verbatim. */
export interface ParcelValuation {
  parcelId: string;
  address: ParcelAddress;
  pricePaidCents: number;
  acquiredDay: number;
  currentValueCents: number;
  deltaCents: number;
  /** Item-by-item diff of the current itemized value against
   *  `valueItemsAtPurchase` (KTD6), non-zero entries only, sorted by
   *  magnitude (largest cause first, AE4). Walks the fixed
   *  `ALL_PARCEL_VALUE_ITEM_NAMES` order rather than a `Map`/`Set` key
   *  iteration, so the result is deterministic independent of item
   *  insertion order. */
  attribution: AttributionItem[];
}

function itemCents(items: ParcelValueItem[], name: ParcelValueItemName): number {
  return items.find((i) => i.name === name)?.cents ?? 0;
}

/**
 * Current value, delta, and item-by-item attribution for an owned parcel
 * (milestone 6 U5, KTD6, R8/R9/AE4/AE5). `null` for an unknown `parcelId`.
 * Pure read-model derivation — `currentParcelValueAt` is never stored, so
 * this is recomputed from `landValueAt` and any live charter every call
 * (the same "derived per query" discipline milestone 5's `landValueAt`
 * itself follows).
 */
export function parcelValuation(state: GameState, parcelId: string): ParcelValuation | null {
  const parcel = state.parcels.find((p) => p.id === parcelId);
  if (!parcel) return null;

  const current = currentParcelValueAt(state, parcel.address);
  const attribution: AttributionItem[] = ALL_PARCEL_VALUE_ITEM_NAMES.map((name) => ({
    name,
    cents: itemCents(current.items, name) - itemCents(parcel.valueItemsAtPurchase, name),
  }))
    .filter((item) => item.cents !== 0)
    .sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents));

  return {
    parcelId: parcel.id,
    address: parcel.address,
    pricePaidCents: parcel.pricePaidCents,
    acquiredDay: parcel.acquiredDay,
    currentValueCents: current.totalCents,
    deltaCents: current.totalCents - parcel.pricePaidCents,
    attribution,
  };
}
