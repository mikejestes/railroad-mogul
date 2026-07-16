import { describe, it, expect } from 'vitest';
import { createGameState, type GameState } from '../../src/sim/state.ts';
import { tick } from '../../src/sim/tick.ts';
import { movementSystem, departTrain } from '../../src/sim/systems/movement.ts';
import { deliverySystem, PROCESSOR_INPUT_CAP } from '../../src/sim/systems/delivery.ts';
import { makeTrain, engineById, totalCargo } from '../../src/sim/model/trains.ts';
import { serializeSave, deserializeSave } from '../../src/persistence/saveStore.ts';
import { layTrack, buildStation, segmentWeight, TRACK_COST_PER_SEGMENT, MOUNTAIN_SURCHARGE } from '../../src/sim/model/track.ts';
import { findPath } from '../../src/sim/pathfinding.ts';

function landWorld(w: number, h: number): GameState {
  const s = createGameState(1);
  s.world = { width: w, height: h, terrain: new Array(w * h).fill('land') };
  s.moneyCents = 1_000_000_00;
  return s;
}

describe('review fixes', () => {
  it('a train survives a save round-trip and still initializes (NaN->null fix)', () => {
    const s = landWorld(4, 1);
    s.stations.push({ id: 'A', x: 0, y: 0, radius: 1 });
    s.stations.push({ id: 'B', x: 3, y: 0, radius: 1 });
    for (let x = 0; x < 3; x++) s.track.segments.push({ ax: x, ay: 0, bx: x + 1, by: 0 });
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
    s.stations.push({ id: 'A', x: 0, y: 0, radius: 1 });
    s.stations.push({ id: 'B', x: 3, y: 0, radius: 1 });
    for (let x = 0; x < 3; x++) s.track.segments.push({ ax: x, ay: 0, bx: x + 1, by: 0 });
    // Endless coal at A; B has no coal demand and no coal-consuming processor,
    // so coal is loaded but never delivered — the old bug piled it up forever.
    s.industries.push({ id: 'mine', type: 'coalMine', x: 0, y: 0, output: 'coal', outputStock: 100000, inputStock: {} });
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
    s.stations.push({ id: 'B', x: 1, y: 1, radius: 1 });
    // Steel mill needs iron AND coal; feeding only iron means it never consumes,
    // so inputStock.iron would grow forever without the cap.
    s.industries.push({ id: 'mill', type: 'steelMill', x: 1, y: 1, output: 'steel', outputStock: 0, inputStock: {} });

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
    s.stations.push({ id: 'B', x: 1, y: 1, radius: 1 });
    s.industries.push({ id: 'mill', type: 'steelMill', x: 1, y: 1, output: 'steel', outputStock: 0, inputStock: {} });
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
    const s = landWorld(3, 1);
    s.world.terrain[1] = 'mountain'; // tile (1,0)
    const before = s.moneyCents;
    expect(layTrack(s, 0, 0, 1, 0)).toBe(true); // land -> mountain
    expect(before - s.moneyCents).toBe(TRACK_COST_PER_SEGMENT + MOUNTAIN_SURCHARGE);

    const mountainSeg = segmentWeight(s.world, { ax: 0, ay: 0, bx: 1, by: 0 });
    const landSeg = segmentWeight({ width: 3, height: 1, terrain: ['land', 'land', 'land'] }, { ax: 0, ay: 0, bx: 1, by: 0 });
    expect(mountainSeg).toBeGreaterThan(landSeg);
  });

  it('building over sea is rejected; cost only charged on success', () => {
    const s = landWorld(3, 1);
    s.world.terrain[2] = 'sea';
    const before = s.moneyCents;
    expect(buildStation(s, 'x', 2, 0, 2)).toBe(false);
    expect(s.moneyCents).toBe(before); // no charge on a rejected build
  });

  it('pathfinding: unreachable returns null, same tile returns a single node', () => {
    const s = landWorld(4, 1);
    s.track.segments.push({ ax: 0, ay: 0, bx: 1, by: 0 }); // A-region
    // No track reaching (3,0).
    expect(findPath(s, 0, 0, 3, 0)).toBeNull();
    expect(findPath(s, 2, 0, 2, 0)).toEqual([{ x: 2, y: 0 }]); // start === goal
  });

  it('a train targeting a station not connected by track idles without crashing', () => {
    const s = landWorld(6, 1);
    s.stations.push({ id: 'A', x: 0, y: 0, radius: 1 });
    s.stations.push({ id: 'B', x: 5, y: 0, radius: 1 });
    // No track between A and B.
    const train = makeTrain('t', 'planet', [
      { stationId: 'A', loads: [], unload: true },
      { stationId: 'B', loads: [], unload: true },
    ]);
    s.trains.push(train);
    tick(s, 1, [movementSystem]); // init at A
    departTrain(train); // head toward B (targetIndex -> 1), which has no track
    for (let i = 0; i < 20; i++) tick(s, 1, [movementSystem]); // no path -> idles
    expect(train.x).toBe(0); // never moved
    expect(train.atStationId).toBeNull();
  });
});
