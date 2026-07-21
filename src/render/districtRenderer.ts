/**
 * District street rendering (M4 U7, KTD7, KTD8, R8/R10/R11).
 *
 * Follows `TerrainChunkManager`'s proven shape (`render/terrainChunks.ts`):
 * pure policy functions — which districts are in view, a cache key derived
 * from the quantized record, LRU eviction over a resident budget — plus a
 * thin GPU-facing shell that carries out their answers against a real
 * PixiJS `Renderer`. `selectEvictable` itself is imported straight from
 * `terrainChunks.ts` rather than re-implemented: it is already a generic
 * (string key, `lastSeen` counter) LRU with no terrain-specific assumptions,
 * so a second copy here would be exactly the kind of drift the repo's
 * "no rendering tests, cover the pure policy" discipline warns about.
 *
 * The cache key *is* the derivation input (KTD8): a district's scene is
 * regenerated when its id, the zoom tier, its quantized
 * `development`/channel/`density` tuple, its own `cuts.length`, or a nearby
 * derelict-site count actually changes — a tick that nudges a channel by a
 * sub-quantum amount (and touches none of the others) reuses the resident
 * texture.
 *
 * Only the `street` tier mounts this layer (KTD7); `local` and below stay
 * pixel-identical to their pre-M4 marker rendering (`worldRenderer.ts`).
 *
 * Draw calls themselves are not unit-tested, per the repo's no-rendering-
 * tests policy — the pure functions below (`districtsInView`,
 * `districtSceneCacheKey`) carry the coverage; `DistrictRenderer` is a thin,
 * deliberately simple shell around them and `world/streets.ts`'s pure scene
 * generator.
 */
import { Container, Graphics, Sprite, RenderTexture } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import type { Camera, Rect } from './camera.ts';
import type { ZoomTierId } from './zoomTiers.ts';
import type { GameState } from '../sim/state.ts';
import type { District } from '../sim/model/districts.ts';
import { DISTRICT_FOOTPRINT_TILES } from '../sim/model/districts.ts';
import { quantizeDistrict, generateDistrictScene, extentTilesFor } from '../world/streets.ts';
import { selectEvictable, type ChunkLruEntry } from './terrainChunks.ts';

/** World-tile margin added around the camera's visible rect before a
 *  district's scene is considered "in view" — mirrors
 *  `VISIBLE_MARGIN_TILES` in `worldRenderer.ts`. */
export const DISTRICT_VIEW_MARGIN_TILES = 1;

/** Maximum number of district scene textures kept resident at once, mirror
 *  of `RESIDENT_CHUNK_BUDGET`'s rationale — a district's texture is small
 *  relative to a terrain chunk (one district, not 1024 tiles), so a smaller
 *  budget than terrain's still comfortably covers the visible range at
 *  `street` tier. */
export const RESIDENT_DISTRICT_BUDGET = 32;

/** Raster resolution (px) a district scene's `RenderTexture` is rendered
 *  at — a fixed, crisp texture size regardless of the district's world-tile
 *  extent, the same decoupling `CHUNK_TEXTURE_PX_PER_TILE` gives terrain. */
export const SCENE_TEXTURE_PX = 512;

/** Whether a world-space point lies within `visible`, expanded by
 *  `marginTiles` on every side. A small local copy of `worldRenderer.ts`'s
 *  `isWithinVisibleBounds` predicate (identical formula) rather than an
 *  import, to avoid a `districtRenderer.ts` <-> `worldRenderer.ts` import
 *  cycle now that `worldRenderer.ts` mounts this module's container. */
function withinRect(point: { x: number; y: number }, visible: Rect, marginTiles: number): boolean {
  return (
    point.x >= visible.x - marginTiles &&
    point.x <= visible.x + visible.width + marginTiles &&
    point.y >= visible.y - marginTiles &&
    point.y <= visible.y + visible.height + marginTiles
  );
}

/** Districts whose anchor falls within the camera's visible rect (plus
 *  margin) — the in-view predicate `DistrictRenderer.update` reconciles
 *  resident scenes against (KTD8). Pure, so it's testable without a PixiJS
 *  instance or DOM. */
export function districtsInView(
  districts: readonly District[],
  visible: Rect,
  marginTiles: number = DISTRICT_VIEW_MARGIN_TILES,
): District[] {
  return districts.filter((d) => withinRect({ x: d.anchorX, y: d.anchorY }, visible, marginTiles));
}

