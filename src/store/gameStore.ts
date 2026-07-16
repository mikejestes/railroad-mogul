import type { GameState } from '../sim/state.ts';

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
  | { kind: 'buildStation'; x: number; y: number; radius: number };

export type Listener = (state: GameState) => void;

export class GameStore {
  private state: GameState;
  private listeners = new Set<Listener>();
  private pending: Intent[] = [];

  constructor(initial: GameState) {
    this.state = initial;
  }

  /** Latest snapshot (read-only for consumers). */
  getState(): GameState {
    return this.state;
  }

  /** Publish a new snapshot and notify subscribers (called on tick). */
  publish(state: GameState): void {
    this.state = state;
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
