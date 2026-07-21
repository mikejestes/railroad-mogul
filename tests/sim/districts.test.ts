import { describe, it, expect } from 'vitest';
import {
  makeDistrict,
  accrueDelivery,
  useMix,
  blockGranularity,
  ageVariety,
  densityScore,
  districtHealth,
  districtTrafficMultiplier,
  districtTrafficWeight,
  GOOD_FORM_WEIGHTS,
  STATION_TYPE_MODIFIERS,
  STATION_TYPE_TRAFFIC_WEIGHTS,
  CHANNEL_CAP,
  EPISODE_TARGET,
  EPISODE_COUNT_CAP,
  AGE_SPAN_DAYS,
  DENSITY_PLATEAU,
  HEALTH_NEUTRAL,
  MULT_MIN,
  MULT_MAX,
  DEVELOPMENT_FLOOR,
  type District,
} from '../../src/sim/model/districts.ts';
import type { StationType } from '../../src/sim/model/track.ts';
import {
  districtSystem,
  developmentTarget,
  NEGLECT_DAYS,
  EPISODE_GAP_DAYS,
  GROWTH_RATE_PER_DAY,
  DECLINE_RATE_PER_DAY,
} from '../../src/sim/systems/districts.ts';
import { createGameState, serialize } from '../../src/sim/state.ts';
import { tick } from '../../src/sim/tick.ts';
import { makeCity } from '../../src/sim/model/cities.ts';
import { generateGame } from '../../src/world/generate.ts';
import { applyIntent } from '../../src/store/applyIntents.ts';
import type { GoodId } from '../../src/sim/model/goods.ts';

// Local factory, per repo test convention.
function station(id = 'stn-0', x = 5, y = 5) {
  return { id, x, y };
}

