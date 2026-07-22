import { describe, it, expect } from 'vitest';
import { createGameState, STARTING_CAPITAL, type GameState } from '../../src/sim/state.ts';
import { tick } from '../../src/sim/tick.ts';
import { productionSystem, CITY_SUPPLY_CAP } from '../../src/sim/systems/production.ts';
import { demandSystem } from '../../src/sim/systems/demand.ts';
import { makeCity } from '../../src/sim/model/cities.ts';
import { makeTrain } from '../../src/sim/model/trains.ts';
import { makeDistrict, EPISODE_TARGET, AGE_SPAN_DAYS, DENSITY_PLATEAU } from '../../src/sim/model/districts.ts';

describe('passengers & mail', () => {
  it('cities generate passenger and mail supply from population, up to a cap', () => {
    const s = createGameState(1);
    const city = makeCity('c', 'C', 0, 0, 1);
    s.cities.push(city);
    tick(s, 1, [productionSystem]);
    expect(city.supply.passengers).toBeGreaterThan(0);
    expect(city.supply.mail).toBeGreaterThan(0);
    for (let i = 0; i < 100; i++) tick(s, 1, [productionSystem]);
    expect(city.supply.passengers!).toBeLessThanOrEqual(CITY_SUPPLY_CAP);
  });

  // U3: terrain is no longer a stored array a fixture can fill with a
  // uniform placeholder — it comes from `terrainAt(x, y)` (real, authored
  // geography). Anchor at a coordinate range verified never to be sea (see
  // tests/sim/movement.test.ts's LINE_OX/LINE_OY) rather than the tile
  // origin (open Atlantic).
  const OX = 17;
  const OY = 0;

  /** Two cities on a connected line, a train looping between them. */
  function twoCityLine(): GameState {
    const s = createGameState(1);
    s.moneyCents = STARTING_CAPITAL;
    s.world = { width: OX + 6, height: OY + 1 };
    s.stations.push({ id: 'A', x: OX, y: OY, radius: 1 });
    s.stations.push({ id: 'B', x: OX + 4, y: OY, radius: 1 });
    for (let x = 0; x < 4; x++) s.track.segments.push({ ax: OX + x, ay: OY, bx: OX + x + 1, by: OY });
    s.cities.push(makeCity('cityA', 'Aville', OX, OY, 1));
    s.cities.push(makeCity('cityB', 'Bville', OX + 4, OY, 1));
    s.trains.push(
      makeTrain('t', 'american', [
        { stationId: 'A', loads: ['passengers', 'mail'], unload: true },
        { stationId: 'B', loads: ['passengers', 'mail'], unload: true },
      ]),
    );
    return s;
  }

  it('a train hauls passengers/mail city-to-city and earns fees', () => {
    const s = twoCityLine();
    const before = s.moneyCents;
    for (let i = 0; i < 200; i++) tick(s);
    expect(s.moneyCents).toBeGreaterThan(before); // paid for passenger/mail delivery
    // Delivery drained some of the destination's passenger backlog.
    const totalPax = s.cities.reduce((n, c) => n + (c.fulfillment.passengers ?? 0), 0);
    expect(totalPax).toBeGreaterThan(0);
  });

  it('hauling only passengers/mail does not grow a city (freight still gates growth)', () => {
    const s = twoCityLine(); // no freight industries anywhere
    for (let i = 0; i < 400; i++) tick(s);
    expect(s.cities.every((c) => c.sizeTier === 1)).toBe(true);
  });
});

