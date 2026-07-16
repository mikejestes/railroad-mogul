import type { System } from '../tick.ts';
import { productionSystem } from './production.ts';
import { demandSystem } from './demand.ts';

/**
 * The ordered system pipeline (KTD3). Each tick runs these in a fixed order —
 * fixed order is required for determinism. The full sequence is:
 *
 *   production -> demand update -> train movement & arrivals ->
 *   delivery & fee settlement -> city growth/evolution -> bookkeeping
 *
 * Movement (U6), delivery (U7), and growth (U8) are inserted in order as those
 * units land.
 */
export const SYSTEMS: System[] = [productionSystem, demandSystem];
