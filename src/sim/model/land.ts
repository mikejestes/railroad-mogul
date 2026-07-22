import type { GameState } from '../state.ts';
import { addMoney } from '../state.ts';
import type { Tile } from '../pathfinding.ts';
import { surveyRoute, type SurveyResult } from '../surveying.ts';
import { inCatchment } from './track.ts';
import { distanceToChord, activeDistrictFor, DISTRICT_FOOTPRINT_TILES, type District } from './districts.ts';
import {
  landValueAt,
  stationUpliftShapeCents,
  type LandValueItemName,
  type LandValueItem,
} from './landValue.ts';

/**
 * Land economics (milestone 6): parcels, charters, and the anti-exploit
 * pricing that makes buying ahead of your own infrastructure a real bet
 * rather than free money. Three load-bearing decisions, all here:
 *
 * KTD1 (charter): `charterRoute` re-runs milestone 3's `surveyRoute` from
 * waypoints (never trusts a UI-proposed path), pays a non-refundable fee,
 * and grants corridor acquisition rights for a bounded window.
 * `consumeCharters` (called from `commitRoute`'s intent handling,
 * `store/applyIntents.ts`) flips a charter to `'consumed'` once enough of
 * the actually-built path overlaps the chartered corridor.
 *
 * KTD2 (anticipation pricing): `purchasePrice` adds a premium on top of the
 * live `landValueAt` — the premium instantiates milestone 5's
 * station-uplift SHAPE (`stationUpliftShapeCents`, `landValue.ts`) at the
 * charter's terminal with PINNED reference inputs
 * (`ANTICIPATION_REFERENCE_RADIUS_TILES`, `ANTICIPATION_REFERENCE_DEVELOPMENT`),
 * never the live district record (which is ~0 at an unserved city — pricing
 * off it would be free money). The premium is a field sampled at the
 * parcel's own center, so it falls off with distance from the terminal
 * exactly as the real uplift will once the station exists.
 *
 * KTD7 (spread): `salePrice` is plain `landValueAt` (deliberately WITHOUT
 * the anticipation premium — the premium was never realized, only paid
 * for) minus a spread, so a buy-then-immediately-sell round trip always
 * loses money: the spread, plus whatever premium was paid at purchase.
 *
 * KTD4 (addressing): a parcel is a fixed sub-tile grid cell, addressed
 * `(tileX, tileY, subX, subY)` via `PARCELS_PER_TILE_EDGE` — stable under
 * everything the scene does, and a different thing entirely from milestone
 * 4's scene "parcels" (derived building lots). Never confuse the two.
 *
 * KTD8 (rights): `canAcquire` is one predicate, two sources — built-station
 * catchment or live-charter corridor — returning a closed refusal union.
 * It takes ownership/corridor data as explicit parameters (not read off
 * `state` directly) so it composes cleanly with fixtures and with the real
 * `state.parcels`/`state.charters` alike.
 *
 * KTD5 (no develop verb): `parcelIntensity` derives a parcel's rent-bearing
 * "how developed is this" purely from the serving district's `development`
 * and the parcel's position in the district's own value-field falloff —
 * never from scene layout. Ownership changes who collects, never what gets
 * built.
 */

// --- KTD4: parcel addressing -------------------------------------------

/** Each world tile subdivides into a `PARCELS_PER_TILE_EDGE` x
 *  `PARCELS_PER_TILE_EDGE` grid of ownership parcels (KTD4) — fixed,
 *  world-stable, and independent of milestone 4's scene block/parcel
 *  regeneration. */
export const PARCELS_PER_TILE_EDGE = 2;

/** A stable sub-tile address (KTD4). `subX`/`subY` are in
 *  `[0, PARCELS_PER_TILE_EDGE)`. */
export interface ParcelAddress {
  tileX: number;
  tileY: number;
  subX: number;
  subY: number;
}

/** The world-space center of an addressed parcel — the point every
 *  field query (`landValueAt`, `purchasePrice`, ...) samples at. */
export function parcelCenter(address: ParcelAddress): { x: number; y: number } {
  return {
    x: address.tileX + (address.subX + 0.5) / PARCELS_PER_TILE_EDGE,
    y: address.tileY + (address.subY + 0.5) / PARCELS_PER_TILE_EDGE,
  };
}

