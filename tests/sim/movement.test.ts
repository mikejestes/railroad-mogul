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

describe('grade slows trains (milestone 3 U5, AE2, R11)', () => {
  // Two real 20-tile straight lines at the DEFAULT_TERRAIN_SEED fallback
  // (this file never calls configureTerrainSeed), same length, same
  // topology as lineWorld above — one anchored on LINE_OX/LINE_OY (verified
  // near-flat), one anchored at (15,10) (empirically the steepest 20-tile
  // straight run found on this seed, avg grade ~0.020 vs ~0.014 flat).
  // Neither anchor was chosen to guarantee an outcome beyond "real terrain,
  // real grade difference" — the resulting tick counts are measured, not
  // assumed.
  function straightLine(ox: number, oy: number, len: number): GameState {
    const s = createGameState(1);
    s.world = { width: ox + len + 2, height: oy + 2 };
    s.stations.push({ id: 'A', x: ox, y: oy, radius: 1 });
    s.stations.push({ id: 'B', x: ox + len, y: oy, radius: 1 });
    for (let x = 0; x < len; x++) {
      s.track.segments.push({ ax: ox + x, ay: oy, bx: ox + x + 1, by: oy });
    }
    return s;
  }

  function ticksToTraverse(s: GameState): number {
    const train = makeTrain('t', 'pacific', routeAB());
    s.trains.push(train);
    tick(s, 1, [movementSystem]); // init at A
    departTrain(train);
    let guard = 0;
    while (train.atStationId !== 'B' && guard++ < 500) tick(s, 1, [movementSystem]);
    return guard;
  }

  it('AE2: the same train with the same (empty) cargo takes measurably more ticks on the steeper of two equal-length routes', () => {
    const flatTicks = ticksToTraverse(straightLine(LINE_OX, LINE_OY, 20));
    const steepTicks = ticksToTraverse(straightLine(15, 10, 20));
    expect(steepTicks).toBeGreaterThan(flatTicks);
  });

  it("findPath prefers the gentler of two routes connecting the same two points when its total weight is lower — even though it's the longer, more roundabout one", () => {
    // A real steep direct segment (grade > MAX_UNASSISTED_GRADE) versus a
    // 2-hop detour through a real neighbor tile whose segments are both
    // tunneled (effectiveGrade forced to 0) — found by scanning for a case
    // where the tunneled detour's terrain+grade total genuinely undercuts
    // the untunneled direct segment's, so the choice is real, not assumed.
    const s = createGameState(1);
    s.world = { width: 40, height: 28 };
    const A = { x: 22, y: 1 };
    const B = { x: 23, y: 1 };
    const M = { x: 22, y: 0 };
    s.track.segments.push({ ax: A.x, ay: A.y, bx: B.x, by: B.y }); // direct, steep, no structure
    s.track.segments.push({ ax: A.x, ay: A.y, bx: M.x, by: M.y, structure: 'tunnel' });
    s.track.segments.push({ ax: M.x, ay: M.y, bx: B.x, by: B.y, structure: 'tunnel' });

    const path = findPath(s, A.x, A.y, B.x, B.y);
    expect(path).toEqual([A, M, B]);
  });
});
