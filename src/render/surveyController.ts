import type { GameState } from '../sim/state.ts';
import type { Tile } from '../sim/pathfinding.ts';
import { surveyRoute, type SurveyResult } from '../sim/surveying.ts';

/**
 * Survey interaction state machine (milestone 3 U6, KTD9). Owns the
 * in-progress survey — locked waypoints from clicks, the live cursor tile,
 * and (via `proposalFor`) the latest computed proposal — entirely outside
 * `GameState`: mirrors milestone 1's camera rule (`render/camera.ts`),
 * where view state that would otherwise turn every cursor move into a
 * save-state change instead lives in a boot-scope object driven by raw DOM
 * events in `main.ts`. Kept in its own class (rather than inline in
 * `main.ts`) for the same reason `Camera` is: pure, DOM-free transition
 * logic that is independently unit-testable without synthesizing pointer
 * events.
 *
 * State machine (see the plan's `stateDiagram-v2`):
 *   Idle -> Anchored: `click` sets the first waypoint
 *   Anchored -> Proposing: `hover` sets a live cursor tile
 *   Proposing -> Proposing: `click` appends another waypoint
 *   Proposing -> Idle: `reset` (Cancel / Esc / mode change)
 *
 * `proposalFor(state)` is a *preview* of `surveyRoute` — the exact same pure
 * function `applyIntent`'s `commitRoute` handling calls at commit time
 * (KTD2) — so this controller never computes a path or price on its own; it
 * only decides *which waypoints* to survey.
 */

function sameTile(a: Tile, b: Tile): boolean {
  return a.x === b.x && a.y === b.y;
}

export interface SurveyProposal {
  /** The waypoints a commit right now would send: locked waypoints plus the
   *  live cursor tile, when the cursor is set and distinct from the last
   *  locked waypoint. */
  waypoints: Tile[];
  result: SurveyResult;
}

export class SurveyController {
  private waypoints: Tile[] = [];
  private cursor: Tile | null = null;
  private version = 0;
  private listeners = new Set<() => void>();

  /** Monotonic version, bumped on every state change — the same
   *  version-counter pattern `GameStore` uses (see
   *  `docs/solutions/ui-bugs/react-frozen-ui-over-mutable-store-state.md`),
   *  since this controller also mutates in place rather than handing back a
   *  fresh object each time. */
  getVersion(): number {
    return this.version;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(): void {
    this.version += 1;
    for (const l of this.listeners) l();
  }

  /** Whether a survey is in progress at all (at least an anchor is set). */
  get active(): boolean {
    return this.waypoints.length > 0;
  }

  /** The waypoints the current preview reflects (locked waypoints, plus the
   *  live cursor tile when it extends them). */
  private previewWaypoints(): Tile[] {
    if (this.cursor && (this.waypoints.length === 0 || !sameTile(this.cursor, this.waypoints[this.waypoints.length - 1]))) {
      return [...this.waypoints, this.cursor];
    }
    return this.waypoints;
  }

  /** First click sets the anchor; every click after that locks in the
   *  current live cursor tile as a permanent waypoint (Idle -> Anchored,
   *  Proposing -> Proposing). */
  click(tile: Tile): void {
    this.waypoints = [...this.waypoints, { x: tile.x, y: tile.y }];
    this.cursor = null;
    this.publish();
  }

  /** Live cursor position while a survey is in progress (Anchored ->
   *  Proposing) — a no-op before any anchor is set, since there is nothing
   *  to propose toward yet. */
  hover(tile: Tile): void {
    if (this.waypoints.length === 0) return;
    this.cursor = { x: tile.x, y: tile.y };
    this.publish();
  }

  /** Cancel / Esc / mode change: clears the whole survey (-> Idle). A no-op
   *  when nothing is pending, so it never bumps the version spuriously. */
  reset(): void {
    if (this.waypoints.length === 0 && this.cursor === null) return;
    this.waypoints = [];
    this.cursor = null;
    this.publish();
  }

  /**
   * The current proposal for `state`, or `null` when no survey is active or
   * fewer than two waypoints are proposed yet (a lone anchor has nothing to
   * price). Callers should re-invoke this whenever they want a fresh read —
   * A* over the tile grid is cheap enough to run per cursor move or per
   * frame (KTD3) — so the panel's price never goes stale against sim state
   * it doesn't otherwise observe (KTD2).
   */
  proposalFor(state: GameState): SurveyProposal | null {
    const waypoints = this.previewWaypoints();
    if (waypoints.length < 2) return null;
    return { waypoints, result: surveyRoute(state, waypoints) };
  }
}
