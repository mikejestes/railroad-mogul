import { describe, it, expect } from 'vitest';
import { GameStore } from '../../src/store/gameStore.ts';
import { applyIntent, buyTrain } from '../../src/store/applyIntents.ts';
import { createGameState, STARTING_CAPITAL, type GameState } from '../../src/sim/state.ts';
import { engineById } from '../../src/sim/model/trains.ts';
import { refusalMessage, summarizeSteps, structureBreakdown } from '../../src/ui/panels/SurveyPanel.tsx';
import type { SurveyRefusalReason } from '../../src/sim/surveying.ts';
import type { StepCost } from '../../src/sim/model/trackCost.ts';

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

  // U3: terrain is no longer a stored array a fixture can fill with a
  // uniform placeholder — it comes from `terrainAt(x, y)` (real, authored
  // geography). Anchor at a coordinate range verified never to be sea (see
  // tests/sim/movement.test.ts's LINE_OX/LINE_OY) rather than the tile
  // origin (open Atlantic).
  const OX = 17;
  const OY = 0;

  it('applies a layTrack intent to sim state', () => {
    const s = createGameState(1);
    s.world = { width: OX + 4, height: OY + 2 };
    s.moneyCents = 1_000_000_00;
    applyIntent(s, { kind: 'layTrack', ax: OX, ay: OY, bx: OX + 1, by: OY });
    expect(s.track.segments).toHaveLength(1);
  });

  it('applies a buildStation intent to sim state', () => {
    const s = createGameState(1);
    s.world = { width: OX + 4, height: OY + 2 };
    s.moneyCents = 1_000_000_00;
    applyIntent(s, { kind: 'buildStation', x: OX + 1, y: OY + 1, radius: 2 });
    expect(s.stations).toHaveLength(1);
    expect(s.stations[0].radius).toBe(2);
  });

  it('threads stationType end to end: intent -> stored station (milestone 5 U1, R4)', () => {
    const s = createGameState(1);
    s.world = { width: OX + 4, height: OY + 2 };
    s.moneyCents = 1_000_000_00;
    applyIntent(s, { kind: 'buildStation', x: OX + 1, y: OY + 1, radius: 2, stationType: 'passenger' });
    expect(s.stations[0].stationType).toBe('passenger');
  });

  it('a buildStation intent with no stationType stores the mixed default', () => {
    const s = createGameState(1);
    s.world = { width: OX + 4, height: OY + 2 };
    s.moneyCents = 1_000_000_00;
    applyIntent(s, { kind: 'buildStation', x: OX + 1, y: OY + 1, radius: 2 });
    expect(s.stations[0].stationType).toBe('mixed');
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

describe('SurveyPanel content logic (milestone 3 U6, AE3/AE4, KTD7)', () => {
  // Per the repo's no-rendering-tests policy, SurveyPanel's JSX itself is
  // untested — these are the pure functions that decide *what* it shows,
  // the same split worldRenderer.ts's predicates already use.
  function makeStep(overrides: Partial<StepCost> = {}): StepCost {
    return {
      baseCents: 100,
      terrainCents: 20,
      gradeCents: 5,
      structureCents: 0,
      landCents: 10,
      totalCents: 135,
      rawGrade: 0.01,
      effectiveGrade: 0.01,
      ...overrides,
    };
  }

  it('every refusal reason maps to a distinct, human-readable message', () => {
    const reasons: SurveyRefusalReason[] = ['endpoint-on-sea', 'waypoint-on-sea', 'no-path'];
    const messages = reasons.map(refusalMessage);
    expect(new Set(messages).size).toBe(reasons.length); // all distinct
    for (const m of messages) {
      expect(m.length).toBeGreaterThan(0);
      expect(m).not.toMatch(/^undefined$/);
    }
  });

  it('summarizeSteps sums each category across steps, and the categories sum to the total (itemization completeness)', () => {
    const steps = [makeStep(), makeStep({ baseCents: 200, terrainCents: 40, gradeCents: 10, landCents: 20, totalCents: 270 })];
    const totals = summarizeSteps(steps);
    expect(totals).toEqual({
      baseCents: 300,
      terrainCents: 60,
      gradeCents: 15,
      structureCents: 0,
      landCents: 30,
      totalCents: 405,
    });
    expect(totals.baseCents + totals.terrainCents + totals.gradeCents + totals.structureCents + totals.landCents).toBe(
      totals.totalCents,
    );
  });

  it('summarizeSteps on an empty step list is all zero', () => {
    expect(summarizeSteps([])).toEqual({
      baseCents: 0,
      terrainCents: 0,
      gradeCents: 0,
      structureCents: 0,
      landCents: 0,
      totalCents: 0,
    });
  });

  it("AE3: a proposal whose steps include a bridge shows a bridge line item, distinct from other structures", () => {
    const steps = [
      makeStep({ structure: 'bridge', structureCents: 12_000, totalCents: 12_135 }),
      makeStep({ structure: 'tunnel', structureCents: 30_000, totalCents: 30_135 }),
      makeStep(), // plain step: contributes nothing to the breakdown
    ];
    const breakdown = structureBreakdown(steps);
    expect(breakdown.bridge).toBe(12_000);
    expect(breakdown.tunnel).toBe(30_000);
    expect(breakdown.cutting).toBeUndefined();
  });

  it('structureBreakdown is empty when no step carries a structure', () => {
    expect(structureBreakdown([makeStep(), makeStep()])).toEqual({});
  });
});
