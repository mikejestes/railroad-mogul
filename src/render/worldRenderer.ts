import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { GameState } from '../sim/state.ts';
import { cityDemand } from '../store/selectors.ts';

/**
 * Draws the whole world onto the map canvas (U3/U5/U6/U9). Terrain is drawn
 * once (static); track, stations, trains, and city demand cues are redrawn each
 * frame so the player sees their network appear as they build it. Reads state
 * only — never mutates it (KTD1).
 *
 * Layers, back to front: terrain grid -> track -> stations -> city markers +
 * labels -> trains.
 */
const COLORS = {
  sea: 0x11314f,
  land: 0x2f5d50,
  mountain: 0x5a5148,
  grid: 0x0d1b2a,
  track: 0xb08d57,
  station: 0xf1faee,
  train: 0xffd166,
  cityLabel: 0xe0e1dd,
};

export class WorldRenderer {
  readonly container = new Container();
  private terrainLayer = new Container();
  private trackLayer = new Graphics();
  private stationLayer = new Graphics();
  private cityLayer = new Container();
  private trainLayer = new Graphics();
  private labels = new Map<string, Text>();
  private terrainDrawn = false;

  constructor(private tilePx: number) {
    this.container.addChild(this.terrainLayer, this.trackLayer, this.stationLayer, this.cityLayer, this.trainLayer);
  }

  /** Draw the static terrain grid once. */
  private drawTerrain(state: GameState): void {
    const g = new Graphics();
    const { width, height, terrain } = state.world;
    const t = this.tilePx;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const kind = terrain[y * width + x];
        const color = kind === 'sea' ? COLORS.sea : kind === 'mountain' ? COLORS.mountain : COLORS.land;
        g.rect(x * t, y * t, t - 1, t - 1).fill({ color });
      }
    }
    this.terrainLayer.addChild(g);
    this.terrainDrawn = true;
  }

  render(state: GameState): void {
    const t = this.tilePx;
    if (!this.terrainDrawn && state.world.width > 0) this.drawTerrain(state);

    // Track segments.
    this.trackLayer.clear();
    for (const seg of state.track.segments) {
      this.trackLayer
        .moveTo(seg.ax * t + t / 2, seg.ay * t + t / 2)
        .lineTo(seg.bx * t + t / 2, seg.by * t + t / 2)
        .stroke({ color: COLORS.track, width: 3 });
    }

    // Stations (white squares).
    this.stationLayer.clear();
    for (const s of state.stations) {
      this.stationLayer.rect(s.x * t + t * 0.25, s.y * t + t * 0.25, t * 0.5, t * 0.5).fill({ color: COLORS.station });
    }

    // City markers coloured by unmet demand, with name labels.
    this.cityLayer.removeChildren();
    for (const city of state.cities) {
      const unmet = cityDemand(state, city.id).reduce((n, r) => n + r.backlog, 0);
      const intensity = Math.min(1, unmet / 40);
      const red = Math.round(120 + intensity * 135);
      const green = Math.round(200 - intensity * 150);
      const dot = new Graphics();
      dot.circle(city.x * t + t / 2, city.y * t + t / 2, 4 + intensity * 4).fill({
        color: (red << 16) | (green << 8) | 0x50,
      });
      this.cityLayer.addChild(dot);
      this.labelFor(city.id, city.name, city.x * t + t / 2, city.y * t - 2);
    }

    // Trains (yellow dots).
    this.trainLayer.clear();
    for (const train of state.trains) {
      if (!train.initialized) continue;
      this.trainLayer.circle(train.x * t + t / 2, train.y * t + t / 2, 3.5).fill({ color: COLORS.train });
    }
  }

  private labelFor(id: string, name: string, x: number, y: number): void {
    let label = this.labels.get(id);
    if (!label) {
      label = new Text({
        text: name,
        style: new TextStyle({ fill: COLORS.cityLabel, fontSize: 10, fontFamily: 'system-ui' }),
      });
      label.anchor.set(0.5, 1);
      this.labels.set(id, label);
    }
    label.x = x;
    label.y = y;
    this.cityLayer.addChild(label);
  }
}
