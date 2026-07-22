import type { System } from '../tick.ts';
import { productionSystem } from './production.ts';
import { demandSystem } from './demand.ts';
import { movementSystem } from './movement.ts';
import { deliverySystem } from './delivery.ts';
import { districtSystem } from './districts.ts';
import { landSystem } from './land.ts';
import { growthSystem } from './growth.ts';

/**
 * The ordered system pipeline (KTD3). Each tick runs these in a fixed order —
 * fixed order is required for determinism. The full sequence is:
 *
 *   production -> demand update -> train movement & arrivals ->
 *   delivery & fee settlement -> district growth/decay -> land economics ->
 *   city growth/evolution -> bookkeeping
 *
 * Movement (U6), delivery (U7), and growth (U8) are inserted in order as
 * those units land. Districts (M4 U4) are inserted after delivery and before
 * growth — the plan's own ordering note — so districts read the deliveries
 * the same tick applied and settle before city growth reads anything.
 *
 * Milestone 6 U4 (KTD9) inserts `landSystem` after `districtSystem` and
 * before `growthSystem` — the plan's own reserved slot: charter expiry,
 * ground charge, and ground rent all read `development` from the district
 * record districts just settled this tick, and land income should never lag
 * a tick behind the district state it is priced against.
 */
export const SYSTEMS: System[] = [
  productionSystem,
  demandSystem,
  movementSystem,
  deliverySystem,
  districtSystem,
  landSystem,
  growthSystem,
];