/** The address of the parcel containing world point `(wx, wy)` — the
 *  inverse of `parcelCenter` (round-trip stable: `addressAt(parcelCenter(a))`
 *  equals `a` for every valid address `a`). Used by the buy-mode click
 *  handler (`main.ts`, U6) to turn a cursor position into an address. */
export function addressAt(wx: number, wy: number): ParcelAddress {
  const tileX = Math.floor(wx);
  const tileY = Math.floor(wy);
  const fracX = wx - tileX;
  const fracY = wy - tileY;
  const subX = Math.min(PARCELS_PER_TILE_EDGE - 1, Math.max(0, Math.floor(fracX * PARCELS_PER_TILE_EDGE)));
  const subY = Math.min(PARCELS_PER_TILE_EDGE - 1, Math.max(0, Math.floor(fracY * PARCELS_PER_TILE_EDGE)));
  return { tileX, tileY, subX, subY };
}

/** A canonical string key for address equality/lookup — never used for
 *  iteration order (R11's determinism guard), only for `===`-style
 *  comparison across plain-object addresses. */
export function addressKey(address: ParcelAddress): string {
  return `${address.tileX},${address.tileY},${address.subX},${address.subY}`;
}

// --- KTD4: the stored parcel record -------------------------------------

/** Item names milestone 6's *current* itemized parcel value can carry
 *  (KTD6): every name `landValueAt` can emit, plus `'anticipation'` — the
 *  live, unrealized premium a pending charter still prices in. Never
 *  stored on `LandValueItemName` itself (milestone 5's own contract);
 *  this is milestone 6's superset for parcel-facing valuation only. */
export type ParcelValueItemName = LandValueItemName | 'anticipation';

export interface ParcelValueItem {
  name: ParcelValueItemName;
  cents: number;
}

/** Every name `currentParcelValueAt` can ever emit, in a fixed order — the
 *  attribution basis `store/selectors.ts`'s `parcelValuation` (U5) walks
 *  deterministically (never a `Map`/`Set` iteration order) to diff current
 *  vs purchase-time items name by name. */
export const ALL_PARCEL_VALUE_ITEM_NAMES: ParcelValueItemName[] = [
  'terrain-base',
  'station-uplift',
  'district-development',
  'severance',
  'derelict',
  'floor-adjustment',
  'anticipation',
];

export interface ParcelValue {
  totalCents: number;
  items: ParcelValueItem[];
}

/** A held parcel (KTD4, R11): a compact record, never a per-tile map.
 *  `valueItemsAtPurchase` is the itemized breakdown at the moment of
 *  purchase (KTD6) — attribution (R9) is computed on demand as the diff
 *  against `currentParcelValueAt`'s live items, never stored itself. */
export interface Parcel {
  id: string;
  address: ParcelAddress;
  pricePaidCents: number;
  acquiredDay: number;
  valueItemsAtPurchase: ParcelValueItem[];
}

// --- KTD8: acquisition rights --------------------------------------------

/** Distance (world tiles, Chebyshev-adjacent path metric) within which a
 *  live charter's corridor grants acquisition rights (KTD8) — covers the
 *  prospective terminal catchment too, since every charter's path ends
 *  there. Also the corridor-membership radius `consumeCharters` and
 *  `purchasePrice`'s premium gate use, so "does this charter reach this
 *  point" never disagrees between rights, consumption, and pricing. */
export const CHARTER_RIGHTS_RADIUS = 2;

export type AcquireRefusal = 'no-rights' | 'already-owned';

/** Shortest distance from a world point to any leg of a polyline path
 *  (a charter's or committed route's `path`) — the min over each
 *  consecutive pair's chord distance (`distanceToChord`, shared with
 *  severance geometry, `model/districts.ts`), so "how far is this point
 *  from this corridor" never drifts from how the codebase already answers
 *  "how far is this point from this cut". */
function distanceToPath(path: ReadonlyArray<Tile>, x: number, y: number): number {
  if (path.length === 0) return Infinity;
  if (path.length === 1) return Math.hypot(x - path[0].x, y - path[0].y);
  let min = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const d = distanceToChord(x, y, { ax: path[i].x, ay: path[i].y, bx: path[i + 1].x, by: path[i + 1].y });
    if (d < min) min = d;
  }
  return min;
}

