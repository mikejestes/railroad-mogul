import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import type { GameState } from '../sim/state.ts';
import { cityDemand, industryOutputPressure, industryStarved } from '../store/selectors.ts';
import { RAW_INDUSTRY_TYPES } from '../sim/model/goods.ts';
import type { Camera, Point, Rect } from './camera.ts';
import type { ZoomTierId } from './zoomTiers.ts';
import { TerrainChunkManager } from './terrainChunks.ts';

/**
 * Draws the whole world onto the map canvas (U3/U5/U6/U9). Terrain is drawn
 * as chunk textures reconciled against the camera each frame (U4, see below);
 * track, industries, stations, trains, and city demand cues are redrawn each
 * frame so the player sees their network appear as they build it. Reads
 * state only — never mutates it (KTD1).
 *
 * Layers, back to front: terrain grid -> track -> industries -> stations ->
 * city markers + labels -> trains.
 *
 * U5 (KTD4/KTD5/R5/R7): `render` now takes the `Camera` and branches on
 * `camera.tier` — zoom changes what an entity draws as, not just its size
 * (KTD4's semantic-zoom model). Cities are demand-tinted dots at every tier
 * but only labeled below `continent`, or above a population floor at
 * `continent`, so the map does not clutter with every hamlet's name at the
 * widest zoom. Stations gain a catchment outline from `region` inward and a
 * distinguishable ring mark at `local`; trains gain a directional mark at
 * `local` so a moving train reads differently from a stationary station.
 *
 * KTD6: PixiJS does not compensate stroke width, marker size, or text scale
 * for a scaled parent — the world container carries the camera's own scale
 * (KTD2), so a fixed-world-unit stroke (or a fixed-fontSize `Text`) would
 * grow with zoom. Every stroke width and marker radius here is computed by
 * `scaleCompensatedSize`, which divides a fixed *apparent* pixel size by
 * `camera.scale` before handing it to a draw call, so it reads the same size
 * on screen at any zoom; city name labels get the equivalent treatment via
 * `label.scale.set(scaleCompensatedSize(1, camera.scale))` in `labelFor`.
 *
 * Entities outside the camera's visible world rect (plus a small margin) are
 * skipped — `isWithinVisibleBounds` is a cheap per-entity bounds check, not
 * generic culling, appropriate for this entity count (see the U5 plan note).
 *
 * The repo has no rendering-test policy (KTD7) — draw calls themselves are
 * not unit-tested. The three predicates above (`isWithinVisibleBounds`,
 * `scaleCompensatedSize`, `shouldShowCityLabel`) are pure and DOM/Pixi-free,
 * so the logic that decides *what* would render is fully covered without
 * touching pixels.
 *
 * U4 (KTD7/KTD8, R2/R3/R9): the terrain layer is no longer a single static
 * per-tile `Graphics` draw. `TerrainChunkManager` (`terrainChunks.ts`) owns
 * it now — chunk textures generated lazily as the camera's visible range
 * touches them, evicted by LRU past a resident budget — and `render` just
 * asks it to reconcile against the camera every frame. `WorldRenderer` now
 * takes the PixiJS `Renderer` at construction (previously only `tilePx`)
 * purely to hand it to the chunk manager, which needs a real renderer to
 * draw chunk `Graphics` into a `RenderTexture`.
 *
 * U6 (R7): industries — the 26 sites simulated by `productionSystem` but
 * previously never drawn — get their own layer between track and stations.
 * Raw extractors draw as a diamond, processors as a triangle, so the supply
 * chain reads at a glance; a starved processor (via `industryStarved`, a
 * selector rather than logic duplicated here — see `src/store/selectors.ts`)
 * draws in a distinguishing color from a running one. Both shapes fade in
 * with `industryOutputPressure` so a fuller stockpile reads more solid,
 * hinting it needs a pickup. Hidden at `continent` — 26 small marks at the
 * widest zoom is clutter, not signal — and shown from `region` inward, same
 * gating rule as station catchment outlines.
 */
