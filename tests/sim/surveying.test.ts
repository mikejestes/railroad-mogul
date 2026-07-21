import { describe, it, expect } from 'vitest';
import { createGameState, type GameState } from '../../src/sim/state.ts';
import { configureTerrainSeed, GRID_WIDTH, GRID_HEIGHT, terrainAt } from '../../src/world/geography.ts';
import { buildRiverGraph } from '../../src/world/rivers.ts';
import { makeCity } from '../../src/sim/model/cities.ts';
import { stepCost } from '../../src/sim/model/trackCost.ts';
import { surveyRoute } from '../../src/sim/surveying.ts';

/**
 * Local factory: a real, fully-generated substrate at the canonical grid
 * size, anchored to seed 7 (the coordinates below were found by scanning
 * this seed's actual reference field and, for the AE1 fixture, by running
 * `surveyRoute` itself — not hand-picked — per repo convention).
 */
const SEED = 7;

function surveyState(): GameState {
  configureTerrainSeed(SEED);
  const s = createGameState(SEED);
  s.world = { width: GRID_WIDTH, height: GRID_HEIGHT };
  s.rivers = buildRiverGraph(SEED, GRID_WIDTH, GRID_HEIGHT);
  return s;
}

describe('surveyRoute refusals (U3, R5, KTD3)', () => {
  it("AE4: an endpoint on sea refuses with 'endpoint-on-sea', at either end, never an empty path", () => {
    const first = surveyRoute(surveyState(), [{ x: 0, y: 0 }, { x: 17, y: 0 }]);
    expect(first).toEqual({ ok: false, reason: 'endpoint-on-sea' });

    const last = surveyRoute(surveyState(), [{ x: 17, y: 0 }, { x: 0, y: 0 }]);
    expect(last).toEqual({ ok: false, reason: 'endpoint-on-sea' });
  });

  it("AE4: an intermediate waypoint on sea refuses with 'waypoint-on-sea', distinct from an endpoint refusal", () => {
    const result = surveyRoute(surveyState(), [{ x: 17, y: 0 }, { x: 0, y: 0 }, { x: 18, y: 0 }]);
    expect(result).toEqual({ ok: false, reason: 'waypoint-on-sea' });
  });

  it("AE4: two land tiles the world's bounds genuinely disconnect refuse with 'no-path'", () => {
    // Both (17,0) and (17,17) are real, non-sea tiles at seed 7 — the refusal
    // is not about terrain but about state.world's bounds: A* never expands
    // past height 10, so the goal (y=17) can never be reached from the start
    // (y=0), exactly as `canLayTrack`'s own inBounds check would also refuse
    // a segment outside `state.world`.
    const s = surveyState();
    s.world = { width: GRID_WIDTH, height: 10 };
    expect(terrainAt(17, 0)).not.toBe('sea');
    expect(terrainAt(17, 17)).not.toBe('sea');
    const result = surveyRoute(s, [{ x: 17, y: 0 }, { x: 17, y: 17 }]);
    expect(result).toEqual({ ok: false, reason: 'no-path' });
  });

  it('fewer than two waypoints refuses rather than throwing', () => {
    expect(surveyRoute(surveyState(), [])).toEqual({ ok: false, reason: 'no-path' });
    expect(surveyRoute(surveyState(), [{ x: 17, y: 0 }])).toEqual({ ok: false, reason: 'no-path' });
  });
});