/**
 * One predicate, two rights sources (KTD8): the parcel center lies within a
 * built station's catchment, or within `CHARTER_RIGHTS_RADIUS` of a live
 * charter's path. `ownedAddresses`/`corridors` are passed as explicit data
 * (rather than read off `state.parcels`/`state.charters` directly) so this
 * composes with fixtures before those fields exist on a caller's state, and
 * so a caller with a different candidate set (e.g. a UI preview considering
 * a not-yet-chartered corridor) can reuse the same predicate. Real callers
 * (`buyLand`, below) pass the live `state.parcels`/`state.charters` data.
 */
export function canAcquire(
  state: GameState,
  address: ParcelAddress,
  ownedAddresses: ReadonlyArray<ParcelAddress>,
  corridors: ReadonlyArray<ReadonlyArray<Tile>>,
): AcquireRefusal | null {
  const key = addressKey(address);
  if (ownedAddresses.some((a) => addressKey(a) === key)) return 'already-owned';

  const center = parcelCenter(address);
  const inBuiltCatchment = state.stations.some((s) => inCatchment(s, center.x, center.y));
  if (inBuiltCatchment) return null;

  const inCorridor = corridors.some((path) => distanceToPath(path, center.x, center.y) <= CHARTER_RIGHTS_RADIUS);
  if (inCorridor) return null;

  return 'no-rights';
}

// --- KTD1: charters --------------------------------------------------------

/** Non-refundable fraction of the surveyed build cost a charter costs
 *  (KTD1) — the first of the three composed constraints (fee, expiry,
 *  anticipation pricing) that defuse the buy-ahead exploit. */
export const CHARTER_FEE_FRACTION = 0.15;

/** Days a charter's corridor rights last before lapsing unbuilt (KTD1). */
export const CHARTER_WINDOW_DAYS = 180;

/** Fraction of a committed path's tiles that must lie within a live
 *  charter's corridor (`CHARTER_RIGHTS_RADIUS`) for that charter to count as
 *  consumed by the build (KTD1's Approach) — a threshold, not an exact
 *  match, since milestone 3's `commitRoute` re-runs A* against *current*
 *  costs, and those costs can legitimately drift over a charter's window. */
export const CHARTER_CONSUME_OVERLAP = 0.6;

export type CharterStatus = 'live' | 'consumed' | 'lapsed';

/** A paid, expiring commitment (KTD1): the player-facing record of a
 *  chartered corridor, distinct from a committed `Route` (`model/track.ts`).
 *  `path`/`waypoints` mirror `Route`'s own split — `path` is what
 *  `surveyRoute` resolved to at charter time, `waypoints` is what the player
 *  clicked. Status only ever transitions forward (`'live' -> 'consumed'` or
 *  `'live' -> 'lapsed'`); fees never refund. */
export interface Charter {
  id: string;
  waypoints: Tile[];
  path: Tile[];
  surveyedCostCents: number;
  feePaidCents: number;
  charteredDay: number;
  expiresDay: number;
  status: CharterStatus;
}

/** The non-refundable charter fee for a survey costing `surveyedCostCents`
 *  (KTD1) — a pure formula, exported so `land.test.ts` can assert the exact
 *  debit without duplicating the fraction. */
export function charterFeeCents(surveyedCostCents: number): number {
  return Math.round(CHARTER_FEE_FRACTION * surveyedCostCents);
}

/**
 * Charter a surveyed route (KTD1): re-runs `surveyRoute` from `waypoints`
 * (milestone 3's KTD2 discipline — the sim recomputes, never trusts a
 * UI-supplied path/cost), debits the non-refundable fee, and grants corridor
 * rights for `CHARTER_WINDOW_DAYS`. Self-contained validate-then-mutate,
 * following `buyTrain`'s precedent (`store/applyIntents.ts`) rather than
 * `buildStation`'s — `state.nextCharterId` only advances on success, so a
 * refused survey or unaffordable fee is a no-op with byte-identical state
 * (including the counter). Returns whether the charter was granted.
 */