describe('district model (M4 U1, KTD1)', () => {
  it('makeDistrict creates a zero-development hamlet anchored at the station tile', () => {
    const d = makeDistrict('dst-0', station('stn-0', 3, 4));
    expect(d.stationId).toBe('stn-0');
    expect(d.anchorX).toBe(3);
    expect(d.anchorY).toBe(4);
    expect(d.residential).toBe(0);
    expect(d.commercial).toBe(0);
    expect(d.industrial).toBe(0);
    expect(d.density).toBe(0);
    expect(d.development).toBe(0);
    expect(d.firstGrowthDay).toBeNull();
    expect(d.lastGrowthDay).toBeNull();
    expect(d.episodeCount).toBe(0);
    expect(d.lastDeliveryDay).toBeNull();
  });

  it('every GoodId has a non-zero weight row (KTD2)', () => {
    const goods: GoodId[] = ['coal', 'iron', 'grain', 'cattle', 'steel', 'food', 'goods', 'passengers', 'mail'];
    for (const good of goods) {
      const row = GOOD_FORM_WEIGHTS[good];
      expect(row).toBeDefined();
      const total = (row.residential ?? 0) + (row.commercial ?? 0) + (row.industrial ?? 0) + (row.density ?? 0);
      expect(total).toBeGreaterThan(0);
    }
  });

  describe('accrueDelivery bounds (AE5)', () => {
    it('accruing any good far beyond its cap leaves every channel at or below CHANNEL_CAP', () => {
      const d = makeDistrict('dst-0', station());
      for (let i = 0; i < 10_000; i++) {
        accrueDelivery(d, 'steel', 1_000, i);
      }
      expect(d.residential).toBeLessThanOrEqual(CHANNEL_CAP);
      expect(d.commercial).toBeLessThanOrEqual(CHANNEL_CAP);
      expect(d.industrial).toBeLessThanOrEqual(CHANNEL_CAP);
      expect(d.density).toBeLessThanOrEqual(CHANNEL_CAP);
      expect(d.industrial).toBe(CHANNEL_CAP);
      expect(d.density).toBe(CHANNEL_CAP);
    });

    it('a zero or negative quantity accrues nothing and does not stamp lastDeliveryDay', () => {
      const d = makeDistrict('dst-0', station());
      accrueDelivery(d, 'food', 0, 5);
      accrueDelivery(d, 'food', -3, 5);
      expect(d.residential).toBe(0);
      expect(d.lastDeliveryDay).toBeNull();
    });

    it('stamps lastDeliveryDay to the day of the accepted delivery', () => {
      const d = makeDistrict('dst-0', station());
      accrueDelivery(d, 'food', 5, 42);
      expect(d.lastDeliveryDay).toBe(42);
    });
  });

  describe('AE1 (model level): built form reflects what was delivered', () => {
    it('a district fed steel+goods and a district fed only food produce different dominant channels and density', () => {
      const industrial = makeDistrict('dst-i', station());
      for (let i = 0; i < 30; i++) {
        accrueDelivery(industrial, 'steel', 5, i);
        accrueDelivery(industrial, 'goods', 5, i);
      }

      const residentialOnly = makeDistrict('dst-r', station());
      for (let i = 0; i < 30; i++) {
        accrueDelivery(residentialOnly, 'food', 5, i);
      }

      expect(industrial.industrial).toBeGreaterThan(industrial.residential);
      expect(residentialOnly.residential).toBeGreaterThan(residentialOnly.industrial);
      expect(industrial.density).toBeGreaterThan(residentialOnly.density);
      expect(industrial.residential).toBe(0); // food/cattle/grain never touched
    });
  });

  describe('useMix (KTD4)', () => {
    it('a balanced three-channel district scores higher mixed-use than a single-channel district of equal total', () => {
      const balanced: District = { ...makeDistrict('a', station()), residential: 0.3, commercial: 0.3, industrial: 0.3 };
      const single: District = { ...makeDistrict('b', station()), residential: 0.9, commercial: 0, industrial: 0 };
      expect(useMix(balanced)).toBeGreaterThan(useMix(single));
    });

    it('a district with no built form at all scores zero mixed-use (not the vacuous uniform-shares 1)', () => {
      const empty = makeDistrict('a', station());
      expect(useMix(empty)).toBe(0);
    });

    it('useMix stays in [0, 1]', () => {
      const perfectlyMixed: District = { ...makeDistrict('a', station()), residential: 1, commercial: 1, industrial: 1 };
      expect(useMix(perfectlyMixed)).toBeCloseTo(1, 6);
    });
  });

  describe('blockGranularity (KTD4)', () => {
    it('episodeCount at EPISODE_TARGET yields granularity 1', () => {
      const d: District = { ...makeDistrict('a', station()), episodeCount: EPISODE_TARGET };
      expect(blockGranularity(d)).toBe(1);
    });

    it('a single episode yields the documented minimum (1 / EPISODE_TARGET)', () => {
      const d: District = { ...makeDistrict('a', station()), episodeCount: 1 };
      expect(blockGranularity(d)).toBeCloseTo(1 / EPISODE_TARGET, 9);
    });

    it('never exceeds 1 even at the hard episodeCount cap', () => {
      const d: District = { ...makeDistrict('a', station()), episodeCount: EPISODE_COUNT_CAP };
      expect(blockGranularity(d)).toBe(1);
    });
  });

  describe('ageVariety (KTD4)', () => {
    it('a growth span of zero days yields age variety 0', () => {
      const d: District = { ...makeDistrict('a', station()), firstGrowthDay: 10, lastGrowthDay: 10 };
      expect(ageVariety(d)).toBe(0);
    });

    it('no growth yet (null growth days) yields age variety 0', () => {
      expect(ageVariety(makeDistrict('a', station()))).toBe(0);
    });

    it('a span >= AGE_SPAN_DAYS yields 1', () => {
      const d: District = { ...makeDistrict('a', station()), firstGrowthDay: 0, lastGrowthDay: AGE_SPAN_DAYS };
      expect(ageVariety(d)).toBe(1);
      const beyond: District = { ...makeDistrict('a', station()), firstGrowthDay: 0, lastGrowthDay: AGE_SPAN_DAYS * 2 };
      expect(ageVariety(beyond)).toBe(1);
    });
  });

  describe('densityScore (KTD4)', () => {
    it('is a plateau curve: saturates to 1 at or above DENSITY_PLATEAU, scales below it', () => {
      const low: District = { ...makeDistrict('a', station()), density: DENSITY_PLATEAU / 2 };
      const atPlateau: District = { ...makeDistrict('a', station()), density: DENSITY_PLATEAU };
      const above: District = { ...makeDistrict('a', station()), density: 1 };
      expect(densityScore(low)).toBeCloseTo(0.5, 6);
      expect(densityScore(atPlateau)).toBe(1);
      expect(densityScore(above)).toBe(1);
    });
  });

  describe('districtHealth (KTD4, R6)', () => {
    it('stays in [0, 1] across a randomized sweep of valid records', () => {
      let seed = 12345;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) >>> 0;
        return (seed >>> 8) / 0xffffff;
      };
      for (let i = 0; i < 200; i++) {
        const d: District = {
          ...makeDistrict('a', station()),
          residential: rand(),
          commercial: rand(),
          industrial: rand(),
          density: rand(),
          episodeCount: Math.floor(rand() * EPISODE_COUNT_CAP),
          firstGrowthDay: 0,
          lastGrowthDay: Math.floor(rand() * AGE_SPAN_DAYS * 2),
        };
        const h = districtHealth(d);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(1);
      }
    });

    it('increases monotonically when any single generator input improves, others held fixed', () => {
      const base: District = {
        ...makeDistrict('a', station()),
        residential: 0.2,
        commercial: 0.2,
        industrial: 0.2,
        density: 0.1,
        episodeCount: 2,
        firstGrowthDay: 0,
        lastGrowthDay: 10,
      };
      const baseHealth = districtHealth(base);

      const betterDensity: District = { ...base, density: 0.6 };
      expect(districtHealth(betterDensity)).toBeGreaterThan(baseHealth);

      const betterGranularity: District = { ...base, episodeCount: 10 };
      expect(districtHealth(betterGranularity)).toBeGreaterThan(baseHealth);

      const betterAge: District = { ...base, lastGrowthDay: 400 };
      expect(districtHealth(betterAge)).toBeGreaterThan(baseHealth);

      // Balancing channels toward uniform, from an already-lopsided base, raises useMix.
      const lopsided: District = { ...base, residential: 0.9, commercial: 0.05, industrial: 0.05 };
      const balanced: District = { ...base, residential: 0.3, commercial: 0.3, industrial: 0.3 };
      expect(districtHealth(balanced)).toBeGreaterThan(districtHealth(lopsided));
    });
  });

  describe('R14: JSON round-trip safety', () => {
    it('a grown district round-trips JSON.stringify/parse with no NaN, Infinity, or undefined fields', () => {
      const d = makeDistrict('dst-0', station());
      for (let i = 0; i < 50; i++) accrueDelivery(d, 'steel', 3, i);
      const round = JSON.parse(JSON.stringify(d)) as District;
      expect(round).toEqual(d);
      for (const value of Object.values(round)) {
        expect(Number.isNaN(value as number)).toBe(false);
        expect(value).not.toBe(Infinity);
        expect(value).not.toBe(-Infinity);
        expect(value).not.toBeUndefined();
      }
    });
  });
});

