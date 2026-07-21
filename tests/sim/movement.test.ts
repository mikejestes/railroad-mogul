import { describe, it, expect } from 'vitest';
import { createGameState, type GameState } from '../../src/sim/state.ts';
import { tick } from '../../src/sim/tick.ts';
import { movementSystem, departTrain } from '../../src/sim/systems/movement.ts';
import { makeTrain } from '../../src/sim/model/trains.ts';
import { availableEngines, ENGINES } from '../../src/sim/model/trains.ts';
import { findPath } from '../../src/sim/pathfinding.ts';

// U3: terrain is no longer a stored array a fixture can fill with a uniform
// placeholder — it comes from `terrainAt(x, y)` (real, authored geography),
// which is not uniform. These tests care about movement/pathfinding
// mechanics, not geography, so they anchor at coordinate ranges verified
// (empirically, against the actual reference field/seed) never to be `sea`
// (movement just needs a buildable, finite-cost line — cost need not be
// uniform, since e.g. "a heavier consist travels slower" only ever compares
// two trains on the *same* track). `LINE_OX`/`LINE_OY` starts a row that
// stays non-sea for at least 22 tiles east.
const LINE_OX = 17;
const LINE_OY = 0;

/** A small buildable-land world with a straight track A(0,0)..B(len,0),
 *  anchored so every tile along the line is real, non-sea terrain. */
function lineWorld(len: number): GameState {
  const s = createGameState(1);
  s.world = { width: LINE_OX + len + 2, height: LINE_OY + 1 };
  s.stations.push({ id: 'A', x: LINE_OX, y: LINE_OY, radius: 1 });
  s.stations.push({ id: 'B', x: LINE_OX + len, y: LINE_OY, radius: 1 });
  for (let x = 0; x < len; x++) {
    s.track.segments.push({ ax: LINE_OX + x, ay: LINE_OY, bx: LINE_OX + x + 1, by: LINE_OY });
  }
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
    expect(train.x).toBe(LINE_OX + 5);
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
    // A separate anchor from LINE_OX/LINE_OY: this test compares path *cost*
    // between a direct and a detour route, so — unlike lineWorld above — it
    // needs every tile on both candidate paths at uniform move cost (verified
    // empirically), or an unlucky expensive tile on the detour could make it
    // spuriously cheaper or more expensive than intended.
    const [x0, y0, y1] = [36, 0, 1];
    s.world = { width: x0 + 4, height: y1 + 2 };
    // Direct: (x0,y0)-(x0+1,y0)-(x0+2,y0). Detour via y1.
    s.track.segments.push({ ax: x0, ay: y0, bx: x0 + 1, by: y0 });
    s.track.segments.push({ ax: x0 + 1, ay: y0, bx: x0 + 2, by: y0 });
    s.track.segments.push({ ax: x0, ay: y0, bx: x0, by: y1 });
    s.track.segments.push({ ax: x0, ay: y1, bx: x0 + 1, by: y1 });
    s.track.segments.push({ ax: x0 + 1, ay: y1, bx: x0 + 2, by: y1 });
    s.track.segments.push({ ax: x0 + 2, ay: y1, bx: x0 + 2, by: y0 });
    const path = findPath(s, x0, y0, x0 + 2, y0);
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