export function charterRoute(state: GameState, waypoints: Tile[]): boolean {
  const survey: SurveyResult = surveyRoute(state, waypoints);
  if (!survey.ok) return false;
  const fee = charterFeeCents(survey.totalCents);
  if (state.moneyCents < fee) return false;

  const id = `chr-${state.nextCharterId++}`;
  state.charters.push({
    id,
    waypoints: waypoints.map((t) => ({ x: t.x, y: t.y })),
    path: survey.path.map((t) => ({ x: t.x, y: t.y })),
    surveyedCostCents: survey.totalCents,
    feePaidCents: fee,
    charteredDay: state.timeDays,
    expiresDay: state.timeDays + CHARTER_WINDOW_DAYS,
    status: 'live',
  });
  addMoney(state, -fee);
  return true;
}

/**
 * Consume every live charter whose corridor the just-built `builtPath`
 * (a committed route's resolved path) sufficiently overlaps (KTD1's
 * Approach). Called from `commitRoute`'s intent handling
 * (`store/applyIntents.ts`) after `emitRoute` has already landed the track —
 * building inside a charter's corridor is what spends it. Idempotent: a
 * charter already `'consumed'` or `'lapsed'` is left alone.
 */
export function consumeCharters(state: GameState, builtPath: ReadonlyArray<Tile>): void {
  if (builtPath.length === 0) return;
  for (const charter of state.charters) {
    if (charter.status !== 'live') continue;
    const withinCount = builtPath.reduce(
      (n, t) => (distanceToPath(charter.path, t.x, t.y) <= CHARTER_RIGHTS_RADIUS ? n + 1 : n),
      0,
    );
    const fraction = withinCount / builtPath.length;
    if (fraction >= CHARTER_CONSUME_OVERLAP) charter.status = 'consumed';
  }
}

/**
 * Expire every charter past its window (KTD1/KTD3/KTD9) — called once per
 * tick from `landSystem` (`sim/systems/land.ts`), before ground charge/rent.
 * A charter already `'consumed'` never lapses (building inside the window
 * already resolved its fate); flips `'live' -> 'lapsed'` exactly once per
 * charter (idempotent past that point — a lapsed charter's `status` check
 * simply skips it on every subsequent tick).
 */
export function expireCharters(state: GameState): void {
  for (const charter of state.charters) {
    if (charter.status === 'live' && state.timeDays >= charter.expiresDay) {
      charter.status = 'lapsed';
    }
  }
}

// --- KTD2: anticipation pricing --------------------------------------------

/** Fraction of the *projected* uplift a purchase's anticipation premium
 *  charges (KTD2) — strictly between 0 and 1: at 1 speculation is pointless
 *  (the seller has already captured the entire eventual gain), at 0 it is
 *  free money (buying ahead costs nothing extra). The tuning dial U8's
 *  exploit gate turns. */
export const ANTICIPATION_FRACTION = 0.5;

/** Pinned reference radius (KTD2) for the projected-uplift field — stands in
 *  for the real station's eventual catchment radius, which does not exist
 *  yet at charter time. Matches a radius-2 (Station-tier) catchment, the
 *  middle of `STATION_COST`'s three tiers (`model/track.ts`) — a plausible,
 *  documented guess, not the player's eventual choice. */
export const ANTICIPATION_REFERENCE_RADIUS_TILES = 2;

/** Pinned reference development (KTD2), strictly greater than zero — stands
 *  in for the district's eventual development at the point real uplift
 *  arrives. Deliberately NOT the live district record: a charter terminal at
 *  an unserved city has no district yet, and evaluating naively against a
 *  live record would land on ~0, the free-money endpoint KTD2 exists to
 *  avoid. A mid-life value: plausible, not maximal — real development could
 *  end up higher (the player captures the surplus) or lower (the player eats
 *  the loss), which is exactly the risk R6 demands. */
export const ANTICIPATION_REFERENCE_DEVELOPMENT = 0.5;

/**
 * The projected uplift field (KTD2): milestone 5's station-uplift SHAPE
 * (`stationUpliftShapeCents`, `landValue.ts`) instantiated at a charter's
 * `terminal` with the pinned reference radius/development, queried at the
 * parcel's own `center` — exactly as `landValueAt` will query the real
 * uplift once a station exists there. Falls off with `center`'s distance
 * from `terminal` (Chebyshev, matching `inCatchment`'s own metric), so a
 * parcel near the terminal carries most of the premium and one far along
 * the corridor carries little to none.
 */
export function projectedUplift(terminal: { x: number; y: number }, center: { x: number; y: number }): number {
  const distance = Math.max(Math.abs(center.x - terminal.x), Math.abs(center.y - terminal.y));
  return stationUpliftShapeCents(ANTICIPATION_REFERENCE_RADIUS_TILES, ANTICIPATION_REFERENCE_DEVELOPMENT, distance);
}

