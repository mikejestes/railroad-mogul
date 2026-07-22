import { describe, it, expect } from 'vitest';
import { createGameState, serialize, type GameState } from '../../src/sim/state.ts';
import { tick } from '../../src/sim/tick.ts';
import { SYSTEMS } from '../../src/sim/systems/index.ts';
import { deliverySystem } from '../../src/sim/systems/delivery.ts';
import { landSystem, LAND_TAX_RATE } from '../../src/sim/systems/land.ts';
import { makeCity } from '../../src/sim/model/cities.ts';
import { applyIntent } from '../../src/store/applyIntents.ts';
import type { Intent } from '../../src/store/gameStore.ts';
import { parcelValuation, type ParcelValuation } from '../../src/store/selectors.ts';
import {
  addressAt,
  CHARTER_WINDOW_DAYS,
  type ParcelAddress,
} from '../../src/sim/model/land.ts';
import {
  landValueAt,
  STATION_UPLIFT_CAP_CENTS,
  STATION_UPLIFT_BASE_CENTS,
  STATION_UPLIFT_DEV_BONUS_CENTS,
} from '../../src/sim/model/landValue.ts';
import { MIN_STATION_SPACING_TILES } from '../../src/sim/model/track.ts';

/**
 * Milestone 6 U8 (KTD1-KTD3, R3/R6/R10) — the exploit gate that carries the
 * whole milestone. Scripted end-to-end scenarios over the headless sim,
 * following `tests/sim/loop.e2e.test.ts`'s pattern (real stations, real
 * track, real trains, ticked through the full pipeline) rather than unit
 * tests of individual pricing functions (`tests/sim/land.test.ts` already
 * covers those). Every assertion here is an ORDERING property — hold-and-feed
 * beats flip, abandon loses, land stays subordinate to haulage — never an
 * exact number, per the plan's Assumptions: the tuning constants
 * (`CHARTER_FEE_FRACTION`, `ANTICIPATION_FRACTION`, `LAND_TAX_RATE`,
 * `GROUND_RENT_RATE`, `SALE_SPREAD_FRACTION`, `CHARTER_WINDOW_DAYS`) are
 * starting points U8 is allowed to retune (see `systems/land.ts`'s
 * `GROUND_RENT_RATE` docblock for this suite's own retuning of it) as long
 * as these orderings keep holding.
 *
 * Every scenario shares one geography: a source station `A` (a fed food
 * plant) at (OX, OY), and an unserved city `B` at the charter's terminal,
 * (OX+6, OY) — the same 10x10 sea-free coordinate block `tests/sim/land.test.ts`
 * and `tests/sim/track.test.ts` already anchor on (seed 1, verified
 * empirically sea-free). The parcel under test sits one tile off the direct
 * rail line near the terminal (`TERMINAL_ADDRESS`) — close enough to the
 * terminal to carry a real anticipation premium and real eventual
 * station-uplift, but not sitting exactly on the corridor's own chord, where
 * the corridor's unavoidable severance cut (AE5 — the same infrastructure
 * that serves land also cuts it) would swamp every other effect.
 */

const OX = 19;
const OY = 0;
const TERMINAL_X = OX + 6;
const TERMINAL_Y = OY;
const WAYPOINTS = [
  { x: OX, y: OY },
  { x: TERMINAL_X, y: TERMINAL_Y },
];
const SOURCE_STATION_ID = 'stn-0';
const TERMINAL_STATION_ID = 'stn-1';
/** One tile off the direct corridor near the terminal — see module docblock. */
const TERMINAL_ADDRESS: ParcelAddress = addressAt(TERMINAL_X, TERMINAL_Y + 1);

/** A world with a fed source station at A and an unserved city at the
 *  charter's future terminal — nothing chartered, bought, or built yet. */
function freshWorld(): GameState {
  const s = createGameState(1);
  s.world = { width: OX + 30, height: OY + 30 };
  s.moneyCents = 10_000_000_00; // headroom for stations, charter, land, and a train
  applyIntent(s, { kind: 'buildStation', x: OX, y: OY, radius: 2, stationType: 'mixed' } as Intent);
  s.industries.push({
    id: 'plant',
    type: 'foodPlant',
    x: OX,
    y: OY,
    output: 'food',
    outputStock: 8,
    inputStock: { grain: 100_000 },
  });
  s.cities.push(makeCity('metro', 'Metro', TERMINAL_X, TERMINAL_Y, 0));
  return s;
}

