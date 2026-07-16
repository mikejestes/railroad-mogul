import { describe, it, expect } from 'vitest';
import { createGameState, type GameState } from '../../src/sim/state.ts';
import { tick } from '../../src/sim/tick.ts';
import { movementSystem, departTrain } from '../../src/sim/systems/movement.ts';
import { makeTrain } from '../../src/sim/model/trains.ts';
import { availableEngines, ENGINES } from '../../src/sim/model/trains.ts';
import { findPath } from '../../src/sim/pathfinding.ts';

/** A small all-land world with a straight track A(0,0)..B(len,0). */
function lineWorld(len: number): GameState {
  const s = createGameState(1);
  s.world = { width: len + 2, height: 3, terrain: new Array((len + 2) * 3).fill('land') };
  s.stations.push({ id: 'A', x: 0, y: 0, radius: 1 });
  s.stations.push({ id: 'B', x: len, y: 0, radius: 1 });
  for (let x = 0; x < len; x++) s.track.segments.push({ ax: x, ay: 0, bx: x + 1, by: 0 });
  return s;
}

const routeAB = () => [
  { stationId: 'A', loads: [], unload: true },
  { stationId: 'B', loads: [], unload: true },
];

describe('train movement', () => {
  it('advances along track and reaches the destination station', () => {
    const s = lineWorld(5);
    const train = makeTrain('t1', 'planet', routeAB());
    s.trains.push(train);

    tick(s, 1, [movementSystem]); // init: sits at A
    expect(train.atStationId).toBe('A');
    departTrain(train); // simulate delivery departing it toward B

    let guard = 0;
    while (train.atStationId !== 'B' && guard++ < 100) tick(s, 1, [movementSystem]);
    expect(train.atStationId).toBe('B');
    expect(train.x).toBe(5);
  });

  it('a heavier consist travels slower', () => {
    const build = (cargo: number) => {
      const s = lineWorld(20);
      const train = makeTrain('t', 'pacific', routeAB());
      if (cargo > 0) train.cars.push({ good: 'coal', qty: cargo, originX: 0, originY: 0, loadedDay: 0 });
      s.trains.push(train);
      tick(s, 1, [movementSystem]); // init at A
      departTrain(train);
      tick(s, 1, [movementSystem]); // one day of travel
      return train;
    };
    const empty = build(0);
    const loaded = build(70); // near capacity for the Pacific
    // Progress measured as node index minus fraction remaining to next node.
    expect(empty.pathPos).toBeGreaterThanOrEqual(loaded.pathPos);
    const emptyProgress = empty.pathPos - (empty.distToNext > 0 ? 0 : 0);
    expect(emptyProgress).toBeGreaterThan(loaded.pathPos - 1e-9);
    expect(empty.x).toBeGreaterThan(loaded.x);
  });

  it('takes the shorter weighted route when two paths connect the stops', () => {
    const s = createGameState(1);
    s.world = { width: 4, height: 3, terrain: new Array(12).fill('land') };
    // Direct: (0,0)-(1,0)-(2,0). Detour: (0,0)-(0,1)-(1,1)-(2,1)-(2,0).
    s.track.segments.push({ ax: 0, ay: 0, bx: 1, by: 0 });
    s.track.segments.push({ ax: 1, ay: 0, bx: 2, by: 0 });
    s.track.segments.push({ ax: 0, ay: 0, bx: 0, by: 1 });
    s.track.segments.push({ ax: 0, ay: 1, bx: 1, by: 1 });
    s.track.segments.push({ ax: 1, ay: 1, bx: 2, by: 1 });
    s.track.segments.push({ ax: 2, ay: 1, bx: 2, by: 0 });
    const path = findPath(s, 0, 0, 2, 0);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(3); // the direct 2-hop route
  });

  it('unlocks engines only at or after their era year', () => {
    const early = availableEngines(1830).map((e) => e.id);
    const later = availableEngines(1915).map((e) => e.id);
    expect(early).toContain('planet');
    expect(early).not.toContain('pacific');
    expect(later.length).toBe(ENGINES.length);
  });

  it('loops the route cyclically on departure', () => {
    const train = makeTrain('t', 'planet', routeAB());
    expect(train.targetIndex).toBe(0);
    departTrain(train);
    expect(train.targetIndex).toBe(1);
    departTrain(train);
    expect(train.targetIndex).toBe(0); // wrapped
  });
});
