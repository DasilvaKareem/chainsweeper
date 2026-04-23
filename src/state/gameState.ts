// Pure game state + reducer. No Phaser deps. This shape is the blueprint
// for the on-chain Solidity contract — keep side-effect free and deterministic.

export type CellState = 'hidden' | 'revealed' | 'marked';

export interface Cell {
  state: CellState;
  isCore: boolean;
  adjacent: number;
  revealedBy: number | null;
  markedBy: number | null;
}

export type MatchStatus = 'playing' | 'ended';

export interface Rules {
  gentleman: boolean;
  soreLoser: boolean;
  soreLoserLead: number;
  limitedBomb: boolean;
  limitedBombThreshold: number;
}

export const DEFAULT_RULES: Rules = {
  gentleman: false,
  soreLoser: false,
  soreLoserLead: 3,
  limitedBomb: false,
  limitedBombThreshold: 5,
};

export interface GameState {
  width: number;
  height: number;
  coreCount: number;
  board: Cell[];
  players: number;
  currentPlayer: number;
  scores: number[];
  // Lives per player. Each Corruption Core hit decrements the hitter's health
  // by 1. A player at 0 HP is eliminated and skipped in turn order.
  health: number[];
  // Per-player HP ceiling — the value `health[i]` was initialized to. Used
  // by the HUD when rendering hearts so each player's bar scales against
  // their own starting lives (champions may start with more than the human).
  startingHealth: number[];
  // Max across startingHealth. Preserved for existing `maxHealth > 0` gates
  // that treat 0 as "health system disabled" and for callers that want a
  // global ceiling without walking the array.
  maxHealth: number;
  eliminated: boolean[];
  // Per-player Quarantine Marker stats (cumulative; removals don't decrement).
  // markersCorrect[p] / markersPlaced[p] = decision accuracy on Marker calls.
  markersPlaced: number[];
  markersCorrect: number[];
  // Speed combo counter per player. Builds on fast reveals (<2s), resets on
  // core hits, rule violations, slow reveals (>5s), and timeouts. Applied as
  // a score multiplier inside `reveal()`.
  combos: number[];
  status: MatchStatus;
  winner: number | null;
  seed: number;
  turnCount: number;
  rules: Rules;
  turnSeconds: number;
}

export type PlayerType =
  | { kind: 'human' }
  | { kind: 'ai'; difficulty: 'random' | 'smart' };

export interface MatchConfig {
  width: number;
  height: number;
  coreCount: number;
  players: number;
  seed: number;
  rules?: Rules;
  turnSeconds?: number;
  // Length must equal `players`. Defaults to all human if omitted.
  playerTypes?: PlayerType[];
  // Starting hearts per player. Defaults to 3. 0 disables the system.
  maxHealth?: number;
  // Per-player starting-health override. When present, each slot uses its
  // own value instead of the uniform `maxHealth` fill — so arcade champions
  // can start with more lives than the human seat. Length must equal
  // `players` when provided. Falls back to `maxHealth` otherwise.
  startingHealth?: number[];
}

export const DEFAULT_MAX_HEALTH = 3;

// Speed-combo constants. A reveal's elapsed time from turn start drops it
// into one of three buckets; the bucket updates the combo counter, which
// then scales the points awarded from that same reveal.
export const COMBO_FAST_MS = 2000;       // snap decision: +1 combo
export const COMBO_NORMAL_MS = 5000;     // normal thought: combo holds
// Anything slower resets combo to 0.
export const COMBO_BONUS_PER_STACK = 0.2; // +20% per combo stack
export const COMBO_CAP = 10;              // stacks 11+ clamp to this (max 3× mult)

export type SpeedBucket = 'fast' | 'normal' | 'slow';

export function speedBucket(elapsedMs: number): SpeedBucket {
  if (elapsedMs < COMBO_FAST_MS) return 'fast';
  if (elapsedMs < COMBO_NORMAL_MS) return 'normal';
  return 'slow';
}

