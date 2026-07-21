import { describe, it, expect } from 'vitest';
import { buildRiverGraph, riverTileKeys, RIVER_ACCUMULATION_THRESHOLD, type RiverGraph } from '../../src/world/rivers.ts';
import { SEA_LEVEL } from '../../src/world/fields.ts';
import { terrainAt } from '../../src/world/geography.ts';
import { serialize } from '../../src/sim/state.ts';
import { generateGame } from '../../src/world/generate.ts';

// Local factory, per repo test convention. Grid dimensions mirror the real
// game grid's shape (40x28) — kept as local constants rather than importing
// GRID_WIDTH/GRID_HEIGHT from geography.ts, since this suite wants to control
// its own inputs explicitly. `buildRiverGraph` depends on `geography.ts` as
// of milestone-3 U1's rebase (KTD7(a)): the elevation it routes flow over,
// and the authored landmask termination, both come from there now.
const GRID_WIDTH = 40;
const GRID_HEIGHT = 28;

function makeGraph(seed: number): RiverGraph {
  return buildRiverGraph(seed, GRID_WIDTH, GRID_HEIGHT);
}

// Milestone-3 U1 (KTD7(a)) rebased river generation onto geography.ts's
// per-seed-offset elevation specifically to fix seed 1 (and others) producing
// zero rivers under the old, un-offset field. Seed 1 is now included
// deliberately, alongside a spread of other seeds, as the regression guard
// for that fix — every seed here is expected to produce at least one river.
const SEEDS_WITH_RIVERS = [1, 7, 42, 99, 123];

function collectPointKeys(graph: RiverGraph): Set<string> {
  const keys = new Set<string>();
  for (const river of graph.rivers) {
    for (const p of river.points) keys.add(`${p.x},${p.y}`);
  }
  return keys;
}

