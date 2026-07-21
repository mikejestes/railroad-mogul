/**
 * River graph: a coarse, precomputed flow-accumulation graph over the
 * elevation field, stored once at world generation (U5, KTD6, R7).
 *
 * KTD6 — flow accumulation is inherently non-local (a cell's flow depends on
 * every cell upstream of it), so it cannot be expressed as a stateless
 * function of a single coordinate the way `fields.ts`'s elevation/moisture/
 * temperature can (R1). This module is the one deliberate exception the
 * Product Contract carves out: sample elevation once on a coarse grid, route
 * flow over that fixed snapshot, and store the resulting polylines. Nothing
 * else in the terrain substrate is stored; this is kilobytes, not megabytes.
 *
 * Milestone-3 U1 rebase (KTD7(a), R8): this module used to sample its own,
 * independent `TerrainFields` instance at `RIVER_FIELD_SCALE`, disjoint from
 * `geography.ts`'s per-seed-offset, authored-landmask-aware `elevationAt`/
 * `terrainAt`. Two empirical facts (re-verified while planning milestone 3)
 * made that untenable: without the per-seed land-median offset, a large
 * share of seeds (5 of 12 in a spot check) produced *zero* rivers, because
 * the raw field's DC level sat at or below sea level over the whole
 * landmass; and on seeds that did produce rivers, the fraction of river
 * points landing on a tile `terrainAt` calls `sea` ranged from near-zero to
 * over 80% depending on seed — not a narrow, ignorable band. So flow routing
 * now samples the exact same elevation source the player sees:
 * `geography.ts`'s `elevationAt(x, y)`, tile-indexed 1:1 (no separate
 * coarse-grid scale — the "coarse grid" *is* the tile grid now), via
 * `configureTerrainSeed(seed)` at the top of `buildRiverGraph` so the graph
 * stays a pure function of `(seed, gridWidth, gridHeight)` regardless of call
 * order (`configureTerrainSeed` is idempotent per seed — see
 * `geography.ts`). A cell counts as sea for routing purposes — `isSea`,
 * below — if *either* `terrainAt` classifies it as sea (outside every
 * authored landmass box, KTD5) *or* its offset elevation is at/below
 * `SEA_LEVEL` (the field's own notion of sea, which `terrainAt` softens to
 * `'coast'` inside authored land rather than reporting as `'sea'`): a river
 * can end by leaving the authored continent or by reaching a genuinely
 * low-lying point inside it, and either is a legitimate mouth.
 *
 * Algorithm (single-flow-direction / D8, the standard coarse hydrology
 * model — no erosion, no pit-filling, per the plan's explicit scope
 * boundary):
 *   1. Sample offset tile elevation (`geography.ts`'s `elevationAt`) at
 *      every grid cell.
 *   2. Each non-sea cell (per `isSea` above) gets a flow direction toward
 *      its single lowest 8-connected neighbor, if any neighbor is lower.
 *      Cells with no lower neighbor (pits) have no flow direction. Flow
 *      always points to a strictly lower cell, so the flow graph is
 *      acyclic by construction — no river can ever loop back on itself.
 *   3. `reachesSea` is computed bottom-up (ascending elevation, so a cell's
 *      flow target — always lower — is resolved before the cell itself):
 *      sea cells trivially reach the sea; a land cell reaches the sea iff
 *      its flow target does. This rules out pit-trapped basins from ever
 *      being classified as rivers, which is what guarantees AE4 ("every
 *      river reaches the sea") rather than merely hoping for it.
 *   4. Flow accumulation is computed top-down (descending elevation, so
 *      every upstream contributor is folded in before its target is read):
 *      every cell starts at 1 unit and adds its total into its flow
 *      target's total. Accumulation is therefore monotonically
 *      non-decreasing downstream.
 *   5. A cell is a river cell if it reaches the sea and its accumulation
 *      meets `RIVER_ACCUMULATION_THRESHOLD`. Polylines are traced by
 *      walking river cells in descending elevation order: the first time an
 *      unclaimed river cell is seen, it is a genuine headwater (any
 *      qualifying upstream ancestor would have already claimed it via an
 *      earlier, higher-elevation trace), so a new polyline starts there and
 *      follows flow downstream, claiming cells as it goes, until it reaches
 *      a sea cell (the river's mouth) or a cell some earlier polyline
 *      already claimed (a confluence — "joins another river"). This bounds
 *      total vertex count: every non-sea cell is claimed at most once, and
 *      each polyline can only additionally repeat one already-claimed
 *      terminal (its confluence point) or one sea cell (its mouth), so
 *      total vertices across the whole graph never exceed
 *      `2 * gridWidth * gridHeight` — see `tests/world/rivers.test.ts` for
 *      the assertion.
 *
 * Determinism (R10): the only randomness is the world seed feeding
 * `geography.ts`'s reference fields (via `configureTerrainSeed`), which is
 * pure and order-independent; everything downstream here is plain
 * deterministic array processing (stable-sorted by elevation, ties broken by
 * the fixed row-major scan order), so the same seed and grid dimensions
 * always produce byte-identical output.
 *
 * Serialization safety (referenced in the plan via commit `36dfac7`, which
 * fixed an earlier NaN-as-JSON-sentinel bug elsewhere in this codebase):
 * the stored `RiverGraph` contains only finite numbers — elevation values
 * already come clamped to `[MIN_ELEVATION, MAX_ELEVATION]` from `fields.ts`,
 * and there is no "no flow direction" or "not yet computed" sentinel
 * anywhere in the output type. The internal working arrays (`flowTo`, which
 * legitimately needs a "no downhill neighbor" sentinel) are local to
 * `buildRiverGraph` and never escape into the stored graph.
 *
 * `riverTileKeys` (U1, KTD7(b)): the pure derivation of which tiles a
 * surveyed route must bridge (`src/sim/model/trackCost.ts`, milestone 3 U2).
 * A tile is a *crossable river tile* iff a river polyline passes through it
 * and `terrainAt` classifies that tile as land — a masked-sea point is
 * unbuildable anyway (no track can reach it to need a bridge), so it drops
 * out rather than requiring special-casing downstream. No interpolation is
 * needed between polyline points: D8 flow steps are 8-adjacent by
 * construction, so every polyline already visits every tile it crosses.
 * Memoized by `RiverGraph` object reference (a `WeakMap`) — the graph is
 * immutable after generation, so recomputing per call would be pure waste
 * for something every survey call needs.
 */
