import type { GameState } from './state.ts';
import { segmentWeight } from './model/track.ts';

/**
 * Shortest weighted path over the player-built track graph (U6). Trains travel
 * station-to-station along track; when more than one route connects two tiles,
 * movement takes the cheaper (terrain-weighted) one. Returns the tile sequence
 * from start to goal inclusive, or null when they are not connected by track.
 */
export interface Tile {
  x: number;
  y: number;
}

const key = (x: number, y: number) => `${x},${y}`;

interface Edge {
  to: string;
  x: number;
  y: number;
  weight: number;
}

function buildAdjacency(state: GameState): Map<string, Edge[]> {
  const adj = new Map<string, Edge[]>();
  const link = (ax: number, ay: number, bx: number, by: number, weight: number) => {
    const k = key(ax, ay);
    if (!adj.has(k)) adj.set(k, []);
    adj.get(k)!.push({ to: key(bx, by), x: bx, y: by, weight });
  };
  for (const seg of state.track.segments) {
    const w = segmentWeight(state.world, seg);
    link(seg.ax, seg.ay, seg.bx, seg.by, w);
    link(seg.bx, seg.by, seg.ax, seg.ay, w);
  }
  return adj;
}

/** Dijkstra shortest path from (sx,sy) to (gx,gy) over track. */
export function findPath(state: GameState, sx: number, sy: number, gx: number, gy: number): Tile[] | null {
  const adj = buildAdjacency(state);
  const start = key(sx, sy);
  const goal = key(gx, gy);
  if (start === goal) return [{ x: sx, y: sy }];
  if (!adj.has(start)) return null;

  const dist = new Map<string, number>([[start, 0]]);
  const prev = new Map<string, Tile>();
  const visited = new Set<string>();
  // Simple array-based priority selection — track graphs here are small.
  const frontier: Array<{ k: string; x: number; y: number; d: number }> = [{ k: start, x: sx, y: sy, d: 0 }];

  while (frontier.length > 0) {
    let bi = 0;
    for (let i = 1; i < frontier.length; i++) if (frontier[i].d < frontier[bi].d) bi = i;
    const cur = frontier.splice(bi, 1)[0];
    if (visited.has(cur.k)) continue;
    visited.add(cur.k);
    if (cur.k === goal) break;

    for (const edge of adj.get(cur.k) ?? []) {
      if (visited.has(edge.to)) continue;
      const nd = cur.d + edge.weight;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, { x: cur.x, y: cur.y });
        frontier.push({ k: edge.to, x: edge.x, y: edge.y, d: nd });
      }
    }
  }

  if (!dist.has(goal)) return null;

  // Reconstruct.
  const path: Tile[] = [{ x: gx, y: gy }];
  let ck = goal;
  let cxy: Tile = { x: gx, y: gy };
  while (ck !== start) {
    const p = prev.get(ck);
    if (!p) return null;
    path.push(p);
    cxy = p;
    ck = key(cxy.x, cxy.y);
  }
  path.reverse();
  return path;
}

/** Total weighted length of a resolved path. */
export function pathLength(state: GameState, path: Tile[]): number {
  let total = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    total += segmentWeight(state.world, {
      ax: path[i].x,
      ay: path[i].y,
      bx: path[i + 1].x,
      by: path[i + 1].y,
    });
  }
  return total;
}
