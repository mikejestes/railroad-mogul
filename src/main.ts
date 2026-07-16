import { StrictMode, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import type { BuildMode } from './ui/panels/BuildPanel.tsx';
import { createMapRenderer } from './render/mapRenderer.ts';
import { WorldRenderer } from './render/worldRenderer.ts';
import { generateGame } from './world/generate.ts';
import { GameStore } from './store/gameStore.ts';
import { applyIntent } from './store/applyIntents.ts';
import { GameClock } from './sim/clock.ts';
import { installDebugHook } from './dev/debugHook.ts';

/**
 * Entry point. Wires the whole game together (U10/U12):
 *   generate world -> store -> clock -> map renderer + React overlay,
 * driven by a requestAnimationFrame loop that drains player intents, advances
 * the clock (fixed ticks), and redraws the map.
 *
 * The sim never advances while the tab is hidden — the clock pauses on blur —
 * so returning to the tab resumes rather than replaying a large gap (U12).
 */
const TILE_PX = 22;

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
  const world = new WorldRenderer(TILE_PX);
  renderer.app.stage.addChild(world.container);

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
  let buildMode: BuildMode = 'none';
  let lastTrackTile: { x: number; y: number } | null = null;
  const canvas = renderer.app.canvas as HTMLCanvasElement;
  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / TILE_PX);
    const y = Math.floor((e.clientY - rect.top) / TILE_PX);
    if (buildMode === 'station') {
      store.dispatch({ kind: 'buildStation', x, y, radius: 2 });
    } else if (buildMode === 'track') {
      if (lastTrackTile) {
        store.dispatch({ kind: 'layTrack', ax: lastTrackTile.x, ay: lastTrackTile.y, bx: x, by: y });
      }
      lastTrackTile = { x, y };
    }
  });

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
  if (import.meta.env.DEV) installDebugHook(store, clock, seed);

  // Game loop: drain intents, advance the clock, redraw overlays.
  let last = performance.now();
  const frame = (now: number) => {
    const dt = now - last;
    last = now;
    for (const intent of store.drainIntents()) applyIntent(store.getState(), intent);
    clock.advance(dt);
    world.render(store.getState());
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void boot();
