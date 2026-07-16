import { Application } from 'pixi.js';

/**
 * The map surface. U1 mounts a bare PixiJS application; later units (U3 world,
 * U5 track, U9 overlays) draw the grid, track, and economy cues into it.
 *
 * The renderer only ever READS simulation state through the store — it never
 * mutates sim state. Keeping this boundary clean is what lets the kernel stay
 * deterministic and headless (KTD1, KTD2).
 */
export interface MapRenderer {
  readonly app: Application;
  destroy(): void;
}

export async function createMapRenderer(container: HTMLElement): Promise<MapRenderer> {
  const app = new Application();
  await app.init({
    background: '#0d1b2a',
    resizeTo: container,
    antialias: true,
  });
  container.appendChild(app.canvas);

  return {
    app,
    destroy() {
      app.destroy(true, { children: true });
    },
  };
}