/**
 * A district's resident-texture cache key (KTD8): identity, tier, the exact
 * quantized tuple `generateDistrictScene` derives its scene from, the
 * district's own `cuts.length`, and (via `nearbyDerelictCount`, below) a
 * count of `state.derelictSites` within this district's footprint — so this
 * key changes whenever any of those regeneration inputs does.
 *
 * Milestone 5 U7/U4 fix: this key used to omit `cuts`/derelict/land-value
 * entirely, so a player laying track through their own district could go on
 * not seeing the vacuum band their own cut just created until some unrelated
 * channel happened to cross a quantum boundary — "a cut the player cannot
 * see is a punishment, not a decision." `cuts.length` and a nearby-derelict
 * count are cheap, monotonically-changing signals that fix exactly that: a
 * fresh cut or a newly-appeared derelict site anywhere in the district's
 * reach now invalidates the resident texture immediately. This is a
 * rendering-only cache key — nothing here is stored in `GameState` or the
 * save.
 *
 * Still-known limitation: this key has no term for `landValueAt` (U6) — a
 * neighboring station's catchment newly overlapping this district's parcels
 * can shift sampled land value with zero movement in any term above, so a
 * resident texture can still go stale on that axis until the next
 * channel/cut/derelict-driven regeneration. Noted here rather than silently
 * accepted; the repo's no-rendering-tests policy leaves this class of key
 * uncovered by tests either way.
 */
export function districtSceneCacheKey(district: District, tier: ZoomTierId, nearbyDerelictCount: number = 0): string {
  const q = quantizeDistrict(district);
  return `${district.id}:${tier}:${q.development}:${q.residential}:${q.commercial}:${q.industrial}:${q.density}:${district.cuts.length}:${nearbyDerelictCount}`;
}

/**
 * Count of `state.derelictSites` within `district`'s footprint (Chebyshev,
 * matching `world/streets.ts`'s own derelict-yard filter) — the cheap,
 * renderer-only signal `districtSceneCacheKey` folds in so a derelict site
 * appearing elsewhere on the map (any station relocation, anywhere) but
 * landing inside this district's rendered extent invalidates its resident
 * texture, even though nothing about this district's own record changed.
 */
export function nearbyDerelictCount(state: GameState, district: District): number {
  let count = 0;
  for (const site of state.derelictSites) {
    if (
      Math.max(Math.abs(site.x - district.anchorX), Math.abs(site.y - district.anchorY)) <= DISTRICT_FOOTPRINT_TILES
    ) {
      count++;
    }
  }
  return count;
}

const USE_COLORS = {
  residential: 0xc9a876,
  commercial: 0x6fb3d9,
  industrial: 0x8a7f9e,
} as const;

const STREET_COLOR = 0x2a2a2a;
const STATION_SQUARE_COLOR = 0xf1faee;
const VACANT_ALPHA = 0.25;
/** Milestone 5 U7 (R13): the abandoned-yard mark's color — a dull rust,
 *  distinct from every building-use color and from the plain vacancy fade
 *  (`VACANT_ALPHA`), so a derelict site reads as a different KIND of scar,
 *  not just another empty building. */
const DERELICT_YARD_COLOR = 0x6b3f2a;

interface ResidentScene {
  texture: RenderTexture;
  sprite: Sprite;
  extentTiles: number;
  lastSeen: number;
}

/**
 * Owns the set of resident district-scene textures and the container their
 * sprites are added to. GPU-facing and deliberately thin, mirroring
 * `TerrainChunkManager` — all policy decisions above are pure and covered
 * without touching pixels; this class only carries them out.
 */
export class DistrictRenderer {
  readonly container = new Container();
  private resident = new Map<string, ResidentScene>();
  private frame = 0;

  constructor(
    private readonly renderer: Renderer,
    private readonly tilePx: number,
  ) {}

  /** Destroy every resident scene texture — called when the world renderer
   *  itself is torn down, so scene VRAM doesn't outlive it. */
  destroy(): void {
    for (const key of Array.from(this.resident.keys())) this.evict(key);
  }

  /**
   * Reconcile resident district scenes against the camera's current visible
   * rect and tier. A no-op (with the layer hidden) below `street` tier —
   * district scenes only ever draw at `street` (KTD7). `seed` should be
   * `state.rng.seed` (plain data, never `state.rng` itself — see
   * `world/streets.ts`'s module docblock).
   */
  update(state: GameState, camera: Camera): void {
    this.container.visible = camera.tier === 'street';
    if (camera.tier !== 'street') return;

    this.frame++;
    const visible = camera.visibleWorldRect();
    const inView = districtsInView(state.districts, visible);
    const visibleKeys = new Set<string>();

    for (const district of inView) {
      const key = districtSceneCacheKey(district, camera.tier, nearbyDerelictCount(state, district));
      visibleKeys.add(key);
      let scene = this.resident.get(key);
      if (!scene) {
        scene = this.generate(district, state);
        this.resident.set(key, scene);
        this.container.addChild(scene.sprite);
      }
      scene.lastSeen = this.frame;
      const size = scene.extentTiles * 2 * this.tilePx;
      scene.sprite.position.set(
        (district.anchorX - scene.extentTiles) * this.tilePx,
        (district.anchorY - scene.extentTiles) * this.tilePx,
      );
      scene.sprite.width = size;
      scene.sprite.height = size;
    }

    const entries: ChunkLruEntry[] = Array.from(this.resident, ([key, s]) => ({ key, lastSeen: s.lastSeen }));
    for (const key of selectEvictable(entries, visibleKeys, RESIDENT_DISTRICT_BUDGET)) {
      this.evict(key);
    }
  }

