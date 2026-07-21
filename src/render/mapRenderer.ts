import { Application } from 'pixi.js';

/**
 * The map surface. U1 mounts a bare PixiJS application; later units (U3 world,
 * U5 track, U9 overlays) draw the grid, track, and economy cues into it.
 *
 * The renderer only ever READS simulation state through the store — it never
 * mutates sim state. Keeping this boundary clean is what lets the kernel stay
 * deterministic and headless (KTD1, KTD2).
 *
 * `screen` and `onResize` exist so the Camera (src/render/camera.ts, U1) can
 * fit the world to the viewport at boot and re-fit on resize (R1) without
 * reaching into `app.renderer` itself.
 */
export interface MapRenderer {
  readonly app: Application;
  /** Current viewport size, kept in sync by `resizeTo` below. */
  readonly screen: { width: number; height: number };
  /** Subscribe to viewport resizes; returns an unsubscribe function. */
  onResize(callback: (width: number, height: number) => void): () => void;
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
    get screen() {
      return { width: app.screen.width, height: app.screen.height };
    },
    onResize(callback) {
      app.renderer.on('resize', callback);
      return () => app.renderer.off('resize', callback);
    },
    destroy() {
      app.destroy(true, { children: true });
    },
  };
}
