import type { GameStore, Intent } from '../store/gameStore.ts';
import type { GameClock } from '../sim/clock.ts';
import type { GameState } from '../sim/state.ts';
import { applyIntent, buyTrain } from '../store/applyIntents.ts';
import type { Camera, Rect } from '../render/camera.ts';
import type { ZoomTierId } from '../render/zoomTiers.ts';
import { terrainAt, elevationAt, type Terrain } from '../world/geography.ts';

/**
 * Dev-only inspection & control hook (installed behind import.meta.env.DEV).
 * Exposes `window.__game` so a browser driver — or you at the console — can read
 * sim state directly (cash, cities, trains) and perform build/train actions
 * without synthesizing pointer events. This is what makes browser verification
 * assert on numbers, not just pixels. Never shipped in a production build.
 *
 * U7 (KTD7, R8) extends this with camera affordances: `camera` reports scale,
 * zoom tier, and the visible world rect so a browser driver can assert camera
 * state the same way it already asserts sim state, and `setCamera` drives the
 * view to a known position for reproducible checks. Camera state is view-only
 * (KTD3) — nothing here reads or writes `GameState`, so this cannot affect the
 * determinism gate (R8). `setCamera` is composed entirely from `Camera`'s own
 * `zoomAt`/`panBy`/`worldToScreen`, the same methods the real wheel/pointer
 * handlers in `main.ts` drive — following the `buyTrain` precedent of routing
 * through one validated path rather than adding a second, hook-only way to
 * mutate camera state (e.g. poking origin/scale fields directly).
 *
 * Terrain-substrate milestone U7 (KTD9, R10) extends this further: `terrainAt`
 * and `elevationAt` re-export `world/geography.ts`'s pure field/classification
 * functions verbatim (no wrapping, no caching of their own) so a browser
 * driver can assert terrain by value — e.g. "the tile under this city is not
 * sea" or "this mountain tile's elevation exceeds the mountain threshold" —
 * the same standing rule that motivated `camera` and `summary` above. Terrain
 * is a pure function of coordinates (KTD1), not of `GameState`, so exposing
 * it here reads state nothing else on this hook reads and cannot affect the
 * determinism gate (R10): sampling it any number of times, in any order, from
 * automation never mutates `state` or the save.
 */
export interface DebugApi {
  /** Live game state (always current). */
  readonly state: GameState;
  store: GameStore;
  clock: GameClock;
  seed: number;
  dispatch(intent: Intent): void;
  /** Apply any queued intents now (the rAF loop does this each frame in-app;
   *  call it in automation where a background tab throttles rAF). */
  drain(): void;
  buildStation(x: number, y: number, radius?: number): void;
  layTrack(ax: number, ay: number, bx: number, by: number): void;
  /** Create a train looping between two stations; returns its id. */
  buyTrain(fromStationId: string, toStationId: string, engineId?: string): string;
  /** Live camera view state (always current) — scale (pixels per world unit),
   *  the current semantic zoom tier, and the world rect currently on screen. */
  readonly camera: {
    readonly scale: number;
    readonly tier: ZoomTierId;
    visibleWorldRect(): Rect;
  };
  /** Drive the camera to a known position/scale for reproducible checks.
   *  `x`/`y` are the screen-space position of world point (0, 0) (i.e. what
   *  `camera.worldToScreen(0, 0)` reports); `scale` is pixels per world unit.
   *  Any field may be omitted to leave that part of the camera unchanged.
   *  Subject to the same zoom/position clamping (R4) real gestures obey. */
  setCamera(partial: { x?: number; y?: number; scale?: number }): void;
  /** Classified terrain at a tile coordinate (pure function of coordinates,
   *  not of live state — see the module docblock, terrain-substrate U7). */
  terrainAt(x: number, y: number): Terrain;
  /** Raw elevation at a tile coordinate, on the same reference field and
   *  coordinate transform `terrainAt` classifies from (terrain-substrate U7). */
  elevationAt(x: number, y: number): number;
  /** Snapshot of headline numbers for quick assertions. */
  summary(): {
    tick: number;
    year: number;
    cash: number;
    cities: number;
    stations: number;
    trains: number;
    scale: number;
    tier: ZoomTierId;
  };
}

declare global {
  interface Window {
    __game?: DebugApi;
  }
}

export function installDebugHook(store: GameStore, clock: GameClock, seed: number, camera: Camera): void {
  // Apply immediately and publish, so hook-driven builds land regardless of
  // whether the rAF loop (which drains the normal intent queue) is running —
  // a background/automated tab throttles rAF, so queued dispatch wouldn't apply.
  const applyNow = (intent: Intent) => {
    applyIntent(store.getState(), intent);
    store.publish(store.getState());
  };

  const api: DebugApi = {
    get state() {
      return store.getState();
    },
    store,
    clock,
    seed,
    dispatch: (intent) => store.dispatch(intent),
    drain: () => {
      for (const intent of store.drainIntents()) applyIntent(store.getState(), intent);
      store.publish(store.getState());
    },
    buildStation: (x, y, radius = 2) => applyNow({ kind: 'buildStation', x, y, radius }),
    layTrack: (ax, ay, bx, by) => applyNow({ kind: 'layTrack', ax, ay, bx, by }),
    buyTrain: (fromStationId, toStationId, engineId = 'american') => {
      const ok = buyTrain(store.getState(), engineId, [fromStationId, toStationId]);
      if (!ok) throw new Error('buyTrain failed: engine unavailable/unaffordable or fewer than 2 valid stations');
      const s = store.getState();
      return s.trains[s.trains.length - 1].id;
    },
    get camera() {
      return {
        scale: camera.scale,
        tier: camera.tier,
        visibleWorldRect: () => camera.visibleWorldRect(),
      };
    },
    terrainAt: (x, y) => terrainAt(x, y),
    elevationAt: (x, y) => elevationAt(x, y),
    setCamera: ({ x, y, scale }) => {
      // Reuse the same methods real wheel/pointer input drives (zoomAt,
      // panBy, worldToScreen) rather than a bypass that pokes camera
      // position/scale fields directly — see the module docblock.
      if (scale !== undefined && scale !== camera.scale) {
        camera.zoomAt({ x: 0, y: 0 }, scale / camera.scale);
      }
      if (x !== undefined || y !== undefined) {
        const origin = camera.worldToScreen(0, 0);
        const targetX = x ?? origin.x;
        const targetY = y ?? origin.y;
        camera.panBy(targetX - origin.x, targetY - origin.y);
      }
    },
    summary: () => {
      const s = store.getState();
      return {
        tick: s.tick,
        year: s.startYear + Math.floor(s.timeDays / 365),
        cash: s.moneyCents / 100,
        cities: s.cities.length,
        stations: s.stations.length,
        trains: s.trains.length,
        scale: camera.scale,
        tier: camera.tier,
      };
    },
  };

  window.__game = api;
}
