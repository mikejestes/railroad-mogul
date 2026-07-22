import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import type { GameState } from '../sim/state.ts';
import { cityDemand, industryOutputPressure, industryStarved } from '../store/selectors.ts';
import { RAW_INDUSTRY_TYPES } from '../sim/model/goods.ts';
import type { Camera, Point, Rect } from './camera.ts';
import type { ZoomTierId } from './zoomTiers.ts';
import { TerrainChunkManager } from './terrainChunks.ts';
import type { Tile } from '../sim/pathfinding.ts';
import type { StepCost, TrackStructure } from '../sim/model/trackCost.ts';

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
 * touching pixels. Milestone 3 U6 adds two more in the same spirit:
 * `riverJitter` (deterministic per-tile river polyline displacement) and
 * `structureMarksFor` (maps a survey overlay's steps to the tiles where a
 * structure line item should draw a mark).
 *
 * Milestone 3 U6 additions (KTD9, R2/R3/R8):
 *   - A river layer (`riverLayer`), between terrain and track — nothing drew
 *     `state.rivers` before this milestone, and a bridge itemized in the
 *     survey panel over an invisible river is illegible (AE3). Drawn from
 *     the U1-rebased graph, each polyline point jittered by `riverJitter` so
 *     it reads as a meandering river rather than a coarse-grid zigzag — the
 *     treatment the terrain milestone's plan described but deferred.
 *   - An optional survey proposal overlay (`overlayLayer`), above track: a
 *     dashed polyline through the proposed path with a distinct mark on
 *     every step that carries a structure. `render`'s `overlay` parameter is
 *     `undefined` outside survey mode — the overlay is never authoritative
 *     (KTD9: it mirrors `SurveyController`'s boot-scope view state, never
 *     `GameState`) and is redrawn from scratch every frame like everything
 *     else here.
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

// --- Rivers (U6, AE3's visibility substrate) -------------------------------

export const RIVER_STROKE_PX = 1.5;
export const RIVER_COLOR = 0x4a7ba6;

/** Maximum per-axis jitter (world tiles) applied to a river polyline point
 *  before drawing (U6). Deliberately well under 0.5 tiles so a jittered
 *  point never crosses into a neighboring tile's visual space — it should
 *  read as "a river winding through this tile," not relocate the river. */
export const RIVER_JITTER_TILES = 0.28;

/**
 * Deterministic per-tile jitter for river polyline points (U6). A river
 * traced on the coarse tile grid (`world/rivers.ts`) is dead straight
 * between D8 steps, which reads as a surveyed canal, not a river — this
 * offsets each point by a small, fixed-per-coordinate amount so the same
 * river looks the same every frame (no per-frame randomness, which would
 * make the line visibly crawl) while still breaking up the grid-aligned
 * look. Pure and DOM/Pixi-free (KTD7): a hash of `(x, y)` via two
 * decorrelated sine terms, the same "cheap deterministic pseudo-random"
 * technique noise libraries use for hash-based jitter, not cryptographic
 * quality — it only needs to look irregular, not be unpredictable.
 */
export function riverJitter(x: number, y: number): Point {
  const hashA = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  const hashB = Math.sin(x * 269.5 + y * 183.3) * 43758.5453;
  const frac = (v: number) => v - Math.floor(v);
  return {
    x: (frac(hashA) - 0.5) * 2 * RIVER_JITTER_TILES,
    y: (frac(hashB) - 0.5) * 2 * RIVER_JITTER_TILES,
  };
}

// --- Survey proposal overlay (U6, KTD9) ------------------------------------

export const OVERLAY_STROKE_PX = 2.5;
export const OVERLAY_COLOR = 0xffe066;
export const OVERLAY_DASH_PX = 6;
export const OVERLAY_GAP_PX = 4;
export const STRUCTURE_MARK_PX = 8;
export const STRUCTURE_COLORS: Record<TrackStructure, number> = {
  bridge: 0x4a7ba6,
  tunnel: 0x8d5524,
  cutting: 0xd4a24c,
};

/** A survey proposal's path and itemized steps — everything `WorldRenderer`
 *  needs to draw it, and nothing it doesn't (never the full `SurveyResult`
 *  union, since an overlay only ever exists for an `ok: true` proposal —
 *  the caller in `main.ts` narrows before constructing this). */
export interface SurveyOverlay {
  path: Tile[];
  steps: StepCost[];
}

export interface StructureMark {
  x: number;
  y: number;
  structure: TrackStructure;
}

/**
 * Map a survey overlay's steps to the tiles where a structure mark should
 * draw (U6). Pure — the logic the "overlay-describing helper" test coverage
 * targets, per the repo's no-rendering-tests policy (KTD7): this decides
 * *where* marks land, `render` just draws them. Each mark sits at the
 * midpoint of the step it belongs to (`path[i]`..`path[i+1]`), one per
 * structured step, in path order.
 */
export function structureMarksFor(overlay: SurveyOverlay): StructureMark[] {
  const marks: StructureMark[] = [];
  for (let i = 0; i < overlay.steps.length; i++) {
    const structure = overlay.steps[i].structure;
    if (!structure) continue;
    const a = overlay.path[i];
    const b = overlay.path[i + 1];
    if (!a || !b) continue;
    marks.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, structure });
  }
  return marks;
}