  private generate(district: District, state: GameState): ResidentScene {
    const anchor = { x: district.anchorX, y: district.anchorY };
    const scene = generateDistrictScene(state.rng.seed, district, anchor, state);
    const extentTiles = Math.max(extentTilesFor(quantizeDistrict(district).development), 0.05);

    const g = new Graphics();
    const worldToLocalPx = (wx: number, wy: number) => ({
      x: ((wx - anchor.x + extentTiles) / (extentTiles * 2)) * SCENE_TEXTURE_PX,
      y: ((wy - anchor.y + extentTiles) / (extentTiles * 2)) * SCENE_TEXTURE_PX,
    });

    for (const street of scene.streets) {
      const a = worldToLocalPx(street.ax, street.ay);
      const b = worldToLocalPx(street.bx, street.by);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: STREET_COLOR, width: 2 });
    }

    for (const fp of scene.footprints) {
      const topLeft = worldToLocalPx(fp.rect.x, fp.rect.y);
      const bottomRight = worldToLocalPx(fp.rect.x + fp.rect.width, fp.rect.y + fp.rect.height);
      const w = Math.max(1, bottomRight.x - topLeft.x);
      const h = Math.max(1, bottomRight.y - topLeft.y);
      // Taller (higher heightClass) buildings read as visibly larger footprints
      // in this stylized top-down draw; vacancy is the health cue (R8) —
      // drawn faint rather than solid.
      const growth = 1 + fp.heightClass * 0.15;
      g.rect(topLeft.x - (w * (growth - 1)) / 2, topLeft.y - (h * (growth - 1)) / 2, w * growth, h * growth).fill({
        color: USE_COLORS[fp.use],
        alpha: fp.vacant ? VACANT_ALPHA : 1,
      });
    }

    const stationPx = worldToLocalPx(
      scene.stationSquare.x - scene.stationSquare.size / 2,
      scene.stationSquare.y - scene.stationSquare.size / 2,
    );
    const stationSizePx = (scene.stationSquare.size / (extentTiles * 2)) * SCENE_TEXTURE_PX;
    g.rect(stationPx.x, stationPx.y, Math.max(2, stationSizePx), Math.max(2, stationSizePx)).fill({
      color: STATION_SQUARE_COLOR,
    });

    // Derelict yards (milestone 5 U7, R13): a dark X over a faint patch —
    // the abandoned-yard scar, distinct from a vacant footprint's plain
    // faded fill.
    for (const yard of scene.derelictYards) {
      const centerPx = worldToLocalPx(yard.x, yard.y);
      const sizePx = Math.max(4, (yard.size / (extentTiles * 2)) * SCENE_TEXTURE_PX);
      g.rect(centerPx.x - sizePx / 2, centerPx.y - sizePx / 2, sizePx, sizePx).fill({
        color: DERELICT_YARD_COLOR,
        alpha: 0.6,
      });
      g.moveTo(centerPx.x - sizePx / 2, centerPx.y - sizePx / 2)
        .lineTo(centerPx.x + sizePx / 2, centerPx.y + sizePx / 2)
        .moveTo(centerPx.x + sizePx / 2, centerPx.y - sizePx / 2)
        .lineTo(centerPx.x - sizePx / 2, centerPx.y + sizePx / 2)
        .stroke({ color: DERELICT_YARD_COLOR, width: 2 });
    }

    const texture = RenderTexture.create({ width: SCENE_TEXTURE_PX, height: SCENE_TEXTURE_PX });
    this.renderer.render({ container: g, target: texture });
    texture.source.updateMipmaps();
    g.destroy();

    const sprite = new Sprite(texture);
    return { texture, sprite, extentTiles, lastSeen: this.frame };
  }

  private evict(key: string): void {
    const scene = this.resident.get(key);
    if (!scene) return;
    this.container.removeChild(scene.sprite);
    scene.sprite.destroy();
    scene.texture.destroy(true);
    this.resident.delete(key);
  }
}
