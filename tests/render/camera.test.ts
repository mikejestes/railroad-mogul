import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import {
  Camera,
  exceedsClickThreshold,
  CLICK_DRAG_THRESHOLD_PX,
  wheelZoomFactor,
  worldPointToTile,
  MIN_SCALE,
  MAX_SCALE,
} from '../../src/render/camera.ts';

// Local factory: a Camera wired to a fresh render-group container, per KTD2.
function makeCamera(): Camera {
  return new Camera(new Container({ isRenderGroup: true }));
}

describe('camera transform (KTD3)', () => {
  it('round-trips screenToWorld/worldToScreen at unit scale', () => {
    const camera = makeCamera();
    camera.fitToViewport(10, 10, { width: 10, height: 10 }); // scale = 1
    const points = [
      { x: 0, y: 0 },
      { x: 3.5, y: 7.2 },
      { x: 10, y: 10 },
    ];
    for (const p of points) {
      const screen = camera.worldToScreen(p.x, p.y);
      const back = camera.screenToWorld(screen.x, screen.y);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it('round-trips screenToWorld/worldToScreen at a non-unit scale', () => {
    const camera = makeCamera();
    camera.fitToViewport(40, 28, { width: 1200, height: 700 }); // non-1 scale
    const points = [
      { x: 0, y: 0 },
      { x: 12.25, y: 4.75 },
      { x: 39, y: 27 },
    ];
    for (const p of points) {
      const screen = camera.worldToScreen(p.x, p.y);
      const back = camera.screenToWorld(screen.x, screen.y);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it('fitToViewport on a wide viewport shows the whole world, centered', () => {
    const camera = makeCamera();
    // World is roughly square (40x28-ish); viewport is much wider than tall.
    camera.fitToViewport(40, 28, { width: 2000, height: 400 });
    // The limiting axis is height, so scale = 400/28.
    expect(camera.scale).toBeCloseTo(400 / 28, 6);
    const rect = camera.visibleWorldRect();
    // The whole world (and then some, on the wide axis) must be visible.
    expect(rect.x).toBeLessThanOrEqual(0);
    expect(rect.y).toBeCloseTo(0, 6);
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(40);
    expect(rect.y + rect.height).toBeCloseTo(28, 6);
    // Centered: the world's horizontal midpoint maps to the viewport's midpoint.
    const mid = camera.worldToScreen(20, 14);
    expect(mid.x).toBeCloseTo(1000, 3);
    expect(mid.y).toBeCloseTo(200, 3);
  });

  it('fitToViewport on a tall viewport shows the whole world, centered', () => {
    const camera = makeCamera();
    camera.fitToViewport(40, 28, { width: 300, height: 2000 });
    // The limiting axis is width, so scale = 300/40.
    expect(camera.scale).toBeCloseTo(300 / 40, 6);
    const rect = camera.visibleWorldRect();
    expect(rect.y).toBeLessThanOrEqual(0);
    expect(rect.x).toBeCloseTo(0, 6);
    expect(rect.y + rect.height).toBeGreaterThanOrEqual(28);
    expect(rect.x + rect.width).toBeCloseTo(40, 6);
    const mid = camera.worldToScreen(20, 14);
    expect(mid.x).toBeCloseTo(150, 3);
    expect(mid.y).toBeCloseTo(1000, 3);
  });

  it('panBy moves the visible world rect by the screen delta divided by scale', () => {
    const camera = makeCamera();
    camera.fitToViewport(40, 28, { width: 800, height: 560 }); // scale = 20
    const before = camera.visibleWorldRect();
    camera.panBy(40, -20); // screen-space drag
    const after = camera.visibleWorldRect();
    // The world follows the pointer, so the visible rect moves opposite the drag.
    expect(after.x).toBeCloseTo(before.x - 40 / camera.scale, 6);
    expect(after.y).toBeCloseTo(before.y - -20 / camera.scale, 6);
    // Size is unaffected by a pure pan.
    expect(after.width).toBeCloseTo(before.width, 6);
    expect(after.height).toBeCloseTo(before.height, 6);
  });

  it('visibleWorldRect returns a sub-rect when the viewport shows only part of a larger world', () => {
    const camera = makeCamera();
    const REAL_WORLD_WIDTH = 40;
    const REAL_WORLD_HEIGHT = 28;
    // Fit to a 10x7 patch — as zoom (U2) will let the player do — so what's
    // on screen is strictly smaller than the full 40x28 world.
    camera.fitToViewport(10, 7, { width: 500, height: 350 });
    const rect = camera.visibleWorldRect();
    expect(rect.width).toBeCloseTo(10, 6);
    expect(rect.height).toBeCloseTo(7, 6);
    expect(rect.width).toBeLessThan(REAL_WORLD_WIDTH);
    expect(rect.height).toBeLessThan(REAL_WORLD_HEIGHT);
  });

  it('visibleWorldRect contains the whole world when the viewport is larger than the world', () => {
    const camera = makeCamera();
    // Aspect mismatch: height is the limiting axis, so the wide axis
    // letterboxes and the visible rect extends past the world's left/right edges.
    camera.fitToViewport(10, 8, { width: 2000, height: 800 }); // scale = 100
    const rect = camera.visibleWorldRect();
    expect(rect.x).toBeLessThan(0);
    expect(rect.y).toBeCloseTo(0, 6);
    expect(rect.x + rect.width).toBeGreaterThan(10);
    expect(rect.y + rect.height).toBeCloseTo(8, 6);
  });
});

describe('cursor-anchored wheel zoom (KTD3)', () => {
  // Local factory: a camera whose fit is an exact pixel-per-tile match (world
  // 40x28 into an 800x560 viewport, scale 20, no letterboxing), so screen and
  // world corners coincide and the math stays easy to hand-check.
  function makeExactFitCamera(): Camera {
    const camera = new Camera(new Container({ isRenderGroup: true }));
    camera.fitToViewport(40, 28, { width: 800, height: 560 });
    return camera;
  }

  it('AE1: zooming in at a screen point leaves screenToWorld(point) unchanged', () => {
    const camera = makeExactFitCamera();
    const point = { x: 200, y: 150 }; // resting "over a specific city"
    const worldBefore = camera.screenToWorld(point.x, point.y);
    camera.zoomAt(point, 2);
    const worldAfter = camera.screenToWorld(point.x, point.y);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6);
    expect(camera.scale).toBeCloseTo(40, 6);
  });

  it('AE1: zooming out at a screen point leaves screenToWorld(point) unchanged', () => {
    const camera = makeExactFitCamera();
    const point = { x: 620, y: 340 };
    const worldBefore = camera.screenToWorld(point.x, point.y);
    camera.zoomAt(point, 0.5);
    const worldAfter = camera.screenToWorld(point.x, point.y);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6);
    expect(camera.scale).toBeCloseTo(10, 6);
  });

  it('AE1: repeated in/out zoom steps at a fixed point preserve the anchor throughout', () => {
    const camera = makeExactFitCamera();
    const point = { x: 333, y: 217 };
    const worldBefore = camera.screenToWorld(point.x, point.y);
    const factors = [1.5, 1 / 1.5, 3, 1 / 3, 2.2, 1 / 2.2];
    for (const factor of factors) {
      camera.zoomAt(point, factor);
      const worldNow = camera.screenToWorld(point.x, point.y);
      expect(worldNow.x).toBeCloseTo(worldBefore.x, 6);
      expect(worldNow.y).toBeCloseTo(worldBefore.y, 6);
    }
    // The factors telescope back to 1x overall, so scale round-trips too.
    expect(camera.scale).toBeCloseTo(20, 6);
  });

  it('zooming at the viewport corner (not just the center) preserves the anchor', () => {
    const corners = [
      { x: 0, y: 0 },
      { x: 800, y: 560 },
    ];
    for (const corner of corners) {
      const camera = makeExactFitCamera();
      const worldBefore = camera.screenToWorld(corner.x, corner.y);
      camera.zoomAt(corner, 2.5);
      const worldAfter = camera.screenToWorld(corner.x, corner.y);
      expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6);
      expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6);
    }
  });

  it('scale clamps at MAX_SCALE and does not overshoot on a large zoom-in delta', () => {
    const camera = makeExactFitCamera();
    camera.zoomAt({ x: 400, y: 280 }, 1e9);
    expect(camera.scale).toBe(MAX_SCALE);
  });

  it('scale clamps at MIN_SCALE and does not overshoot on a large zoom-out delta', () => {
    const camera = makeExactFitCamera();
    camera.zoomAt({ x: 400, y: 280 }, 1e-9);
    expect(camera.scale).toBe(MIN_SCALE);
  });

  it('a deltaMode of line units and of pixel units producing the same intended zoom yield the same factor', () => {
    // DOM_DELTA_PIXEL (0): raw pixels. DOM_DELTA_LINE (1): normalized by the
    // line-height constant, so an equivalent line delta is deltaPx / lineHeight.
    const deltaPx = -120;
    const lineHeight = 16;
    const pixelFactor = wheelZoomFactor(deltaPx, 0);
    const lineFactor = wheelZoomFactor(deltaPx / lineHeight, 1);
    expect(lineFactor).toBeCloseTo(pixelFactor, 10);
  });

  it('a deltaMode of line units and of pixel units producing the same intended zoom yield the same resulting scale', () => {
    const deltaPx = -80;
    const lineHeight = 16;
    const pixelCamera = makeExactFitCamera();
    const lineCamera = makeExactFitCamera();
    const point = { x: 400, y: 280 };
    pixelCamera.zoomAt(point, wheelZoomFactor(deltaPx, 0));
    lineCamera.zoomAt(point, wheelZoomFactor(deltaPx / lineHeight, 1));
    expect(lineCamera.scale).toBeCloseTo(pixelCamera.scale, 10);
  });

  it('wheelZoomFactor is greater than 1 (zoom in) for a negative deltaY and less than 1 for a positive deltaY', () => {
    expect(wheelZoomFactor(-100, 0)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, 0)).toBeLessThan(1);
  });

  it('position clamping keeps at least part of the world within the viewport after an extreme pan', () => {
    const camera = makeExactFitCamera();
    camera.panBy(1_000_000, 1_000_000);
    const rect = camera.visibleWorldRect();
    // The visible rect must overlap the world's [0,40]x[0,28] bounds.
    const overlapWidth = Math.min(rect.x + rect.width, 40) - Math.max(rect.x, 0);
    const overlapHeight = Math.min(rect.y + rect.height, 28) - Math.max(rect.y, 0);
    expect(overlapWidth).toBeGreaterThan(0);
    expect(overlapHeight).toBeGreaterThan(0);
  });

  it('position clamping keeps at least part of the world within the viewport after an extreme pan in the opposite direction', () => {
    const camera = makeExactFitCamera();
    camera.panBy(-1_000_000, -1_000_000);
    const rect = camera.visibleWorldRect();
    const overlapWidth = Math.min(rect.x + rect.width, 40) - Math.max(rect.x, 0);
    const overlapHeight = Math.min(rect.y + rect.height, 28) - Math.max(rect.y, 0);
    expect(overlapWidth).toBeGreaterThan(0);
    expect(overlapHeight).toBeGreaterThan(0);
  });
});

describe('click vs. drag threshold (R2)', () => {
  it('a drag shorter than the click threshold is not treated as a pan', () => {
    const short = CLICK_DRAG_THRESHOLD_PX - 1;
    expect(exceedsClickThreshold(short, 0)).toBe(false);
    expect(exceedsClickThreshold(0, short)).toBe(false);
    expect(exceedsClickThreshold(0, 0)).toBe(false);
  });

  it('a drag past the click threshold is treated as a pan', () => {
    const long = CLICK_DRAG_THRESHOLD_PX + 5;
    expect(exceedsClickThreshold(long, 0)).toBe(true);
    expect(exceedsClickThreshold(3, long)).toBe(true);
  });
});

describe('build-click hit testing through the camera (KTD3, U3)', () => {
  const WORLD = { width: 40, height: 28 };

  // Local factory, matching the U2 suite's exact-fit camera: world 40x28 into
  // an 800x560 viewport, scale 20, no letterboxing, so hand-computed screen
  // points map to tidy world coordinates.
  function makeExactFitCamera(): Camera {
    const camera = new Camera(new Container({ isRenderGroup: true }));
    camera.fitToViewport(WORLD.width, WORLD.height, { width: 800, height: 560 });
    return camera;
  }

  it('a click at a known screen position resolves to the expected tile at unit scale', () => {
    const camera = makeExactFitCamera(); // scale = 20, origin = (0, 0)
    const tile = worldPointToTile(camera.screenToWorld(205, 155), WORLD);
    // world point (10.25, 7.75) floors to (10, 7).
    expect(tile).toEqual({ x: 10, y: 7 });
  });

  it('the same screen position resolves to a different tile after zooming and panning', () => {
    const camera = makeExactFitCamera();
    camera.zoomAt({ x: 205, y: 155 }, 2); // scale 20 -> 40, anchored at the click point
    camera.panBy(100, 100); // slide the world out from under that screen point
    const tile = worldPointToTile(camera.screenToWorld(205, 155), WORLD);
    expect(tile).toEqual({ x: 7, y: 5 });
    expect(tile).not.toEqual({ x: 10, y: 7 }); // the un-zoomed, un-panned answer
  });

  it('a click exactly at a tile boundary floors to that tile, not the one before it', () => {
    const camera = makeExactFitCamera();
    for (const world of [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 13, y: 9 },
      { x: 39, y: 27 }, // the last valid tile
    ]) {
      const screen = camera.worldToScreen(world.x, world.y);
      const tile = worldPointToTile(camera.screenToWorld(screen.x, screen.y), WORLD);
      expect(tile).toEqual(world);
    }
  });

  it('a click in fitToViewport\'s letterboxed margin clamps to a tile inside the world', () => {
    const camera = new Camera(new Container({ isRenderGroup: true }));
    // Wide viewport against a near-square world: the x axis letterboxes, so
    // screen (0, 0) and the far right edge both fall outside [0, 40).
    camera.fitToViewport(WORLD.width, WORLD.height, { width: 2000, height: 800 });

    const left = worldPointToTile(camera.screenToWorld(0, 0), WORLD);
    expect(left.x).toBe(0);
    expect(left.x).toBeGreaterThanOrEqual(0);

    const right = worldPointToTile(camera.screenToWorld(2000, 0), WORLD);
    expect(right.x).toBe(WORLD.width - 1);
    expect(right.x).toBeLessThan(WORLD.width);
  });

  it('a click after an extreme pan still resolves to a tile inside world bounds', () => {
    const camera = makeExactFitCamera();
    camera.panBy(1_000_000, 1_000_000); // position-clamped (U2), but push it anyway
    const tile = worldPointToTile(camera.screenToWorld(0, 0), WORLD);
    expect(tile.x).toBeGreaterThanOrEqual(0);
    expect(tile.x).toBeLessThan(WORLD.width);
    expect(tile.y).toBeGreaterThanOrEqual(0);
    expect(tile.y).toBeLessThan(WORLD.height);
  });
});
