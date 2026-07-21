import type { GameState, World } from '../state.ts';
import { moveCostFor, terrainAt } from '../../world/geography.ts';
import { addMoney } from '../state.ts';

/**
 * Track & stations (U5). Track segments connect adjacent tiles and form the
 * graph that trains pathfind over (U6). Stations have a catchment radius;
 * industries and city tiles within radius supply and demand through the
 * station — the original's proven catchment economics, mouse-driven (R14).
 *
 * U3 change: terrain lookups used to index a stored `World.terrain` array;
 * that array is gone (R9 — terrain is never stored), so every lookup here
 * calls `terrainAt(x, y)` directly instead (KTD1). `World` is kept as the
 * parameter type on `segmentWeight` purely for bounds context and call-site
 * stability elsewhere in the codebase, even though this module no longer
 * reads terrain data off it.
 */
export interface TrackSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface Station {
  id: string;
  x: number;
  y: number;
  /** Chebyshev catchment radius (Depot 1 / Station 2 / Terminal 3). */
  radius: number;
}

export interface TrackNetwork {
  segments: TrackSegment[];
}

export const TRACK_COST_PER_SEGMENT = 50_00; // cents
export const MOUNTAIN_SURCHARGE = 100_00;
export const STATION_COST = [50_00, 100_00, 200_00]; // by radius-1 index

function inBounds(world: World, x: number, y: number): boolean {
  return x >= 0 && x < world.width && y >= 0 && y < world.height;
}

/** Whether a track segment between two tiles is legal (adjacent, on buildable land). */
export function canLayTrack(state: GameState, ax: number, ay: number, bx: number, by: number): boolean {
  const w = state.world;
  if (!inBounds(w, ax, ay) || !inBounds(w, bx, by)) return false;
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  if (dx === 0 && dy === 0) return false;
  if (dx > 1 || dy > 1) return false; // must be adjacent (incl. diagonal)
  if (terrainAt(ax, ay) === 'sea' || terrainAt(bx, by) === 'sea') return false;
  return true;
}

function segmentCost(seg: TrackSegment): number {
  const a = terrainAt(seg.ax, seg.ay);
  const b = terrainAt(seg.bx, seg.by);
  let cost = TRACK_COST_PER_SEGMENT;
  if (a === 'mountain' || b === 'mountain') cost += MOUNTAIN_SURCHARGE;
  return cost;
}

/** Lay a track segment if legal and affordable; returns success. */
export function layTrack(state: GameState, ax: number, ay: number, bx: number, by: number): boolean {
  if (!canLayTrack(state, ax, ay, bx, by)) return false;
  const seg: TrackSegment = { ax, ay, bx, by };
  const cost = segmentCost(seg);
  if (state.moneyCents < cost) return false;
  state.track.segments.push(seg);
  addMoney(state, -cost);
  return true;
}

/** Build a station if the tile is buildable and affordable; returns success. */
export function buildStation(state: GameState, id: string, x: number, y: number, radius: number): boolean {
  const w = state.world;
  if (!inBounds(w, x, y) || terrainAt(x, y) === 'sea') return false;
  const cost = STATION_COST[Math.min(STATION_COST.length - 1, Math.max(0, radius - 1))];
  if (state.moneyCents < cost) return false;
  state.stations.push({ id, x, y, radius });
  addMoney(state, -cost);
  return true;
}

/** Is a tile within a station's Chebyshev catchment radius? */
export function inCatchment(station: Station, x: number, y: number): boolean {
  return Math.max(Math.abs(station.x - x), Math.abs(station.y - y)) <= station.radius;
}

export function industriesInCatchment(state: GameState, station: Station) {
  return state.industries.filter((i) => inCatchment(station, i.x, i.y));
}

export function citiesInCatchment(state: GameState, station: Station) {
  return state.cities.filter((c) => inCatchment(station, c.x, c.y));
}

/** Total move-cost weight of a segment, for train routing (U6). `_world` is
 *  kept as a parameter (unused) only so call sites elsewhere in the codebase
 *  that pass `state.world` need no change — terrain is looked up globally by
 *  coordinate now, not off the `World` object (see module docblock). */
export function segmentWeight(_world: World, seg: TrackSegment): number {
  const a = moveCostFor(terrainAt(seg.ax, seg.ay));
  const b = moveCostFor(terrainAt(seg.bx, seg.by));
  const dist = Math.hypot(seg.ax - seg.bx, seg.ay - seg.by);
  return ((a + b) / 2) * dist;
}