export function comboMultiplier(combo: number): number {
  return 1 + COMBO_BONUS_PER_STACK * Math.min(combo, COMBO_CAP);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function idx(x: number, y: number, width: number): number {
  return y * width + x;
}

export function inBounds(x: number, y: number, w: number, h: number): boolean {
  return x >= 0 && x < w && y >= 0 && y < h;
}

const NEIGHBORS: Array<[number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

function neighborIndices(x: number, y: number, w: number, h: number): number[] {
  const out: number[] = [];
  for (const [dx, dy] of NEIGHBORS) {
    const nx = x + dx;
    const ny = y + dy;
    if (inBounds(nx, ny, w, h)) out.push(idx(nx, ny, w));
  }
  return out;
}

export function createMatch(config: MatchConfig): GameState {
  const { width, height, coreCount, players, seed } = config;
  const size = width * height;
  if (coreCount >= size) throw new Error('Too many Corruption Cores for board');

  const rand = mulberry32(seed);

  const positions = Array.from({ length: size }, (_, i) => i);
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  const coreSites = new Set(positions.slice(0, coreCount));

  const board: Cell[] = new Array(size);
  for (let i = 0; i < size; i++) {
    board[i] = {
      state: 'hidden',
      isCore: coreSites.has(i),
      adjacent: 0,
      revealedBy: null,
      markedBy: null,
    };
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y, width);
      if (board[i].isCore) continue;
      let count = 0;
      for (const [dx, dy] of NEIGHBORS) {
        const nx = x + dx;
        const ny = y + dy;
        if (inBounds(nx, ny, width, height) && board[idx(nx, ny, width)].isCore) count++;
      }
      board[i].adjacent = count;
    }
  }

  const uniformMax = config.maxHealth ?? DEFAULT_MAX_HEALTH;
  // Resolve per-player starting health. If the caller provided an override
  // array, use it verbatim (clamped to the right length). Otherwise every
  // slot starts at `uniformMax`. `maxHealth` becomes the max across slots
  // so existing UI code that uses it as a ceiling still works.
  const startingHealth =
    config.startingHealth && config.startingHealth.length === players
      ? [...config.startingHealth]
      : new Array(players).fill(uniformMax);
  const maxHealth = startingHealth.reduce((m, v) => Math.max(m, v), 0);
  return {
    width,
    height,
    coreCount,
    board,
    players,
    currentPlayer: 0,
    scores: new Array(players).fill(0),
    health: [...startingHealth],
    startingHealth,
    maxHealth,
    eliminated: new Array(players).fill(false),
    markersPlaced: new Array(players).fill(0),
    markersCorrect: new Array(players).fill(0),
    combos: new Array(players).fill(0),
    status: 'playing',
    winner: null,
    seed,
    turnCount: 0,
    rules: config.rules ?? DEFAULT_RULES,
    turnSeconds: config.turnSeconds ?? 0,
  };
}

// -------- Deduction helpers (used by Gentleman / Sore Loser rules) --------

// A hidden tile is forced-Core if some revealed-numbered neighbor has
// (marked neighbors) + (hidden neighbors) == its number, and its number > marked count.
// Treats marked cells as assumed Cores. Purely single-constraint deduction.
export function isForcedCore(state: GameState, x: number, y: number): boolean {
  const w = state.width;
  const h = state.height;
  if (!inBounds(x, y, w, h)) return false;
  const tIdx = idx(x, y, w);
  if (state.board[tIdx].state !== 'hidden') return false;

  for (const nIdx of neighborIndices(x, y, w, h)) {
    const n = state.board[nIdx];
    if (n.state !== 'revealed' || n.isCore || n.adjacent === 0) continue;

    const nx = nIdx % w;
    const ny = Math.floor(nIdx / w);
    let marked = 0;
    let hidden = 0;
    for (const mIdx of neighborIndices(nx, ny, w, h)) {
      const m = state.board[mIdx];
      if (m.state === 'marked') marked++;
      else if (m.state === 'hidden') hidden++;
    }
    if (marked < n.adjacent && marked + hidden === n.adjacent) return true;
  }
  return false;
}

// A hidden tile is forced-safe if some revealed-numbered neighbor already has
// marked neighbors == its number (so all remaining hidden neighbors are safe).
export function isForcedSafe(state: GameState, x: number, y: number): boolean {
  const w = state.width;
  const h = state.height;
  if (!inBounds(x, y, w, h)) return false;
  const tIdx = idx(x, y, w);
  if (state.board[tIdx].state !== 'hidden') return false;

  for (const nIdx of neighborIndices(x, y, w, h)) {
    const n = state.board[nIdx];
    if (n.state !== 'revealed' || n.isCore || n.adjacent === 0) continue;

    const nx = nIdx % w;
    const ny = Math.floor(nIdx / w);
    let marked = 0;
    for (const mIdx of neighborIndices(nx, ny, w, h)) {
      if (state.board[mIdx].state === 'marked') marked++;
    }
    if (marked === n.adjacent) return true;
  }
  return false;
}

