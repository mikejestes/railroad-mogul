import { describe, it, expect } from 'vitest';
import { createGameState, type GameState } from '../../src/sim/state.ts';
import { makeDistrict } from '../../src/sim/model/districts.ts';
import { landValueAt } from '../../src/sim/model/landValue.ts';
import { landSystem, LAND_TAX_RATE, GROUND_RENT_RATE } from '../../src/sim/systems/land.ts';
import {
  PARCELS_PER_TILE_EDGE,
  parcelCenter,
  addressAt,
  addressKey,
  canAcquire,
  charterFeeCents,
  charterRoute,
  consumeCharters,
  expireCharters,
  purchasePrice,
  salePrice,
  buyLand,
  sellLand,
  currentParcelValueAt,
  servingDistrict,
  parcelIntensity,
  CHARTER_FEE_FRACTION,
  CHARTER_WINDOW_DAYS,
  CHARTER_RIGHTS_RADIUS,
  ANTICIPATION_FRACTION,
  SALE_SPREAD_FRACTION,
  type ParcelAddress,
} from '../../src/sim/model/land.ts';

// Anchored at (OX, OY) — the same 10x10 sea-free coordinate block
// tests/sim/track.test.ts and tests/sim/landValue.test.ts already rely on.
const OX = 19;
const OY = 0;

function baseState(): GameState {
  const s = createGameState(1);
  s.world = { width: OX + 30, height: OY + 30 };
  s.moneyCents = 1_000_000_00;
  return s;
}

describe('parcel addressing (milestone 6 U1, KTD4)', () => {
  it('addressAt(parcelCenter(a)) round-trips to the same address for every sub-cell', () => {
    for (let subX = 0; subX < PARCELS_PER_TILE_EDGE; subX++) {
      for (let subY = 0; subY < PARCELS_PER_TILE_EDGE; subY++) {
        const address: ParcelAddress = { tileX: OX, tileY: OY, subX, subY };
        const center = parcelCenter(address);
        expect(addressAt(center.x, center.y)).toEqual(address);
      }
    }
  });

  it('addressKey is stable and unique per address', () => {
    const a: ParcelAddress = { tileX: OX, tileY: OY, subX: 0, subY: 0 };
    const b: ParcelAddress = { tileX: OX, tileY: OY, subX: 1, subY: 0 };
    expect(addressKey(a)).toBe(addressKey({ ...a }));
    expect(addressKey(a)).not.toBe(addressKey(b));
  });

  it('parcelCenter is a pure function of the address, with no state input', () => {
    const address: ParcelAddress = { tileX: OX + 2, tileY: OY + 3, subX: 1, subY: 0 };
    expect(parcelCenter(address)).toEqual(parcelCenter({ ...address }));
  });
});

describe('canAcquire — one predicate, two rights sources (milestone 6 U1, KTD8)', () => {
  it('AE3: an address with no built station and no charter corridor refuses with no-rights', () => {
    const s = baseState();
    const address = addressAt(OX, OY);
    expect(canAcquire(s, address, [], [])).toBe('no-rights');
  });

  it('AE3: the same address inside a built station catchment is acquirable', () => {
    const s = baseState();
    s.stations.push({ id: 'stn', x: OX, y: OY, radius: 3 });
    const address = addressAt(OX + 1, OY);
    expect(canAcquire(s, address, [], [])).toBeNull();
  });

  it('an address within CHARTER_RIGHTS_RADIUS of a corridor path is acquirable, with no station at all', () => {
    const s = baseState();
    const address = addressAt(OX + 5, OY);
    const corridor = [{ x: OX, y: OY }, { x: OX + 10, y: OY }];
    expect(canAcquire(s, address, [], [corridor])).toBeNull();
  });

  it('an address beyond CHARTER_RIGHTS_RADIUS of every corridor refuses with no-rights', () => {
    const s = baseState();
    const address = addressAt(OX + 5, OY + CHARTER_RIGHTS_RADIUS + 5);
    const corridor = [{ x: OX, y: OY }, { x: OX + 10, y: OY }];
    expect(canAcquire(s, address, [], [corridor])).toBe('no-rights');
  });

  it('an already-owned address refuses with already-owned even though it sits in a built catchment', () => {
    const s = baseState();
    s.stations.push({ id: 'stn', x: OX, y: OY, radius: 3 });
    const address = addressAt(OX + 1, OY);
    expect(canAcquire(s, address, [address], [])).toBe('already-owned');
  });
});

