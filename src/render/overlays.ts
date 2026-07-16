import { Container, Graphics } from 'pixi.js';
import type { GameState } from '../sim/state.ts';
import { cityDemand } from '../store/selectors.ts';

/**
 * On-map legibility overlays (U9, R13): a demand cue per city whose intensity
 * reflects unmet demand, so a player reads where goods are wanted straight off
 * the map instead of a menu. Purely a view of selector data — it reads state,
 * never mutates it. Draw math is trivial; the selectors it consumes are tested.
 */
export class DemandOverlay {
  readonly container = new Container();

  /** Redraw demand cues from the latest snapshot. `tilePx` is tile size in px. */
  render(state: GameState, tilePx: number): void {
    this.container.removeChildren();
    for (const city of state.cities) {
      const rows = cityDemand(state, city.id);
      const unmet = rows.reduce((n, r) => n + r.backlog, 0);
      const intensity = Math.min(1, unmet / 40);
      const g = new Graphics();
      const radius = 3 + intensity * 5;
      g.circle(city.x * tilePx + tilePx / 2, city.y * tilePx + tilePx / 2, radius);
      // Hotter (more red) = more unmet demand; cooler = well-fed.
      const red = Math.round(120 + intensity * 135);
      const green = Math.round(200 - intensity * 160);
      g.fill({ color: (red << 16) | (green << 8) | 0x40, alpha: 0.85 });
      this.container.addChild(g);
    }
  }
}
