import { StrictMode, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Container } from 'pixi.js';
import { App } from './ui/App.tsx';
import type { BuildMode } from './ui/panels/BuildPanel.tsx';
import { createMapRenderer } from './render/mapRenderer.ts';
import { WorldRenderer, type SurveyOverlay } from './render/worldRenderer.ts';
import { Camera, exceedsClickThreshold, wheelZoomFactor, worldPointToTile } from './render/camera.ts';
import { SurveyController } from './render/surveyController.ts';
import { generateGame } from './world/generate.ts';
import { GameStore } from './store/gameStore.ts';
import { applyIntent } from './store/applyIntents.ts';
import { GameClock } from './sim/clock.ts';
import { installDebugHook } from './dev/debugHook.ts';
import { DEFAULT_STATION_TYPE, type StationType } from './sim/model/track.ts';

/**
 * Entry point. Wires the whole game together (U10/U12, camera U1):
 *   generate world -> store -> clock -> map renderer + React overlay,
 * driven by a requestAnimationFrame loop that drains player intents, advances
 * the clock (fixed ticks), and redraws the map.
 *
 * The sim never advances while the tab is hidden — the clock pauses on blur —
 * so returning to the tab resumes rather than replaying a large gap (U12).
 *
 * The world container is the sole render group (KTD2); its transform is owned
 * entirely by the Camera (src/render/camera.ts), never touched directly here.
 * `WorldRenderer` now draws in world units (1 unit = 1 tile) — the camera's
 * scale is what converts a world unit to a screen pixel, replacing the old
 * fixed pixels-per-tile constant as the render-time conversion (R1).
 *
 * Build clicks resolve to tile coordinates by inverting the camera transform
 * (`camera.screenToWorld`) and flooring/clamping with `worldPointToTile`
 * (U3), so a click lands on the tile under the cursor at any pan or zoom —
 * the old fixed-`TILE_PX` division is gone.
 *
 * The camera is also handed to `world.render` every frame (U5) so
 * `WorldRenderer` can branch on `camera.tier` and `camera.scale` — what an
 * entity draws as changes with zoom tier, not just its size (KTD4).
 *
 * Milestone 3 U6 (KTD9): the old `'track'` build mode chained adjacent
 * `layTrack` clicks directly (`lastTrackTile`, removed). Survey mode instead
 * feeds every click and cursor position to a `SurveyController`
 * (`render/surveyController.ts`) — boot-scope view state, never
 * `GameState`, exactly like `Camera` — and only the `commitRoute` intent
 * (waypoints only, KTD2) ever reaches the store. The controller's live
 * proposal drives both the React `SurveyPanel` (via `App`'s
 * `useSurveyProposal`) and `WorldRenderer`'s overlay layer, so the two can
 * never show different numbers for the same proposal.
 */

/** World-unit-to-pixel scale WorldRenderer draws at inside the camera-scaled
 * world container: 1, since the camera's own scale supplies the pixel size. */
const WORLD_UNIT_PX = 1;