describe('station type shapes the district (milestone 5 U2, R5, KTD4)', () => {
  it("every station type has a modifier row, and 'mixed' is the identity (no entries)", () => {
    const types: StationType[] = ['freight', 'passenger', 'mixed'];
    for (const t of types) expect(STATION_TYPE_MODIFIERS[t]).toBeDefined();
    expect(Object.keys(STATION_TYPE_MODIFIERS.mixed)).toHaveLength(0);
  });

  it("AE2 (model level): identical delivery histories through a freight yard and a passenger terminal yield different dominant channels and densities", () => {
    const freightFed = makeDistrict('dst-f', station());
    const passengerFed = makeDistrict('dst-p', station());
    // Small enough qty/iteration count that neither channel saturates at
    // CHANNEL_CAP — a difference masked by both sides clamping to 1 would
    // prove nothing about the modifier table.
    for (let i = 0; i < 10; i++) {
      accrueDelivery(freightFed, 'steel', 2, i, 'freight');
      accrueDelivery(freightFed, 'goods', 2, i, 'freight');
      accrueDelivery(passengerFed, 'steel', 2, i, 'passenger');
      accrueDelivery(passengerFed, 'goods', 2, i, 'passenger');
    }
    expect(freightFed.industrial).toBeLessThan(CHANNEL_CAP);
    expect(passengerFed.commercial).toBeLessThan(CHANNEL_CAP);
    // Freight amplifies industrial/density and damps commercial relative to passenger.
    expect(freightFed.industrial).toBeGreaterThan(passengerFed.industrial);
    expect(freightFed.density).toBeGreaterThan(passengerFed.density);
    expect(passengerFed.commercial).toBeGreaterThan(freightFed.commercial);
  });

  it('mixed-depot accrual is byte-identical to calling accrueDelivery with no stationType at all (regression guard)', () => {
    const withDefault = makeDistrict('dst-x', station());
    const withMixed = makeDistrict('dst-x', station());
    for (let i = 0; i < 20; i++) {
      accrueDelivery(withDefault, 'steel', 4, i);
      accrueDelivery(withMixed, 'steel', 4, i, 'mixed');
    }
    expect(withMixed).toEqual(withDefault);
  });

  it('a zero or negative quantity accrues nothing regardless of station type', () => {
    const d = makeDistrict('dst-0', station());
    accrueDelivery(d, 'food', 0, 5, 'freight');
    accrueDelivery(d, 'food', -3, 5, 'passenger');
    expect(d.residential).toBe(0);
    expect(d.lastDeliveryDay).toBeNull();
  });
});

