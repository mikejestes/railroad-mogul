import type { GameState } from '../sim/state.ts';
import type { Tile } from '../sim/pathfinding.ts';
import type { StationType } from '../sim/model/track.ts';

/**
 * The bridge between the simulation kernel and the view layers (KTD1, KTD2).
 * The kernel publishes throttled snapshots here on tick; the PixiJS renderer
 * and React UI subscribe and read. Player intents flow the other way, queued
 * as inputs the clock applies before the next tick.
 *
 * Snapshots are published by reference and treated as read-only by consumers —
 * the store is deliberately message/snapshot-shaped so the kernel can later
 * move to a Web Worker without changing this contract (adversarial hedge).
 */
// Player intents that mutate SIM state. Clock control (pause/speed) is not a
// sim intent — it acts on the GameClock directly — so it is not modeled here.
export type Intent =
  | { kind: 'layTrack'; ax: number; ay: number; bx: number; by: number }
  /** Build a station (U5; `stationType` added milestone 5 U1, KTD3).
   *  `stationType` is optional — `applyIntent` falls through to
   *  `buildStation`'s own `DEFAULT_STATION_TYPE` ('mixed') when omitted, so
   *  every pre-M5 dispatch site and test fixture keeps building the neutral
   *  type without change. */
  | { kind: 'buildStation'; x: number; y: number; radius: number; stationType?: StationType }
  | { kind: 'buyTrain'; engineId: string; stationIds: string[] }
  /** Commit a surveyed route (milestone 3 U4, KTD2). Carries only the
   *  waypoint list — never the path or cost the UI's preview computed —
   *  so `applyIntent` re-runs `surveyRoute` from these waypoints and pays
   *  from that recomputation. This is what keeps a stale UI proposal, a
   *  race with a concurrent state change, or a hand-crafted intent from
   *  ever committing a route at the wrong price. */
  | { kind: 'commitRoute'; waypoints: Tile[] };

export type Listener = (state: GameState) => void;

export class GameStore {
  private state: GameState;
  private version = 0;
  private listeners = new Set<Listener>();
  private pending: Intent[] = [];

  constructor(initial: GameState) {
    this.state = initial;
  }

  /** Latest snapshot (read-only for consumers). */
  getState(): GameState {
    return this.state;
  }

  /**
   * Monotonic version, bumped on every publish. React's useSyncExternalStore
   * uses this as its snapshot: the sim mutates state in place and publishes the
   * same object reference each tick, so an Object.is check on the state itself
   * would never re-render the panels. The changing version is what drives the UI.
   */
  getVersion(): number {
    return this.version;
  }

  /** Publish a new snapshot and notify subscribers (called on tick). */
  publish(state: GameState): void {
    this.state = state;
    this.version += 1;
    for (const l of this.listeners) l(state);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Queue a player intent for the clock to apply before the next tick. */
  dispatch(intent: Intent): void {
    this.pending.push(intent);
  }

  /** Drain queued intents (called by the clock, U12). */
  drainIntents(): Intent[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}