describe('district health feeds back into passenger/mail traffic (M4 U5, KTD5)', () => {
  function healthyDistrict(id: string, stationId: string, x: number, y: number) {
    const d = makeDistrict(id, { id: stationId, x, y });
    d.residential = 0.4;
    d.commercial = 0.35;
    d.industrial = 0.3;
    d.density = 0.6;
    d.development = 0.5;
    d.episodeCount = EPISODE_TARGET;
    d.firstGrowthDay = 0;
    d.lastGrowthDay = AGE_SPAN_DAYS;
    return d;
  }

  function unhealthyDistrict(id: string, stationId: string, x: number, y: number) {
    const d = makeDistrict(id, { id: stationId, x, y });
    // All built form in one channel (low mixed use), one instantaneous
    // episode (low granularity), zero growth span (low age variety) — but
    // enough development to clear the traffic-multiplier floor.
    d.residential = 0.9;
    d.development = 0.3;
    return d;
  }

  it("covers AE2: a healthy district's city generates measurably more passenger/mail supply and backlog than an equal-tier city under a low-health district, over the same ticks", () => {
    const healthy = createGameState(1);
    const healthyCity = makeCity('c', 'C', 0, 0, 1);
    healthy.cities.push(healthyCity);
    healthy.stations.push({ id: 'stn', x: 0, y: 0, radius: 2 });
    healthy.districts.push(healthyDistrict('dst', 'stn', 0, 0));

    const unhealthy = createGameState(1);
    const unhealthyCity = makeCity('c', 'C', 0, 0, 1);
    unhealthy.cities.push(unhealthyCity);
    unhealthy.stations.push({ id: 'stn', x: 0, y: 0, radius: 2 });
    unhealthy.districts.push(unhealthyDistrict('dst', 'stn', 0, 0));

    // Few enough ticks that neither city's supply/backlog saturates at its
    // cap (CITY_SUPPLY_CAP / MAX_BACKLOG_DAYS) — saturation would erase the
    // very difference this test exists to measure.
    for (let i = 0; i < 5; i++) {
      tick(healthy, 1, [productionSystem, demandSystem]);
      tick(unhealthy, 1, [productionSystem, demandSystem]);
    }

    expect(healthyCity.supply.passengers!).toBeGreaterThan(unhealthyCity.supply.passengers!);
    expect(healthyCity.supply.mail!).toBeGreaterThan(unhealthyCity.supply.mail!);
    expect(healthyCity.backlog.passengers!).toBeGreaterThan(unhealthyCity.backlog.passengers!);
  });

  it('a city with no districted station in range has multiplier-neutral, pre-milestone traffic numbers (regression guard)', () => {
    const withoutDistricts = createGameState(1);
    const cityA = makeCity('c', 'C', 0, 0, 1);
    withoutDistricts.cities.push(cityA);

    const emptyDistrictsList = createGameState(1);
    const cityB = makeCity('c', 'C', 0, 0, 1);
    emptyDistrictsList.cities.push(cityB);
    // withoutDistricts and emptyDistrictsList both carry state.districts = []
    // (createGameState always seeds it empty) — this is the baseline every
    // pre-milestone save now has, asserted equal to itself as a regression
    // guard against any future accidental default multiplier != 1.
    for (let i = 0; i < 30; i++) {
      tick(withoutDistricts, 1, [productionSystem, demandSystem]);
      tick(emptyDistrictsList, 1, [productionSystem, demandSystem]);
    }
    expect(cityA.supply.passengers).toBeCloseTo(cityB.supply.passengers!, 9);
    expect(cityA.backlog.passengers).toBeCloseTo(cityB.backlog.passengers!, 9);
  });
});

describe('station-type traffic skew fires end-to-end through production/demand (milestone 5 fix, AE2 traffic arm)', () => {
  // Neutral jacobsHealth (exactly HEALTH_NEUTRAL) so the health-deviation
  // term in the traffic multiplier contributes zero and only the
  // station-type skew (STATION_TYPE_TRAFFIC_WEIGHTS) can explain any
  // difference in generated traffic — same fixture shape as
  // districts.test.ts's AE2 unit test, but exercised through the real
  // per-tick systems (productionSystem/demandSystem) instead of calling
  // districtTrafficMultiplier directly, since that is where the bug lived:
  // production.ts/demand.ts called the multiplier without `good`, so the
  // skew never reached actual play regardless of what the unit-level
  // multiplier test proved.
  function neutralHealthDistrict(id: string, stationId: string, x: number, y: number) {
    const d = makeDistrict(id, { id: stationId, x, y });
    d.residential = 1 / 3;
    d.commercial = 1 / 3;
    d.industrial = 1 / 3;
    d.density = DENSITY_PLATEAU / 2;
    d.development = 0.5;
    return d;
  }

  it('a passenger-terminal city and a freight-yard city of equal health generate measurably different passenger and mail traffic', () => {
    const freight = createGameState(1);
    const freightCity = makeCity('c', 'C', 0, 0, 1);
    freight.cities.push(freightCity);
    freight.stations.push({ id: 'stn-f', x: 0, y: 0, radius: 2, stationType: 'freight' });
    freight.districts.push(neutralHealthDistrict('dst-f', 'stn-f', 0, 0));

    const passenger = createGameState(1);
    const passengerCity = makeCity('c', 'C', 0, 0, 1);
    passenger.cities.push(passengerCity);
    passenger.stations.push({ id: 'stn-p', x: 0, y: 0, radius: 2, stationType: 'passenger' });
    passenger.districts.push(neutralHealthDistrict('dst-p', 'stn-p', 0, 0));

    // Few enough ticks that neither city's supply/backlog saturates its cap
    // — saturation would erase the very difference this test measures.
    for (let i = 0; i < 5; i++) {
      tick(freight, 1, [productionSystem, demandSystem]);
      tick(passenger, 1, [productionSystem, demandSystem]);
    }

    // freight: passengers *0.7, mail *1.3 — passenger: passengers *1.3, mail *0.7.
    expect(passengerCity.supply.passengers!).toBeGreaterThan(freightCity.supply.passengers!);
    expect(freightCity.supply.mail!).toBeGreaterThan(passengerCity.supply.mail!);
    expect(passengerCity.backlog.passengers!).toBeGreaterThan(freightCity.backlog.passengers!);
    expect(freightCity.backlog.mail!).toBeGreaterThan(passengerCity.backlog.mail!);
  });
});
