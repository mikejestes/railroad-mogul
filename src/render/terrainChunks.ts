/**
 * Chunked terrain rendering (U4, KTD7, KTD8, R2, R3, R9).
 *
 * KTD7 — the pre-U4 renderer emitted one `Graphics#rect().fill()` per tile
 * across the whole map (a documented PixiJS performance cliff: cost scales
 * with draw calls), and kept every one of those tiles resident forever, so
 * the terrain layer's cost only ever grew with map size. This module instead
 * renders each 32x32-tile chunk once into a `RenderTexture` and thereafter
 * draws it as a single `Sprite`, generated lazily as the camera's visible
 * range reaches it and evicted by LRU once resident chunks exceed a budget
 * (`RESIDENT_CHUNK_BUDGET`) — cost tracks *visible* area, not map size (R9).
 * `CHUNK_SIZE_TILES = 32` follows Factorio's long-proven chunk size (plan
 * Assumptions). `CHUNK_TEXTURE_PX_PER_TILE` is the *raster* resolution a
 * chunk is rendered at — independent of the world-unit tile size
 * (`WORLD_UNIT_PX = 1`, `src/main.ts`) the sprite is then scaled to fill —
 * so a chunk stays a crisp ~1024x1024 texture (the plan's own sizing
 * assumption) regardless of how "big" a tile is in world units.
 *
 * KTD8 — the set of chunks a camera should have resident is computed
 * arithmetically from its visible world rect (`visibleChunks`), not via
 * PixiJS's generic `Culler`: for a regular grid the answer falls directly
 * out of a min/max division by chunk size, and generic culling would pay for
 * bounds-walking the arithmetic already gives for free.
 *
 * A chunk is keyed by position *and* zoom tier (`chunkKey`/`parseChunkKey`):
 * changing tier requests a different resident texture rather than rescaling
 * a stale one, which matters once a tier-appropriate octave budget
 * (`octaveBudgetForTier`, KTD4) makes two tiers' textures genuinely
 * different content, not just different scale.
 *
 * Octave-budget note (KTD4, honest gap): `octaveBudgetForTier` is exported
 * and tested here as the pure LOD policy KTD4 describes — coarser tiers get
 * fewer octaves, monotonically. `terrainAt` (`src/world/geography.ts`, out of
 * this unit's file list per the plan) does not currently accept an octaves
 * parameter — U2/U3 fixed its signature at `terrainAt(x, y)` specifically so
 * downstream callers wouldn't need to change when the authored landmask was
 * added. `TerrainChunkManager` below therefore calls `terrainAt(x, y)`
 * directly, same as the renderer it replaces, and does not yet thread
 * `octaveBudgetForTier`'s result into generation — chunk *content* is
 * currently the same at every tier, only the resident *texture* differs by
 * tier key. Wiring the budget through requires widening `terrainAt`'s
 * signature, deferred to whichever future unit needs the perf win R2/R9
 * anticipate from it (this unit's own budget is met without it — see the
 * plan's Assumptions on per-chunk generation cost).
 *
 * The eviction policy (`selectEvictable`) is plain LRU over a resident
 * budget (`RESIDENT_CHUNK_BUDGET`): the least-recently-seen chunks are
 * evicted first, and a chunk in the camera's *current* visible range is
 * never a candidate, however stale its `lastSeen` — a chunk on screen right
 * now cannot be the one that's "not needed anymore".
 *
 * Chunk generation and the eviction/generation loop touch the GPU (a real
 * PixiJS `Renderer` and `RenderTexture`) and are not unit-testable in Node,
 * per the repo's no-rendering-tests policy (KTD7 in the umbrella plan). The
 * five functions above `TerrainChunkManager` are pure and DOM/GPU-free, so
 * the LOD, culling, keying, and eviction *logic* is fully covered without
 * touching pixels; `TerrainChunkManager` itself is a thin, deliberately
 * simple GPU-facing shell around them.
 */
import { Container, Graphics, Sprite, RenderTexture } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import type { Camera, Rect } from './camera.ts';
import type { ZoomTierId } from './zoomTiers.ts';
import { terrainAt, type Terrain } from '../world/geography.ts';
import { FULL_OCTAVES } from '../world/fields.ts';

/** Tiles per chunk edge (KTD7) — Factorio's chunk size, chosen for the same
 * reason: large enough to amortize draw-call overhead, small enough that a
 * chunk near the visible edge doesn't waste much off-screen generation. */
export const CHUNK_SIZE_TILES = 32;

/** Raster resolution (px) a chunk's `RenderTexture` is rendered at, per
 * world tile — decoupled from `WORLD_UNIT_PX` so the texture stays a crisp
 * fixed size (`CHUNK_SIZE_TILES * CHUNK_TEXTURE_PX_PER_TILE`, ~1024px,
 * matching the plan's own VRAM-budget assumption) regardless of the world's
 * own unit scale. */
export const CHUNK_TEXTURE_PX_PER_TILE = 32;

