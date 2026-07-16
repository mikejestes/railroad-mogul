import type { System } from '../tick.ts';
import type { GameState } from '../state.ts';
import type { Station } from '../model/track.ts';
import { engineById, totalCargo, type Train } from '../model/trains.ts';
import { findPath, type Tile } from '../pathfinding.ts';
import { segmentWeight } from '../model/track.ts';

/**
 * Movement system (U6, third in the KTD3 pipeline). Advances each train along
 * its resolved shortest path to the next stop, then marks arrival for the
 * delivery system (U7) to process. A heavier consist and higher-terrain-cost
 * routes both slow a train down.
 */
function stationById(state: GameState, id: string): Station | undefined {
  return state.stations.find((s) => s.id === id);
}

/** Effective speed: engine speed reduced as the consist fills toward capacity. */
function effectiveSpeed(train: Train): number {
  const engine = engineById(train.engineId);
  if (!engine) return 0;
  const capacity = engine.power * train.capacityPerCar;
  const loadFactor = capacity > 0 ? totalCargo(train) / capacity : 0;
  return engine.speed / (1 + loadFactor);
}

function resolvePath(state: GameState, train: Train, target: Station): boolean {
  const path = findPath(state, train.x, train.y, target.x, target.y);
  if (!path || path.length === 0) {
    train.path = [];
    return false;
  }
  train.path = path;
  train.pathPos = 0;
  train.distToNext = path.length > 1 ? edgeWeight(state, path[0], path[1]) : 0;
  return true;
}

function edgeWeight(state: GameState, a: Tile, b: Tile): number {
  return segmentWeight(state.world, { ax: a.x, ay: a.y, bx: b.x, by: b.y });
}

export const movementSystem: System = (state, dtDays) => {
  for (const train of state.trains) {
    if (train.route.length < 2) continue;

    // Lazy init: place the train at its first stop and let delivery process it.
    // Guards on the JSON-safe `initialized` flag, not a NaN sentinel, so a
    // train saved before its first tick still re-inits after load (correctness/
    // adversarial finding: NaN -> null across serialize would strand it).
    if (!train.initialized) {
      const origin = stationById(state, train.route[0].stationId);
      if (!origin) continue;
      train.x = origin.x;
      train.y = origin.y;
      train.targetIndex = 0;
      train.atStationId = train.route[0].stationId;
      train.initialized = true;
      continue;
    }

    // Waiting at a station for the delivery system to process and depart it.
    if (train.atStationId !== null) continue;

    const target = stationById(state, train.route[train.targetIndex].stationId);
    if (!target) continue;

    if (train.path.length === 0) {
      if (!resolvePath(state, train, target)) continue; // not connected by track — idle
    }

    let budget = effectiveSpeed(train) * dtDays;
    while (budget > 0 && train.pathPos < train.path.length - 1) {
      if (budget >= train.distToNext) {
        budget -= train.distToNext;
        train.pathPos += 1;
        train.x = train.path[train.pathPos].x;
        train.y = train.path[train.pathPos].y;
        train.distToNext =
          train.pathPos < train.path.length - 1
            ? edgeWeight(state, train.path[train.pathPos], train.path[train.pathPos + 1])
            : 0;
      } else {
        train.distToNext -= budget;
        budget = 0;
      }
    }

    if (train.pathPos >= train.path.length - 1) {
      // Reached the target station tile.
      train.x = target.x;
      train.y = target.y;
      train.atStationId = target.id;
      train.path = [];
    }
  }
};

/**
 * Depart a train from the station it arrived at: advance to the next stop
 * cyclically and clear the arrival marker. Called by the delivery system (U7)
 * after it processes loads/unloads, so a train loops its route.
 */
export function departTrain(train: Train): void {
  train.targetIndex = (train.targetIndex + 1) % train.route.length;
  train.atStationId = null;
  train.path = [];
  train.pathPos = 0;
}
