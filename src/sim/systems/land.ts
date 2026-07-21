import type { System } from '../tick.ts';
import { landValueAt } from '../model/landValue.ts';
import { expireCharters, parcelIntensity, parcelCenter } from '../model/land.ts';
import { addMoney } from '../state.ts';

/**
 * Land economics tick (milestone 6 U4, KTD3/KTD9). Inserted after
 * `districtSystem` and before `growthSystem` in the pipeline
 * (`systems/index.ts`) — the same slot milestone 5's KTD9 already reserved,
 * so land carrying costs/rent read the same tick's district development
 * city growth is about to read, never a tick stale.
 *
 * Each tick: expire past-window charters (`expireCharters`, `model/land.ts`),
 * then debit every parcel a ground charge and credit every parcel a ground
 * rent scaled by its development intensity (`parcelIntensity`, KTD5). Both
 * rates are per-day and multiply `dtDays`, matching every other system's
 * shape (`districts.ts`, `production.ts`), and both flow through `addMoney`
 * in integer cents (R3) as two separate, individually-rounded debits/credits
 * rather than one netted figure — so a save inspected mid-tick can always
 * account for tax and rent as distinct line items, the same itemization
 * discipline `landValueAt` follows for value.
 */

/** Per-day ground charge, as a fraction of `pricePaidCents` (KTD3) — bleeds
 *  every held parcel regardless of development, the cost of idle
 *  speculation (AE2's abandon arm). Tuned (with `GROUND_RENT_RATE` and the
 *  anticipation/spread constants in `model/land.ts`) so U8's exploit and
 *  subordination gates hold — see that suite's own tuning notes. */
export const LAND_TAX_RATE = 0.00035;

/** Per-day ground rent, as a fraction of a parcel's current `landValueAt`
 *  total, further scaled by `parcelIntensity` (KTD3/KTD5) — the payoff for
 *  land the player's own trains actually cause to develop. Bounded per
 *  parcel: intensity is at most 1 and `landValueAt` is itself bounded (no
 *  unbounded-growth term feeds it), so rent per parcel per day is bounded
 *  regardless of how long or how developed a district gets. */
export const GROUND_RENT_RATE = 0.0009;

export const landSystem: System = (state, dtDays) => {
  expireCharters(state);

  for (const parcel of state.parcels) {
    const charge = Math.round(LAND_TAX_RATE * parcel.pricePaidCents * dtDays);
    if (charge !== 0) addMoney(state, -charge);

    const center = parcelCenter(parcel.address);
    const value = landValueAt(state, center.x, center.y).totalCents;
    const intensity = parcelIntensity(state, parcel);
    const rent = Math.round(GROUND_RENT_RATE * value * intensity * dtDays);
    if (rent !== 0) addMoney(state, rent);
  }
};