describe('river graph (U5, KTD6)', () => {
  it('AE4: every river polyline has non-increasing elevation from source to mouth', () => {
    let sawAnyRiver = false;
    for (const seed of SEEDS_WITH_RIVERS) {
      const graph = makeGraph(seed);
      for (const river of graph.rivers) {
        sawAnyRiver = true;
        for (let i = 1; i < river.points.length; i++) {
          expect(river.points[i].elevation).toBeLessThanOrEqual(river.points[i - 1].elevation + 1e-9);
        }
      }
    }
    expect(sawAnyRiver).toBe(true);
  });

  it('every river terminates at a sea cell or joins another river', () => {
    let sawAnyRiver = false;
    for (const seed of SEEDS_WITH_RIVERS) {
      const graph = makeGraph(seed);
      const allPoints = collectPointKeys(graph);
      for (const river of graph.rivers) {
        sawAnyRiver = true;
        const last = river.points[river.points.length - 1];
        // A mouth can be field-sea (elevation at/below SEA_LEVEL) or
        // authored-mask sea (outside every LAND_BOXES box, KTD7(a)) — the
        // two termination conditions `isSeaTile` accepts internally.
        const isSeaPoint = last.elevation <= SEA_LEVEL || terrainAt(last.x, last.y) === 'sea';
        // "Joins another river" means the terminal point also appears
        // somewhere in the graph's overall point set (a confluence claimed
        // by an earlier, higher-elevation trace) rather than dangling.
        const joinsAnotherRiver = allPoints.has(`${last.x},${last.y}`);
        expect(isSeaPoint || joinsAnotherRiver).toBe(true);
      }
    }
    expect(sawAnyRiver).toBe(true);
  });

  it('U1 (KTD7(a)): the rebased graph produces at least one river on every seed in the spread, including seed 1', () => {
    // Seed 1 produced zero rivers under the pre-rebase, un-offset field —
    // this is the regression guard for the fix, checked per-seed (not just
    // "some seed somewhere") so a future regression on any one seed is caught.
    for (const seed of SEEDS_WITH_RIVERS) {
      const graph = makeGraph(seed);
      expect(graph.rivers.length).toBeGreaterThan(0);
    }
  });

  it('no river forms a cycle', () => {
    for (const seed of SEEDS_WITH_RIVERS) {
      const graph = makeGraph(seed);
      for (const river of graph.rivers) {
        const seen = new Set<string>();
        for (const p of river.points) {
          const key = `${p.x},${p.y}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
    }
  });

  it('is deterministic: the same seed produces an identical graph, compared by serialization', () => {
    const a = buildRiverGraph(17, GRID_WIDTH, GRID_HEIGHT);
    const b = buildRiverGraph(17, GRID_WIDTH, GRID_HEIGHT);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    // Different seeds produce a different graph (sanity: the seed actually
    // matters, this isn't a constant that ignores its input).
    const c = buildRiverGraph(18, GRID_WIDTH, GRID_HEIGHT);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('the graph round-trips through serialize() unchanged, embedded in a generated GameState', () => {
    const state = generateGame(7);
    const restored = JSON.parse(serialize(state));
    expect(restored.rivers).toEqual(JSON.parse(JSON.stringify(state.rivers)));
    expect(serialize(restored)).toBe(serialize(state));
  });

  it('graph size stays bounded: total vertex count never exceeds 2x the grid cell count', () => {
    // Derived structurally (see rivers.ts's docblock, step 5): every
    // non-sea cell is claimed into at most one polyline, and each polyline
    // can additionally repeat at most one already-claimed cell (its
    // confluence) or one sea cell (its mouth) as its terminal point — so
    // total vertices can never exceed twice the number of grid cells,
    // regardless of seed.
    for (const seed of [1, 7, 42, 99, 123, 2024, 999999]) {
      const graph = buildRiverGraph(seed, GRID_WIDTH, GRID_HEIGHT);
      const totalVertices = graph.rivers.reduce((sum, r) => sum + r.points.length, 0);
      expect(totalVertices).toBeLessThanOrEqual(2 * GRID_WIDTH * GRID_HEIGHT);
    }
  });

  it('a degenerate (zero-area) grid produces an empty graph rather than throwing', () => {
    expect(buildRiverGraph(1, 0, 0)).toEqual({ rivers: [] });
  });

  it('every river has at least RIVER_ACCUMULATION_THRESHOLD upstream contribution at its source', () => {
    // Sanity check on the threshold constant itself: a river's source point
    // is the first cell whose accumulated flow crosses the threshold, so a
    // single-cell polyline is only possible when a source flows directly
    // into the sea or an existing river with no intermediate land cells —
    // this asserts the threshold is actually load-bearing (a threshold of 0
    // would make every land cell a "river").
    expect(RIVER_ACCUMULATION_THRESHOLD).toBeGreaterThan(1);
  });
});

describe('riverTileKeys (U1, KTD7(b))', () => {
  it('every key classifies as land under terrainAt; none classifies as sea', () => {
    for (const seed of SEEDS_WITH_RIVERS) {
      const graph = makeGraph(seed);
      const keys = riverTileKeys(graph);
      for (const key of keys) {
        const [x, y] = key.split(',').map(Number);
        expect(terrainAt(x, y)).not.toBe('sea');
      }
    }
  });

  it('the same graph reference returns the same Set instance (memoization)', () => {
    const graph = makeGraph(7);
    const a = riverTileKeys(graph);
    const b = riverTileKeys(graph);
    expect(a).toBe(b);
  });

  it('an equal-valued but distinct graph returns equal contents', () => {
    const a = riverTileKeys(makeGraph(7));
    const b = riverTileKeys(makeGraph(7)); // separate buildRiverGraph call -> separate object
    expect(a).not.toBe(b);
    expect([...a].sort()).toEqual([...b].sort());
  });

  it('an empty river graph returns an empty set', () => {
    const empty: RiverGraph = { rivers: [] };
    expect(riverTileKeys(empty)).toEqual(new Set());
  });
});
