import { StrictMode, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Container } from 'pixi.js';
import { App } from './ui/App.tsx';
import type { BuildMode } from './ui/panels/BuildPanel.tsx';
import { createMapRenderer } from './render/mapRenderer.ts';
import { WorldRenderer } from './render/worldRenderer.ts';
import { Camera, exceedsClickThreshold, wheelZoomFactor, worldPointToTile } from './render/camera.ts';
import { generateGame } from './world/generate.ts';
import { GameStore } from './store/gameStore.ts';
import { applyIntent } from './store/applyIntents.ts';
import { GameClock } from './sim/clock.ts';
import { installDebugHook } from './dev/debugHook.ts';

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
  // in the loop below). Track mode chains adjacent clicks into segments.
  //
  // Every pointer gesture starts as a potential drag (R2): pointermove pans
  // the camera and accumulates the total screen-space distance moved; pointerup
  // only fires the build click if that distance stayed under the click
  // threshold, so dragging the map never also lays track or drops a station.
  let buildMode: BuildMode = 'none';
  let lastTrackTile: { x: number; y: number } | null = null;
  const canvas = renderer.app.canvas as HTMLCanvasElement;
  let lastPointer = { x: 0, y: 0 };
  let dragTotal = { dx: 0, dy: 0 };
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
  canvas.addEventListener('pointerup', (e) => {
    canvas.releasePointerCapture(e.pointerId);
    if (exceedsClickThreshold(dragTotal.dx, dragTotal.dy)) return; // was a pan, not a click
    const rect = canvas.getBoundingClientRect();
    const screenPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const { x, y } = worldPointToTile(camera.screenToWorld(screenPoint.x, screenPoint.y), state.world);
    if (buildMode === 'station') {
      store.dispatch({ kind: 'buildStation', x, y, radius: 2 });
    } else if (buildMode === 'track') {
      if (lastTrackTile) {
        store.dispatch({ kind: 'layTrack', ax: lastTrackTile.x, ay: lastTrackTile.y, bx: x, by: y });
      }
      lastTrackTile = { x, y };
    }
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

  createRoot(uiHost).render(
    createElement(
      StrictMode,
      null,
      createElement(App, {
        store,
        clock,
        onBuildModeChange: (mode: BuildMode) => {
          buildMode = mode;
          lastTrackTile = null; // reset the track chain when the mode changes
          canvas.style.cursor = mode === 'none' ? 'default' : 'crosshair';
        },
      }),
    ),
  );

  // Dev-only inspection/control hook for console + browser-driven verification.
  // Camera is passed in (U7) so `window.__game.camera`/`setCamera` can report
  // and drive view state alongside sim state (R8: camera state is view-only,
  // never GameState, so this cannot affect determinism).
  if (import.meta.env.DEV) installDebugHook(store, clock, seed, camera);

  // Game loop: drain intents, advance the clock, redraw overlays.
  let last = performance.now();
  const frame = (now: number) => {
    const dt = now - last;
    last = now;
    for (const intent of store.drainIntents()) applyIntent(store.getState(), intent);
    clock.advance(dt);
    world.render(store.getState(), camera);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void boot();