function charterToTerminal(s: GameState) {
  applyIntent(s, { kind: 'charterRoute', waypoints: WAYPOINTS } as Intent);
  return s.charters[s.charters.length - 1];
}

function buyTerminalParcel(s: GameState) {
  applyIntent(s, { kind: 'buyLand', address: TERMINAL_ADDRESS } as Intent);
  return s.parcels[s.parcels.length - 1];
}

/** Build the chartered route (consumes the charter) and site the terminal
 *  station, creating its district (R2/R5). */
function buildRouteAndTerminal(s: GameState) {
  applyIntent(s, { kind: 'commitRoute', waypoints: WAYPOINTS } as Intent);
  applyIntent(s, {
    kind: 'buildStation',
    x: TERMINAL_X,
    y: TERMINAL_Y,
    radius: 2,
    stationType: 'mixed',
  } as Intent);
}

/** Buy the cheapest available engine and run it looping A <-> terminal,
 *  hauling whatever the source and city can supply (food outbound, any
 *  passengers/mail the growing city generates on the way back) — feeding
 *  the terminal district exactly the way a played game would. */
function feedWithATrain(s: GameState) {
  applyIntent(s, {
    kind: 'buyTrain',
    engineId: 'planet',
    stationIds: [SOURCE_STATION_ID, TERMINAL_STATION_ID],
  } as Intent);
}

/** The exact per-day ground charge `landSystem` debits a parcel bought at
 *  `pricePaidCents` (KTD3) — a pure function of the fixed purchase price, so
 *  the total carrying cost over `heldDays` is this times `heldDays` exactly
 *  (no rounding drift, since the per-day charge itself is already an
 *  integer). Mirrors `land.test.ts`'s own convention of asserting expected
 *  values through the imported rate rather than a duplicated formula. */
function dailyTaxCents(pricePaidCents: number): number {
  return Math.round(LAND_TAX_RATE * pricePaidCents);
}

/** Advance `days` ticks through the real pipeline, bucketing the money this
 *  specific run earns from haulage (`deliverySystem`) separately from land
 *  ops (`landSystem`) — the only two systems that ever call `addMoney` once
 *  setup is done (`sim/systems/*.ts`). Walks the SAME `SYSTEMS` pipeline
 *  array `tick()` itself runs (`sim/systems/index.ts`), identified by
 *  function reference, so this ledger can never drift out of sync with a
 *  future reordering of the real pipeline — and replicates `tick()`'s own
 *  bookkeeping (`timeDays`/`tick` advance) exactly, so a caller that also
 *  calls `tick()` elsewhere in the same test sees identical sim time either
 *  way. */
function tickWithLedger(s: GameState, days: number): { haulageCents: number; landNetCents: number } {
  let haulageCents = 0;
  let landNetCents = 0;
  for (let day = 0; day < days; day++) {
    for (const system of SYSTEMS) {
      const before = s.moneyCents;
      system(s, 1);
      const delta = s.moneyCents - before;
      if (system === deliverySystem) haulageCents += delta;
      else if (system === landSystem) landNetCents += delta;
    }
    s.timeDays += 1;
    s.tick += 1;
  }
  return { haulageCents, landNetCents };
}

const FEED_DAYS = 1000;