import { SEA_LEVEL } from './fields.ts';
import { configureTerrainSeed, elevationAt, terrainAt } from './geography.ts';

/**
 * Minimum flow accumulation (in upstream-cell units) for a reaches-the-sea
 * cell to be classified as part of a river. Chosen empirically against a
 * spread of seeds to produce a handful of distinct rivers rather than
 * either none or a river on every other tile.
 */
export const RIVER_ACCUMULATION_THRESHOLD = 8;

/** 8-connected neighborhood (D8), excluding the cell itself. */
const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

export interface RiverPoint {
  x: number;
  y: number;
  /** Elevation at this point, in `[MIN_ELEVATION, MAX_ELEVATION]` (see `fields.ts`). */
  elevation: number;
}

export interface River {
  /** Source-to-mouth polyline; elevation is non-increasing along it (AE4). */
  points: RiverPoint[];
}

export interface RiverGraph {
  rivers: River[];
}

function cellIndex(x: number, y: number, gridWidth: number): number {
  return y * gridWidth + x;
}

/**
 * A cell counts as sea for flow-routing purposes if either the authored
 * landmask says so (`terrainAt` outside every `LAND_BOXES` box) or its
 * offset elevation is at/below `SEA_LEVEL` (see module docblock, KTD7(a)).
 */
function isSeaTile(x: number, y: number): boolean {
  return terrainAt(x, y) === 'sea' || elevationAt(x, y) <= SEA_LEVEL;
}

/**
 * Build the river graph for a world (U5, R7; rebased onto `geography.ts`'s
 * elevation in milestone-3 U1, KTD7(a)). Pure function of `seed` and the
 * grid's dimensions — see the module docblock for the algorithm and the
 * determinism argument. `configureTerrainSeed(seed)` is idempotent per seed
 * (see `geography.ts`), so calling this before or after other code that
 * configures the same seed makes no difference.
 */