describe('station type traffic mix (milestone 5 U2, R5, KTD4)', () => {
  it("every station type has a traffic weight row, and 'mixed' is neutral (1, 1)", () => {
    expect(STATION_TYPE_TRAFFIC_WEIGHTS.mixed).toEqual({ passengers: 1, mail: 1 });
  });

  it('districtTrafficWeight reads the neutral default for an untyped (pre-M5-fixture) station', () => {
    const untyped = { id: 's', x: 0, y: 0, radius: 1 };
    expect(districtTrafficWeight(untyped, 'passengers')).toBe(1);
    expect(districtTrafficWeight(untyped, 'mail')).toBe(1);
  });

  function districtServing(id: string, stationId: string, x: number, y: number): District {
    const d = makeDistrict(id, { id: stationId, x, y });
    // Tie jacobsHealth to exactly HEALTH_NEUTRAL so the health-deviation term
    // contributes zero and only the type skew can explain any difference.
    d.residential = 1 / 3;
    d.commercial = 1 / 3;
    d.industrial = 1 / 3;
    d.density = DENSITY_PLATEAU / 2;
    d.development = 0.5;
    return d;
  }

  it('AE2 (traffic level): a freight-anchored and a passenger-anchored district contribute measurably different passenger/mail generation at equal (neutral) health', () => {
    const s = createGameState(1);
    const city = makeCity('c', 'C', 0, 0, 1);
    s.cities.push(city);
    s.stations.push({ id: 'stn-f', x: 0, y: 0, radius: 2, stationType: 'freight' });
    s.stations.push({ id: 'stn-p', x: 5, y: 5, radius: 2, stationType: 'passenger' });

    const freightDistrict = districtServing('dst-f', 'stn-f', 0, 0);
    const passengerDistrict = districtServing('dst-p', 'stn-p', 5, 5);
    expect(districtHealth(freightDistrict)).toBeCloseTo(districtHealth(passengerDistrict), 9); // equal health

    const cityAtFreight = makeCity('cf', 'CF', 0, 0, 1);
    const cityAtPassenger = makeCity('cp', 'CP', 5, 5, 1);
    const freightOnly = createGameState(1);
    freightOnly.stations.push({ id: 'stn-f', x: 0, y: 0, radius: 2, stationType: 'freight' });
    freightOnly.districts.push(freightDistrict);
    const passengerOnly = createGameState(1);
    passengerOnly.stations.push({ id: 'stn-p', x: 5, y: 5, radius: 2, stationType: 'passenger' });
    passengerOnly.districts.push(passengerDistrict);

    const freightPassengers = districtTrafficMultiplier(freightOnly, cityAtFreight, 'passengers');
    const passengerPassengers = districtTrafficMultiplier(passengerOnly, cityAtPassenger, 'passengers');
    const freightMail = districtTrafficMultiplier(freightOnly, cityAtFreight, 'mail');
    const passengerMail = districtTrafficMultiplier(passengerOnly, cityAtPassenger, 'mail');

    expect(passengerPassengers).toBeGreaterThan(freightPassengers);
    expect(freightMail).toBeGreaterThan(passengerMail);
  });

  it("omitting `good` (every pre-M5 call site) is byte-identical to milestone 4's formula, and a mixed-anchored district's weighted call equals its unweighted call", () => {
    const s = createGameState(1);
    const city = makeCity('c', 'C', 0, 0, 1);
    s.cities.push(city);
    s.stations.push({ id: 'stn', x: 0, y: 0, radius: 2, stationType: 'mixed' });
    s.districts.push(districtServing('dst', 'stn', 0, 0));

    const unweighted = districtTrafficMultiplier(s, city);
    expect(districtTrafficMultiplier(s, city, 'passengers')).toBe(unweighted);
    expect(districtTrafficMultiplier(s, city, 'mail')).toBe(unweighted);
  });
});

