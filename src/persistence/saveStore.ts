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
 * Migration hook. No version has ever shipped a real migrator; future format
 * bumps add a case here that upgrades an older state in place before it is
 * used, if one is ever warranted.
 *
 * v1 -> v2 (KTD9, terrain-substrate milestone U7): schema 2 removed
 * `World.terrain` (U3) — the array a v1 save's `state` JSON still carries —
 * in favor of terrain as a pure function of coordinates. There is nothing to
 * migrate a v1 `terrain` array *into*; the field simply no longer exists on
 * `World`, and the fields.ts noise fields a v2 world derives terrain from
 * have no v1 counterpart to translate from. A migrator would have to
 * fabricate field values that could never match what a real seed produces,
 * silently corrupting the world underneath the player. `migrate` therefore
 * refuses a v1 load outright per KTD9 rather than attempting a lossy
 * upgrade — safe today because no save UI, autosave, or load path exists in
 * the running app, so no v1 save can exist in the wild to strand.
 *
 * v2 -> v3 (route-surveying milestone U4, KTD10): schema 3 adds
 * `GameState.routes`, `nextRouteId`, and the optional `TrackSegment.structure`
 * field (`model/track.ts`). A v2 save has no routes to migrate forward and no
 * way to retroactively decide which hand-laid segments would have "wanted" a
 * structure.
 *
 * v3 -> v4 (city-districts milestone U2, KTD11): schema 4 adds
 * `state.districts` and `state.nextDistrictId`. There is no history to
 * synthesize an older save's districts from — a district's channels are a
 * readout of delivery history that was never recorded before, so fabricating
 * one would silently invent built form the player never earned. Same
 * rationale, and the same "safe because no save path ships yet" argument, as
 * v1 -> v2: `migrate` refuses the mismatch rather than guessing.
 *
 * v4 -> v5 (station siting/severance milestone U7, KTD11): schema 5 adds
 * `Station.stationType` (optional, so this alone wouldn't force a bump),
 * `District.cuts`, and `state.derelictSites`. `cuts` and `derelictSites` are
 * permanent, path-dependent history — which infrastructure severed a
 * district, and when a station was abandoned — that a v4 save never
 * recorded, so there is nothing to synthesize either from; a v4 district's
 * `cuts` can only honestly be `[]`, which would silently understate real
 * severance a v4 save's own track/station data could imply, the same
 * "refuse rather than guess" rationale as every prior bump.
 *
 * v5 -> v6 (land-economics-and-speculation milestone, KTD11): schema 6 adds
 * `state.charters`, `state.parcels`, `nextCharterId`, and `nextParcelId`
 * (`sim/model/land.ts`). No v5 save has ever chartered a route or bought a
 * parcel (the intents did not exist under schema 5), so unlike `cuts` above
 * there is no understated history at risk — but `migrate` still refuses the
 * mismatch outright rather than special-casing an all-empty backfill, the
 * same uniform "refuse rather than guess" rule every prior bump follows.
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
