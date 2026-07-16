import { SCHEMA_VERSION, serialize, type GameState } from '../sim/state.ts';

/**
 * Persistence (U11, KTD8). A save is a canonical serialization of the plain sim
 * state (which already includes the RNG seed/counter) wrapped with a schema
 * version for migrations. Because the kernel is deterministic, a restored save
 * resumes with a byte-identical future.
 *
 * `SaveStore` hides the backend so IndexedDB (browser) or an in-memory store
 * (tests/headless) or a future cloud API are interchangeable — the one-file
 * swap promised in KTD8.
 */
export interface SaveStore {
  save(slot: string, state: GameState): Promise<void>;
  load(slot: string): Promise<GameState | null>;
  list(): Promise<string[]>;
  remove(slot: string): Promise<void>;
}

export interface SaveEnvelope {
  version: number;
  savedAtDay: number;
  state: string; // canonical serialization of GameState
}

/** Serialize a save envelope (versioned, canonical). */
export function serializeSave(state: GameState): string {
  const envelope: SaveEnvelope = {
    version: SCHEMA_VERSION,
    savedAtDay: state.timeDays,
    state: serialize(state),
  };
  return JSON.stringify(envelope);
}

/** Parse a save envelope back into game state, applying migrations if needed. */
export function deserializeSave(json: string): GameState {
  const envelope = JSON.parse(json) as SaveEnvelope;
  const state = JSON.parse(envelope.state) as GameState;
  return migrate(state, envelope.version);
}

/**
 * Migration hook. v1 is the only shipped version; future format bumps add a
 * case here that upgrades an older state in place before it is used.
 */
function migrate(state: GameState, fromVersion: number): GameState {
  if (fromVersion === SCHEMA_VERSION) return state;
  // Future: step older versions forward. For now, refuse silently-wrong loads.
  throw new Error(`Unsupported save version ${fromVersion} (expected ${SCHEMA_VERSION})`);
}

/** In-memory store for tests and headless runs. */
export class MemorySaveStore implements SaveStore {
  private slots = new Map<string, string>();

  async save(slot: string, state: GameState): Promise<void> {
    this.slots.set(slot, serializeSave(state));
  }

  async load(slot: string): Promise<GameState | null> {
    const json = this.slots.get(slot);
    return json ? deserializeSave(json) : null;
  }

  async list(): Promise<string[]> {
    return [...this.slots.keys()].sort();
  }

  async remove(slot: string): Promise<void> {
    this.slots.delete(slot);
  }
}
