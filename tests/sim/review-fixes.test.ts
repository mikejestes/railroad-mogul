import { describe, it, expect } from 'vitest';
import { createGameState, type GameState } from '../../src/sim/state.ts';
import { tick } from '../../src/sim/tick.ts';
import { movementSystem, departTrain } from '../../src/sim/systems/movement.ts';
import { deliverySystem, PROCESSOR_INPUT_CAP } from '../../src/sim/systems/delivery.ts';
import { makeTrain, engineById, totalCargo } from '../../src/sim/model/trains.ts';
import { serializeSave, deserializeSave } from '../../src/persistence/saveStore.ts';
import { layTrack, buildStation, segmentWeight, TRACK_COST_PER_SEGMENT, MOUNTAIN_SURCHARGE } from '../../src/sim/model/track.ts';
import { findPath } from '../../src/sim/pathfinding.ts';
import { terrainAt, GRID_WIDTH, GRID_HEIGHT } from '../../src/world/geography.ts';

// U3: terrain is no longer a stored array a fixture can fill with a uniform
// placeholder — it comes from `terrainAt(x, y)` (real, authored geography).
// Anchor at (OX, OY), a coordinate block verified (empirically, against the
// actual reference field/seed) entirely sea-free for at least a 6x3 span,
// rather than the tile origin (open Atlantic).
const OX = 17;
const OY = 0;

type Tile = { x: number; y: number };
/** First horizontally-adjacent tile pair (scanning the grid in row-major
 *  order) whose two tiles satisfy `pred`, or null if none does. Lets a test
 *  locate a terrain feature by property instead of by a hardcoded coordinate
 *  that terrain tuning could invalidate. */
function findAdjacent(pred: (a: Tile, b: Tile) => boolean): { a: Tile; b: Tile } | null {
  for (let y = 0; y < GRID_HEIGHT; y++) {
    for (let x = 0; x < GRID_WIDTH - 1; x++) {
      const a = { x, y };
      const b = { x: x + 1, y };
      if (pred(a, b)) return { a, b };
    }
  }
  return null;
}

function landWorld(w: number, h: number): GameState {
  const s = createGameState(1);
  s.world = { width: OX + w, height: OY + h };
  s.moneyCents = 1_000_000_00;
  return s;
}

