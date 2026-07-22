import type { Container } from 'pixi.js';
import { tierFor, type ZoomTierId } from './zoomTiers.ts';

/**
 * The camera: owns the world container's pan/zoom transform and answers the
 * coordinate queries the renderer and input handlers need (U1/U2/U3, KTD3, KTD7).
 *
 * Camera state (origin, scale) is a plain class field set, owned by the boot
 * sequence — never part of `GameState`. `GameState` is serialized wholesale
 * and byte-equality is the determinism oracle (KTD3); a camera field there
 * would turn every pan into a save-state change. Because there is no
 * rendering-test policy in this repo (KTD7), correctness here is proven by
 * unit-testing the transform math directly, not by looking at pixels.
 *
 * The world container this camera drives is constructed by the caller with
 * `{ isRenderGroup: true }` (KTD2) so pan/zoom transforms move to the GPU and
 * cost near-zero CPU regardless of child count — the camera itself is
 * transform bookkeeping and never touches rendering.
 *
 * The camera also tracks the current zoom tier (U4, KTD5): every scale
 * change (`fitToViewport`, `zoomAt`) re-derives it via `tierFor`, passing the
 * *previous* tier so the hysteresis band in `zoomTiers.ts` applies
 * directionally. `WorldRenderer` reads `camera.tier` to decide what an
 * entity draws as (R5) — the camera never decides *how* to draw, only what
 * scale and tier the renderer should draw at.
 */
export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenSize {
  width: number;
  height: number;
}

/** Screen-space drag distance (px) beyond which a pointer gesture counts as a
 * pan rather than a click, so dragging the map does not also lay track/build
 * a station under the pointer's start position. */
export const CLICK_DRAG_THRESHOLD_PX = 4;

/**
 * Zoom bounds (R4), expressed in the same units as `camera.scale` — pixels
 * per world unit, since `WORLD_UNIT_PX = 1` (one world unit is one tile).
 * `MIN_SCALE` stops the player shrinking the world to an unreadable speck;
 * `MAX_SCALE` stops zooming in past the point where a single tile fills the
 * screen and there's nothing left to see.
 *
 * M4 U7 (KTD7): raised 480 -> 3600 to give the new `street` tier
 * (`zoomTiers.ts`) real depth to resolve district scenes in, rather than a
 * sliver just past `local`'s old ceiling — sized to roughly the same
 * zoom-depth ratio `local` had under the old `MAX_SCALE` (~3.4x its own
 * up-threshold), applied to `STREET_UP_THRESHOLD` instead.
 */
export const MIN_SCALE = 4;
export const MAX_SCALE = 3600;

/** Approximate CSS pixel height of one "line" of `WheelEvent.deltaY` under
 * `DOM_DELTA_LINE`, used to normalize line-mode wheel deltas (typical of
 * some mice) onto the same scale as pixel-mode deltas (typical of
 * trackpads) before deriving a zoom factor. */
export const WHEEL_LINE_HEIGHT_PX = 16;

/** How much wheel delta (in normalized pixels) it takes to double/halve the
 * zoom: `factor = exp(-normalizedDeltaY * WHEEL_ZOOM_SENSITIVITY)`, so the
 * step is multiplicative and feels linear in log space rather than additive
 * (additive steps feel wrong at the extremes). */
export const WHEEL_ZOOM_SENSITIVITY = 0.0015;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Convert a raw `WheelEvent.deltaY`/`deltaMode` pair into a multiplicative
 * zoom factor (>1 zooms in, <1 zooms out). Pure and DOM-free so it can be
 * unit-tested directly (KTD7) rather than by synthesizing wheel events.
 * Only `DOM_DELTA_PIXEL` (0) and `DOM_DELTA_LINE` (1) are normalized
 * distinctly; any other mode is treated as already pixel-scaled.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const normalizedDeltaY = deltaMode === 1 ? deltaY * WHEEL_LINE_HEIGHT_PX : deltaY;
  return Math.exp(-normalizedDeltaY * WHEEL_ZOOM_SENSITIVITY);
}

export class Camera {
  // Screen-space position of world point (0, 0) — i.e. where the world
  // container's origin currently renders on screen.
  private originX = 0;
  private originY = 0;
  private currentScale = 1;
  private screenWidth = 0;
  private screenHeight = 0;
  private worldWidth = 0;
  private worldHeight = 0;
  // Seeded at the lowest tier: with no prior camera state, deriving the
  // initial tier via tierFor(scale, 'continent') on the first fitToViewport
  // call is equivalent to a scale-only lookup (only the "advance" direction
  // can run from the lowest seed), which is what a cold start should do —
  // hysteresis only matters once there is a tier to hold onto.
  private currentTierId: ZoomTierId = 'continent';

  constructor(private readonly world: Container) {}

  get scale(): number {
    return this.currentScale;
  }

  /** The current zoom tier (U4, KTD5), re-derived with hysteresis on every
   * scale change. Never affects simulation state (KTD3) — it is a pure
   * function of scale and read-only view state. */
  get tier(): ZoomTierId {
    return this.currentTierId;
  }

  private updateTier(): void {
    this.currentTierId = tierFor(this.currentScale, this.currentTierId);
  }