// Count only *hidden* non-core tiles. Marked non-core tiles don't block
// progress — a stale Quarantine Marker on a safe tile shouldn't keep the
// match running once every actually-hidden safe tile has been revealed.
function safeTilesLeft(state: GameState): number {
  let n = 0;
  for (const c of state.board) if (!c.isCore && c.state === 'hidden') n++;
  return n;
}

function leaderLead(state: GameState): { leader: number; lead: number } {
  let max = state.scores[0];
  let second = -Infinity;
  let leader = 0;
  for (let i = 0; i < state.scores.length; i++) {
    const s = state.scores[i];
    if (s > max) {
      second = max;
      max = s;
      leader = i;
    } else if (s > second) {
      second = s;
    }
  }
  return { leader, lead: max - (second === -Infinity ? 0 : second) };
}

// -------- Actions --------

export interface RevealResult {
  state: GameState;
  revealed: number[];
  hitCore: boolean;
  violation: null | 'gentleman' | 'soreLoser';
  // Points awarded to the actor (base tiles × combo multiplier). Useful for
  // HUD flash / audio-layered feedback; not required for game logic.
  pointsAwarded: number;
  // Combo snapshot AFTER this action resolves. Caller uses this to render
  // the updated multiplier without inspecting state.combos directly.
  combo: number;
}

// Game reducer for revealing a tile. `elapsedMs` is how long the actor took
// to commit this move, measured from the start of their turn — drives the
// speed-combo scoring bonus. Callers that don't care about speed (batch
// replay, tests) can pass 0; that lands in the 'fast' bucket by definition.
export function reveal(state: GameState, x: number, y: number, elapsedMs: number = 0): RevealResult {
  const empty: RevealResult = {
    state,
    revealed: [],
    hitCore: false,
    violation: null,
    pointsAwarded: 0,
    combo: state.combos[state.currentPlayer] ?? 0,
  };
  if (state.status !== 'playing') return empty;
  if (!inBounds(x, y, state.width, state.height)) return empty;

  const i = idx(x, y, state.width);
  const target = state.board[i];
  if (target.state !== 'hidden') return empty;

  const player = state.currentPlayer;

  // Rule violations — compute before mutating state.
  let violation: RevealResult['violation'] = null;
  if (state.rules.gentleman && isForcedCore(state, x, y)) {
    violation = 'gentleman';
  } else if (state.rules.soreLoser) {
    const { leader, lead } = leaderLead(state);
    if (leader === player && lead >= state.rules.soreLoserLead && isForcedSafe(state, x, y)) {
      violation = 'soreLoser';
    }
  }

  const scores = [...state.scores];
  // Violation: opponents (all other players) split +1 each.
  if (violation) {
    for (let p = 0; p < state.players; p++) if (p !== player) scores[p] += 1;
  }

  const board = state.board.map((c) => ({ ...c }));
  const health = [...state.health];
  const eliminated = [...state.eliminated];
  const combos = [...state.combos];

  // Speed bucket + new combo value. Computed once per reveal — the bucket
  // reflects this click's reaction time, not per-tile thought.
  const bucket = speedBucket(elapsedMs);

  if (target.isCore) {
    // Hitting a Core: reveal it (so opponents see the risk zone), no points,
    // -1 HP. -1 score too in limited-bomb endgame. Breaks speed combo.
    board[i].state = 'revealed';
    board[i].revealedBy = player;
    if (state.maxHealth > 0) {
      health[player] = Math.max(0, health[player] - 1);
      if (health[player] === 0) eliminated[player] = true;
    }
    if (state.rules.limitedBomb && safeTilesLeft(state) <= state.rules.limitedBombThreshold) {
      scores[player] -= 1;
    }
    combos[player] = 0;
    const next = advanceTurn({ ...state, board, scores, health, eliminated, combos });
    return {
      state: checkEnd(next),
      revealed: [i],
      hitCore: true,
      violation,
      pointsAwarded: 0,
      combo: 0,
    };
  }

  // Flood fill safe cells from (x,y). Points are awarded AFTER the flood with
  // the combo multiplier applied to the total — not per-tile — so a big chain
  // on a combo-3 click scales the whole haul.
  const revealed: number[] = [];
  const queue: number[] = [i];
  const seen = new Set<number>([i]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const cell = board[cur];
    if (cell.state !== 'hidden' || cell.isCore) continue;
    cell.state = 'revealed';
    cell.revealedBy = player;
    revealed.push(cur);

    if (cell.adjacent === 0) {
      const cx = cur % state.width;
      const cy = Math.floor(cur / state.width);
      for (const nIdx of neighborIndices(cx, cy, state.width, state.height)) {
        if (seen.has(nIdx)) continue;
        seen.add(nIdx);
        const nb = board[nIdx];
        if (nb.state === 'hidden' && !nb.isCore) queue.push(nIdx);
      }
    }
  }

  // Update combo: violations break it (bad call); fast clicks build; slow
  // clicks reset; normal clicks hold. Then multiplier applies to this reveal.
  if (violation) combos[player] = 0;
  else if (bucket === 'fast') combos[player] = Math.min(combos[player] + 1, COMBO_CAP);
  else if (bucket === 'slow') combos[player] = 0;
  // 'normal' bucket: combos[player] unchanged.
  const multiplier = comboMultiplier(combos[player]);
  const pointsAwarded = Math.floor(revealed.length * multiplier);
  scores[player] += pointsAwarded;

  const next = advanceTurn({ ...state, board, scores, combos });
  return {
    state: checkEnd(next),
    revealed,
    hitCore: false,
    violation,
    pointsAwarded,
    combo: combos[player],
  };
}

