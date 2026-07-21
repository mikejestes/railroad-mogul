import { describe, it, expect } from 'vitest';
import {
  tierFor,
  ZOOM_TIERS,
  REGION_UP_THRESHOLD,
  REGION_DOWN_THRESHOLD,
  LOCAL_UP_THRESHOLD,
  LOCAL_DOWN_THRESHOLD,
  type ZoomTierId,
} from '../../src/render/zoomTiers.ts';

describe('zoom tier hysteresis (KTD5)', () => {
  it('AE2: scale inside the continent/region hysteresis band returns the current tier, approached from either side', () => {
    // Band is [REGION_DOWN_THRESHOLD, REGION_UP_THRESHOLD]; pick a scale strictly inside it.
    const bandScale = (REGION_DOWN_THRESHOLD + REGION_UP_THRESHOLD) / 2;
    expect(tierFor(bandScale, 'continent')).toBe('continent');
    expect(tierFor(bandScale, 'region')).toBe('region');
  });

  it('AE2: scale inside the region/local hysteresis band returns the current tier, approached from either side', () => {
    const bandScale = (LOCAL_DOWN_THRESHOLD + LOCAL_UP_THRESHOLD) / 2;
    expect(tierFor(bandScale, 'region')).toBe('region');
    expect(tierFor(bandScale, 'local')).toBe('local');
  });

  it('crossing upThreshold from below advances the tier', () => {
    const justAbove = REGION_UP_THRESHOLD + 0.01;
    expect(tierFor(justAbove, 'continent')).toBe('region');

    const justAboveLocal = LOCAL_UP_THRESHOLD + 0.01;
    expect(tierFor(justAboveLocal, 'region')).toBe('local');
  });

  it('crossing downThreshold from above retreats the tier', () => {
    const justBelow = REGION_DOWN_THRESHOLD - 0.01;
    expect(tierFor(justBelow, 'region')).toBe('continent');

    const justBelowLocal = LOCAL_DOWN_THRESHOLD - 0.01;
    expect(tierFor(justBelowLocal, 'local')).toBe('region');
  });

  it('does not advance or retreat while scale sits exactly at a threshold (band is inclusive)', () => {
    expect(tierFor(REGION_UP_THRESHOLD, 'continent')).toBe('continent');
    expect(tierFor(REGION_DOWN_THRESHOLD, 'region')).toBe('region');
  });

  it('oscillating scale within the band across many calls never changes tier', () => {
    let tier: ZoomTierId = 'region';
    const midBand = (REGION_DOWN_THRESHOLD + REGION_UP_THRESHOLD) / 2;
    const wiggle = (REGION_UP_THRESHOLD - REGION_DOWN_THRESHOLD) / 4;
    for (let i = 0; i < 50; i++) {
      const scale = midBand + (i % 2 === 0 ? wiggle : -wiggle);
      tier = tierFor(scale, tier);
      expect(tier).toBe('region');
    }
  });

  it('scale far below the lowest threshold clamps to the lowest (continent) tier', () => {
    expect(tierFor(0.001, 'local')).toBe('continent');
    expect(tierFor(0.001, 'region')).toBe('continent');
  });

  it('scale far above the highest threshold clamps to the highest (local) tier', () => {
    expect(tierFor(1_000_000, 'continent')).toBe('local');
    expect(tierFor(1_000_000, 'region')).toBe('local');
  });

  it('a large scale jump from continent lands directly on local, skipping no logic for the intermediate boundary', () => {
    expect(tierFor(LOCAL_UP_THRESHOLD + 1, 'continent')).toBe('local');
  });

  it('a large scale drop from local lands directly on continent', () => {
    expect(tierFor(REGION_DOWN_THRESHOLD - 1, 'local')).toBe('continent');
  });

  it('tierFor is pure: the same inputs always return the same tier', () => {
    const cases: Array<[number, ZoomTierId]> = [
      [10, 'continent'],
      [20, 'region'],
      [200, 'local'],
      [REGION_UP_THRESHOLD, 'continent'],
      [LOCAL_DOWN_THRESHOLD, 'local'],
    ];
    for (const [scale, currentTier] of cases) {
      const first = tierFor(scale, currentTier);
      const second = tierFor(scale, currentTier);
      const third = tierFor(scale, currentTier);
      expect(second).toBe(first);
      expect(third).toBe(first);
    }
  });

  it('ZOOM_TIERS is ordered lowest tier first and defines a downThreshold below its upThreshold for every real boundary', () => {
    expect(ZOOM_TIERS.map((t) => t.id)).toEqual(['continent', 'region', 'local']);
    for (const tier of ZOOM_TIERS.slice(1)) {
      expect(tier.downThreshold).toBeLessThan(tier.upThreshold);
    }
  });
});
