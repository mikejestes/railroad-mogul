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
import { DEFAULT_STATION_TYPE, type StationType, type DerelictSite } from '../sim/model/track.ts';
import { landValueAt as runLandValueAt, type LandValue } from '../sim/model/landValue.ts';
import type { Charter, Parcel, ParcelAddress } from '../sim/model/land.ts';
import { purchasePrice as runPurchasePrice } from '../sim/model/land.ts';
import { parcelValuation as runParcelValuation, type ParcelValuation } from '../store/selectors.ts';

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
 *
 * Station-siting/severance milestone U8 closes this milestone the same way:
 * `landValueAt` re-exports `sim/model/landValue.ts`'s itemized, pure
 * derivation verbatim (read-only — the module's own KTD2 purity guarantee
 * means calling it any number of times, at any coordinates, never mutates
 * `state` or grows the save), so a browser driver can assert AE1 ("value
 * rises in the catchment, falls off with distance") directly by value —
 * `totalCents` and each named item — the moment a station is sited, without
 * waiting on or interpreting a rendered scene. `moveStation` follows the
 * `buildStation`/`commitRoute` precedent: the exact `moveStation` intent the
 * map's move-mode click flow (`main.ts`) dispatches, applied immediately via
 * `applyNow` so a browser driver can assert AE4 (both scars — the permanent
 * cut and the derelict yard — outlive a relocation) without depending on the
 * rAF loop. `derelictSites` exposes the live, append-only list the same way
 * `districts` already does.
 *
 * Land-economics-and-speculation milestone U8 closes the whole game's
 * feature set the same way: `charterRoute`, `buyLand`, and `sellLand`
 * follow the `commitRoute`/`buildStation` precedent exactly — the real
 * intents the map's build-mode click flow (`main.ts`, U6) dispatches,
 * applied immediately via `applyNow` so a browser driver can assert the
 * whole charter -> buy -> build -> feed -> collect arc without depending on
 * the rAF loop, and a refused/unaffordable attempt is a no-op exactly as
 * `applyIntent` already guarantees. `parcelValuation` re-exports
 * `store/selectors.ts`'s pure read-model derivation verbatim (read-only,
 * KTD6) so a driver can assert AE4's "current value and the reason for the
 * change are both legible" by value — current value, delta, and the
 * item-by-item attribution — the same "assert on state, not pixels"
 * standing rule every prior milestone's debug-hook addition follows.
 * `charters`/`parcels` expose the live records the same live-reference
 * pattern `districts`/`derelictSites` already use.
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
  /** Relocate a station (milestone 5 U7/U8, KTD8) — the exact `moveStation`
   *  intent the map's move-mode click flow dispatches, applied immediately
   *  via `applyNow` (the `buildStation`/`commitRoute` precedent). A no-op
   *  (per `applyIntent`'s own refusal handling) if the target tile is sea,
   *  out of bounds, the station's current tile, or unaffordable. */
  moveStation(stationId: string, x: number, y: number): void;
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
  /** Itemized, derived land value at a world coordinate (milestone 5 U5/U8,
   *  KTD2) — re-exports `sim/model/landValue.ts`'s `landValueAt` verbatim.
   *  Never mutates `state`; safe to call any number of times, at any
   *  coordinates, for value assertions (`totalCents`, or any named item —
   *  `'terrain-base' | 'station-uplift' | 'district-development' |
   *  'severance' | 'derelict' | 'floor-adjustment'`). */
  landValueAt(wx: number, wy: number): LandValue;
  /** Live, append-only list of abandoned station sites (milestone 5 U7/U8,
   *  KTD8/KTD9) — the same live-reference pattern `districts` already
   *  follows (through the existing version channel, no second store). */
  readonly derelictSites: readonly DerelictSite[];
  /** Charter a surveyed corridor (milestone 6 U8, KTD1) — dispatches the
   *  same `charterRoute` intent applied immediately via `applyNow`. A no-op
   *  if the survey is refused or the fee is unaffordable. */
  charterRoute(waypoints: Tile[]): void;
  /** Buy the parcel at `address` (milestone 6 U8, KTD2/KTD3/KTD8) —
   *  dispatches the same `buyLand` intent applied immediately. A no-op if
   *  rights are refused or the price is unaffordable. */
  buyLand(address: ParcelAddress): void;
  /** Sell an owned parcel by id (milestone 6 U8, KTD7) — dispatches the
   *  same `sellLand` intent applied immediately. A no-op for an unknown id. */
  sellLand(parcelId: string): void;
  /** Read-only preview of what `buyLand` would charge right now (milestone 6
   *  U8, KTD2) — the exact `purchasePrice` function `buyLand` prices from.
   *  Never mutates `state`. */
  purchasePrice(address: ParcelAddress): number;
  /** Current value, delta, and item-by-item attribution for an owned parcel
   *  (milestone 6 U8, KTD6, R8/R9/AE4) — re-exports
   *  `store/selectors.ts`'s `parcelValuation` verbatim. `null` for an
   *  unknown parcel id. */
  parcelValuation(parcelId: string): ParcelValuation | null;
  /** Live charter records (milestone 6 U8) — the same live-reference
   *  pattern `districts` already follows. */
  readonly charters: readonly Charter[];
  /** Live owned-parcel records (milestone 6 U8, R11) — the same
   *  live-reference pattern `districts`/`charters` already follow. */
  readonly parcels: readonly Parcel[];
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
    moveStation: (stationId, x, y) => applyNow({ kind: 'moveStation', stationId, x, y }),
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
    landValueAt: (wx, wy) => runLandValueAt(store.getState(), wx, wy),
    get derelictSites() {
      return store.getState().derelictSites;
    },
    charterRoute: (waypoints) => applyNow({ kind: 'charterRoute', waypoints }),
    buyLand: (address) => applyNow({ kind: 'buyLand', address }),
    sellLand: (parcelId) => applyNow({ kind: 'sellLand', parcelId }),
    purchasePrice: (address) => runPurchasePrice(store.getState(), address),
    parcelValuation: (parcelId) => runParcelValuation(store.getState(), parcelId),
    get charters() {
      return store.getState().charters;
    },
    get parcels() {
      return store.getState().parcels;
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