describe('charters (milestone 6 U2, KTD1)', () => {
  function buildableWorld(): GameState {
    const s = createGameState(1);
    s.world = { width: OX + 10, height: OY + 2 };
    s.moneyCents = 1_000_000_00;
    return s;
  }

  it('charterFeeCents is exactly CHARTER_FEE_FRACTION of the surveyed cost, rounded', () => {
    expect(charterFeeCents(1000_00)).toBe(Math.round(CHARTER_FEE_FRACTION * 1000_00));
  });

  it('charters debits exactly the fee, grants corridor rights along the surveyed path, and expires at charteredDay + CHARTER_WINDOW_DAYS', () => {
    const s = buildableWorld();
    const before = s.moneyCents;
    const ok = charterRoute(s, [{ x: OX, y: OY }, { x: OX + 4, y: OY }]);
    expect(ok).toBe(true);
    expect(s.charters).toHaveLength(1);
    const charter = s.charters[0];
    expect(charter.status).toBe('live');
    expect(charter.feePaidCents).toBe(charterFeeCents(charter.surveyedCostCents));
    expect(before - s.moneyCents).toBe(charter.feePaidCents);
    expect(charter.expiresDay).toBe(charter.charteredDay + CHARTER_WINDOW_DAYS);
    expect(s.nextCharterId).toBe(1);

    // Rights now reach a point along the corridor that had no rights before.
    const address = addressAt(OX + 2, OY);
    const corridors = s.charters.filter((c) => c.status === 'live').map((c) => c.path);
    expect(canAcquire(s, address, [], corridors)).toBeNull();
  });

  it('an unaffordable charter is a no-op with byte-identical state (nextCharterId untouched)', () => {
    const s = buildableWorld();
    s.moneyCents = 0;
    const before = JSON.stringify(s);
    const ok = charterRoute(s, [{ x: OX, y: OY }, { x: OX + 4, y: OY }]);
    expect(ok).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('a refused survey (sea waypoint) is a no-op with byte-identical state', () => {
    const s = buildableWorld();
    const before = JSON.stringify(s);
    // x=0 sits west of every authored landmass box — always sea.
    const ok = charterRoute(s, [{ x: 0, y: OY }, { x: OX, y: OY }]);
    expect(ok).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('building within the corridor consumes the charter (status -> consumed)', () => {
    const s = buildableWorld();
    charterRoute(s, [{ x: OX, y: OY }, { x: OX + 4, y: OY }]);
    const charter = s.charters[0];
    consumeCharters(s, charter.path);
    expect(s.charters[0].status).toBe('consumed');
  });

  it('a built path that does not overlap the corridor leaves the charter live', () => {
    const s = buildableWorld();
    charterRoute(s, [{ x: OX, y: OY }, { x: OX + 4, y: OY }]);
    const farPath = [{ x: OX, y: OY + 20 }, { x: OX + 4, y: OY + 20 }];
    consumeCharters(s, farPath);
    expect(s.charters[0].status).toBe('live');
  });

  it('expireCharters flips a live charter to lapsed exactly once past its window, and never touches a consumed one', () => {
    const s = buildableWorld();
    charterRoute(s, [{ x: OX, y: OY }, { x: OX + 4, y: OY }]);
    consumeCharters(s, s.charters[0].path); // now 'consumed'
    charterRoute(s, [{ x: OX, y: OY }, { x: OX + 3, y: OY }]);
    const liveCharter = s.charters[1];

    s.timeDays = liveCharter.expiresDay - 1;
    expireCharters(s);
    expect(s.charters[1].status).toBe('live');
    expect(s.charters[0].status).toBe('consumed'); // untouched

    s.timeDays = liveCharter.expiresDay;
    expireCharters(s);
    expect(s.charters[1].status).toBe('lapsed');
    expect(s.charters[0].status).toBe('consumed'); // still untouched — a consumed charter never lapses

    // Idempotent: calling again past the window changes nothing further.
    expireCharters(s);
    expect(s.charters[1].status).toBe('lapsed');
  });

  it('a lapsed charter no longer grants corridor rights (U1 predicate now refuses)', () => {
    const s = buildableWorld();
    charterRoute(s, [{ x: OX, y: OY }, { x: OX + 4, y: OY }]);
    const charter = s.charters[0];
    s.timeDays = charter.expiresDay;
    expireCharters(s);

    const address = addressAt(OX + 2, OY);
    const liveCorridors = s.charters.filter((c) => c.status === 'live').map((c) => c.path);
    expect(canAcquire(s, address, [], liveCorridors)).toBe('no-rights');
  });
});

describe('purchasePrice — anticipation pricing (milestone 6 U3, KTD2)', () => {
  function chartered(terminalX: number): GameState {
    const s = baseState();
    charterRoute(s, [{ x: OX, y: OY }, { x: terminalX, y: OY }]);
    return s;
  }

  it('inside a built catchment with no pending infrastructure, price is exactly landValueAt (no premium)', () => {
    const s = baseState();
    s.stations.push({ id: 'stn', x: OX, y: OY, radius: 3 });
    const address = addressAt(OX + 1, OY);
    const center = parcelCenter(address);
    expect(purchasePrice(s, address)).toBe(landValueAt(s, center.x, center.y).totalCents);
  });

  it('inside a live charter corridor, price is strictly more than raw landValueAt (the premium is real)', () => {
    const s = chartered(OX + 8);
    const address = addressAt(OX + 7, OY); // close enough to the terminal to fall within the reference radius
    const center = parcelCenter(address);
    const raw = landValueAt(s, center.x, center.y).totalCents;
    expect(purchasePrice(s, address)).toBeGreaterThan(raw);
  });

  it('the premium falls off with distance from the charter terminal along the same corridor', () => {
    const s = chartered(OX + 8); // terminal at (OX+8, OY)
    const near = addressAt(OX + 7, OY); // close to the terminal
    const mid = addressAt(OX + 6, OY); // further along the corridor, still within the reference radius
    const nearCenter = parcelCenter(near);
    const midCenter = parcelCenter(mid);
    const nearPremium = purchasePrice(s, near) - landValueAt(s, nearCenter.x, nearCenter.y).totalCents;
    const midPremium = purchasePrice(s, mid) - landValueAt(s, midCenter.x, midCenter.y).totalCents;
    expect(nearPremium).toBeGreaterThan(midPremium);
    expect(midPremium).toBeGreaterThan(0);
  });

  it('a parcel far along the corridor (beyond the reference radius from the terminal) carries near-zero premium', () => {
    const s = chartered(OX + 8);
    const far = addressAt(OX + 1, OY); // several tiles from the terminal at OX+8
    const center = parcelCenter(far);
    const premium = purchasePrice(s, far) - landValueAt(s, center.x, center.y).totalCents;
    expect(premium).toBeGreaterThanOrEqual(0);
    // Strictly less than the near-terminal premium (already covered above);
    // here just confirm it never goes negative and stays small relative to
    // the near-terminal case.
    const nearCenter = parcelCenter(addressAt(OX + 7, OY));
    const nearPremium = purchasePrice(s, addressAt(OX + 7, OY)) - landValueAt(s, nearCenter.x, nearCenter.y).totalCents;
    expect(premium).toBeLessThan(nearPremium);
  });

  it('every price is an integer number of cents', () => {
    const s = chartered(OX + 8);
    const address = addressAt(OX + 2, OY);
    expect(Number.isInteger(purchasePrice(s, address))).toBe(true);
  });

  it('ANTICIPATION_FRACTION is strictly between 0 and 1 (KTD2 — the tuning dial)', () => {
    expect(ANTICIPATION_FRACTION).toBeGreaterThan(0);
    expect(ANTICIPATION_FRACTION).toBeLessThan(1);
  });
});

describe('buyLand / sellLand (milestone 6 U3, KTD2/KTD3/KTD7/KTD8/R3/R10)', () => {
  it('buying inside a built catchment debits exactly purchasePrice and stores the purchase-time itemization', () => {
    const s = baseState();
    s.stations.push({ id: 'stn', x: OX, y: OY, radius: 3 });
    const address = addressAt(OX + 1, OY);
    const price = purchasePrice(s, address);
    const before = s.moneyCents;

    const refusal = buyLand(s, address);

    expect(refusal).toBeNull();
    expect(before - s.moneyCents).toBe(price);
    expect(s.parcels).toHaveLength(1);
    const parcel = s.parcels[0];
    expect(parcel.pricePaidCents).toBe(price);
    expect(parcel.id).toBe('parcel-0');
    expect(s.nextParcelId).toBe(1);
    const itemSum = parcel.valueItemsAtPurchase.reduce((sum, i) => sum + i.cents, 0);
    expect(itemSum).toBe(price); // itemization completeness (KTD6)
  });

  it('a rights-refused purchase is a no-op with byte-identical state (nextParcelId untouched)', () => {
    const s = baseState();
    const address = addressAt(OX, OY);
    const before = JSON.stringify(s);
    const refusal = buyLand(s, address);
    expect(refusal).toBe('no-rights');
    expect(JSON.stringify(s)).toBe(before);
  });

  it('an unaffordable purchase refuses with insufficient-funds and is a no-op with byte-identical state', () => {
    const s = baseState();
    s.stations.push({ id: 'stn', x: OX, y: OY, radius: 3 });
    s.moneyCents = 0;
    const before = JSON.stringify(s);
    const refusal = buyLand(s, addressAt(OX + 1, OY));
    expect(refusal).toBe('insufficient-funds');
    expect(JSON.stringify(s)).toBe(before);
  });

  it('buying the same address twice refuses the second time with already-owned', () => {
    const s = baseState();
    s.stations.push({ id: 'stn', x: OX, y: OY, radius: 3 });
    const address = addressAt(OX + 1, OY);
    expect(buyLand(s, address)).toBeNull();
    expect(buyLand(s, address)).toBe('already-owned');
    expect(s.parcels).toHaveLength(1);
  });

  it('sellLand credits landValueAt(center) * (1 - SALE_SPREAD_FRACTION) and removes the parcel', () => {
    const s = baseState();
    s.stations.push({ id: 'stn', x: OX, y: OY, radius: 3 });
    const address = addressAt(OX + 1, OY);
    buyLand(s, address);
    const parcelId = s.parcels[0].id;
    const before = s.moneyCents;
    const center = parcelCenter(address);
    const expectedSale = Math.round(landValueAt(s, center.x, center.y).totalCents * (1 - SALE_SPREAD_FRACTION));

    const sold = sellLand(s, parcelId);

    expect(sold).toBe(true);
    expect(s.moneyCents - before).toBe(expectedSale);
    expect(expectedSale).toBe(salePrice(s, address));
    expect(s.parcels).toHaveLength(0);
  });

  it('selling an unknown parcel id is a no-op', () => {
    const s = baseState();
    const before = JSON.stringify(s);
    expect(sellLand(s, 'ghost')).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('buy-then-immediately-sell inside a live charter corridor loses money — the spread plus the anticipation premium (no flip profit)', () => {
    const s = baseState();
    charterRoute(s, [{ x: OX, y: OY }, { x: OX + 6, y: OY }]);
    const address = addressAt(OX + 5, OY); // near the terminal — real premium
    const cashBefore = s.moneyCents;

    buyLand(s, address);
    const parcelId = s.parcels[0].id;
    sellLand(s, parcelId);

    expect(s.moneyCents).toBeLessThan(cashBefore); // net loss on the round trip
  });
});

describe('currentParcelValueAt — attribution basis (milestone 6 U5/U6, KTD6)', () => {
  it('sums to the same total as purchasePrice at the moment of purchase (itemization completeness)', () => {
    const s = baseState();
    charterRoute(s, [{ x: OX, y: OY }, { x: OX + 6, y: OY }]);
    const address = addressAt(OX + 5, OY);
    const price = purchasePrice(s, address);
    const value = currentParcelValueAt(s, address);
    expect(value.totalCents).toBe(price);
    expect(value.items.reduce((sum, i) => sum + i.cents, 0)).toBe(value.totalCents);
    expect(value.items.some((i) => i.name === 'anticipation')).toBe(true);
  });

  it('carries no anticipation item outside any live charter corridor', () => {
    const s = baseState();
    s.stations.push({ id: 'stn', x: OX, y: OY, radius: 3 });
    const address = addressAt(OX + 1, OY);
    const value = currentParcelValueAt(s, address);
    expect(value.items.some((i) => i.name === 'anticipation')).toBe(false);
  });

  it('the anticipation item disappears once its charter lapses', () => {
    const s = baseState();
    charterRoute(s, [{ x: OX, y: OY }, { x: OX + 6, y: OY }]);
    const address = addressAt(OX + 5, OY);
    expect(currentParcelValueAt(s, address).items.some((i) => i.name === 'anticipation')).toBe(true);

    s.timeDays = s.charters[0].expiresDay;
    expireCharters(s);
    expect(currentParcelValueAt(s, address).items.some((i) => i.name === 'anticipation')).toBe(false);
  });
});

describe('landSystem — carrying cost, rent, expiry (milestone 6 U4, KTD3/KTD9)', () => {
  it('an undeveloped, unserved parcel bleeds the documented ground charge per day and earns no rent', () => {
    const s = baseState();
    s.stations.push({ id: 'stn', x: OX, y: OY, radius: 3 }); // rights only, no district growth
    const address = addressAt(OX + 1, OY);
    buyLand(s, address);
    const parcel = s.parcels[0];
    const before = s.moneyCents;

    landSystem(s, 1);

    const expectedCharge = Math.round(LAND_TAX_RATE * parcel.pricePaidCents * 1);
    expect(before - s.moneyCents).toBe(expectedCharge);
    expect(expectedCharge).toBeGreaterThan(0);
  });

  it('a parcel in a well-developed serving district nets positive over enough days', () => {
    const s = baseState();
    s.stations.push({ id: 'stn', x: OX, y: OY, radius: 3 });
    const district = makeDistrict('dst', { id: 'stn', x: OX, y: OY });
    district.development = 1;
    s.districts.push(district);
    const address = addressAt(OX, OY); // right at the anchor — maximal field share
    buyLand(s, address);
    const before = s.moneyCents;

    for (let i = 0; i < 200; i++) landSystem(s, 1);

    expect(s.moneyCents).toBeGreaterThan(before);
  });

  it('a charter past its window flips to lapsed exactly once via the tick pipeline', () => {
    const s = baseState();
    charterRoute(s, [{ x: OX, y: OY }, { x: OX + 4, y: OY }]);
    const charter = s.charters[0];
    s.timeDays = charter.expiresDay;

    landSystem(s, 1);
    expect(s.charters[0].status).toBe('lapsed');

    landSystem(s, 1); // idempotent
    expect(s.charters[0].status).toBe('lapsed');
  });

  it('rent is bounded per parcel even at maximal development and value', () => {
    const s = baseState();
    s.stations.push({ id: 'stn', x: OX, y: OY, radius: 3 });
    const district = makeDistrict('dst', { id: 'stn', x: OX, y: OY });
    district.development = 1;
    s.districts.push(district);
    const address = addressAt(OX, OY);
    buyLand(s, address);
    const before = s.moneyCents;

    landSystem(s, 1);

    const center = parcelCenter(address);
    const value = landValueAt(s, center.x, center.y).totalCents;
    const maxPossibleRent = Math.round(GROUND_RENT_RATE * value * 1 * 1);
    expect(s.moneyCents - before + Math.round(LAND_TAX_RATE * s.parcels[0].pricePaidCents)).toBeLessThanOrEqual(
      maxPossibleRent,
    );
  });

  it('is deterministic: byte-identical money flow across two runs from the same seed and intents', () => {
    const run = () => {
      const s = baseState();
      s.stations.push({ id: 'stn', x: OX, y: OY, radius: 3 });
      const district = makeDistrict('dst', { id: 'stn', x: OX, y: OY });
      district.development = 0.6;
      s.districts.push(district);
      buyLand(s, addressAt(OX, OY));
      buyLand(s, addressAt(OX + 1, OY));
      for (let i = 0; i < 50; i++) landSystem(s, 1);
      return s.moneyCents;
    };
    expect(run()).toBe(run());
  });
});

describe('servingDistrict / parcelIntensity (milestone 6 U7, KTD3/KTD5)', () => {
  it('a parcel in a developing district gains intensity as development rises; a hamlet stays near zero', () => {
    const s = baseState();
    s.stations.push({ id: 'stn', x: OX, y: OY, radius: 3 });
    const district = makeDistrict('dst', { id: 'stn', x: OX, y: OY });
    s.districts.push(district);
    const address = addressAt(OX, OY);
    buyLand(s, address);
    const parcel = s.parcels[0];

    const hamletIntensity = parcelIntensity(s, parcel);
    expect(hamletIntensity).toBeCloseTo(0, 5);

    district.development = 1;
    const developedIntensity = parcelIntensity(s, parcel);
    expect(developedIntensity).toBeGreaterThan(hamletIntensity);
  });

  it('under overlapping catchments, the highest-development covering district serves the parcel', () => {
    const s = baseState();
    s.stations.push({ id: 'lo', x: OX, y: OY, radius: 4 });
    s.stations.push({ id: 'hi', x: OX + 2, y: OY, radius: 4 });
    const loDistrict = makeDistrict('lo-d', { id: 'lo', x: OX, y: OY });
    loDistrict.development = 0.2;
    const hiDistrict = makeDistrict('hi-d', { id: 'hi', x: OX + 2, y: OY });
    hiDistrict.development = 0.9;
    s.districts.push(loDistrict, hiDistrict);

    const served = servingDistrict(s, OX + 1, OY); // covered by both catchments
    expect(served?.id).toBe('hi-d');
  });

  it('a parcel under no covering district has zero intensity', () => {
    const s = baseState();
    const address = addressAt(OX, OY);
    // No station at all — canAcquire would refuse a real buy, so construct the
    // parcel record directly to isolate parcelIntensity's own no-coverage case.
    s.parcels.push({ id: 'p', address, pricePaidCents: 100_00, acquiredDay: 0, valueItemsAtPurchase: [] });
    expect(parcelIntensity(s, s.parcels[0])).toBe(0);
    expect(servingDistrict(s, OX, OY)).toBeUndefined();
  });

  it('intensity is always bounded to [0, 1]', () => {
    const s = baseState();
    s.stations.push({ id: 'stn', x: OX, y: OY, radius: 6 });
    const district = makeDistrict('dst', { id: 'stn', x: OX, y: OY });
    district.development = 1;
    s.districts.push(district);
    for (const [dx, dy] of [[0, 0], [1, 0], [3, 3], [5, 0]]) {
      const address = addressAt(OX + dx, OY + dy);
      const parcel = { id: 'p', address, pricePaidCents: 0, acquiredDay: 0, valueItemsAtPurchase: [] };
      const intensity = parcelIntensity(s, parcel);
      expect(intensity).toBeGreaterThanOrEqual(0);
      expect(intensity).toBeLessThanOrEqual(1);
    }
  });

  it('parcelIntensity never reads scene/rendering layout (purity guard): repeated calls never mutate state', () => {
    const s = baseState();
    s.stations.push({ id: 'stn', x: OX, y: OY, radius: 3 });
    const district = makeDistrict('dst', { id: 'stn', x: OX, y: OY });
    district.development = 0.5;
    s.districts.push(district);
    const address = addressAt(OX, OY);
    buyLand(s, address);
    const before = JSON.stringify(s);
    parcelIntensity(s, s.parcels[0]);
    parcelIntensity(s, s.parcels[0]);
    expect(JSON.stringify(s)).toBe(before);
  });
});
