import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { App } from './ui/App.tsx';
import { createMapRenderer } from './render/mapRenderer.ts';

/**
 * Entry point. Boots the two sibling trees over one game:
 *   - the PixiJS map canvas into #map-canvas
 *   - the React management overlay into #ui-overlay
 *
 * The simulation kernel (src/sim) is intentionally NOT started here yet — it is
 * wired to a real-time clock in U12. U1 only proves the two view layers mount.
 */
async function boot() {
  const canvasHost = document.getElementById('map-canvas');
  const uiHost = document.getElementById('ui-overlay');
  if (!canvasHost || !uiHost) {
    throw new Error('Expected #map-canvas and #ui-overlay hosts in index.html');
  }

  await createMapRenderer(canvasHost);

  createRoot(uiHost).render(createElement(StrictMode, null, createElement(App)));
}

void boot();
