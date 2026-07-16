import type { System } from '../tick.ts';

/**
 * The ordered system pipeline (KTD3). Each tick runs these in a fixed order —
 * fixed order is required for determinism. Later units register their systems
 * here in this exact sequence:
 *
 *   production -> demand update -> train movement & arrivals ->
 *   delivery & fee settlement -> city growth/evolution -> bookkeeping
 *
 * U2 ships the empty pipeline and the ordering contract; U4/U6/U7/U8 fill it.
 */
export const SYSTEMS: System[] = [];