/**
 * The live anticipation premium at world point `center` (KTD2): summed over
 * every LIVE charter whose corridor rights cover `center`
 * (`CHARTER_RIGHTS_RADIUS`, the same gate `canAcquire` uses) —
 * `ANTICIPATION_FRACTION` of that charter's `projectedUplift` from its own
 * terminal (the path's last point). Zero with no covering live charter.
 * Shared by `purchasePrice` (what `buyLand` charges) and
 * `currentParcelValueAt` (the live `'anticipation'` item, KTD6) so the two
 * can never disagree about what the premium currently is.
 */
export function anticipationPremiumCents(state: GameState, center: { x: number; y: number }): number {
  let upliftSum = 0;
  for (const charter of state.charters) {
    if (charter.status !== 'live') continue;
    if (distanceToPath(charter.path, center.x, center.y) > CHARTER_RIGHTS_RADIUS) continue;
    const terminal = charter.path[charter.path.length - 1];
    if (!terminal) continue;
    upliftSum += projectedUplift(terminal, center);
  }
  return Math.round(ANTICIPATION_FRACTION * upliftSum);
}

/**
 * Purchase price (KTD2): the current `landValueAt` plus the live
 * anticipation premium — the exact number `buyLand` debits and the buy-mode
 * overlay (U6) tints by, never a parallel formula.
 */
export function purchasePrice(state: GameState, address: ParcelAddress): number {
  const center = parcelCenter(address);
  const base = landValueAt(state, center.x, center.y).totalCents;
  return base + anticipationPremiumCents(state, center);
}

/** Fraction of current value lost to the spread on a sale (KTD7) — closes
 *  the buy-then-flip loop: round-tripping always costs at least this much,
 *  plus whatever anticipation premium was paid going in (never realized,
 *  since a sale prices off plain `landValueAt`, not `purchasePrice`). */
export const SALE_SPREAD_FRACTION = 0.1;

/** Sale price (KTD7): plain current `landValueAt` (deliberately WITHOUT the
 *  anticipation premium — see the module docblock) minus the spread. */
export function salePrice(state: GameState, address: ParcelAddress): number {
  const center = parcelCenter(address);
  const raw = landValueAt(state, center.x, center.y).totalCents;
  return Math.round(raw * (1 - SALE_SPREAD_FRACTION));
}

// --- KTD6: current itemized value & attribution basis ----------------------

/**
 * The current itemized value of the parcel at `address` (KTD6): every
 * `landValueAt` item, plus a live `'anticipation'` item when a covering
 * charter is still live (omitted, like `landValueAt`'s own
 * `'floor-adjustment'`, when it would contribute exactly zero). This is what
 * gets stored verbatim as `valueItemsAtPurchase` at buy time, and what a
 * later query's items are diffed against for attribution
 * (`store/selectors.ts`'s `parcelValuation`, U5) — using the same item set
 * on both sides is what makes "the anticipation item disappears and the
 * real station-uplift item takes over" a legible diff rather than an
 * unnamed residual.
 */
export function currentParcelValueAt(state: GameState, address: ParcelAddress): ParcelValue {
  const center = parcelCenter(address);
  const lv = landValueAt(state, center.x, center.y);
  const items: ParcelValueItem[] = lv.items.map((i: LandValueItem) => ({ name: i.name, cents: i.cents }));
  const anticipation = anticipationPremiumCents(state, center);
  if (anticipation !== 0) items.push({ name: 'anticipation', cents: anticipation });
  const totalCents = items.reduce((sum, i) => sum + i.cents, 0);
  return { totalCents, items };
}

// --- KTD3/KTD7: buying and selling ------------------------------------------

export type BuyRefusal = AcquireRefusal | 'insufficient-funds';

/**
 * Buy the parcel at `address` (KTD2/KTD3/KTD8/R3/R10): validates rights
 * (`canAcquire`, against the live `state.parcels`/`state.charters`), prices
 * it (`purchasePrice`), and — if affordable — stores it with its
 * purchase-time itemization (KTD6). Self-contained, `buyTrain`-style
 * validate-then-mutate: `state.nextParcelId` only advances on success, so a
 * refused or unaffordable purchase is a no-op with byte-identical state.
 * Returns `null` on success, else the refusal reason (KTD8's closed union
 * plus `'insufficient-funds'`).
 */