/**
 * Draw one dashed line segment from `(ax, ay)` to `(bx, by)`, continuing the
 * dash/gap phase carried in `phase` (mutated) so a multi-segment polyline's
 * dash pattern stays continuous across segment joins rather than resetting
 * at every tile boundary. World-unit lengths in, so the caller has already
 * scale-compensated `dashWorld`/`gapWorld`/`width` (KTD6's stroke-sizing
 * convention). Not itself a candidate for the pure-helper test surface
 * (KTD7) — it draws — but is kept small and separate from `render` so the
 * one genuinely nontrivial bit of overlay drawing isn't buried inline.
 */
function drawDashedSegment(
  g: Graphics,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  dashWorld: number,
  gapWorld: number,
  color: number,
  width: number,
  phase: { value: number },
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0 || dashWorld <= 0) return;
  const ux = dx / len;
  const uy = dy / len;
  const cycle = dashWorld + gapWorld;
  let pos = 0;
  let cyclePos = phase.value % cycle;
  while (pos < len) {
    const inDash = cyclePos < dashWorld;
    const remainingInPhase = inDash ? dashWorld - cyclePos : cycle - cyclePos;
    const step = Math.min(remainingInPhase, len - pos);
    if (inDash) {
      g.moveTo(ax + ux * pos, ay + uy * pos)
        .lineTo(ax + ux * (pos + step), ay + uy * (pos + step))
        .stroke({ color, width });
    }
    pos += step;
    cyclePos += step;
    if (cyclePos >= cycle) cyclePos -= cycle;
  }
  phase.value = (phase.value + len) % cycle;
}

export class WorldRenderer {
  readonly container = new Container();
  private chunkManager: TerrainChunkManager;
  private riverLayer = new Graphics();
  private trackLayer = new Graphics();
  private industryLayer = new Graphics();
  private stationLayer = new Graphics();
  private cityLayer = new Container();
  private trainLayer = new Graphics();
  private overlayLayer = new Graphics();
  private labels = new Map<string, Text>();
  // Cached per-city dot Graphics, reused across frames the way `labelFor`
  // already caches Text objects — the U1-era version reallocated a Graphics
  // per city per frame without destroying the old one (U5 execution note).
  private cityDots = new Map<string, Graphics>();

  constructor(renderer: Renderer, private tilePx: number) {
    this.chunkManager = new TerrainChunkManager(renderer, tilePx);
    // Back to front: terrain -> rivers -> track -> industries -> stations ->
    // cities -> trains -> survey overlay (drawn above everything else, U6).
    this.container.addChild(
      this.chunkManager.container,
      this.riverLayer,
      this.trackLayer,
      this.industryLayer,
      this.stationLayer,
      this.cityLayer,
      this.trainLayer,
      this.overlayLayer,
    );
  }

  /** Destroy every resident chunk texture (KTD7) so terrain VRAM doesn't
   * outlive the renderer that owns it. */
  destroy(): void {
    this.chunkManager.destroy();
  }

  render(state: GameState, camera: Camera, overlay?: SurveyOverlay): void {
    this.chunkManager.update(camera, state.world.width, state.world.height);
    const t = this.tilePx;

    const { scale, tier } = camera;
    const visible = camera.visibleWorldRect();

    // Rivers (U6): a jittered polyline layer between terrain and track, so a
    // structure the survey panel itemizes over a river has a river to show
    // for it (AE3). Culled per-point the same way track segments are.
    this.riverLayer.clear();
    const riverStroke = scaleCompensatedSize(RIVER_STROKE_PX, scale);
    for (const river of state.rivers.rivers) {
      let started = false;
      for (const p of river.points) {
        if (!isWithinVisibleBounds({ x: p.x, y: p.y }, visible, VISIBLE_MARGIN_TILES)) {
          started = false;
          continue;
        }
        const jitter = riverJitter(p.x, p.y);
        const px = (p.x + jitter.x) * t + t / 2;
        const py = (p.y + jitter.y) * t + t / 2;
        if (!started) {
          this.riverLayer.moveTo(px, py);
          started = true;
        } else {
          this.riverLayer.lineTo(px, py);
        }
      }
      this.riverLayer.stroke({ color: RIVER_COLOR, width: riverStroke });
    }

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

    // Survey proposal overlay (U6, KTD9): a dashed polyline through the
    // proposed path, with a distinct mark on every step that carries a
    // structure (AE3). `overlay` is only ever passed while a survey is in
    // progress — nothing to clear-and-skip is needed the rest of the time
    // beyond the unconditional `.clear()` below.
    this.overlayLayer.clear();
    if (overlay) {
      const overlayStroke = scaleCompensatedSize(OVERLAY_STROKE_PX, scale);
      const dashWorld = scaleCompensatedSize(OVERLAY_DASH_PX, scale);
      const gapWorld = scaleCompensatedSize(OVERLAY_GAP_PX, scale);
      const phase = { value: 0 };
      for (let i = 0; i + 1 < overlay.path.length; i++) {
        const a = overlay.path[i];
        const b = overlay.path[i + 1];
        drawDashedSegment(
          this.overlayLayer,
          a.x * t + t / 2,
          a.y * t + t / 2,
          b.x * t + t / 2,
          b.y * t + t / 2,
          dashWorld,
          gapWorld,
          OVERLAY_COLOR,
          overlayStroke,
          phase,
        );
      }

      const markSize = scaleCompensatedSize(STRUCTURE_MARK_PX, scale);
      for (const mark of structureMarksFor(overlay)) {
        this.overlayLayer
          .circle(mark.x * t + t / 2, mark.y * t + t / 2, markSize / 2)
          .fill({ color: STRUCTURE_COLORS[mark.structure] });
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
