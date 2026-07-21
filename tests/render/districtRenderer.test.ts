import { describe, it, expect } from 'vitest';
import {
  districtsInView,
  districtSceneCacheKey,
  DISTRICT_VIEW_MARGIN_TILES,
  RESIDENT_DISTRICT_BUDGET,
} from '../../src/render/districtRenderer.ts';
import { selectEvictable, type ChunkLruEntry } from '../../src/render/terrainChunks.ts';
import { makeDistrict } from '../../src/sim/model/districts.ts';
import type { Rect } from '../../src/render/camera.ts';

/**
 * `DistrictRenderer`'s draw calls touch the GPU (a real PixiJS `Renderer`
 * and `RenderTexture`) and are untestable in Node, per the repo's
 * no-rendering-tests policy (KTD7). These cover the pure logic it
 * delegates to: which districts are in view (KTD8), the quantized-tuple
 * cache key (KTD8), and — reusing `terrainChunks.ts`'s already-tested LRU
 * selector — that eviction never targets a district currently on screen.
 */
describe('districts in view (M4 U7, KTD8)', () => {
  const visible: Rect = { x: 10, y: 10, width: 20, height: 15 }; // covers x:[10,30], y:[10,25]

  it('includes a district whose anchor is strictly inside the visible rect', () => {
    const d = makeDistrict('a', { id: 's', x: 15, y: 12 });
    expect(districtsInView([d], visible)).toEqual([d]);
  });

  it('includes a district just outside the rect but within the margin', () => {
    const justOutside = 10 - DISTRICT_VIEW_MARGIN_TILES;
    const d = makeDistrict('a', { id: 's', x: justOutside, y: 15 });
    expect(districtsInView([d], visible)).toEqual([d]);
  });

  it('excludes a district well outside the rect, past the margin', () => {
    const d = makeDistrict('a', { id: 's', x: 1000, y: 1000 });
    expect(districtsInView([d], visible)).toEqual([]);
  });

  it('returns exactly the subset of districts within range, preserving order', () => {
    const inside = makeDistrict('in', { id: 's1', x: 20, y: 20 });
    const outside = makeDistrict('out', { id: 's2', x: -500, y: -500 });
    const alsoInside = makeDistrict('in2', { id: 's3', x: 11, y: 11 });
    expect(districtsInView([inside, outside, alsoInside], visible)).toEqual([inside, alsoInside]);
  });
});

describe('district scene cache key (M4 U7, KTD8)', () => {
  it('is stable for an unchanged district and tier', () => {
    const d = makeDistrict('dst-0', { id: 's', x: 5, y: 5 });
    d.development = 0.5;
    expect(districtSceneCacheKey(d, 'street')).toBe(districtSceneCacheKey(d, 'street'));
  });

  it('changes when the district id changes', () => {
    const a = makeDistrict('dst-a', { id: 's', x: 5, y: 5 });
    const b = makeDistrict('dst-b', { id: 's', x: 5, y: 5 });
    expect(districtSceneCacheKey(a, 'street')).not.toBe(districtSceneCacheKey(b, 'street'));
  });

  it('changes when the tier changes', () => {
    const d = makeDistrict('dst-0', { id: 's', x: 5, y: 5 });
    expect(districtSceneCacheKey(d, 'street')).not.toBe(districtSceneCacheKey(d, 'local'));
  });

  it('changes exactly when the quantized record changes — stable across a sub-quantum nudge, different across a quantum-crossing one', () => {
    const d = makeDistrict('dst-0', { id: 's', x: 5, y: 5 });
    d.development = 0.5;
    const keyBefore = districtSceneCacheKey(d, 'street');

    d.development = 0.5 + 0.001; // sub-quantum (QUANTUM = 1/16 = 0.0625)
    expect(districtSceneCacheKey(d, 'street')).toBe(keyBefore);

    d.development = 0.5 + 1 / 16; // crosses one quantum step
    expect(districtSceneCacheKey(d, 'street')).not.toBe(keyBefore);
  });

  it('is unaffected by discrete growth-history fields not part of the quantized tuple', () => {
    const a = makeDistrict('dst-0', { id: 's', x: 5, y: 5 });
    const b = { ...makeDistrict('dst-0', { id: 's', x: 5, y: 5 }), episodeCount: 10, firstGrowthDay: 3, lastGrowthDay: 40 };
    expect(districtSceneCacheKey(a, 'street')).toBe(districtSceneCacheKey(b, 'street'));
  });
});

describe('eviction never targets an in-view district (M4 U7, reusing terrainChunks.ts LRU)', () => {
  function entry(key: string, lastSeen: number): ChunkLruEntry {
    return { key, lastSeen };
  }

  it('stays within RESIDENT_DISTRICT_BUDGET by evicting the least-recently-seen out-of-view scene first', () => {
    const d1 = makeDistrict('dst-1', { id: 's1', x: 0, y: 0 });
    const d2 = makeDistrict('dst-2', { id: 's2', x: 0, y: 0 });
    const key1 = districtSceneCacheKey(d1, 'street');
    const key2 = districtSceneCacheKey(d2, 'street');
    const entries = [entry(key1, 1), entry(key2, 2)];

    // Both were resident once, but only key2 is in view now.
    const evictable = selectEvictable(entries, new Set([key2]), 1);
    expect(evictable).toEqual([key1]);
  });

  it('never evicts a district currently in view, even if it is the stalest entry', () => {
    const entries = [entry('a', 1), entry('b', 2), entry('c', 3)];
    expect(selectEvictable(entries, new Set(['a']), 0)).not.toContain('a');
  });

  it('RESIDENT_DISTRICT_BUDGET is a positive, finite budget', () => {
    expect(RESIDENT_DISTRICT_BUDGET).toBeGreaterThan(0);
    expect(Number.isFinite(RESIDENT_DISTRICT_BUDGET)).toBe(true);
  });
});