export interface MarkResult {
  state: GameState;
  changed: boolean;
}

export function mark(state: GameState, x: number, y: number): MarkResult {
  if (state.status !== 'playing') return { state, changed: false };
  if (!inBounds(x, y, state.width, state.height)) return { state, changed: false };

  const i = idx(x, y, state.width);
  const cell = state.board[i];
  if (cell.state === 'revealed') return { state, changed: false };

  const player = state.currentPlayer;
  const board = state.board.map((c) => ({ ...c }));
  const c = board[i];
  const markersPlaced = [...state.markersPlaced];
  const markersCorrect = [...state.markersCorrect];

  if (c.state === 'marked') {
    if (c.markedBy !== player) return { state, changed: false };
    c.state = 'hidden';
    c.markedBy = null;
  } else {
    c.state = 'marked';
    c.markedBy = player;
    markersPlaced[player] += 1;
    if (c.isCore) markersCorrect[player] += 1;
  }
  // Marks are free actions within your turn — they DON'T advance turn order.
  // This closes the mark/unmark stall exploit: a player can only end their
  // turn by revealing a tile or letting the timer run out. Classic-minesweeper
  // feel: plant markers as prep, commit via reveal.
  return {
    state: { ...state, board, markersPlaced, markersCorrect },
    changed: true,
  };
}

// Apply a single reveal that came from an external authority (on-chain event).
// Unlike `reveal`, this does NO flood-fill, NO rule-violation checks, and uses
// the adjacency reported by the authority rather than recomputing it. That
// matches how the on-chain MachineSweepMatch contract reveals cells: one
// cell at a time, with the adjacency decrypted from the BITE ciphertext.
//
// Ends the match only on HP-based conditions (wipeout / last-player-standing).
// The "all safe revealed" end is NOT derived here because hidden cells carry
// placeholder `isCore` values in chain mode — use the contract's MatchEnded
// event to settle clean-board finishes.
export function applyChainReveal(
  state: GameState,
  player: number,
  x: number,
  y: number,
  wasCore: boolean,
  adjacency: number,
): GameState {
  if (state.status !== 'playing') return state;
  if (!inBounds(x, y, state.width, state.height)) return state;
  const i = idx(x, y, state.width);
  const cell = state.board[i];
  if (cell.state !== 'hidden') return state;

  const board = state.board.map((c) => ({ ...c }));
  const health = [...state.health];
  const eliminated = [...state.eliminated];
  const scores = [...state.scores];
  const combos = [...state.combos]; // reset-on-core only; no speed combo on chain

  const t = board[i];
  t.state = 'revealed';
  t.revealedBy = player;
  t.isCore = wasCore;
  t.adjacent = adjacency;

  if (wasCore) {
    if (state.maxHealth > 0) {
      health[player] = Math.max(0, health[player] - 1);
      if (health[player] === 0) eliminated[player] = true;
    }
    combos[player] = 0;
  } else {
    scores[player] += 1;
  }

  const next = advanceTurn({ ...state, board, health, eliminated, scores, combos });

  const alive = next.eliminated.reduce((n, e) => n + (e ? 0 : 1), 0);
  if (alive === 0) {
    return { ...next, status: 'ended', winner: null };
  }
  if (next.players > 1 && alive === 1) {
    const winner = next.eliminated.findIndex((e) => !e);
    return { ...next, status: 'ended', winner };
  }
  return next;
}

