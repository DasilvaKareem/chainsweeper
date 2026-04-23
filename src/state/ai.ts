// AI move selection. Pure function: (state) -> action. Mirrors the shape of a
// human click so MatchScene routes both through the same reducer calls.

import {
  idx,
  inBounds,
  isForcedCore,
  isForcedSafe,
  type GameState,
} from './gameState';

export type AiAction =
  | { kind: 'reveal'; x: number; y: number }
  | { kind: 'mark'; x: number; y: number }
  | { kind: 'skip' };

const NEIGHBORS: Array<[number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

function hiddenTiles(state: GameState): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      const c = state.board[idx(x, y, state.width)];
      if (c.state === 'hidden') out.push([x, y]);
    }
  }
  return out;
}

function anyRevealed(state: GameState): boolean {
  for (const c of state.board) if (c.state === 'revealed' && !c.isCore) return true;
  return false;
}

// Estimate p(tile is a Core) from each revealed-numbered neighbor independently,
// then average. Tiles with no revealed numbered neighbor get the global density.
function coreProbability(state: GameState, x: number, y: number): number {
  const w = state.width;
  const h = state.height;
  const probs: number[] = [];

  for (const [dx, dy] of NEIGHBORS) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(nx, ny, w, h)) continue;
    const n = state.board[idx(nx, ny, w)];
    if (n.state !== 'revealed' || n.isCore || n.adjacent === 0) continue;

    let marked = 0;
    let hidden = 0;
    for (const [ddx, ddy] of NEIGHBORS) {
      const mx = nx + ddx;
      const my = ny + ddy;
      if (!inBounds(mx, my, w, h)) continue;
      const m = state.board[idx(mx, my, w)];
      if (m.state === 'marked') marked++;
      else if (m.state === 'hidden') hidden++;
    }
    const remainingCores = n.adjacent - marked;
    if (hidden > 0 && remainingCores >= 0) {
      probs.push(remainingCores / hidden);
    }
  }

  if (probs.length === 0) {
    // Fall back to global unknown density.
    let hiddenCount = 0;
    let markedCount = 0;
    for (const c of state.board) {
      if (c.state === 'hidden') hiddenCount++;
      else if (c.state === 'marked') markedCount++;
    }
    const coresUnmarked = state.coreCount - markedCount;
    return hiddenCount > 0 ? Math.max(0, coresUnmarked / hiddenCount) : 0.5;
  }
  // Max probability from any single constraint is the most pessimistic.
  return Math.max(...probs);
}

function pickRandom<T>(arr: T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)];
}

// Seeded PRNG so AI moves are deterministic for a given state+player+turn.
// Useful for replay + chain-friendly behavior later.
function rngForTurn(state: GameState): () => number {
  let a = (state.seed ^ (state.turnCount * 0x9e3779b1) ^ state.currentPlayer) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface AiOptions {
  // False when the caller has already observed enough marks from this AI
  // this turn (MatchScene caps at 2). Skips step 2 below so the AI falls
  // through to a reveal and actually ends its turn.
  allowMark?: boolean;
}

export function aiMove(
  state: GameState,
  difficulty: 'random' | 'smart',
  opts: AiOptions = {},
): AiAction {
  const hidden = hiddenTiles(state);
  if (hidden.length === 0) return { kind: 'skip' };
  const rand = rngForTurn(state);
  const allowMark = opts.allowMark ?? true;

  // First move: no revealed numbered cells to reason about. Pick center-ish.
  if (!anyRevealed(state)) {
    const cx = Math.floor(state.width / 2);
    const cy = Math.floor(state.height / 2);
    return { kind: 'reveal', x: cx, y: cy };
  }

  if (difficulty === 'smart') {
    // 1) Prefer any forced-safe tile (free +1 + flood).
    const safes = hidden.filter(([x, y]) => isForcedSafe(state, x, y));
    if (safes.length > 0) {
      const [x, y] = pickRandom(safes, rand);
      return { kind: 'reveal', x, y };
    }
    // 2) Quarantine-mark a forced-Core tile (+2 settled at end). Skipped
    //    once the per-turn mark cap is hit so we don't stall on big boards
    //    with many forced cores.
    if (allowMark) {
      const cores = hidden.filter(([x, y]) => isForcedCore(state, x, y));
      if (cores.length > 0) {
        const [x, y] = pickRandom(cores, rand);
        return { kind: 'mark', x, y };
      }
    }
    // 3) Guess the lowest-probability tile.
    let best: [number, number] = hidden[0];
    let bestP = Infinity;
    for (const [x, y] of hidden) {
      const p = coreProbability(state, x, y);
      if (p < bestP) { bestP = p; best = [x, y]; }
    }
    return { kind: 'reveal', x: best[0], y: best[1] };
  }

  // Random AI: bias toward tiles adjacent to revealed numbers (looks less dumb),
  // and avoid clearly-forced Cores.
  const safeish = hidden.filter(([x, y]) => {
    if (isForcedCore(state, x, y)) return false;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny, state.width, state.height)) continue;
      const n = state.board[idx(nx, ny, state.width)];
      if (n.state === 'revealed' && !n.isCore) return true;
    }
    return false;
  });
  const pool = safeish.length > 0 ? safeish : hidden;
  const [x, y] = pickRandom(pool, rand);
  return { kind: 'reveal', x, y };
}
