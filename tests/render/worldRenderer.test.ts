import { describe, it, expect } from 'vitest';
import {
  isWithinVisibleBounds,
  scaleCompensatedSize,
  shouldShowCityLabel,
  riverJitter,
  structureMarksFor,
  RIVER_JITTER_TILES,
  VISIBLE_MARGIN_TILES,
  CITY_LABEL_POPULATION_THRESHOLD,
  TRACK_STROKE_PX,
  STATION_MARKER_PX,
  CITY_DOT_BASE_PX,
  CITY_LABEL_FONT_PX,
  stationGlyphFor,
  landOverlayColor,
  LAND_OVERLAY_MIN_CENTS,
  LAND_OVERLAY_MAX_CENTS,
  ownershipCueRects,
} from '../../src/render/worldRenderer.ts';
import { PARCELS_PER_TILE_EDGE, type Parcel } from '../../src/sim/model/land.ts';
import type { Rect } from '../../src/render/camera.ts';
import type { StepCost } from '../../src/sim/model/trackCost.ts';
import type { StationType } from '../../src/sim/model/track.ts';

/**
 * U5's draw calls themselves are untested by policy (KTD7, no rendering
 * tests) — these cover the pure predicates `render` uses to decide what
 * *would* draw: visibility culling (R5/R7), scale-compensated stroke/marker
 * sizing (KTD6), and label suppression (R5). U4 moved terrain cell fill
 * sizing (the old `terrainCellSize`) into the chunked terrain renderer
 * (`tests/render/chunks.test.ts`) along with the rest of the terrain-drawing
 * logic it replaced.
 */
describe('visible-bounds culling (R5/R7, KTD7)', () => {
  const visible: Rect = { x: 10, y: 10, width: 20, height: 15 }; // covers x:[10,30], y:[10,25]

  it('includes an entity strictly inside the visible rect', () => {
    expect(isWithinVisibleBounds({ x: 15, y: 12 }, visible, VISIBLE_MARGIN_TILES)).toBe(true);
  });

  it('includes an entity on the exact edge of the visible rect', () => {
    expect(isWithinVisibleBounds({ x: 10, y: 10 }, visible, VISIBLE_MARGIN_TILES)).toBe(true);
    expect(isWithinVisibleBounds({ x: 30, y: 25 }, visible, VISIBLE_MARGIN_TILES)).toBe(true);
  });

  it('includes an entity just outside the rect but within the margin, so it does not pop at the edge', () => {
    const justOutside = 10 - VISIBLE_MARGIN_TILES; // exactly margin distance past the left edge
    expect(isWithinVisibleBounds({ x: justOutside, y: 15 }, visible, VISIBLE_MARGIN_TILES)).toBe(true);
  });

  it('excludes an entity well outside the rect, past the margin', () => {
    expect(isWithinVisibleBounds({ x: 10 - VISIBLE_MARGIN_TILES - 1, y: 15 }, visible, VISIBLE_MARGIN_TILES)).toBe(
      false,
    );
    expect(isWithinVisibleBounds({ x: 1000, y: 1000 }, visible, VISIBLE_MARGIN_TILES)).toBe(false);
  });
});