async function boot() {
  const canvasHost = document.getElementById('map-canvas');
  const uiHost = document.getElementById('ui-overlay');
  if (!canvasHost || !uiHost) throw new Error('Expected #map-canvas and #ui-overlay hosts');

  // URL flags for reproducible, automation-friendly runs:
  //   ?seed=<n>  fixed world seed (default: time-based, so every launch differs)
  //   ?nopause   don't pause the sim on tab blur (also implied under automation)
  const params = new URLSearchParams(location.search);
  const seedParam = params.get('seed');
  const seed = seedParam !== null ? Number(seedParam) >>> 0 : Math.floor(performance.now()) || 1;
  const noPause = params.has('nopause') || navigator.webdriver;

  const state = generateGame(seed);
  const store = new GameStore(state);
  const clock = new GameClock(store.getState(), undefined, (s) => store.publish(s));

  const renderer = await createMapRenderer(canvasHost);
  const worldContainer = new Container({ isRenderGroup: true }); // KTD2: one render group for the whole world
  const world = new WorldRenderer(renderer.app.renderer, WORLD_UNIT_PX);
  worldContainer.addChild(world.container);
  renderer.app.stage.addChild(worldContainer);

  // Camera owns worldContainer's pan/zoom transform; camera state never enters
  // GameState (KTD3). Fit the world to the viewport at boot and on every
  // resize (R1); re-fitting on resize recenters the view rather than
  // preserving pan/zoom across a resize, per the milestone's R1 scope.
  const camera = new Camera(worldContainer);
  camera.fitToViewport(state.world.width, state.world.height, renderer.screen);
  renderer.onResize((w, h) => camera.fitToViewport(state.world.width, state.world.height, { width: w, height: h }));

  // Pause the sim while the tab is hidden; resume on return (U12). Skipped under
  // ?nopause / automation so headless verification keeps ticking.
  if (!noPause) {
    let wasPausedByUser = false;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        wasPausedByUser = clock.paused;
        clock.paused = true;
      } else {
        clock.paused = wasPausedByUser;
      }
    });
  }

  // Map-click building: the React BuildPanel arms a mode; clicks on the canvas
  // translate to tile coords and dispatch build intents to the store (drained
  // in the loop below). Survey mode feeds clicks/hover to `survey` instead of
  // dispatching directly (KTD9) — see the module docblock.
  //
  // Every pointer gesture starts as a potential drag (R2): pointermove pans
  // the camera and accumulates the total screen-space distance moved; pointerup
  // only fires the build click if that distance stayed under the click
  // threshold, so dragging the map never also surveys a waypoint or drops a
  // station.
  let buildMode: BuildMode = 'none';
  // Milestone 5 U1 (R4, KTD3): the type picked in BuildPanel for the *next*
  // buildStation click — boot-scope view state, same status as `buildMode`,
  // never GameState (App.tsx's docblock).
  let stationType: StationType = DEFAULT_STATION_TYPE;
  // Milestone 5 U7 (R11, KTD8): the station id picked by the first click of
  // a move-mode gesture — boot-scope view state, same status as `stationType`
  // above, cleared on any mode change (`onBuildModeChange` below) the same
  // way a pending survey is.
  let selectedStationForMove: string | null = null;
  const survey = new SurveyController();
  const canvas = renderer.app.canvas as HTMLCanvasElement;
  let lastPointer = { x: 0, y: 0 };
  let dragTotal = { dx: 0, dy: 0 };
  const tileAt = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    const screenPoint = { x: clientX - rect.left, y: clientY - rect.top };
    return worldPointToTile(camera.screenToWorld(screenPoint.x, screenPoint.y), state.world);
  };
  canvas.addEventListener('pointerdown', (e) => {
    lastPointer = { x: e.clientX, y: e.clientY };
    dragTotal = { dx: 0, dy: 0 };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!canvas.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - lastPointer.x;
    const dy = e.clientY - lastPointer.y;
    lastPointer = { x: e.clientX, y: e.clientY };
    dragTotal = { dx: dragTotal.dx + dx, dy: dragTotal.dy + dy };
    camera.panBy(dx, dy);
  });
  // Hover tracking for the live survey proposal (KTD3: "cursor moves — live
  // A* to cursor tile") — deliberately not gated on pointer capture, unlike
  // the panning handler above, since hovering (not dragging) is exactly when
  // this should fire.
  canvas.addEventListener('pointermove', (e) => {
    if (buildMode !== 'survey') return;
    survey.hover(tileAt(e.clientX, e.clientY));
  });
  canvas.addEventListener('pointerup', (e) => {
    canvas.releasePointerCapture(e.pointerId);
    if (exceedsClickThreshold(dragTotal.dx, dragTotal.dy)) return; // was a pan, not a click
    const { x, y } = tileAt(e.clientX, e.clientY);
    if (buildMode === 'station') {
      store.dispatch({ kind: 'buildStation', x, y, radius: 2, stationType });
    } else if (buildMode === 'survey') {
      survey.click({ x, y });
    } else if (buildMode === 'move') {
      // First click selects a station at the clicked tile; second click
      // (anywhere else) relocates it there. Clicking empty ground before any
      // station is selected is a no-op, not an error (R11's minimal UI).
      if (selectedStationForMove === null) {
        const hit = store.getState().stations.find((s) => s.x === x && s.y === y);
        if (hit) selectedStationForMove = hit.id;
      } else {
        store.dispatch({ kind: 'moveStation', stationId: selectedStationForMove, x, y });
        selectedStationForMove = null;
      }
    }
  });
  // Esc cancels a pending survey (the state diagram's Proposing -> Idle),
  // matching the panel's own Cancel button.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') survey.reset();
  });

  // Cursor-anchored wheel zoom (R3/R4, U2): the world point under the cursor
  // stays fixed across the zoom. `{ passive: false }` is required so
  // `preventDefault` can suppress the browser's own page-scroll/zoom
  // response to the wheel event.
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      camera.zoomAt(point, wheelZoomFactor(e.deltaY, e.deltaMode));
    },
    { passive: false },
  );

  // Commit dispatches the intent by value (KTD2: waypoints only, the sim
  // re-surveys) and always clears the overlay, whether or not the proposal
  // was actually buildable at commit time — the panel already reflects the
  // sim's own refusal, so there is nothing left pending either way.
  const commitSurvey = () => {
    const proposal = survey.proposalFor(store.getState());
    if (proposal?.result.ok) {
      store.dispatch({ kind: 'commitRoute', waypoints: proposal.waypoints });
    }
    survey.reset();
  };

  createRoot(uiHost).render(
    createElement(
      StrictMode,
      null,
      createElement(App, {
        store,
        clock,
        survey,
        onBuildModeChange: (mode: BuildMode) => {
          buildMode = mode;
          survey.reset(); // any mode change clears any pending survey/overlay (both directions)
          selectedStationForMove = null; // any mode change clears a pending move selection too
          canvas.style.cursor = mode === 'none' ? 'default' : 'crosshair';
        },
        onStationTypeChange: (t: StationType) => {
          stationType = t;
        },
        onSurveyCommit: commitSurvey,
        onSurveyCancel: () => survey.reset(),
      }),
    ),
  );

  // Dev-only inspection/control hook for console + browser-driven verification.
  // Camera is passed in (U7) so `window.__game.camera`/`setCamera` can report
  // and drive view state alongside sim state (R8: camera state is view-only,
  // never GameState, so this cannot affect determinism).
  if (import.meta.env.DEV) installDebugHook(store, clock, seed, camera);

  // Game loop: drain intents, advance the clock, redraw overlays. Re-reading
  // the survey proposal every frame (not just on click/hover) is what keeps
  // its price from going stale against sim state it doesn't otherwise
  // observe (KTD2's preview honesty) — cheap A* (KTD3) makes this affordable
  // even though it only matters while a survey is actually pending.
  let last = performance.now();
  const frame = (now: number) => {
    const dt = now - last;
    last = now;
    for (const intent of store.drainIntents()) applyIntent(store.getState(), intent);
    clock.advance(dt);
    const proposal = survey.active ? survey.proposalFor(store.getState()) : null;
    const overlay: SurveyOverlay | undefined =
      proposal?.result.ok ? { path: proposal.result.path, steps: proposal.result.steps } : undefined;
    world.render(store.getState(), camera, overlay);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void boot();