const COLORS = {
  track: 0xb08d57,
  station: 0xf1faee,
  catchment: 0x4cc9f0,
  train: 0xffd166,
  cityLabel: 0xe0e1dd,
  industryRaw: 0xd4a24c,
  industryProcessor: 0x8ecae6,
  industryStarved: 0xef476f,
};

/** Screen-space margin (in world tiles) added around the visible rect before
 * culling an entity out of the draw pass, so a marker doesn't pop into
 * existence exactly at the viewport edge as the camera pans (R5/R7). */
export const VISIBLE_MARGIN_TILES = 2;

/**
 * Apparent on-screen sizes (px) for strokes and markers (KTD6). Each is
 * divided by `camera.scale` via `scaleCompensatedSize` before being handed
 * to a draw call, so the drawn stroke/marker reads at this size on screen
 * regardless of zoom. Values match the pre-camera fixed-pixel look.
 */
export const TRACK_STROKE_PX = 3;
export const STATION_MARKER_PX = 11;
export const STATION_CATCHMENT_STROKE_PX = 1.5;
export const CITY_DOT_BASE_PX = 4;
export const CITY_DOT_INTENSITY_PX = 4;
export const TRAIN_MARKER_PX = 7;
export const INDUSTRY_MARKER_PX = 9;
/** Apparent font size (px) for a city name label (KTD6). The `Text` object's
 * `fontSize` is fixed at this value and its `.scale` is counter-scaled by
 * `scaleCompensatedSize(1, camera.scale)` before being added to the
 * camera-scaled world container, so the glyph raster reads at this size on
 * screen regardless of zoom — the same treatment as every marker above. */
export const CITY_LABEL_FONT_PX = 10;

/** Fill alpha range for an industry mark, from empty (`industryOutputPressure`
 * === 0) to full (=== 1) — a fuller stockpile reads more solid on the map
 * (U6/R7). Kept well above zero at the low end so an empty industry is still
 * visible, not invisible. */
export const INDUSTRY_ALPHA_MIN = 0.4;
export const INDUSTRY_ALPHA_MAX = 1;

/**
 * Below this population, a city's name label is suppressed at the
 * `continent` tier to avoid clutter (R5) — from `region` inward every city
 * is labeled regardless of size. `populationForTier(0) === 50_000` and
 * `populationForTier(1) === 200_000` (`src/sim/model/cities.ts`), so this
 * threshold hides only the smallest starting-tier cities while the map is
 * zoomed all the way out.
 */
export const CITY_LABEL_POPULATION_THRESHOLD = 100_000;

/**
 * Whether a world-space point lies within `visible`, expanded by
 * `marginTiles` on every side. Pure so the per-entity culling used in
 * `render` is unit-testable without a PixiJS instance or DOM (KTD7).
 */
export function isWithinVisibleBounds(point: Point, visible: Rect, marginTiles: number): boolean {
  return (
    point.x >= visible.x - marginTiles &&
    point.x <= visible.x + visible.width + marginTiles &&
    point.y >= visible.y - marginTiles &&
    point.y <= visible.y + visible.height + marginTiles
  );
}

/**
 * Convert a fixed apparent on-screen size (px) into the world-unit size to
 * draw at, so a stroke or marker reads at that same apparent size regardless
 * of the camera's current scale (KTD6) — the world container's own scale
 * (set from `camera.scale`, KTD2/KTD3) multiplies it back out at render time.
 */
export function scaleCompensatedSize(apparentPx: number, scale: number): number {
  return apparentPx / scale;
}

/**
 * Whether a city's name label should be drawn at the given tier (R5). Only
 * `continent` suppresses small cities; `region` and `local` always label,
 * since the point of zooming in is to see detail that was clutter further out.
 */
export function shouldShowCityLabel(tier: ZoomTierId, population: number): boolean {
  return tier !== 'continent' || population >= CITY_LABEL_POPULATION_THRESHOLD;
}

export class WorldRenderer {
  readonly container = new Container();
  private chunkManager: TerrainChunkManager;
  private trackLayer = new Graphics();
  private industryLayer = new Graphics();
  private stationLayer = new Graphics();
  private cityLayer = new Container();
  private trainLayer = new Graphics();
  private labels = new Map<string, Text>();
  // Cached per-city dot Graphics, reused across frames the way `labelFor`
  // already caches Text objects — the U1-era version reallocated a Graphics
  // per city per frame without destroying the old one (U5 execution note).
  private cityDots = new Map<string, Graphics>();