describe('scale-compensated stroke/marker size (KTD6)', () => {
  it('a track stroke reads at a constant apparent width across several scales', () => {
    const scales = [4, 20, 100, 480]; // spans MIN_SCALE..MAX_SCALE (camera.ts)
    for (const scale of scales) {
      const worldWidth = scaleCompensatedSize(TRACK_STROKE_PX, scale);
      // The world container multiplies this back out by `scale` at render
      // time, so the apparent on-screen width must land back on the base.
      expect(worldWidth * scale).toBeCloseTo(TRACK_STROKE_PX, 6);
    }
  });

  it('a station marker reads at a constant apparent size across several scales', () => {
    const scales = [4, 20, 100, 480];
    for (const scale of scales) {
      const worldSize = scaleCompensatedSize(STATION_MARKER_PX, scale);
      expect(worldSize * scale).toBeCloseTo(STATION_MARKER_PX, 6);
    }
  });

  it('a larger scale (more zoomed in) yields a smaller world-unit size', () => {
    const zoomedOut = scaleCompensatedSize(CITY_DOT_BASE_PX, 10);
    const zoomedIn = scaleCompensatedSize(CITY_DOT_BASE_PX, 100);
    expect(zoomedIn).toBeLessThan(zoomedOut);
  });

  it('a city name label reads at a constant apparent font size across several scales (regression: labels were never counter-scaled, so they rendered at fontSize * camera.scale)', () => {
    const scales = [4, 20, 32.39, 100, 480]; // 32.39 ~= the reported default-boot scale
    for (const scale of scales) {
      // `labelFor` sets `label.scale` to this factor; the world container
      // then multiplies it back out by `scale`, so the apparent glyph size
      // (fontSize * labelScale * scale) must land back on the fixed fontSize.
      const labelScale = scaleCompensatedSize(1, scale);
      expect(CITY_LABEL_FONT_PX * labelScale * scale).toBeCloseTo(CITY_LABEL_FONT_PX, 6);
    }
  });
});

describe('riverJitter (U6, KTD7)', () => {
  it('is deterministic: the same tile always produces the same jitter', () => {
    expect(riverJitter(12, 34)).toEqual(riverJitter(12, 34));
  });

  it('stays within [-RIVER_JITTER_TILES, RIVER_JITTER_TILES] on both axes, across a spread of tiles', () => {
    for (let x = 0; x < 40; x += 3) {
      for (let y = 0; y < 28; y += 3) {
        const j = riverJitter(x, y);
        expect(Math.abs(j.x)).toBeLessThanOrEqual(RIVER_JITTER_TILES);
        expect(Math.abs(j.y)).toBeLessThanOrEqual(RIVER_JITTER_TILES);
      }
    }
  });

  it('different tiles generally produce different jitter (not a constant)', () => {
    const a = riverJitter(1, 1);
    const b = riverJitter(2, 5);
    expect(a).not.toEqual(b);
  });
});

describe('structureMarksFor (U6, AE3 substrate, KTD7)', () => {
  function makeStep(overrides: Partial<StepCost> = {}): StepCost {
    return {
      baseCents: 0,
      terrainCents: 0,
      gradeCents: 0,
      structureCents: 0,
      landCents: 0,
      totalCents: 0,
      rawGrade: 0,
      effectiveGrade: 0,
      ...overrides,
    };
  }

  it('places one mark per structured step, at the midpoint of that step, and none for plain steps', () => {
    const overlay = {
      path: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
      ],
      steps: [makeStep(), makeStep({ structure: 'bridge' }), makeStep({ structure: 'tunnel' })],
    };
    const marks = structureMarksFor(overlay);
    expect(marks).toEqual([
      { x: 1.5, y: 0, structure: 'bridge' },
      { x: 2.5, y: 0, structure: 'tunnel' },
    ]);
  });

  it('returns no marks for an overlay with no structures', () => {
    const overlay = {
      path: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
      steps: [makeStep()],
    };
    expect(structureMarksFor(overlay)).toEqual([]);
  });

  it('returns no marks for an empty overlay', () => {
    expect(structureMarksFor({ path: [], steps: [] })).toEqual([]);
  });
});

describe('city label suppression (R5)', () => {
  it('hides a small city label at continent tier', () => {
    expect(shouldShowCityLabel('continent', CITY_LABEL_POPULATION_THRESHOLD - 1)).toBe(false);
  });

  it('shows a small city label at region tier', () => {
    expect(shouldShowCityLabel('region', CITY_LABEL_POPULATION_THRESHOLD - 1)).toBe(true);
  });

  it('shows a small city label at local tier', () => {
    expect(shouldShowCityLabel('local', CITY_LABEL_POPULATION_THRESHOLD - 1)).toBe(true);
  });

  it('shows a large city label even at continent tier', () => {
    expect(shouldShowCityLabel('continent', CITY_LABEL_POPULATION_THRESHOLD)).toBe(true);
    expect(shouldShowCityLabel('continent', CITY_LABEL_POPULATION_THRESHOLD + 1)).toBe(true);
  });
});

