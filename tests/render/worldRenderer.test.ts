import { describe, it, expect } from 'vitest';
import {
  isWithinVisibleBounds,
  scaleCompensatedSize,
  shouldShowCityLabel,
  VISIBLE_MARGIN_TILES,
  CITY_LABEL_POPULATION_THRESHOLD,
  TRACK_STROKE_PX,
  STATION_MARKER_PX,
  CITY_DOT_BASE_PX,
  CITY_LABEL_FONT_PX,
} from '../../src/render/worldRenderer.ts';
import type { Rect } from '../../src/render/camera.ts';

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