/** World-tile margin added around the camera's visible rect before a chunk
 * is generated, so a chunk exists slightly before it scrolls into view
 * rather than popping in at the viewport edge (mirrors
 * `VISIBLE_MARGIN_TILES` in `worldRenderer.ts`, sized to a whole chunk here
 * since a chunk is the unit of work rather than a single entity). */
export const CHUNK_MARGIN_TILES = CHUNK_SIZE_TILES;

/** Maximum number of chunk textures kept resident at once (KTD7's VRAM
 * assumption: ~4MB per 1024x1024 chunk texture, "a few dozen resident
 * chunks" tuned against the visible range at the finest tier). Past this,
 * `selectEvictable` reclaims the least-recently-seen chunks outside the
 * current visible range. */
export const RESIDENT_CHUNK_BUDGET = 64;

export interface ChunkCoord {
  cx: number;
  cy: number;
}

/**
 * The chunk coordinates whose tiles overlap `rect` (a world rect, e.g.
 * `camera.visibleWorldRect()`) expanded by `marginTiles` on every side
 * (KTD8). Pure arithmetic: no generic culling walk. A chunk `(cx, cy)`
 * spans world tiles `[cx*chunkSizeTiles, (cx+1)*chunkSizeTiles)` — half-open,
 * so a rect edge that lands exactly on a chunk boundary does not pull in an
 * extra, empty-overlap chunk on the far side of that boundary.
 */
export function visibleChunks(rect: Rect, marginTiles: number, chunkSizeTiles: number = CHUNK_SIZE_TILES): ChunkCoord[] {
  const minCx = Math.floor((rect.x - marginTiles) / chunkSizeTiles);
  const maxCx = Math.ceil((rect.x + rect.width + marginTiles) / chunkSizeTiles) - 1;
  const minCy = Math.floor((rect.y - marginTiles) / chunkSizeTiles);
  const maxCy = Math.ceil((rect.y + rect.height + marginTiles) / chunkSizeTiles) - 1;

  const coords: ChunkCoord[] = [];
  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      coords.push({ cx, cy });
    }
  }
  return coords;
}

/** Encode a chunk's identity as a single string key, tier included — a chunk
 * is a (position, tier) pair, not just a position (module docblock). */
export function chunkKey(cx: number, cy: number, tier: ZoomTierId): string {
  return `${cx}:${cy}:${tier}`;
}

/** Inverse of `chunkKey`. Round-trips exactly for any key `chunkKey` produced. */
export function parseChunkKey(key: string): ChunkCoord & { tier: ZoomTierId } {
  const [cxStr, cyStr, tier] = key.split(':');
  return { cx: Number(cxStr), cy: Number(cyStr), tier: tier as ZoomTierId };
}

export interface ChunkLruEntry {
  key: string;
  /** Monotonic counter (e.g. a frame index) of the last time this chunk was
   * in the visible range; higher is more recent. */
  lastSeen: number;
}

/**
 * Select which resident chunks to evict, oldest-`lastSeen`-first, when the
 * resident count exceeds `budget`. Never selects a key present in
 * `visibleKeys` — a chunk on screen right now is not evictable regardless of
 * how stale its `lastSeen` is, even if that means staying over budget until
 * the camera moves. Returns `[]` when `entries.length <= budget`.
 */
export function selectEvictable(entries: ChunkLruEntry[], visibleKeys: ReadonlySet<string>, budget: number): string[] {
  const overBudget = entries.length - budget;
  if (overBudget <= 0) return [];

  const evictable = entries.filter((e) => !visibleKeys.has(e.key)).sort((a, b) => a.lastSeen - b.lastSeen);
  return evictable.slice(0, Math.min(overBudget, evictable.length)).map((e) => e.key);
}

/** Octave budget for the `continent` tier (KTD4) — coarse enough that
 * sub-pixel detail octaves, invisible at this zoom, are never evaluated. */
export const CONTINENT_OCTAVES = 2;
/** Octave budget for the `region` tier. */
export const REGION_OCTAVES = 5;
/** Octave budget for the `local` tier — the simulation's own full budget
 * (`FULL_OCTAVES`, `fields.ts`), since at this zoom every octave is visible. */
export const LOCAL_OCTAVES = FULL_OCTAVES;
/** Octave budget for the `street` tier (M4 U7, KTD7) — the same full budget
 * as `local`: terrain content itself does not change at `street` (only the
 * district scene layer draws above it, see `render/districtRenderer.ts`),
 * so there is no coarser-vs-finer terrain distinction to make at this tier. */
export const STREET_OCTAVES = LOCAL_OCTAVES;

/**
 * Octaves to evaluate elevation at for a given zoom tier (KTD4): fewer at
 * coarser tiers, monotonically non-decreasing from `continent` to `street`
 * (see `tests/render/chunks.test.ts`, which checks this generically against
 * `ZOOM_TIERS`'s own ordering rather than hardcoding it a second time).
 */
export function octaveBudgetForTier(tier: ZoomTierId): number {
  switch (tier) {
    case 'continent':
      return CONTINENT_OCTAVES;
    case 'region':
      return REGION_OCTAVES;
    case 'local':
      return LOCAL_OCTAVES;
    case 'street':
      return STREET_OCTAVES;
  }
}

