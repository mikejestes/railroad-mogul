import { describe, it, expect } from 'vitest';
import { GameStore } from '../../src/store/gameStore.ts';
import { applyIntent } from '../../src/store/applyIntents.ts';
import { createGameState } from '../../src/sim/state.ts';

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