describe('U8: buying-ahead economics (KTD1-KTD3) — the exploit gate', () => {
  it('AE1: charter -> buy in the corridor -> build within the window -> feed the district: the parcel outperforms its all-in cost', () => {
    const s = freshWorld();
    const charter = charterToTerminal(s);
    const parcel = buyTerminalParcel(s);
    const pricePaid = parcel.pricePaidCents;
    const acquiredDay = parcel.acquiredDay;

    // Build strictly inside the charter window (R5) -- the charter is
    // consumed by construction, not left to lapse.
    expect(s.timeDays).toBeLessThan(charter.expiresDay);
    buildRouteAndTerminal(s);
    expect(s.charters[0].status).toBe('consumed');
    feedWithATrain(s);

    for (let day = 0; day < FEED_DAYS; day++) tick(s);

    // Real development actually happened -- this is what separates AE1 from
    // the failure arm below, and from a purely-speculative flat premium.
    const district = s.districts.find((d) => d.stationId === TERMINAL_STATION_ID);
    expect(district).toBeDefined();
    expect(district!.development).toBeGreaterThan(0);

    const heldDays = s.timeDays - acquiredDay;
    const carryingCostCents = dailyTaxCents(pricePaid) * heldDays;
    const allInCostCents = pricePaid + charter.feePaidCents + carryingCostCents;

    const valuation = parcelValuation(s, parcel.id) as ParcelValuation;
    expect(valuation.currentValueCents).toBeGreaterThan(allInCostCents);

    // The gain is attributable (R9/AE4): real infrastructure items now
    // outweigh whatever anticipation premium the purchase itself paid for.
    const gainCauses = valuation.attribution.filter((a) => a.cents > 0).map((a) => a.name);
    expect(gainCauses).toEqual(expect.arrayContaining(['station-uplift']));
  });

  it('AE2 (abandon arm): letting the charter lapse before building leaves a net-negative, attributable loss', () => {
    const s = freshWorld();
    charterToTerminal(s);
    const parcel = buyTerminalParcel(s);
    const pricePaid = parcel.pricePaidCents;

    // Never build. Tick past the charter window so it lapses (R6).
    for (let day = 0; day < CHARTER_WINDOW_DAYS + 10; day++) tick(s);
    expect(s.charters[0].status).toBe('lapsed');

    const valuation = parcelValuation(s, parcel.id) as ParcelValuation;
    expect(valuation.currentValueCents).toBeLessThan(pricePaid);
    expect(valuation.deltaCents).toBeLessThan(0);

    // The loss is attributable (R9): the anticipation premium the player
    // paid for is gone from the itemization now that the charter has
    // lapsed, and it shows up as a named negative cause, not an unexplained
    // residual.
    const anticipationDrop = valuation.attribution.find((a) => a.name === 'anticipation');
    expect(anticipationDrop).toBeDefined();
    expect(anticipationDrop!.cents).toBeLessThan(0);
  });

  it('AE2 (failure arm): building but never feeding the district earns no rent and underperforms the AE1 arc', () => {
    // The AE1 arm, for comparison.
    const ae1 = freshWorld();
    const ae1Charter = charterToTerminal(ae1);
    const ae1Parcel = buyTerminalParcel(ae1);
    buildRouteAndTerminal(ae1);
    feedWithATrain(ae1);
    for (let day = 0; day < FEED_DAYS; day++) tick(ae1);
    const ae1Valuation = parcelValuation(ae1, ae1Parcel.id) as ParcelValuation;
    const ae1NetPosition = ae1Valuation.currentValueCents - ae1Parcel.pricePaidCents - ae1Charter.feePaidCents;

    // The failure arm: identical setup, route and station both built (so
    // real infrastructure exists), but no train ever runs -- the district
    // is never fed.
    const s = freshWorld();
    const charter = charterToTerminal(s);
    const parcel = buyTerminalParcel(s);
    buildRouteAndTerminal(s);
    // No feedWithATrain(s) call -- deliberately never fed.
    for (let day = 0; day < FEED_DAYS; day++) tick(s);

    const district = s.districts.find((d) => d.stationId === TERMINAL_STATION_ID);
    expect(district!.development).toBe(0); // never grew: nothing was ever delivered

    const valuation = parcelValuation(s, parcel.id) as ParcelValuation;
    const netPosition = valuation.currentValueCents - parcel.pricePaidCents - charter.feePaidCents;

    // Rent never covers carrying: with zero development, intensity (and so
    // rent) is exactly zero every day, while the ground charge keeps
    // debiting -- carrying cost is pure loss here, never offset.
    expect(valuation.attribution.some((a) => a.name === 'district-development')).toBe(false);
    expect(netPosition).toBeLessThan(ae1NetPosition);
  });

  it('exploit gate: charter -> buy -> build -> immediately sell everything nets a loss, not a flip profit, and underperforms hold-and-feed', () => {
    // The AE1 arm, for comparison.
    const ae1 = freshWorld();
    const ae1Charter = charterToTerminal(ae1);
    const ae1Parcel = buyTerminalParcel(ae1);
    buildRouteAndTerminal(ae1);
    feedWithATrain(ae1);
    for (let day = 0; day < FEED_DAYS; day++) tick(ae1);
    const ae1Valuation = parcelValuation(ae1, ae1Parcel.id) as ParcelValuation;
    const ae1NetPosition = ae1Valuation.currentValueCents - ae1Parcel.pricePaidCents - ae1Charter.feePaidCents;

    // The flip: charter, buy, build, sell -- all before a single day passes.
    const s = freshWorld();
    charterToTerminal(s);
    const parcel = buyTerminalParcel(s);
    const pricePaid = parcel.pricePaidCents;
    buildRouteAndTerminal(s);

    const beforeSale = s.moneyCents;
    applyIntent(s, { kind: 'sellLand', parcelId: parcel.id } as Intent);
    expect(s.parcels).toHaveLength(0);
    const saleProceeds = s.moneyCents - beforeSale;
    const flipNetCents = saleProceeds - pricePaid;

    // No flip profit (KTD7): the round trip -- premium paid in, spread paid
    // out -- always loses money, even after the infrastructure it
    // anticipated is real. A no-land baseline (never buying at all -- net
    // land cash flow of exactly zero) beats the flip for exactly this
    // reason: zero beats a negative number.
    const noLandBaselineCents = 0;
    expect(flipNetCents).toBeLessThan(noLandBaselineCents);
    // Patience strictly dominates flipping.
    expect(flipNetCents).toBeLessThan(ae1NetPosition);
  });

  it('subordination gate: buying out an entire catchment and collecting rent never dominates one train\'s haulage income', () => {
    const s = freshWorld();
    charterToTerminal(s);

    // Stress case: buy every acquirable parcel inside the corridor/terminal
    // catchment -- far beyond what a reasonable player would hold, and the
    // worst case for this gate (rent scales with parcel count; haulage does
    // not scale with how much land the player owns).
    for (let dx = -2; dx <= 2; dx += 0.5) {
      for (let dy = -2; dy <= 2; dy += 0.5) {
        applyIntent(s, { kind: 'buyLand', address: addressAt(TERMINAL_X + dx, TERMINAL_Y + dy) } as Intent);
      }
    }
    const parcelsHeld = s.parcels.length;
    expect(parcelsHeld).toBeGreaterThan(20); // a real catchment saturation, not a token few

    buildRouteAndTerminal(s);
    feedWithATrain(s); // exactly one train

    const { haulageCents, landNetCents } = tickWithLedger(s, FEED_DAYS);

    expect(haulageCents).toBeGreaterThan(0); // sanity: the train actually earned something
    // The documented margin (KTD3's own success criterion, this suite's
    // tuning gate): even at full catchment saturation, aggregate land
    // income (rent net of tax, across every parcel) stays well under half
    // of what a single feeding train earned over the same run.
    expect(landNetCents).toBeLessThan(haulageCents * 0.5);
  });
});