describe('review fixes', () => {
  it('a train survives a save round-trip and still initializes (NaN->null fix)', () => {
    const s = landWorld(4, 1);
    s.stations.push({ id: 'A', x: OX, y: OY, radius: 1 });
    s.stations.push({ id: 'B', x: OX + 3, y: OY, radius: 1 });
    for (let x = 0; x < 3; x++) s.track.segments.push({ ax: OX + x, ay: OY, bx: OX + x + 1, by: OY });
    s.trains.push(makeTrain('t', 'planet', [
      { stationId: 'A', loads: [], unload: true },
      { stationId: 'B', loads: [], unload: true },
    ]));

    const restored = deserializeSave(serializeSave(s));
    expect(restored.trains[0].initialized).toBe(false); // JSON-safe, not NaN->null
    tick(restored, 1, [movementSystem]);
    expect(restored.trains[0].initialized).toBe(true); // re-initialized, not stranded
    expect(restored.trains[0].atStationId).toBe('A');
  });

  it('cargo never exceeds engine capacity across loops (unbounded-load fix)', () => {
    const s = landWorld(4, 1);
    s.stations.push({ id: 'A', x: OX, y: OY, radius: 1 });
    s.stations.push({ id: 'B', x: OX + 3, y: OY, radius: 1 });
    for (let x = 0; x < 3; x++) s.track.segments.push({ ax: OX + x, ay: OY, bx: OX + x + 1, by: OY });
    // Endless coal at A; B has no coal demand and no coal-consuming processor,
    // so coal is loaded but never delivered — the old bug piled it up forever.
    s.industries.push({
      id: 'mine',
      type: 'coalMine',
      x: OX,
      y: OY,
      output: 'coal',
      outputStock: 100000,
      inputStock: {},
    });
    const train = makeTrain('t', 'american', [
      { stationId: 'A', loads: ['coal'], unload: true },
      { stationId: 'B', loads: [], unload: true },
    ]);
    s.trains.push(train);

    const cap = engineById('american')!.power * train.capacityPerCar;
    for (let i = 0; i < 400; i++) {
      tick(s, 1, [movementSystem, deliverySystem]);
      expect(totalCargo(train)).toBeLessThanOrEqual(cap);
    }
  });

  it('feeding a processor is capped and stops paying past headroom (unbounded-input fix)', () => {
    const s = landWorld(3, 3);
    s.stations.push({ id: 'B', x: OX + 1, y: OY + 1, radius: 1 });
    // Steel mill needs iron AND coal; feeding only iron means it never consumes,
    // so inputStock.iron would grow forever without the cap.
    s.industries.push({
      id: 'mill',
      type: 'steelMill',
      x: OX + 1,
      y: OY + 1,
      output: 'steel',
      outputStock: 0,
      inputStock: {},
    });

    const feed = () => {
      const train = makeTrain('t', 'american', [
        { stationId: 'B', loads: [], unload: true },
        { stationId: 'B', loads: [], unload: true },
      ]);
      train.initialized = true;
      train.atStationId = 'B';
      train.targetIndex = 0;
      train.cars = [{ good: 'iron', qty: 8, originX: 0, originY: 0, loadedDay: 0 }];
      s.trains = [train];
      deliverySystem(s, 1);
    };

    for (let i = 0; i < 30; i++) feed();
    const mill = s.industries[0];
    expect(mill.inputStock.iron!).toBeLessThanOrEqual(PROCESSOR_INPUT_CAP);

    const cashAtCap = s.moneyCents;
    feed(); // once more, already at cap
    expect(s.moneyCents).toBe(cashAtCap); // no pay for input it can't buffer
  });

  it('delivering a raw good to a processor stocks it and pays (untested branch)', () => {
    const s = landWorld(3, 3);
    s.stations.push({ id: 'B', x: OX + 1, y: OY + 1, radius: 1 });
    s.industries.push({
      id: 'mill',
      type: 'steelMill',
      x: OX + 1,
      y: OY + 1,
      output: 'steel',
      outputStock: 0,
      inputStock: {},
    });
    const train = makeTrain('t', 'american', [
      { stationId: 'B', loads: [], unload: true },
      { stationId: 'B', loads: [], unload: true },
    ]);
    train.initialized = true;
    train.atStationId = 'B';
    train.targetIndex = 0;
    train.cars = [{ good: 'iron', qty: 6, originX: 0, originY: 0, loadedDay: 0 }];
    s.trains.push(train);

    const before = s.moneyCents;
    deliverySystem(s, 1);
    expect(s.industries[0].inputStock.iron!).toBe(6);
    expect(s.moneyCents).toBeGreaterThan(before);
  });

  it('mountain track costs a surcharge and weighs more for routing', () => {
    // Terrain is derived from the seed, so this scans for a real mountain tile
    // with a non-sea neighbour (a buildable segment with a mountain endpoint)
    // rather than hardcoding a coordinate that a later terrain-tuning change
    // could reclassify. `createGameState` does not configure a seed, so this
    // runs against the module's default terrain (see geography.ts).
    const mountainSeg = findAdjacent((a, b) => (terrainAt(a.x, a.y) === 'mountain' || terrainAt(b.x, b.y) === 'mountain'));
    expect(mountainSeg, 'default terrain has no buildable mountain segment').not.toBeNull();
    const { a: m0, b: m1 } = mountainSeg!;

    const s = createGameState(1);
    s.world = { width: GRID_WIDTH, height: GRID_HEIGHT };
    s.moneyCents = 1_000_000_00;
    const before = s.moneyCents;
    expect(layTrack(s, m0.x, m0.y, m1.x, m1.y)).toBe(true); // buildable -> mountain
    expect(before - s.moneyCents).toBe(TRACK_COST_PER_SEGMENT + MOUNTAIN_SURCHARGE);

    // A non-mountain, non-sea segment for an apples-to-apples "mountain costs
    // more" comparison.
    const flat = findAdjacent(
      (a, b) => terrainAt(a.x, a.y) !== 'sea' && terrainAt(b.x, b.y) !== 'sea' && terrainAt(a.x, a.y) !== 'mountain' && terrainAt(b.x, b.y) !== 'mountain',
    );
    expect(flat).not.toBeNull();
    const mountainWeight = segmentWeight(s.world, { ax: m0.x, ay: m0.y, bx: m1.x, by: m1.y });
    const flatWeight = segmentWeight(s.world, { ax: flat!.a.x, ay: flat!.a.y, bx: flat!.b.x, by: flat!.b.y });
    expect(mountainWeight).toBeGreaterThan(flatWeight);
  });

  it('building over sea is rejected; cost only charged on success', () => {
    const s = landWorld(3, 1);
    const before = s.moneyCents;
    // x=0 (lon -11) sits west of every authored landmass box at any
    // latitude — always sea, regardless of the (OX, OY) buildable anchor.
    expect(buildStation(s, 'x', 0, OY, 2)).toBe(false);
    expect(s.moneyCents).toBe(before); // no charge on a rejected build
  });

  it('pathfinding: unreachable returns null, same tile returns a single node', () => {
    const s = landWorld(4, 1);
    s.track.segments.push({ ax: OX, ay: OY, bx: OX + 1, by: OY }); // A-region
    // No track reaching (OX+3, OY).
    expect(findPath(s, OX, OY, OX + 3, OY)).toBeNull();
    expect(findPath(s, OX + 2, OY, OX + 2, OY)).toEqual([{ x: OX + 2, y: OY }]); // start === goal
  });

  it('a train targeting a station not connected by track idles without crashing', () => {
    const s = landWorld(6, 1);
    s.stations.push({ id: 'A', x: OX, y: OY, radius: 1 });
    s.stations.push({ id: 'B', x: OX + 5, y: OY, radius: 1 });
    // No track between A and B.
    const train = makeTrain('t', 'planet', [
      { stationId: 'A', loads: [], unload: true },
      { stationId: 'B', loads: [], unload: true },
    ]);
    s.trains.push(train);
    tick(s, 1, [movementSystem]); // init at A
    departTrain(train); // head toward B (targetIndex -> 1), which has no track
    for (let i = 0; i < 20; i++) tick(s, 1, [movementSystem]); // no path -> idles
    expect(train.x).toBe(OX); // never moved
    expect(train.atStationId).toBeNull();
  });
});
