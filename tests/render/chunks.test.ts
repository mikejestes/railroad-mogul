import { describe, it, expect } from 'vitest';
import {
  visibleChunks,
  chunkKey,
  parseChunkKey,
  selectEvictable,
  octaveBudgetForTier,
  CHUNK_SIZE_TILES,
  CONTINENT_OCTAVES,
  REGION_OCTAVES,
  LOCAL_OCTAVES,
  type ChunkLruEntry,
} from '../../src/render/terrainChunks.ts';
import { ZOOM_TIERS } from '../../src/render/zoomTiers.ts';
import type { Rect } from '../../src/render/camera.ts';

/**
 * Chunk generation itself touches the GPU (a real PixiJS `Renderer` and
 * `RenderTexture`) and is untestable in Node, per the repo's no-rendering-
 * tests policy (KTD7). These cover the pure logic `TerrainChunkManager`
 * delegates to: which chunks a visible rect implies (KTD8), how a chunk's
 * identity round-trips through its string key, the LRU eviction selector,
 * and the octave-budget LOD policy (KTD4).
 */
describe('visible chunk range (KTD8)', () => {
  it('a rect exactly one chunk wide, aligned to chunk boundaries, returns exactly that one chunk', () => {
    const rect: Rect = { x: 0, y: 0, width: CHUNK_SIZE_TILES, height: CHUNK_SIZE_TILES };
    expect(visibleChunks(rect, 0)).toEqual([{ cx: 0, cy: 0 }]);
  });

  it('a rect straddling a chunk boundary returns every chunk it overlaps', () => {
    // Right/bottom edge lands mid-chunk-1, so both chunk 0 and chunk 1 rows/cols are needed.
    const rect: Rect = { x: 0, y: 0, width: CHUNK_SIZE_TILES + 5, height: CHUNK_SIZE_TILES + 5 };
    const coords = visibleChunks(rect, 0);
    expect(coords).toHaveLength(4);
    expect(coords).toEqual(
      expect.arrayContaining([
        { cx: 0, cy: 0 },
        { cx: 1, cy: 0 },
        { cx: 0, cy: 1 },
        { cx: 1, cy: 1 },
      ]),
    );
  });

  it('a rect entirely inside one chunk, off-origin, returns exactly that chunk', () => {
    const rect: Rect = { x: 40, y: 40, width: 3, height: 3 }; // inside chunk (1,1)
    expect(visibleChunks(rect, 0)).toEqual([{ cx: 1, cy: 1 }]);
  });

  it('the margin extends the range on every side, pulling in neighboring chunks', () => {
    const rect: Rect = { x: 1, y: 1, width: 1, height: 1 }; // deep inside chunk (0,0)
    const withoutMargin = visibleChunks(rect, 0);
    expect(withoutMargin).toEqual([{ cx: 0, cy: 0 }]);

    const withMargin = visibleChunks(rect, CHUNK_SIZE_TILES);
    expect(withMargin.length).toBeGreaterThan(withoutMargin.length);
    // A full chunk of margin on every side reaches one chunk further in each direction.
    expect(withMargin).toEqual(
      expect.arrayContaining([
        { cx: -1, cy: -1 },
        { cx: 0, cy: -1 },
        { cx: 1, cy: -1 },
        { cx: -1, cy: 0 },
        { cx: 0, cy: 0 },
        { cx: 1, cy: 0 },
        { cx: -1, cy: 1 },
        { cx: 0, cy: 1 },
        { cx: 1, cy: 1 },
      ]),
    );
  });

  it('negative world coordinates (panned past the origin) resolve to negative chunk coordinates', () => {
    const rect: Rect = { x: -10, y: -10, width: 2, height: 2 };
    expect(visibleChunks(rect, 0)).toEqual([{ cx: -1, cy: -1 }]);
  });
});

describe('chunk key round-trip (U4)', () => {
  it('parseChunkKey inverts chunkKey for a variety of positions and tiers', () => {
    const cases: Array<[number, number, 'continent' | 'region' | 'local']> = [
      [0, 0, 'continent'],
      [5, -3, 'region'],
      [-12, 40, 'local'],
      [1000, 1000, 'continent'],
    ];
    for (const [cx, cy, tier] of cases) {
      const key = chunkKey(cx, cy, tier);
      expect(parseChunkKey(key)).toEqual({ cx, cy, tier });
    }
  });

  it('different positions or tiers produce different keys', () => {
    expect(chunkKey(0, 0, 'continent')).not.toBe(chunkKey(1, 0, 'continent'));
    expect(chunkKey(0, 0, 'continent')).not.toBe(chunkKey(0, 1, 'continent'));
    expect(chunkKey(0, 0, 'continent')).not.toBe(chunkKey(0, 0, 'region'));
  });
});

describe('LRU chunk eviction (KTD7)', () => {
  function entry(key: string, lastSeen: number): ChunkLruEntry {
    return { key, lastSeen };
  }

  it('returns nothing when resident count is at or under budget', () => {
    const entries = [entry('a', 1), entry('b', 2), entry('c', 3)];
    expect(selectEvictable(entries, new Set(), 3)).toEqual([]);
    expect(selectEvictable(entries, new Set(), 10)).toEqual([]);
  });

  it('returns the least-recently-seen chunks first when over budget', () => {
    const entries = [entry('newest', 30), entry('oldest', 10), entry('middle', 20)];
    expect(selectEvictable(entries, new Set(), 1)).toEqual(['oldest', 'middle']);
  });

  it('evicts exactly the overage, oldest first, leaving the rest resident', () => {
    const entries = [entry('a', 1), entry('b', 2), entry('c', 3), entry('d', 4)];
    // Budget 3 with 4 entries: exactly one (the oldest) is evicted.
    expect(selectEvictable(entries, new Set(), 3)).toEqual(['a']);
  });

  it('never selects a chunk in the current visible range, even if it is the oldest', () => {
    const entries = [entry('a', 1), entry('b', 2), entry('c', 3)];
    // 'a' is oldest but visible right now; budget forces one eviction, which must be 'b'.
    expect(selectEvictable(entries, new Set(['a']), 2)).toEqual(['b']);
  });

  it('stays over budget rather than evicting a visible chunk, if every stale entry is visible', () => {
    const entries = [entry('a', 1), entry('b', 2)];
    expect(selectEvictable(entries, new Set(['a', 'b']), 0)).toEqual([]);
  });
});

describe('octave budget per zoom tier (KTD4)', () => {
  it('exposes fewer octaves at continent than at region, and fewer at region than at local', () => {
    expect(CONTINENT_OCTAVES).toBeLessThan(REGION_OCTAVES);
    expect(REGION_OCTAVES).toBeLessThan(LOCAL_OCTAVES);
  });

  it('is monotonically non-decreasing across ZOOM_TIERS, from coarsest to finest', () => {
    const budgets = ZOOM_TIERS.map((t) => octaveBudgetForTier(t.id));
    for (let i = 1; i < budgets.length; i++) {
      expect(budgets[i]).toBeGreaterThanOrEqual(budgets[i - 1]);
    }
  });

  it('returns the configured constant for each tier', () => {
    expect(octaveBudgetForTier('continent')).toBe(CONTINENT_OCTAVES);
    expect(octaveBudgetForTier('region')).toBe(REGION_OCTAVES);
    expect(octaveBudgetForTier('local')).toBe(LOCAL_OCTAVES);
  });
});