describe('stationGlyphFor (milestone 5 U1, R6, KTD3)', () => {
  it('maps each station type to a distinct mark', () => {
    const types: StationType[] = ['freight', 'passenger', 'mixed'];
    const glyphs = types.map(stationGlyphFor);
    expect(new Set(glyphs).size).toBe(types.length);
  });

  it("'mixed' keeps the pre-M5 square (regression-safe default)", () => {
    expect(stationGlyphFor('mixed')).toBe('square');
  });

  it('freight and passenger each get their own non-square mark', () => {
    expect(stationGlyphFor('freight')).toBe('diamond');
    expect(stationGlyphFor('passenger')).toBe('circle');
  });
});

describe('landOverlayColor (milestone 6 U6, KTD10, KTD7)', () => {
  it('is monotonic: a strictly higher price never reads as a strictly lower color channel sum', () => {
    const cheap = landOverlayColor(LAND_OVERLAY_MIN_CENTS);
    const mid = landOverlayColor((LAND_OVERLAY_MIN_CENTS + LAND_OVERLAY_MAX_CENTS) / 2);
    const dear = landOverlayColor(LAND_OVERLAY_MAX_CENTS);
    const channelSum = (color: number) => ((color >> 16) & 0xff) + ((color >> 8) & 0xff) + (color & 0xff);
    expect(channelSum(mid)).toBeGreaterThanOrEqual(channelSum(cheap));
    expect(channelSum(dear)).toBeGreaterThanOrEqual(channelSum(mid));
  });

  it('is bounded: values far outside the calibrated range clamp to the same color as the range endpoints', () => {
    expect(landOverlayColor(-1_000_000_00)).toBe(landOverlayColor(LAND_OVERLAY_MIN_CENTS));
    expect(landOverlayColor(1_000_000_00)).toBe(landOverlayColor(LAND_OVERLAY_MAX_CENTS));
  });

  it('always returns a valid 24-bit color', () => {
    for (const cents of [LAND_OVERLAY_MIN_CENTS, 0, 300_00, LAND_OVERLAY_MAX_CENTS, -50_00, 999_999_99]) {
      const color = landOverlayColor(cents);
      expect(color).toBeGreaterThanOrEqual(0);
      expect(color).toBeLessThanOrEqual(0xffffff);
      expect(Number.isInteger(color)).toBe(true);
    }
  });
});

describe('ownershipCueRects (milestone 6 U7, KTD4/KTD5)', () => {
  function makeParcel(tileX: number, tileY: number, subX = 0, subY = 0): Parcel {
    return {
      id: `p-${tileX}-${tileY}-${subX}-${subY}`,
      address: { tileX, tileY, subX, subY },
      pricePaidCents: 100_00,
      acquiredDay: 0,
      valueItemsAtPurchase: [],
    };
  }

  it('produces nothing for an empty parcel list (unowned parcels produce nothing)', () => {
    expect(ownershipCueRects([])).toEqual([]);
  });

  it('maps one owned parcel to exactly one world-space rect of the parcel sub-cell size', () => {
    const rects = ownershipCueRects([makeParcel(10, 5, 0, 0)]);
    expect(rects).toHaveLength(1);
    expect(rects[0].size).toBeCloseTo(1 / PARCELS_PER_TILE_EDGE, 10);
    // The rect is centered on the parcel's own center (KTD4).
    expect(rects[0].x + rects[0].size / 2).toBeCloseTo(10 + 0.25, 10);
    expect(rects[0].y + rects[0].size / 2).toBeCloseTo(5 + 0.25, 10);
  });

  it('maps N owned parcels to N rects, one per parcel, in the same order', () => {
    const parcels = [makeParcel(1, 1), makeParcel(2, 2), makeParcel(3, 3)];
    const rects = ownershipCueRects(parcels);
    expect(rects).toHaveLength(3);
  });
});
