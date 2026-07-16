import { describe, it, expect } from 'vitest';
import { GameStore } from '../../src/store/gameStore.ts';
import { applyIntent, buyTrain } from '../../src/store/applyIntents.ts';
import { createGameState, STARTING_CAPITAL, type GameState } from '../../src/sim/state.ts';
import { engineById } from '../../src/sim/model/trains.ts';

/**
 * U10 wiring: the store bridge publishes snapshots to subscribers, and queued
 * player intents apply to sim state. (The React panels are thin views over the
 * selectors already covered in tests/store.)
 */
describe('store bridge and intents (U10)', () => {
  it('notifies subscribers on publish', () => {
    const store = new GameStore(createGameState(1));
    let seen = 0;
    const unsub = store.subscribe(() => (seen += 1));
    store.publish(createGameState(2));
    expect(seen).toBe(1);
    unsub();
    store.publish(createGameState(3));
    expect(seen).toBe(1); // no longer subscribed
  });

  it('queues and drains intents', () => {
    const store = new GameStore(createGameState(1));
    store.dispatch({ kind: 'layTrack', ax: 0, ay: 0, bx: 1, by: 0 });
    store.dispatch({ kind: 'buildStation', x: 1, y: 1, radius: 2 });
    expect(store.drainIntents()).toHaveLength(2);
    expect(store.drainIntents()).toHaveLength(0); // drained
  });

  it('applies a layTrack intent to sim state', () => {
    const s = createGameState(1);
    s.world = { width: 4, height: 2, terrain: new Array(8).fill('land') };
    s.moneyCents = 1_000_000_00;
    applyIntent(s, { kind: 'layTrack', ax: 0, ay: 0, bx: 1, by: 0 });
    expect(s.track.segments).toHaveLength(1);
  });

  it('applies a buildStation intent to sim state', () => {
    const s = createGameState(1);
    s.world = { width: 4, height: 2, terrain: new Array(8).fill('land') };
    s.moneyCents = 1_000_000_00;
    applyIntent(s, { kind: 'buildStation', x: 1, y: 1, radius: 2 });
    expect(s.stations).toHaveLength(1);
    expect(s.stations[0].radius).toBe(2);
  });
});

describe('buy-train flow (U6/U10)', () => {
  function twoStations(): GameState {
    const s = createGameState(1);
    s.moneyCents = STARTING_CAPITAL;
    s.stations.push({ id: 'A', x: 0, y: 0, radius: 1 });
    s.stations.push({ id: 'B', x: 4, y: 0, radius: 1 });
    return s;
  }

  it('creates a train on a valid route and deducts the engine cost', () => {
    const s = twoStations();
    const before = s.moneyCents;
    expect(buyTrain(s, 'planet', ['A', 'B'])).toBe(true);
    expect(s.trains).toHaveLength(1);
    expect(s.trains[0].route.map((r) => r.stationId)).toEqual(['A', 'B']);
    expect(before - s.moneyCents).toBe(engineById('planet')!.cost);
    expect(s.nextTrainId).toBe(1);
  });

  it('rejects an unavailable engine, a too-short route, and an unaffordable buy', () => {
    const s = twoStations();
    expect(buyTrain(s, 'pacific', ['A', 'B'])).toBe(false); // Pacific unlocks in 1915, not 1830
    expect(buyTrain(s, 'planet', ['A'])).toBe(false); // needs >= 2 stops
    expect(buyTrain(s, 'planet', ['A', 'ghost'])).toBe(false); // 'ghost' isn't a real station
    s.moneyCents = 0;
    expect(buyTrain(s, 'planet', ['A', 'B'])).toBe(false); // can't afford
    expect(s.trains).toHaveLength(0);
  });

  it('applies a buyTrain intent through the dispatcher', () => {
    const s = twoStations();
    applyIntent(s, { kind: 'buyTrain', engineId: 'planet', stationIds: ['A', 'B'] });
    expect(s.trains).toHaveLength(1);
  });
});