describe('districtTrafficMultiplier (M4 U5, KTD5)', () => {
  function healthyDistrict(id: string, stationId: string, x: number, y: number): District {
    const d = makeDistrict(id, { id: stationId, x, y });
    // Feed it into a genuinely healthy state: mixed use, several episodes,
    // a long growth span, and plateau density.
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

  it('a city with no districted station in range has multiplier exactly 1', () => {
    const s = createGameState(1);
    const city = makeCity('c', 'C', 0, 0, 1);
    s.cities.push(city);
    expect(districtTrafficMultiplier(s, city)).toBe(1);
  });

  it("a city whose only district is a fresh zero-development hamlet also has multiplier exactly 1 (KTD5's floor)", () => {
    const s = createGameState(1);
    const city = makeCity('c', 'C', 0, 0, 1);
    s.cities.push(city);
    s.stations.push({ id: 'stn', x: 0, y: 0, radius: 2 });
    s.districts.push(makeDistrict('dst', { id: 'stn', x: 0, y: 0 }));
    expect(s.districts[0].development).toBeLessThan(DEVELOPMENT_FLOOR);
    expect(districtTrafficMultiplier(s, city)).toBe(1);
  });

  it('covers AE2: a healthy district raises the multiplier above 1', () => {
    const s = createGameState(1);
    const city = makeCity('c', 'C', 0, 0, 1);
    s.cities.push(city);
    s.stations.push({ id: 'stn', x: 0, y: 0, radius: 2 });
    s.districts.push(healthyDistrict('dst', 'stn', 0, 0));
    expect(districtHealth(s.districts[0])).toBeGreaterThan(HEALTH_NEUTRAL);
    expect(districtTrafficMultiplier(s, city)).toBeGreaterThan(1);
  });

  it('the multiplier is clamped at both documented bounds under extreme health values', () => {
    const s = createGameState(1);
    const city = makeCity('c', 'C', 0, 0, 1);
    s.cities.push(city);
    s.stations.push({ id: 'stn', x: 0, y: 0, radius: 2 });
    const extreme = healthyDistrict('dst', 'stn', 0, 0);
    s.districts.push(extreme);
    expect(districtTrafficMultiplier(s, city)).toBeLessThanOrEqual(MULT_MAX);
    expect(districtTrafficMultiplier(s, city)).toBeGreaterThanOrEqual(MULT_MIN);
  });
});

describe('district dynamics system (M4 U4, KTD6)', () => {
  function freshDistrictState(): { s: ReturnType<typeof createGameState>; d: District } {
    const s = createGameState(1);
    const d = makeDistrict('dst-0', { id: 'stn', x: 0, y: 0 });
    s.districts.push(d);
    return { s, d };
  }

  it('AE3: a developed district holds steady while not neglected, then declines after NEGLECT_DAYS', () => {
    const { s, d } = freshDistrictState();

    // Feed daily until development plateaus at its channel-supported target.
    for (let i = 0; i < 200; i++) {
      accrueDelivery(d, 'food', 5, s.timeDays);
      tick(s, 1, [districtSystem]);
    }
    const target = developmentTarget(d);
    expect(d.development).toBeCloseTo(target, 2);
    const developedLevel = d.development;

    // Not neglected yet: holds steady for NEGLECT_DAYS - 1 more ticks.
    for (let i = 0; i < NEGLECT_DAYS - 1; i++) {
      tick(s, 1, [districtSystem]);
      expect(d.development).toBeCloseTo(developedLevel, 6);
    }

    // Crossing NEGLECT_DAYS since the last accepted delivery: decline begins.
    tick(s, 1, [districtSystem]);
    expect(d.development).toBeLessThan(developedLevel);

    const afterOneDeclineTick = d.development;
    tick(s, 1, [districtSystem]);
    expect(d.development).toBeLessThan(afterOneDeclineTick); // continues tick over tick
  });

  it('decline per day is measurably slower than growth per day at the same development level (KTD6 asymmetry)', () => {
    expect(DECLINE_RATE_PER_DAY).toBeLessThan(GROWTH_RATE_PER_DAY);

    const growingState = createGameState(1);
    const growing: District = {
      ...makeDistrict('a', { id: 'stn', x: 0, y: 0 }),
      residential: 1,
      commercial: 1,
      industrial: 1,
      development: 0.5,
      lastDeliveryDay: 0,
    };
    growingState.districts.push(growing);
    tick(growingState, 1, [districtSystem]);
    const growthDelta = growing.development - 0.5;
    expect(growthDelta).toBeGreaterThan(0);

    const decliningState = createGameState(1);
    const declining: District = {
      ...makeDistrict('b', { id: 'stn', x: 0, y: 0 }),
      residential: 1,
      commercial: 1,
      industrial: 1,
      development: 0.5,
      lastDeliveryDay: null, // never delivered -> immediately neglected
    };
    decliningState.districts.push(declining);
    tick(decliningState, 1, [districtSystem]);
    const declineDelta = 0.5 - declining.development;
    expect(declineDelta).toBeGreaterThan(0);

    expect(declineDelta).toBeLessThan(growthDelta);
  });

  it('AE5: a district fed maximally for a simulated decade keeps every field at or below its cap, including episodeCount', () => {
    const { s, d } = freshDistrictState();
    const DECADE_DAYS = 3650;
    for (let i = 0; i < DECADE_DAYS; i++) {
      accrueDelivery(d, 'steel', 1000, s.timeDays);
      accrueDelivery(d, 'goods', 1000, s.timeDays);
      accrueDelivery(d, 'food', 1000, s.timeDays);
      tick(s, 1, [districtSystem]);
    }
    expect(d.residential).toBeLessThanOrEqual(CHANNEL_CAP);
    expect(d.commercial).toBeLessThanOrEqual(CHANNEL_CAP);
    expect(d.industrial).toBeLessThanOrEqual(CHANNEL_CAP);
    expect(d.density).toBeLessThanOrEqual(CHANNEL_CAP);
    expect(d.development).toBeLessThanOrEqual(1);
    expect(d.episodeCount).toBeLessThanOrEqual(EPISODE_COUNT_CAP);
  });

  it('two feeding episodes separated by more than EPISODE_GAP_DAYS increment episodeCount; continuous feeding counts one', () => {
    const { s, d } = freshDistrictState();

    // First episode: a small feed, then let development chase and reach its
    // (low) target over a few ticks — continuous growth activity, one episode.
    accrueDelivery(d, 'food', 2, s.timeDays);
    for (let i = 0; i < 10; i++) tick(s, 1, [districtSystem]);
    expect(d.episodeCount).toBe(1);
    const targetAfterFirstFeed = developmentTarget(d);
    expect(d.development).toBeCloseTo(targetAfterFirstFeed, 6); // growth caught up and stopped

    // Idle well past EPISODE_GAP_DAYS since the last growth tick, but short of
    // NEGLECT_DAYS since the last delivery, so nothing grows or decays.
    expect(EPISODE_GAP_DAYS).toBeLessThan(NEGLECT_DAYS);
    const idleTicks = EPISODE_GAP_DAYS + 5;
    expect(idleTicks).toBeLessThan(NEGLECT_DAYS);
    for (let i = 0; i < idleTicks; i++) tick(s, 1, [districtSystem]);
    expect(d.episodeCount).toBe(1); // no growth activity happened while idle

    // Second feed, well after the growth gap: a new episode.
    accrueDelivery(d, 'food', 10, s.timeDays);
    tick(s, 1, [districtSystem]);
    expect(d.episodeCount).toBe(2);
  });

  it('a never-fed district stays a zero-development hamlet indefinitely (no drift)', () => {
    const { s, d } = freshDistrictState();
    for (let i = 0; i < 1000; i++) tick(s, 1, [districtSystem]);
    expect(d.development).toBe(0);
    expect(d.residential).toBe(0);
    expect(d.commercial).toBe(0);
    expect(d.industrial).toBe(0);
    expect(d.density).toBe(0);
    expect(d.episodeCount).toBe(0);
    expect(d.firstGrowthDay).toBeNull();
  });

  it('determinism: same seed and intent log through many ticks produces byte-identical district state', () => {
    const run = () => {
      const s = generateGame(3);
      s.moneyCents = 1_000_000_00;
      applyIntent(s, { kind: 'buildStation', x: 17, y: 0, radius: 2 });
      for (let i = 0; i < 100; i++) tick(s);
      return s;
    };
    expect(serialize(run())).toBe(serialize(run()));
  });
});
