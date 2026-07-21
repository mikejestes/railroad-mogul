import { describe, it, expect } from 'vitest';
import { SurveyController } from '../../src/render/surveyController.ts';
import { createGameState, type GameState } from '../../src/sim/state.ts';
import { configureTerrainSeed, GRID_WIDTH, GRID_HEIGHT } from '../../src/world/geography.ts';
import { buildRiverGraph } from '../../src/world/rivers.ts';

// Real, non-sea, buildable tiles at the DEFAULT_TERRAIN_SEED fallback (this
// file never calls configureTerrainSeed until surveyState() below, matching
// tests/sim/track.test.ts's OX/OY convention).
const A = { x: 17, y: 0 };
const B = { x: 18, y: 0 };
const C = { x: 19, y: 0 };

function surveyState(): GameState {
  configureTerrainSeed(7);
  const s = createGameState(7);
  s.world = { width: GRID_WIDTH, height: GRID_HEIGHT };
  s.rivers = buildRiverGraph(7, GRID_WIDTH, GRID_HEIGHT);
  return s;
}

describe('SurveyController state machine (U6, KTD9)', () => {
  it('starts inactive with no proposal', () => {
    const c = new SurveyController();
    expect(c.active).toBe(false);
    expect(c.proposalFor(surveyState())).toBeNull();
  });

  it('a single click anchors but proposes nothing yet (Idle -> Anchored)', () => {
    const c = new SurveyController();
    c.click(A);
    expect(c.active).toBe(true);
    expect(c.proposalFor(surveyState())).toBeNull(); // one waypoint: nothing to price yet
  });

  it('hovering after an anchor proposes a route through the cursor tile (Anchored -> Proposing)', () => {
    const c = new SurveyController();
    c.click(A);
    c.hover(B);
    const proposal = c.proposalFor(surveyState());
    expect(proposal).not.toBeNull();
    expect(proposal!.waypoints).toEqual([A, B]);
  });

  it('hovering before any anchor is a no-op', () => {
    const c = new SurveyController();
    const before = c.getVersion();
    c.hover(A);
    expect(c.getVersion()).toBe(before);
    expect(c.active).toBe(false);
  });

  it('a second click locks in the hovered tile as a permanent waypoint (Proposing -> Proposing)', () => {
    const c = new SurveyController();
    c.click(A);
    c.hover(B);
    c.click(B);
    // Locked at [A, B] now; hovering a third tile previews [A, B, C].
    c.hover(C);
    const proposal = c.proposalFor(surveyState());
    expect(proposal!.waypoints).toEqual([A, B, C]);
  });

  it('reset clears a pending survey back to Idle, and is a no-op (no version bump) when already idle', () => {
    const c = new SurveyController();
    c.click(A);
    c.hover(B);
    const v1 = c.getVersion();
    c.reset();
    expect(c.active).toBe(false);
    expect(c.proposalFor(surveyState())).toBeNull();
    expect(c.getVersion()).toBeGreaterThan(v1);

    const v2 = c.getVersion();
    c.reset();
    expect(c.getVersion()).toBe(v2); // no-op: nothing was pending
  });

  it('bumps its version on click, hover, and a real reset, notifying subscribers', () => {
    const c = new SurveyController();
    let notifications = 0;
    const unsub = c.subscribe(() => (notifications += 1));

    c.click(A);
    c.hover(B);
    c.click(B);
    c.reset();
    expect(notifications).toBe(4);

    unsub();
    c.click(A);
    expect(notifications).toBe(4); // no longer subscribed
  });

  it('proposalFor is a pure preview of surveyRoute — re-running it against unrelated state mutations returns the same result', () => {
    const c = new SurveyController();
    c.click(A);
    c.hover(B);
    const s = surveyState();
    const before = c.proposalFor(s);
    s.moneyCents += 500;
    const after = c.proposalFor(s);
    expect(after).toEqual(before);
  });
});
