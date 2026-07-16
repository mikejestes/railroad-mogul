import type { System } from '../tick.ts';
import type { GameState } from '../state.ts';
import { GOODS, RECIPES, type GoodId } from '../model/goods.ts';
import { addMoney } from '../state.ts';
import { citiesInCatchment, industriesInCatchment, type Station } from '../model/track.ts';
import { departTrain } from './movement.ts';
import type { Train } from '../model/trains.ts';

/**
 * Delivery & the demand-coupled fee model (U7, KTD4) — the mechanic everything
 * hinges on. When a train reaches a station, carried cargo fulfils city demand
 * (or feeds a processor), and the player is paid a fee that scales with real
 * demand, delivery timeliness, and haul distance.
 *
 * Saturation is expressed ONCE: `demand_pressure` falls as a city's backlog is
 * drained by delivery, so over-supplying a good is what makes each successive
 * delivery pay less — there is no second subtractive saturation term to
 * double-count (the review fix to KTD4). The fee is clamped non-negative, so a
 * fully-satisfied city never produces a pay-to-deliver result.
 */
export interface FeeInputs {
  good: GoodId;
  qty: number;
  /** City's current unmet-demand backlog for the good. */
  backlog: number;
  /** City's demand rate per day for the good (0 if undemanded). */
  demandPerDay: number;
  /** Days the cargo spent in transit since loading. */
  transitDays: number;
  /** Tile distance from load origin to delivery. */
  distance: number;
}

const PRESSURE_DAYS = 6; // backlog (in days of demand) at which pressure saturates to 1
const TIMELINESS_DECAY = 0.05; // per transit day
const TIMELINESS_FLOOR = 0.25;
const DISTANCE_WEIGHT = 0.25; // diminishing-returns coefficient on sqrt(distance)

/** Per-delivery fee in integer cents (KTD4). Always >= 0. */
export function computeFee(inputs: FeeInputs): number {
  const { good, qty, backlog, demandPerDay, transitDays, distance } = inputs;
  if (demandPerDay <= 0 || qty <= 0) return 0;

  const demandPressure = Math.min(1, backlog / (demandPerDay * PRESSURE_DAYS));
  const timeliness = Math.max(TIMELINESS_FLOOR, 1 - transitDays * TIMELINESS_DECAY);
  const distanceFactor = 1 + DISTANCE_WEIGHT * Math.sqrt(Math.max(0, distance));

  const base = GOODS[good].baseRate;
  const perUnit = base * demandPressure * timeliness * distanceFactor;
  return Math.max(0, Math.round(perUnit * qty * 100)); // baseRate is in "dollars"; *100 -> cents
}

/** Which industries in a station's catchment consume `good` as an input? */
function processorsWanting(state: GameState, station: Station, good: GoodId) {
  return industriesInCatchment(state, station).filter((ind) => {
    const recipe = RECIPES[ind.type];
    return (recipe.inputs[good] ?? 0) > 0;
  });
}

export const deliverySystem: System = (state) => {
  const day = state.timeDays;
  for (const train of state.trains) {
    if (train.atStationId === null) continue;
    const station = state.stations.find((s) => s.id === train.atStationId);
    if (!station) {
      departTrain(train);
      continue;
    }
    const stop = train.route[train.targetIndex];
    if (stop && stop.unload) unloadCargo(state, train, station, day);
    if (stop) loadCargo(state, train, station, day);
    departTrain(train);
  }
};

function unloadCargo(state: GameState, train: Train, station: Station, day: number): void {
  const cities = citiesInCatchment(state, station);
  const remaining: typeof train.cars = [];

  for (const car of train.cars) {
    let qtyLeft = car.qty;
    const transitDays = Math.max(0, day - car.loadedDay);
    const distance = Math.hypot(car.originX - station.x, car.originY - station.y);

    // 1. Fulfil city demand (paid, demand-coupled).
    for (const city of cities) {
      if (qtyLeft <= 0) break;
      const backlog = city.backlog[car.good] ?? 0;
      const demandPerDay = city.demand[car.good] ?? 0;
      if (demandPerDay <= 0 || backlog <= 0) continue;

      const take = Math.min(qtyLeft, backlog);
      const fee = computeFee({ good: car.good, qty: take, backlog, demandPerDay, transitDays, distance });
      addMoney(state, fee);
      city.backlog[car.good] = backlog - take;
      city.fulfillment[car.good] = Math.min(1, (city.fulfillment[car.good] ?? 0) + take / (demandPerDay * PRESSURE_DAYS));
      qtyLeft -= take;
    }

    // 2. Feed a processor that consumes this good (paid a flat bulk fee).
    if (qtyLeft > 0) {
      const [processor] = processorsWanting(state, station, car.good);
      if (processor) {
        processor.inputStock[car.good] = (processor.inputStock[car.good] ?? 0) + qtyLeft;
        const feed = computeFee({
          good: car.good,
          qty: qtyLeft,
          backlog: qtyLeft * PRESSURE_DAYS,
          demandPerDay: qtyLeft,
          transitDays,
          distance,
        });
        addMoney(state, feed);
        qtyLeft = 0;
      }
    }

    if (qtyLeft > 0) remaining.push({ ...car, qty: qtyLeft });
  }
  train.cars = remaining;
}

function loadCargo(state: GameState, train: Train, station: Station, day: number): void {
  const stop = train.route[train.targetIndex];
  if (!stop || stop.loads.length === 0) return;

  const engineCapacity = train.capacityPerCar; // per-car; simplified single-car-per-good model
  for (const good of stop.loads) {
    const source = industriesInCatchment(state, station).find((i) => i.output === good && i.outputStock >= 1);
    if (!source) continue;
    const take = Math.min(Math.floor(source.outputStock), engineCapacity);
    if (take <= 0) continue;
    source.outputStock -= take;
    train.cars.push({ good, qty: take, originX: station.x, originY: station.y, loadedDay: day });
  }
}