  constructor(renderer: Renderer, private tilePx: number) {
    this.chunkManager = new TerrainChunkManager(renderer, tilePx);
    this.container.addChild(
      this.chunkManager.container,
      this.trackLayer,
      this.industryLayer,
      this.stationLayer,
      this.cityLayer,
      this.trainLayer,
    );
  }

  /** Destroy every resident chunk texture (KTD7) so terrain VRAM doesn't
   * outlive the renderer that owns it. */
  destroy(): void {
    this.chunkManager.destroy();
  }

  render(state: GameState, camera: Camera): void {
    this.chunkManager.update(camera, state.world.width, state.world.height);
    const t = this.tilePx;

    const { scale, tier } = camera;
    const visible = camera.visibleWorldRect();

    // Track segments — culled to the visible rect (plus margin) and
    // stroke-compensated so the line reads the same width at every zoom.
    this.trackLayer.clear();
    const trackStrokeWidth = scaleCompensatedSize(TRACK_STROKE_PX, scale);
    for (const seg of state.track.segments) {
      const aVisible = isWithinVisibleBounds({ x: seg.ax, y: seg.ay }, visible, VISIBLE_MARGIN_TILES);
      const bVisible = isWithinVisibleBounds({ x: seg.bx, y: seg.by }, visible, VISIBLE_MARGIN_TILES);
      if (!aVisible && !bVisible) continue;
      this.trackLayer
        .moveTo(seg.ax * t + t / 2, seg.ay * t + t / 2)
        .lineTo(seg.bx * t + t / 2, seg.by * t + t / 2)
        .stroke({ color: COLORS.track, width: trackStrokeWidth });
    }

    // Industries: raw extractors (diamonds) and processors (triangles) read
    // differently so the supply chain is visible at a glance (R7). Hidden at
    // continent — 26 small marks is clutter at that zoom — and shown from
    // region inward. A starved processor draws in a distinguishing color; a
    // fuller output stockpile (industryOutputPressure) reads more solid.
    this.industryLayer.clear();
    if (tier !== 'continent') {
      const industryMarkerSize = scaleCompensatedSize(INDUSTRY_MARKER_PX, scale);
      const half = industryMarkerSize / 2;
      for (const ind of state.industries) {
        if (!isWithinVisibleBounds({ x: ind.x, y: ind.y }, visible, VISIBLE_MARGIN_TILES)) continue;
        const cx = ind.x * t + t / 2;
        const cy = ind.y * t + t / 2;
        const alpha = INDUSTRY_ALPHA_MIN + industryOutputPressure(ind) * (INDUSTRY_ALPHA_MAX - INDUSTRY_ALPHA_MIN);
        if (RAW_INDUSTRY_TYPES.includes(ind.type)) {
          this.industryLayer
            .poly([cx, cy - half, cx + half, cy, cx, cy + half, cx - half, cy])
            .fill({ color: COLORS.industryRaw, alpha });
        } else {
          const color = industryStarved(ind) ? COLORS.industryStarved : COLORS.industryProcessor;
          this.industryLayer
            .poly([cx - half, cy + half, cx + half, cy + half, cx, cy - half])
            .fill({ color, alpha });
        }
      }
    }

    // Stations: a plain square marker at continent/region, a distinguishable
    // ring mark at local; a catchment outline appears from region inward so
    // the player can see what a station reaches without being fully zoomed
    // in (R5/R7).
    this.stationLayer.clear();
    const stationMarkerSize = scaleCompensatedSize(STATION_MARKER_PX, scale);
    const catchmentStroke = scaleCompensatedSize(STATION_CATCHMENT_STROKE_PX, scale);
    for (const s of state.stations) {
      if (!isWithinVisibleBounds({ x: s.x, y: s.y }, visible, VISIBLE_MARGIN_TILES)) continue;
      const cx = s.x * t + t / 2;
      const cy = s.y * t + t / 2;
      if (tier === 'local') {
        this.stationLayer.circle(cx, cy, stationMarkerSize / 2).fill({ color: COLORS.station });
        this.stationLayer
          .rect(
            cx - stationMarkerSize * 0.75,
            cy - stationMarkerSize * 0.75,
            stationMarkerSize * 1.5,
            stationMarkerSize * 1.5,
          )
          .stroke({ color: COLORS.station, width: catchmentStroke });
      } else {
        this.stationLayer
          .rect(cx - stationMarkerSize / 2, cy - stationMarkerSize / 2, stationMarkerSize, stationMarkerSize)
          .fill({ color: COLORS.station });
      }
      if (tier !== 'continent') {
        this.stationLayer.circle(cx, cy, s.radius * t).stroke({ color: COLORS.catchment, width: catchmentStroke });
      }
    }

    // City markers coloured by unmet demand, with name labels suppressed for
    // small cities at continent tier (R5).
    this.cityLayer.removeChildren();
    const cityDotRadiusBase = scaleCompensatedSize(CITY_DOT_BASE_PX, scale);
    const cityDotRadiusIntensity = scaleCompensatedSize(CITY_DOT_INTENSITY_PX, scale);
    for (const city of state.cities) {
      if (!isWithinVisibleBounds({ x: city.x, y: city.y }, visible, VISIBLE_MARGIN_TILES)) continue;
      const unmet = cityDemand(state, city.id).reduce((n, r) => n + r.backlog, 0);
      const intensity = Math.min(1, unmet / 40);
      const red = Math.round(120 + intensity * 135);
      const green = Math.round(200 - intensity * 150);
      const dot = this.cityDotFor(city.id);
      dot.clear();
      dot
        .circle(city.x * t + t / 2, city.y * t + t / 2, cityDotRadiusBase + intensity * cityDotRadiusIntensity)
        .fill({ color: (red << 16) | (green << 8) | 0x50 });
      this.cityLayer.addChild(dot);
      if (shouldShowCityLabel(tier, city.population)) {
        this.labelFor(city.id, city.name, city.x * t + t / 2, city.y * t - 2, scale);
      }
    }

    // Trains: a dot at continent/region, a small directional mark at local
    // so a moving train reads differently from a stationary station (R5).
    this.trainLayer.clear();
    const trainMarkerSize = scaleCompensatedSize(TRAIN_MARKER_PX, scale);
    for (const train of state.trains) {
      if (!train.initialized) continue;
      if (!isWithinVisibleBounds({ x: train.x, y: train.y }, visible, VISIBLE_MARGIN_TILES)) continue;
      const cx = train.x * t + t / 2;
      const cy = train.y * t + t / 2;
      if (tier === 'local') {
        this.trainLayer
          .poly([
            cx - trainMarkerSize / 2,
            cy - trainMarkerSize / 2,
            cx + trainMarkerSize / 2,
            cy,
            cx - trainMarkerSize / 2,
            cy + trainMarkerSize / 2,
          ])
          .fill({ color: COLORS.train });
      } else {
        this.trainLayer.circle(cx, cy, trainMarkerSize / 2).fill({ color: COLORS.train });
      }
    }
  }

  private cityDotFor(id: string): Graphics {
    let dot = this.cityDots.get(id);
    if (!dot) {
      dot = new Graphics();
      this.cityDots.set(id, dot);
    }
    return dot;
  }

  private labelFor(id: string, name: string, x: number, y: number, scale: number): void {
    let label = this.labels.get(id);
    if (!label) {
      label = new Text({
        text: name,
        style: new TextStyle({ fill: COLORS.cityLabel, fontSize: CITY_LABEL_FONT_PX, fontFamily: 'system-ui' }),
      });
      label.anchor.set(0.5, 1);
      this.labels.set(id, label);
    }
    label.x = x;
    label.y = y;
    // KTD6: the label's glyph raster is rendered at a fixed `fontSize` in the
    // world container's local space, so like every stroke/marker above it
    // must be counter-scaled by 1/camera.scale to read at a constant
    // apparent size on screen regardless of zoom.
    const labelScale = scaleCompensatedSize(1, scale);
    label.scale.set(labelScale);
    this.cityLayer.addChild(label);
  }
}