export function buyLand(state: GameState, address: ParcelAddress): BuyRefusal | null {
  const ownedAddresses = state.parcels.map((p) => p.address);
  const corridors = state.charters.filter((c) => c.status === 'live').map((c) => c.path);
  const refusal = canAcquire(state, address, ownedAddresses, corridors);
  if (refusal) return refusal;

  const price = purchasePrice(state, address);
  if (state.moneyCents < price) return 'insufficient-funds';

  const items = currentParcelValueAt(state, address).items;
  const id = `parcel-${state.nextParcelId++}`;
  state.parcels.push({
    id,
    address: { ...address },
    pricePaidCents: price,
    acquiredDay: state.timeDays,
    valueItemsAtPurchase: items,
  });
  addMoney(state, -price);
  return null;
}

/**
 * Sell an owned parcel (KTD7): credits `salePrice` and removes the record.
 * `false` for an unknown `parcelId` (no-op, byte-identical state) — there is
 * no legibility requirement on a sell refusal the way `buyLand`'s is (AE3
 * concerns acquisition, not disposal).
 */
export function sellLand(state: GameState, parcelId: string): boolean {
  const idx = state.parcels.findIndex((p) => p.id === parcelId);
  if (idx === -1) return false;
  const parcel = state.parcels[idx];
  const price = salePrice(state, parcel.address);
  state.parcels.splice(idx, 1);
  addMoney(state, price);
  return true;
}

// --- KTD5: development interaction (U7) -------------------------------------

/**
 * The district currently serving world point `(x, y)` for land-economics
 * purposes (KTD3's rule, shared by ground rent and `parcelIntensity`): the
 * highest-`development` district whose station's catchment contains the
 * point. `undefined` when no station's catchment covers it (charter-corridor
 * land before any station exists earns no rent — deliberately). Walks
 * `activeDistrictFor` per distinct `stationId`, the same
 * seen-station-ids-in-array-order pattern `districtTrafficMultiplier`
 * (`model/districts.ts`) already uses, so "which district is this" never
 * double-counts a relocated station's abandoned record.
 */
export function servingDistrict(state: GameState, x: number, y: number): District | undefined {
  let best: District | undefined;
  const seenStationIds: string[] = [];
  for (const district of state.districts) {
    if (seenStationIds.includes(district.stationId)) continue;
    seenStationIds.push(district.stationId);
    const active = activeDistrictFor(state, district.stationId);
    if (!active) continue;
    const station = state.stations.find((s) => s.id === active.stationId);
    if (!station) continue;
    if (!inCatchment(station, x, y)) continue;
    if (!best || active.development > best.development) best = active;
  }
  return best;
}

/** A parcel's share of its serving district's local value field (KTD5): a
 *  linear falloff from 1 at the district's anchor to 0 at
 *  `DISTRICT_FOOTPRINT_TILES` — the same footprint/falloff shape
 *  `landValueAt`'s own `district-development` item uses (`landValue.ts`), so
 *  a parcel's rent-bearing "share" reads consistently with the value it was
 *  priced against. */
function districtFieldShare(district: District, x: number, y: number): number {
  const dist = Math.max(Math.abs(x - district.anchorX), Math.abs(y - district.anchorY));
  if (dist > DISTRICT_FOOTPRINT_TILES) return 0;
  return 1 - dist / DISTRICT_FOOTPRINT_TILES;
}

/**
 * A parcel's development intensity (KTD5, R2): the serving district's
 * `development` scaled by the parcel's share of that district's local value
 * field. Bounded to `[0, 1]` (both factors are), deterministic, and never
 * reads scene layout — feeds `landSystem`'s ground rent (`sim/systems/land.ts`,
 * U4) and any ownership-cue overlay (`render/worldRenderer.ts`, U7). Zero
 * for a parcel no district serves.
 */
export function parcelIntensity(state: GameState, parcel: Parcel): number {
  const center = parcelCenter(parcel.address);
  const district = servingDistrict(state, center.x, center.y);
  if (!district) return 0;
  const share = districtFieldShare(district, center.x, center.y);
  return Math.min(1, Math.max(0, district.development)) * share;
}