export function buildRiverGraph(seed: number, gridWidth: number, gridHeight: number): RiverGraph {
  const cellCount = gridWidth * gridHeight;
  if (cellCount === 0) return { rivers: [] };

  configureTerrainSeed(seed);

  const elevation = new Float64Array(cellCount);
  const seaMask = new Uint8Array(cellCount);
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      const i = cellIndex(x, y, gridWidth);
      elevation[i] = elevationAt(x, y);
      seaMask[i] = isSeaTile(x, y) ? 1 : 0;
    }
  }
  const isSea = (i: number): boolean => seaMask[i] === 1;

  // Step 2: flow direction toward the single lowest 8-connected neighbor.
  // -1 means "no downhill neighbor" (sea cell, or a land pit). This
  // sentinel is internal only — never written into the stored graph.
  const flowTo = new Int32Array(cellCount).fill(-1);
  const allCells: number[] = new Array(cellCount);
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      const i = cellIndex(x, y, gridWidth);
      allCells[i] = i;
      if (isSea(i)) continue;
      let bestTarget = -1;
      let bestElevation = elevation[i];
      for (const [dx, dy] of NEIGHBOR_OFFSETS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= gridWidth || ny < 0 || ny >= gridHeight) continue;
        const ni = cellIndex(nx, ny, gridWidth);
        if (elevation[ni] < bestElevation) {
          bestElevation = elevation[ni];
          bestTarget = ni;
        }
      }
      flowTo[i] = bestTarget;
    }
  }

  // Step 3: reachesSea, ascending elevation so each flow target is resolved
  // before the cells that flow into it.
  const ascending = allCells.slice().sort((a, b) => elevation[a] - elevation[b]);
  const reachesSea = new Uint8Array(cellCount);
  for (const i of ascending) {
    if (isSea(i)) {
      reachesSea[i] = 1;
      continue;
    }
    const target = flowTo[i];
    reachesSea[i] = target >= 0 ? reachesSea[target] : 0;
  }

  // Step 4: flow accumulation, descending elevation so every upstream
  // contributor is folded in before its target is read.
  const descending = ascending.slice().reverse();
  const accumulation = new Float64Array(cellCount).fill(1);
  for (const i of descending) {
    const target = flowTo[i];
    if (target >= 0) accumulation[target] += accumulation[i];
  }

  const isRiverCell = (i: number): boolean =>
    !isSea(i) && reachesSea[i] === 1 && accumulation[i] >= RIVER_ACCUMULATION_THRESHOLD;

  // Step 5: trace polylines in descending elevation order so the first
  // unclaimed river cell encountered is always a genuine headwater.
  const claimed = new Uint8Array(cellCount);
  const rivers: River[] = [];
  const pointAt = (i: number): RiverPoint => ({ x: i % gridWidth, y: Math.floor(i / gridWidth), elevation: elevation[i] });

  for (const i of descending) {
    if (!isRiverCell(i) || claimed[i]) continue;

    const points: RiverPoint[] = [pointAt(i)];
    claimed[i] = 1;
    let current = i;
    // Guaranteed to terminate: reachesSea[i] is true, flow strictly
    // decreases elevation each step, and the grid is finite, so this walk
    // reaches a sea cell (or an already-claimed cell) in at most cellCount
    // steps.
    for (;;) {
      const target = flowTo[current];
      if (target < 0) break; // defensive: reachesSea guarantees this doesn't happen
      points.push(pointAt(target));
      if (isSea(target) || claimed[target]) break;
      claimed[target] = 1;
      current = target;
    }
    rivers.push({ points });
  }

  return { rivers };
}

/** Memoized `RiverGraph` -> crossable-river-tile-key cache (U1, KTD7(b)).
 *  Keyed by object reference: `RiverGraph` is immutable after generation, so
 *  the same graph instance always yields the same key set. */
const riverTileKeysCache = new WeakMap<RiverGraph, Set<string>>();

/**
 * Every tile a route must bridge to cross a river (U1, KTD7(b)): the set of
 * `"x,y"` keys for every point on every polyline in `graph` whose tile
 * `terrainAt` classifies as land. A river point that lands on a
 * `terrainAt`-sea tile (open ocean/estuary beyond the authored coastline) is
 * unbuildable anyway, so it drops out rather than needing a bridge of its
 * own. Pure function of `graph`'s contents; memoized by reference so a
 * survey re-run every cursor move (KTD3) doesn't re-walk every river.
 */
export function riverTileKeys(graph: RiverGraph): Set<string> {
  const cached = riverTileKeysCache.get(graph);
  if (cached) return cached;

  const keys = new Set<string>();
  for (const river of graph.rivers) {
    for (const p of river.points) {
      if (terrainAt(p.x, p.y) !== 'sea') keys.add(`${p.x},${p.y}`);
    }
  }
  riverTileKeysCache.set(graph, keys);
  return keys;
}