/** Fill color for each terrain palette member (U4; supersedes the 3-color
 * `sea`/`land`/`mountain` map the pre-chunk renderer used — U2/U3 widened
 * the palette to 8 members and this is the first draw path to render all of
 * them distinctly). */
export const TERRAIN_COLORS: Record<Terrain, number> = {
  sea: 0x11314f,
  coast: 0xd7c9a3,
  plains: 0x4f7942,
  farmland: 0xc2a94b,
  forest: 0x1f4d2e,
  marsh: 0x4a6b5a,
  hills: 0x8a7a54,
  mountain: 0x5a5148,
};

interface ResidentChunk {
  texture: RenderTexture;
  sprite: Sprite;
  lastSeen: number;
}

/**
 * Owns the set of resident terrain chunk textures and the container their
 * sprites are added to. GPU-facing and deliberately thin — all its policy
 * decisions (which chunks are visible, what to evict, how many octaves a
 * tier gets) are the pure functions above, so this class exists only to
 * carry out their answers against a real PixiJS `Renderer`.
 */
export class TerrainChunkManager {
  readonly container = new Container();
  private resident = new Map<string, ResidentChunk>();
  private frame = 0;

  constructor(
    private readonly renderer: Renderer,
    private readonly tilePx: number,
  ) {}

  /**
   * Reconcile resident chunks against the camera's current visible rect and
   * tier (KTD8): generate any chunk in range that isn't resident yet, mark
   * every in-range chunk as freshly seen, then evict least-recently-seen
   * chunks past `RESIDENT_CHUNK_BUDGET` (never one currently in range).
   * `worldWidth`/`worldHeight` (tiles) skip generating chunks entirely
   * outside the world's bounds, e.g. past the map edge while panned there.
   */
  update(camera: Camera, worldWidth: number, worldHeight: number): void {
    this.frame++;
    const tier = camera.tier;
    const coords = visibleChunks(camera.visibleWorldRect(), CHUNK_MARGIN_TILES);
    const visibleKeys = new Set<string>();

    for (const { cx, cy } of coords) {
      if ((cx + 1) * CHUNK_SIZE_TILES <= 0 || cx * CHUNK_SIZE_TILES >= worldWidth) continue;
      if ((cy + 1) * CHUNK_SIZE_TILES <= 0 || cy * CHUNK_SIZE_TILES >= worldHeight) continue;

      const key = chunkKey(cx, cy, tier);
      visibleKeys.add(key);
      let chunk = this.resident.get(key);
      if (!chunk) {
        chunk = this.generateChunk(cx, cy);
        this.resident.set(key, chunk);
        this.container.addChild(chunk.sprite);
      }
      chunk.lastSeen = this.frame;
    }

    const entries: ChunkLruEntry[] = Array.from(this.resident, ([key, chunk]) => ({ key, lastSeen: chunk.lastSeen }));
    for (const key of selectEvictable(entries, visibleKeys, RESIDENT_CHUNK_BUDGET)) {
      this.evict(key);
    }
  }

  /** Destroy every resident chunk texture and sprite — called when the
   * world renderer itself is torn down, so chunk VRAM doesn't outlive it. */
  destroy(): void {
    for (const key of Array.from(this.resident.keys())) this.evict(key);
  }

  private generateChunk(cx: number, cy: number): ResidentChunk {
    const texturePx = CHUNK_SIZE_TILES * CHUNK_TEXTURE_PX_PER_TILE;
    const g = new Graphics();
    const originX = cx * CHUNK_SIZE_TILES;
    const originY = cy * CHUNK_SIZE_TILES;
    for (let ty = 0; ty < CHUNK_SIZE_TILES; ty++) {
      for (let tx = 0; tx < CHUNK_SIZE_TILES; tx++) {
        const kind = terrainAt(originX + tx, originY + ty);
        g.rect(tx * CHUNK_TEXTURE_PX_PER_TILE, ty * CHUNK_TEXTURE_PX_PER_TILE, CHUNK_TEXTURE_PX_PER_TILE, CHUNK_TEXTURE_PX_PER_TILE).fill({
          color: TERRAIN_COLORS[kind],
        });
      }
    }

    const texture = RenderTexture.create({ width: texturePx, height: texturePx });
    this.renderer.render({ container: g, target: texture });
    // KTD7: PixiJS v8 no longer auto-generates mipmaps on a schedule: without
    // this call a minified (zoomed-out) chunk shimmers as it pans.
    texture.source.updateMipmaps();
    g.destroy();

    const sprite = new Sprite(texture);
    sprite.position.set(originX * this.tilePx, originY * this.tilePx);
    sprite.width = CHUNK_SIZE_TILES * this.tilePx;
    sprite.height = CHUNK_SIZE_TILES * this.tilePx;

    return { texture, sprite, lastSeen: this.frame };
  }

  private evict(key: string): void {
    const chunk = this.resident.get(key);
    if (!chunk) return;
    this.container.removeChild(chunk.sprite);
    chunk.sprite.destroy();
    chunk.texture.destroy(true);
    this.resident.delete(key);
  }
}