describe('surveyRoute success shape (U3, R1, R3)', () => {
  const PARIS = { x: 15, y: 12 };
  const LYON = { x: 18, y: 16 };

  it('two land endpoints on the same landmass return a connected, 8-adjacent path from start to end inclusive', () => {
    const result = surveyRoute(surveyState(), [PARIS, LYON]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path[0]).toEqual(PARIS);
    expect(result.path[result.path.length - 1]).toEqual(LYON);
    for (let i = 1; i < result.path.length; i++) {
      const dx = Math.abs(result.path[i].x - result.path[i - 1].x);
      const dy = Math.abs(result.path[i].y - result.path[i - 1].y);
      expect(Math.max(dx, dy)).toBe(1); // 8-adjacent, never a jump
    }
    expect(result.steps.length).toBe(result.path.length - 1);
    expect(result.totalCents).toBe(result.steps.reduce((n, s) => n + s.totalCents, 0));
  });

  it("adding a waypoint off the direct line produces a path through that waypoint, at cost >= the unconstrained path (R3's adjust-and-see-update)", () => {
    const s = surveyState();
    const detourWaypoint = { x: 16, y: 12 };
    s.cities.push(makeCity('mid', 'Mid', detourWaypoint.x, detourWaypoint.y, 2));

    const direct = surveyRoute(s, [PARIS, LYON]);
    const withWaypoint = surveyRoute(s, [PARIS, detourWaypoint, LYON]);
    expect(direct.ok).toBe(true);
    expect(withWaypoint.ok).toBe(true);
    if (!direct.ok || !withWaypoint.ok) return;

    expect(withWaypoint.path.some((t) => t.x === detourWaypoint.x && t.y === detourWaypoint.y)).toBe(true);
    expect(withWaypoint.totalCents).toBeGreaterThanOrEqual(direct.totalCents);
  });

  it("the chosen path's total cost is <= a hand-built Manhattan alternative between the same endpoints (optimality spot check)", () => {
    const s = surveyState();
    const result = surveyRoute(s, [PARIS, LYON]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Hand-built alternative: move along x first, then along y — a valid,
    // real (non-A*) buildable path between the same two points.
    let manualTotal = 0;
    let cx = PARIS.x;
    let cy = PARIS.y;
    while (cx !== LYON.x) {
      const nx = cx + Math.sign(LYON.x - cx);
      manualTotal += stepCost(s, { x: cx, y: cy }, { x: nx, y: cy }).totalCents;
      cx = nx;
    }
    while (cy !== LYON.y) {
      const ny = cy + Math.sign(LYON.y - cy);
      manualTotal += stepCost(s, { x: cx, y: cy }, { x: cx, y: ny }).totalCents;
      cy = ny;
    }
    expect(result.totalCents).toBeLessThanOrEqual(manualTotal);
  });

  it('AE1: neither of two candidate routes between the same endpoints dominates — one is cheaper and steeper, the other pricier and flatter', () => {
    // Direct Paris-Lyon crosses real elevated terrain at seed 7 (a tunnel is
    // itemized). A waypoint into nearby priced land (a synthetic tier-2 city
    // at the detour point, per R9's interim proxy) produces a real
    // alternative: longer, more expensive (more land cost), but flatter.
    const s = surveyState();
    const detourWaypoint = { x: 16, y: 12 };
    s.cities.push(makeCity('mid', 'Mid', detourWaypoint.x, detourWaypoint.y, 2));

    const direct = surveyRoute(s, [PARIS, LYON]);
    const detour = surveyRoute(s, [PARIS, detourWaypoint, LYON]);
    expect(direct.ok).toBe(true);
    expect(detour.ok).toBe(true);
    if (!direct.ok || !detour.ok) return;

    expect(direct.steps.some((step) => step.structure)).toBe(true); // AE3 substrate: a real structure is itemized

    // Neither dominates: direct wins on cost, detour wins on grade.
    expect(direct.totalCents).toBeLessThan(detour.totalCents);
    expect(direct.maxGrade).toBeGreaterThan(detour.maxGrade);

    const directLand = direct.steps.reduce((n, step) => n + step.landCents, 0);
    const detourLand = detour.steps.reduce((n, step) => n + step.landCents, 0);
    expect(detourLand).toBeGreaterThan(directLand); // the flatter route paid for developed land instead
  });

  it('the grade profile is cumulative distance/elevation, starting at zero and monotonically non-decreasing in distance', () => {
    const result = surveyRoute(surveyState(), [PARIS, LYON]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.length).toBe(result.path.length);
    expect(result.profile[0].distance).toBe(0);
    for (let i = 1; i < result.profile.length; i++) {
      expect(result.profile[i].distance).toBeGreaterThan(result.profile[i - 1].distance);
    }
  });
});

describe('surveyRoute purity and determinism (U3, KTD2, KTD3)', () => {
  const PARIS = { x: 15, y: 12 };
  const LYON = { x: 18, y: 16 };

  it('surveying the same state and waypoints twice returns identical results', () => {
    const s = surveyState();
    const a = surveyRoute(s, [PARIS, LYON]);
    const b = surveyRoute(s, [PARIS, LYON]);
    expect(a).toEqual(b);
  });

  it('surveying after unrelated state mutations (money, tick) returns the same result', () => {
    const s = surveyState();
    const before = surveyRoute(s, [PARIS, LYON]);
    s.moneyCents += 12_345_00;
    s.tick += 7;
    const after = surveyRoute(s, [PARIS, LYON]);
    expect(after).toEqual(before);
  });
});