// Settle the match into Ended, mirroring a MatchEnded event from chain. Used
// when the contract's clean-board finish fires — locally we can't detect it
// because placeholder isCore values make the safe-remaining check unreliable.
export function forceEnd(state: GameState, winner: number | null): GameState {
  if (state.status === 'ended') return state;
  return { ...state, status: 'ended', winner };
}

// Turn timer ran out — current player loses 1 HP (if health is enabled) and
// the turn passes. Matches Core-hit penalty: staring at the clock is not a
// free pass. Only called from timeout paths, so the penalty lives here.
export function skipTurn(state: GameState): GameState {
  if (state.status !== 'playing') return state;
  const player = state.currentPlayer;
  const health = [...state.health];
  const eliminated = [...state.eliminated];
  const combos = [...state.combos];
  if (state.maxHealth > 0) {
    health[player] = Math.max(0, health[player] - 1);
    if (health[player] === 0) eliminated[player] = true;
  }
  // Timing out is the slowest possible "decision" — combo breaks.
  combos[player] = 0;
  const next = advanceTurn({ ...state, health, eliminated, combos });
  return checkEnd(next);
}

function advanceTurn(state: GameState): GameState {
  // Walk forward to the next non-eliminated player. If everyone's out we leave
  // currentPlayer where it was — checkEnd will flip status to 'ended'.
  let next = state.currentPlayer;
  for (let step = 0; step < state.players; step++) {
    next = (next + 1) % state.players;
    if (!state.eliminated[next]) break;
  }
  return {
    ...state,
    currentPlayer: next,
    turnCount: state.turnCount + 1,
  };
}

function aliveCount(state: GameState): number {
  let n = 0;
  for (const e of state.eliminated) if (!e) n++;
  return n;
}

function checkEnd(state: GameState): GameState {
  // Marked non-core tiles don't count as safe-left — otherwise a forgotten
  // Marker on a safe tile wedges the match in limbo with no legal reveal
  // left. Marker settlement below still pays out (or docks) those markers.
  const safeLeft = state.board.some((c) => !c.isCore && c.state === 'hidden');
  const alive = aliveCount(state);

  // End conditions:
  // 1. All safe tiles revealed (standard clean-sweep finish).
  // 2. Every player has been eliminated (nobody left to play).
  // 3. Only one player left and they're alive — they win by default.
  const standardEnd = !safeLeft;
  const wipeout = alive === 0;
  const lastPlayerStanding = state.players > 1 && alive === 1;
  if (!standardEnd && !wipeout && !lastPlayerStanding) return state;

  const scores = [...state.scores];
  // Settle Marker bonuses only on a standard clean end (Marker payouts don't
  // feel fair when triggered by a wipeout mid-game).
  if (standardEnd) {
    for (const c of state.board) {
      if (c.state !== 'marked' || c.markedBy === null) continue;
      scores[c.markedBy] += c.isCore ? 2 : -1;
    }
  }

  // Pick winner. Eliminated players can't win; ties resolve to null.
  let winner: number | null = null;
  let best = -Infinity;
  let tie = false;
  for (let p = 0; p < state.players; p++) {
    if (state.eliminated[p]) continue;
    if (scores[p] > best) {
      best = scores[p];
      winner = p;
      tie = false;
    } else if (scores[p] === best) {
      tie = true;
    }
  }
  return { ...state, scores, status: 'ended', winner: tie ? null : winner };
}