  /**
   * Fit the whole world into `screen`, centered, scaled so the world's longer
   * axis (relative to the viewport) touches the edge and nothing is cropped
   * (R1). This replaces a fixed pixels-per-tile constant: the camera's scale
   * *is* the pixels-per-world-unit conversion the renderer draws through.
   * Called at boot and again on every window resize.
   */
  fitToViewport(worldWidth: number, worldHeight: number, screen: ScreenSize): void {
    this.screenWidth = screen.width;
    this.screenHeight = screen.height;
    this.worldWidth = worldWidth;
    this.worldHeight = worldHeight;
    const scale =
      worldWidth > 0 && worldHeight > 0 ? Math.min(screen.width / worldWidth, screen.height / worldHeight) : 1;
    this.currentScale = scale;
    this.originX = (screen.width - worldWidth * scale) / 2;
    this.originY = (screen.height - worldHeight * scale) / 2;
    this.updateTier();
    this.sync();
  }

  /** Convert a screen-space point (e.g. a pointer event) to world coordinates. */
  screenToWorld(screenX: number, screenY: number): Point {
    return { x: (screenX - this.originX) / this.currentScale, y: (screenY - this.originY) / this.currentScale };
  }

  /** Convert a world-space point to its current screen position. */
  worldToScreen(worldX: number, worldY: number): Point {
    return { x: worldX * this.currentScale + this.originX, y: worldY * this.currentScale + this.originY };
  }

  /**
   * Pan by a screen-space pointer delta (R2): the world follows the pointer,
   * so the visible world rect moves by the delta divided by scale, in the
   * opposite direction — panning the content right uncovers world to the left.
   */
  panBy(dxScreen: number, dyScreen: number): void {
    this.originX += dxScreen;
    this.originY += dyScreen;
    this.clampPosition();
    this.sync();
  }

  /**
   * Zoom around a fixed screen point (R3): the world point currently under
   * `screenPoint` is read first, the scale is updated multiplicatively and
   * clamped to `[MIN_SCALE, MAX_SCALE]` (R4), and the origin is then solved
   * so that same world point lands back under `screenPoint` — this is the
   * cursor-anchoring AE1 depends on. Position clamping (R4) runs last and
   * can override the anchor at the extremes, where "keep the world on
   * screen" wins over "keep the cursor anchored".
   */
  zoomAt(screenPoint: Point, factor: number): void {
    const worldPoint = this.screenToWorld(screenPoint.x, screenPoint.y);
    const newScale = clamp(this.currentScale * factor, MIN_SCALE, MAX_SCALE);
    this.currentScale = newScale;
    this.originX = screenPoint.x - worldPoint.x * newScale;
    this.originY = screenPoint.y - worldPoint.y * newScale;
    this.updateTier();
    this.clampPosition();
    this.sync();
  }

  /** The rectangle of world space currently visible on screen. */
  visibleWorldRect(): Rect {
    const topLeft = this.screenToWorld(0, 0);
    const bottomRight = this.screenToWorld(this.screenWidth, this.screenHeight);
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };
  }

  /**
   * Keep the world from being panned or zoomed entirely off screen (R4).
   * Constrains the *center* of the viewport, in world coordinates, to stay
   * within the world's bounds — so however far the player pans or zooms
   * out, the world content at the middle of the screen is always real
   * world, not empty space past an edge. A no-op while the world has no
   * extent yet (before the first `fitToViewport`).
   */
  private clampPosition(): void {
    if (this.worldWidth <= 0 || this.worldHeight <= 0) return;
    const centerScreenX = this.screenWidth / 2;
    const centerScreenY = this.screenHeight / 2;
    const center = this.screenToWorld(centerScreenX, centerScreenY);
    const clampedX = clamp(center.x, 0, this.worldWidth);
    const clampedY = clamp(center.y, 0, this.worldHeight);
    if (clampedX !== center.x) this.originX = centerScreenX - clampedX * this.currentScale;
    if (clampedY !== center.y) this.originY = centerScreenY - clampedY * this.currentScale;
  }

  private sync(): void {
    this.world.position.set(this.originX, this.originY);
    this.world.scale.set(this.currentScale, this.currentScale);
  }
}

/**
 * Whether an accumulated screen-space drag is large enough to count as a pan
 * rather than a click. Pure so pointer-handling logic in `main.ts` can be
 * exercised without synthesizing DOM events.
 */
export function exceedsClickThreshold(totalDxScreen: number, totalDyScreen: number): boolean {
  return totalDxScreen * totalDxScreen + totalDyScreen * totalDyScreen > CLICK_DRAG_THRESHOLD_PX * CLICK_DRAG_THRESHOLD_PX;
}

/**
 * Floor a continuous world-space point (as returned by `camera.screenToWorld`)
 * to integer tile coordinates and clamp them into the world's bounds (U3,
 * R2/R3). This replaces the old fixed `TILE_PX` division in `main.ts`'s click
 * handler: the camera now supplies the continuous world point at any pan/zoom,
 * and this is the pure last step before a build intent is dispatched.
 *
 * Clamping (not just flooring) matters because a screen point's world-space
 * image can legitimately fall outside `[0, world.width) x [0, world.height)`
 * — a click in `fitToViewport`'s letterboxed margin, or a point right at the
 * world's far edge where the continuous coordinate is exactly `width`/`height`
 * — and a build intent must never carry an out-of-grid tile.
 */
export function worldPointToTile(worldPoint: Point, world: { width: number; height: number }): Point {
  return {
    x: clamp(Math.floor(worldPoint.x), 0, world.width - 1),
    y: clamp(Math.floor(worldPoint.y), 0, world.height - 1),
  };
}