/**
 * U8 (this fix): the station-uplift stacking exploit gate. Before this fix,
 * `stationUpliftItem` (`sim/model/landValue.ts`) summed every covering
 * station's uplift with no ceiling at all, and `buildStation`
 * (`sim/model/track.ts`) had no same-tile or minimum-spacing guard — so a
 * player could buy out a station's whole catchment (at plain `landValueAt`,
 * no charter/anticipation premium required, since the catchment already
 * grants rights) and then site any number of extra cheap stations on or
 * near the same tile purely to inflate `landValueAt` at the parcels they
 * already own, before immediately `sellLand`-ing everything for a
 * same-tick profit. Two measures close it, defense in depth:
 * `MIN_STATION_SPACING_TILES` refuses a degenerate same-tile re-site
 * outright; `STATION_UPLIFT_CAP_CENTS` bounds the additive sum any single
 * point can ever carry, so stations sited just off the blocked tile (which
 * the spacing guard alone cannot stop) still can't push value past a
 * two-station ceiling. Both constants' own docblocks explain why they sit
 * where they do — this suite proves the composed result.
 */
describe('U8 exploit gate: station-uplift stacking cannot print money', () => {
  it('MIN_STATION_SPACING_TILES refuses a second station on a tile an existing station already occupies', () => {
    const s = freshWorld();
    const moneyBefore = s.moneyCents;
    applyIntent(s, { kind: 'buildStation', x: OX, y: OY, radius: 1, stationType: 'mixed' } as Intent);
    expect(s.stations).toHaveLength(1); // the same-tile attempt was refused, not appended
    expect(s.moneyCents).toBe(moneyBefore); // refused before any cost was charged, same as buildStation's other refusal paths (sea tile, unaffordable)
  });

  it('stacking exploit gate: build a station, buy its whole catchment, try to inflate value with more stations on/near the same tile, then sell everything -- nets a loss, not a flip profit', () => {
    const s = freshWorld(); // builds the real source station at (OX, OY), radius 2
    const moneyAtStart = s.moneyCents; // baseline BEFORE any land is bought at all

    // Buy every acquirable parcel inside the source station's own catchment
    // -- the exact precondition the exploit needs: real rights, no charter,
    // no anticipation premium, plain landValueAt pricing.
    for (let dx = -2; dx <= 2; dx += 0.5) {
      for (let dy = -2; dy <= 2; dy += 0.5) {
        applyIntent(s, { kind: 'buyLand', address: addressAt(OX + dx, OY + dy) } as Intent);
      }
    }
    const ownedIds = s.parcels.map((p) => p.id);
    expect(ownedIds.length).toBeGreaterThan(20); // a real catchment saturation, not a token few

    const stationsBeforeStacking = s.stations.length;

    // The literal reported exploit: pile extra stations directly on top of
    // the existing one, purely to inflate the land just bought.
    for (let i = 0; i < 5; i++) {
      applyIntent(s, { kind: 'buildStation', x: OX, y: OY, radius: 3, stationType: 'mixed' } as Intent);
    }
    expect(s.stations).toHaveLength(stationsBeforeStacking); // every same-tile attempt refused (MIN_STATION_SPACING_TILES)

    // The "near, not exactly on" variant the spacing guard alone cannot
    // refuse (each of these is a distinct, legal tile) -- this is where
    // STATION_UPLIFT_CAP_CENTS has to carry the defense.
    const nearOffsets: Array<[number, number]> = [
      [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1],
    ];
    for (const [dx, dy] of nearOffsets) {
      applyIntent(s, { kind: 'buildStation', x: OX + dx, y: OY + dy, radius: 1, stationType: 'mixed' } as Intent);
    }
    expect(s.stations.length).toBeGreaterThan(stationsBeforeStacking); // these DID get built -- real, legal, costly sites

    // The overlap this ring creates is real and capped, not zeroed out --
    // confirms the stacking attempt actually engaged the cap rather than
    // trivially failing for an unrelated reason.
    const capped = landValueAt(s, OX, OY).items.find((i) => i.name === 'station-uplift')!.cents;
    expect(capped).toBeLessThanOrEqual(STATION_UPLIFT_CAP_CENTS);

    // Cash out everything that was bought.
    for (const id of ownedIds) applyIntent(s, { kind: 'sellLand', parcelId: id } as Intent);

    // The whole sequence -- buy the catchment, stack stations against it
    // every way the guard and the cap allow, sell everything -- nets a
    // loss (or at best break-even), never a flip profit: KTD7's spread
    // plus the extra stations' own build cost dominates whatever capped
    // residual value bump the stacking maneuver bought.
    const net = s.moneyCents - moneyAtStart;
    expect(net).toBeLessThanOrEqual(0);
  });
});

