import type { GameStore, Intent } from '../store/gameStore.ts';
import type { GameClock } from '../sim/clock.ts';
import type { GameState } from '../sim/state.ts';
import { applyIntent, buyTrain } from '../store/applyIntents.ts';
import type { Camera, Rect } from '../render/camera.ts';
import type { ZoomTierId } from '../render/zoomTiers.ts';
import { terrainAt, elevationAt, type Terrain } from '../world/geography.ts';
import { surveyRoute as runSurveyRoute, type SurveyResult } from '../sim/surveying.ts';
import type { Tile } from '../sim/pathfinding.ts';
import type { District } from '../sim/model/districts.ts';
import { generateDistrictScene, type DistrictScene } from '../world/streets.ts';
import { DEFAULT_STATION_TYPE, type StationType } from '../sim/model/track.ts';

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
 *
 * Route-surveying milestone U7 closes that milestone with the same pattern:
 * `surveyRoute` re-exports `sim/surveying.ts`'s pure function verbatim
 * (read-only — never mutates `state` or dispatches anything, so a browser
 * driver can assert a proposal's price/grade/refusal by value before ever
 * touching Commit) and `commitRoute` follows the `buyTrain`/`layTrack`
 * precedent of routing through `applyNow` — the exact `commitRoute` intent
 * `SurveyPanel`'s Commit button dispatches (U6), just applied synchronously
 * so automation doesn't depend on the rAF loop draining it.
 *
 * City-districts milestone U8 (R9/R11/R13) extends this once more:
 * `districts` exposes the live district records (through the existing
 * version channel — R13, no second store), and `districtScene` samples
 * `world/streets.ts`'s pure generator for a given district id, using the
 * live world seed (`state.rng.seed`, plain data — never the RNG counter).
 * This is what lets a browser driver verify AE1 by comparing scene
 * *statistics* (height-class distribution, use counts) between two
 * differently-fed districts, per the assert-on-state-not-pixels rule, rather
 * than by diffing screenshots. Like `terrainAt`/`elevationAt`, sampling a
 * scene any number of times never mutates `state` or the save (R9's
 * scene-purity gate) — `districtScene` calls straight into the pure
 * generator with no caching of its own.
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
  buildStation(x: number, y: number, radius?: number, stationType?: StationType): void;
  layTrack(ax: number, ay: number, bx: number, by: number): void;
  /** Create a train looping between two stations; returns its id. */
  buyTrain(fromStationId: string, toStationId: string, engineId?: string): string;
  /** Read-only preview of a survey (U7) — the same pure `surveyRoute` the UI
   *  previews with and `commitRoute` (below) re-runs at commit time (KTD2).
   *  Never mutates `state`; safe to call any number of times for value
   *  assertions (price, grade, itemized steps, or a refusal reason). */
  surveyRoute(waypoints: Tile[]): SurveyResult;
  /** Commit a route by waypoints (U7) — dispatches the same `commitRoute`
   *  intent `SurveyPanel`'s Commit button does, applied immediately via
   *  `applyNow` rather than queued, so it lands without depending on the
   *  rAF loop. A no-op (per `applyIntent`'s own refusal handling) if the
   *  waypoints don't survey to a buildable, affordable route. */
  commitRoute(waypoints: Tile[]): void;
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
  /** Live district records (always current, city-districts U8). */
  readonly districts: readonly District[];
  /** Sample the pure street-scene generator for a district, by id, using the
   *  live world seed. Throws if no district with that id exists. Never
   *  mutates state — safe to call any number of times (R9's scene-purity
   *  gate; see the module docblock). */
  districtScene(districtId: string): DistrictScene;
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
    buildStation: (x, y, radius = 2, stationType = DEFAULT_STATION_TYPE) =>
      applyNow({ kind: 'buildStation', x, y, radius, stationType }),
    layTrack: (ax, ay, bx, by) => applyNow({ kind: 'layTrack', ax, ay, bx, by }),
    surveyRoute: (waypoints) => runSurveyRoute(store.getState(), waypoints),
    commitRoute: (waypoints) => applyNow({ kind: 'commitRoute', waypoints }),
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
    get districts() {
      return store.getState().districts;
    },
    districtScene: (districtId) => {
      const s = store.getState();
      const district = s.districts.find((d) => d.id === districtId);
      if (!district) throw new Error(`districtScene: no district with id ${districtId}`);
      return generateDistrictScene(s.rng.seed, district, { x: district.anchorX, y: district.anchorY }, s);
    },
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