/**
 * U8: legitimate additive composition survives the cap. Two genuinely
 * separate stations -- each its own real siting decision, each serving its
 * own neighborhood -- still compose additively where their catchments
 * overlap (KTD2, the plan's own "overlapping catchments compose
 * additively" scenario, `landValue.test.ts`'s unit-level version of this
 * same property), right up to `STATION_UPLIFT_CAP_CENTS`. The cap exists to
 * bound degenerate stacking (above), not to flatten real two-neighborhood
 * overlap into a single station's worth of value.
 */
describe('U8: overlapping catchments from two genuinely separate stations still compose (bounded by the cap)', () => {
  const AX = 19;
  const AY = 0;
  const BX = AX + 4; // far enough apart to be two real, separately-useful stations; close enough for a real catchment overlap

  function twoStationWorld(): GameState {
    const s = createGameState(1);
    s.world = { width: BX + 20, height: AY + 20 };
    s.moneyCents = 10_000_000_00;
    expect(BX - AX).toBeGreaterThanOrEqual(MIN_STATION_SPACING_TILES); // sanity: a legal, non-degenerate siting
    applyIntent(s, { kind: 'buildStation', x: AX, y: AY, radius: 3, stationType: 'mixed' } as Intent);
    applyIntent(s, { kind: 'buildStation', x: BX, y: AY, radius: 3, stationType: 'mixed' } as Intent);
    return s;
  }

  it('the overlap between two stations is worth strictly more than either station alone, and stays bounded by the cap', () => {
    const both = twoStationWorld();
    const midX = (AX + BX) / 2; // squarely in both catchments (radius 3, 4 tiles apart)

    const onlyA = createGameState(1);
    onlyA.world = both.world;
    onlyA.moneyCents = 10_000_000_00;
    applyIntent(onlyA, { kind: 'buildStation', x: AX, y: AY, radius: 3, stationType: 'mixed' } as Intent);

    const onlyB = createGameState(1);
    onlyB.world = both.world;
    onlyB.moneyCents = 10_000_000_00;
    applyIntent(onlyB, { kind: 'buildStation', x: BX, y: AY, radius: 3, stationType: 'mixed' } as Intent);

    const bothUplift = landValueAt(both, midX, AY).items.find((i) => i.name === 'station-uplift')!.cents;
    const onlyAUplift = landValueAt(onlyA, midX, AY).items.find((i) => i.name === 'station-uplift')!.cents;
    const onlyBUplift = landValueAt(onlyB, midX, AY).items.find((i) => i.name === 'station-uplift')!.cents;

    // Additive composition: at dev 0 (both fresh, no district growth yet)
    // and well under the cap, the sum is exact, not clipped.
    expect(bothUplift).toBe(onlyAUplift + onlyBUplift);
    expect(bothUplift).toBeGreaterThan(onlyAUplift);
    expect(bothUplift).toBeGreaterThan(onlyBUplift);
    expect(bothUplift).toBeLessThanOrEqual(STATION_UPLIFT_CAP_CENTS);

    // A real player can still buy into that legitimate overlap at full
    // price -- composition being capped in the degenerate-stacking case
    // above never nerfs this ordinary, single-decision two-city scenario.
    const address = addressAt(midX, AY);
    const refusal = (() => {
      const s2 = both;
      const before = s2.parcels.length;
      applyIntent(s2, { kind: 'buyLand', address } as Intent);
      return s2.parcels.length === before ? 'refused' : null;
    })();
    expect(refusal).toBeNull();
  });

  it('the cap has real headroom above the maximum a single fully-developed station alone can ever contribute', () => {
    // The cap is sized as a multiple of one station's own theoretical peak
    // (STATION_UPLIFT_BASE_CENTS + STATION_UPLIFT_DEV_BONUS_CENTS) -- a
    // single real, fully-developed station's own uplift never approaches
    // the cap on its own, so the cap is never what limits ONE station's
    // legitimate value.
    const singlePeak = STATION_UPLIFT_BASE_CENTS + STATION_UPLIFT_DEV_BONUS_CENTS;
    expect(STATION_UPLIFT_CAP_CENTS).toBeGreaterThanOrEqual(singlePeak);
    expect(STATION_UPLIFT_CAP_CENTS).toBeGreaterThan(singlePeak); // strictly -- headroom for genuine 2-station overlap, not just 1x
  });
});

describe('U8: determinism and persistence of the scripted arc', () => {
  it('the full charter -> buy -> build -> feed arc serializes byte-identically across two runs from the same seed and intents', () => {
    const run = (): string => {
      const s = freshWorld();
      charterToTerminal(s);
      buyTerminalParcel(s);
      buildRouteAndTerminal(s);
      feedWithATrain(s);
      for (let day = 0; day < 300; day++) tick(s);
      return serialize(s);
    };
    expect(run()).toBe(run());
  });

  it('a save taken mid-arc round-trips and resumes identically to an uninterrupted run', () => {
    const live = freshWorld();
    charterToTerminal(live);
    buyTerminalParcel(live);
    buildRouteAndTerminal(live);
    feedWithATrain(live);
    for (let day = 0; day < 150; day++) tick(live);

    const snapshot = serialize(live);

    for (let day = 0; day < 150; day++) tick(live);
    const liveFinal = serialize(live);

    const restored: GameState = JSON.parse(snapshot);
    for (let day = 0; day < 150; day++) tick(restored);
    expect(serialize(restored)).toBe(liveFinal);
  });
});
